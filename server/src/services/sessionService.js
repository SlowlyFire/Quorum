/**
 * §8's session endpoints: create, list, read, rename or re-crew, delete.
 *
 * The council a session carries is its DEFAULT, not its history. Rounds
 * snapshot their own line-up into round_models as they run, so replacing a
 * session's council changes what the NEXT round will use and leaves every
 * round already run exactly as it was. That property is what makes "change
 * models mid-conversation" safe, and it is verified rather than assumed.
 */
import { withTransaction } from '../db/pool.js';
import { httpError } from '../lib/httpError.js';
import { listResponsesBySession } from '../models/modelResponseModel.js';
import { listRoundsBySession } from '../models/roundModel.js';
import { listRoundModelsBySession } from '../models/roundModelModel.js';
import {
  countSessionsByUser,
  deleteSession as deleteSessionRow,
  findSessionById,
  insertSession,
  listSessionsByUser,
  updateSession as updateSessionRow,
} from '../models/sessionModel.js';
import {
  deleteSessionModels,
  insertSessionModels,
  listSessionModels,
  listSessionModelsForSessions,
} from '../models/sessionModelModel.js';
import { resolveCouncil, toPublicCouncilModel, toSessionModelEntries } from './councilService.js';
import { planCouncil } from './debateService.js';
import { toPublicRound } from './roundService.js';

/** The requireOwnership loader for every /api/sessions/:id route. */
export async function loadSessionForOwnership(id) {
  return findSessionById(id);
}

// ---------------------------------------------------------------------------
// Wire shape
// ---------------------------------------------------------------------------

/**
 * The single place a sessions row becomes wire shape, as toPublicUser is for
 * users: snake_case out, camelCase in, and an allow-list rather than a spread.
 */
export function toPublicSession(row, councilRows = [], extra = {}) {
  const chairmanRow = councilRows.find((council) => council.is_chairman);

  return {
    id: row.id,
    title: row.title,
    chairmanAbstains: row.chairman_abstains,
    rebuttalEnabled: row.rebuttal_enabled,
    shareToken: row.share_token,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    council: {
      chairmanId: chairmanRow?.model_id ?? null,
      models: councilRows.map((council) =>
        toPublicCouncilModel(
          {
            id: council.model_id,
            slug: council.openrouter_slug,
            displayName: council.display_name,
            provider: council.provider,
          },
          chairmanRow?.model_id ?? null,
        ),
      ),
    },
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createSession({
  userId,
  title = null,
  council,
  chairmanAbstains = true,
  rebuttalEnabled = true,
}) {
  const resolved = await resolveCouncil(council);

  /**
   * The engine's own rules, applied at creation time. A council that can never
   * hold a debate — two models with the chairman abstaining, say — is not worth
   * storing: the session would be created happily and then fail every round
   * with INSUFFICIENT_COUNCIL, which is a worse place to learn it.
   */
  planCouncil({ ...resolved, chairmanAbstains, rebuttalEnabled });

  /**
   * One transaction. A session without its council is a session no round can
   * start from, and half of a create is not a create.
   */
  const { row, councilRows } = await withTransaction(async (exec) => {
    const created = await insertSession(
      { userId, title, chairmanAbstains, rebuttalEnabled },
      exec,
    );

    await insertSessionModels(created.id, toSessionModelEntries(resolved), exec);

    return { row: created, councilRows: await listSessionModels(created.id, exec) };
  });

  return toPublicSession(row, councilRows, { roundCount: 0 });
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export async function listSessions({ userId, limit, offset, search, verdict }) {
  const filters = { search: search ?? null, verdict: verdict ?? null };

  const [rows, total] = await Promise.all([
    listSessionsByUser(userId, { limit, offset, ...filters }),
    countSessionsByUser(userId, filters),
  ]);

  // One query for every council on the page rather than one per session.
  const councils = rows.length > 0 ? await listSessionModelsForSessions(rows.map((row) => row.id)) : [];
  const bySession = new Map();

  for (const council of councils) {
    if (!bySession.has(council.session_id)) bySession.set(council.session_id, []);
    bySession.get(council.session_id).push(council);
  }

  return {
    sessions: rows.map((row) =>
      toPublicSession(row, bySession.get(row.id) ?? [], {
        roundCount: Number(row.round_count),
        /**
         * The row's verdict chip and spend column on mockup 03. Both are
         * aggregates over the session's rounds, so they exist on the LIST shape
         * and not on the detail shape — the detail response carries every round
         * and the client can add them up from there.
         */
        latestVerdictType: row.latest_verdict_type ?? null,
        totalSpend: Number(row.total_spend ?? 0),
      }),
    ),
    pagination: {
      limit,
      offset,
      total,
      // Saves the client the arithmetic, and is the only field that knows
      // whether the page it just received was the last one.
      hasMore: offset + rows.length < total,
    },
  };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * §8: "Session + all rounds + all responses". Five queries flat, not one per
 * round: a twenty-round session would otherwise be forty-one round trips to
 * Supabase for a single page load.
 */
export async function getSessionDetail(sessionId) {
  const session = await findSessionById(sessionId);

  if (!session) {
    throw httpError(404, 'NOT_FOUND', 'Session not found');
  }

  const [councilRows, rounds, roundCouncils, responses] = await Promise.all([
    listSessionModels(sessionId),
    listRoundsBySession(sessionId),
    listRoundModelsBySession(sessionId),
    listResponsesBySession(sessionId),
  ]);

  const councilsByRound = groupBy(roundCouncils, 'round_id');
  const responsesByRound = groupBy(responses, 'round_id');

  return toPublicSession(session, councilRows, {
    roundCount: rounds.length,
    rounds: rounds.map((round) =>
      toPublicRound(round, councilsByRound.get(round.id) ?? [], responsesByRound.get(round.id) ?? []),
    ),
  });
}

function groupBy(rows, key) {
  const grouped = new Map();

  for (const row of rows) {
    if (!grouped.has(row[key])) grouped.set(row[key], []);
    grouped.get(row[key]).push(row);
  }

  return grouped;
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

/**
 * Rename, re-crew, or change either debate setting. `current` is the row
 * requireOwnership already loaded.
 *
 * Replacing the council is delete-then-insert rather than a diff: a council is
 * a set of at most eight rows, and the chairman flag moving between two models
 * is two updates and an ordering problem that a rewrite does not have.
 */
export async function updateSession({ current, title, council, chairmanAbstains, rebuttalEnabled }) {
  const resolved = council ? await resolveCouncil(council) : null;

  if (resolved) {
    /**
     * Checked against the settings this session will have AFTER the patch, not
     * the ones it has now: sending a two-model council and chairmanAbstains
     * false in the same request is legal, and validating against the stored
     * flags would reject it.
     */
    planCouncil({
      ...resolved,
      chairmanAbstains: chairmanAbstains ?? current.chairman_abstains,
      rebuttalEnabled: rebuttalEnabled ?? current.rebuttal_enabled,
    });
  }

  const { row, councilRows } = await withTransaction(async (exec) => {
    const updated = await updateSessionRow(
      current.id,
      {
        title: title ?? null,
        chairmanAbstains: chairmanAbstains ?? null,
        rebuttalEnabled: rebuttalEnabled ?? null,
      },
      exec,
    );

    if (resolved) {
      await deleteSessionModels(current.id, exec);
      await insertSessionModels(current.id, toSessionModelEntries(resolved), exec);
    }

    return { row: updated, councilRows: await listSessionModels(current.id, exec) };
  });

  return toPublicSession(row, councilRows);
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * 204 and nothing else. The cascade takes rounds, round_models,
 * model_responses, attachments and session_models with it;
 * credit_transactions.round_id is ON DELETE SET NULL, so the billing history
 * outlives the conversation it belongs to.
 */
export async function deleteSession(sessionId) {
  const deleted = await deleteSessionRow(sessionId);

  if (!deleted) {
    // requireOwnership loaded the row moments ago, so losing the race with
    // another delete is the only way here.
    throw httpError(404, 'NOT_FOUND', 'Session not found');
  }
}
