/**
 * Public share links — §4.8, and §8's three endpoints:
 * POST and DELETE /api/sessions/:id/share, and the public GET /api/share/:token.
 *
 * THIS FILE OWNS THE ONLY UNAUTHENTICATED DATA ROUTE IN THE PRODUCT. Everything
 * else is behind requireAuth and, for anything with an :id, requireOwnership.
 * Here the token IS the authorisation, and it is handed to whoever the owner
 * gave the link to — which means the payload has to be safe to give to a
 * stranger, permanently, because a link that has been sent cannot be unsent.
 *
 * THE PAYLOAD IS BUILT BY ALLOW-LIST, NEVER BY STRIPPING. `toSharedSession`
 * below constructs a new object field by field rather than deleting keys from
 * `toPublicSession`'s output, and the difference is what happens when somebody
 * adds a field upstream: a strip-list leaks it by default and an allow-list
 * drops it by default. The one that fails safe is the one guarding the public
 * route. `scripts/verify-sharing.js` walks the response structurally and asserts
 * that no key at any depth is a user id, an email, or a cost.
 *
 * What is deliberately NOT here, and why:
 *
 *   user_id / email / display_name   who ran the debate. §11: "the shared view
 *                                    excludes wallet and account data". A link
 *                                    shares a debate, not an identity.
 *   cost / total_cost / tokens       what the owner paid. Nobody handed a link
 *                                    should learn another person's spending, and
 *                                    token counts are the same number divided by
 *                                    a price.
 *   share_token                      already in the caller's URL, and echoing a
 *                                    credential into a body it does not need is
 *                                    how it ends up in a log.
 *   session_id on a round            an internal id the public reader can do
 *                                    nothing with; the ownership-guarded routes
 *                                    that accept it would 403 anyway, so it is
 *                                    only ever a hint about what else exists.
 */
import { randomBytes } from 'node:crypto';

import { env } from '../config/env.js';
import { httpError } from '../lib/httpError.js';
import { listResponsesBySession } from '../models/modelResponseModel.js';
import { listRoundsBySession } from '../models/roundModel.js';
import { listRoundModelsBySession } from '../models/roundModelModel.js';
import { findSessionByShareToken, setSessionShareToken } from '../models/sessionModel.js';
import { listSessionModels } from '../models/sessionModelModel.js';
import { verdictFromResponses } from './roundService.js';

/**
 * 24 bytes of CSPRNG, base64url — 32 characters, 192 bits. The token is the
 * only thing standing between a private debate and the internet, so it is sized
 * to be unguessable rather than to be short: at 192 bits, enumeration is not a
 * threat model, which is what lets the unknown-token response be a plain 404
 * with no rate-limit games behind it.
 *
 * base64url rather than hex — same entropy in 32 characters instead of 48 — and
 * URL-safe by construction, so nothing downstream has to encode it.
 */
const TOKEN_BYTES = 24;

function generateToken() {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/** The link a user copies. Built from CLIENT_URL so it is right in every
 *  environment; §6 routes the public view at /s/:shareToken. */
export function shareUrl(token) {
  return `${env.CLIENT_URL}/s/${token}`;
}

// ---------------------------------------------------------------------------
// Owner-side: create and revoke
// ---------------------------------------------------------------------------

/**
 * IDEMPOTENT. Calling twice returns the token that already exists rather than
 * rotating it, because the button that calls this is "Share" and a user who
 * presses it again after sending the link to somebody expects to see the same
 * link — not to have silently broken the one they sent. Rotation is revoke then
 * share, which is two deliberate actions and says what it does.
 *
 * `session` is the row requireOwnership already loaded.
 */
export async function shareSession(session) {
  if (session.share_token) {
    return { shareToken: session.share_token, url: shareUrl(session.share_token), created: false };
  }

  const token = generateToken();
  const updated = await setSessionShareToken(session.id, token);

  if (!updated) {
    // requireOwnership loaded the row moments ago; losing it to a concurrent
    // delete is the only way here.
    throw httpError(404, 'NOT_FOUND', 'Session not found');
  }

  return { shareToken: token, url: shareUrl(token), created: true };
}

/**
 * Revoking writes null, so the row stops matching `findSessionByShareToken` —
 * there is no revoked state to remember to check for. 204 either way: DELETE on
 * a session that was never shared has already achieved what the caller asked
 * for, and a 404 there would be reporting success as failure.
 */
export async function revokeShare(session) {
  await setSessionShareToken(session.id, null);
}

// ---------------------------------------------------------------------------
// Public-side: the read
// ---------------------------------------------------------------------------

/** One model on a council, as a stranger may see it. Catalogue facts only. */
function toSharedCouncilModel(row, chairmanId) {
  return {
    modelId: row.model_id,
    displayName: row.display_name,
    slug: row.openrouter_slug,
    provider: row.provider,
    isChairman: row.model_id === chairmanId,
  };
}

/**
 * One model_responses row. Everything a reader needs to see who said what, and
 * nothing about what it cost.
 *
 * `latencyMs` stays: it is a property of the debate rather than of the account,
 * it is already visible on every draft card, and "Gemini took 4.1s" tells a
 * reader something about the models — which is the point of sharing a debate.
 * `promptTokens` and `completionTokens` do not, because a token count times a
 * published per-token price is the cost with an extra step.
 */
function toSharedResponse(row) {
  return {
    id: row.id,
    stage: row.stage,
    label: row.anon_label,
    modelId: row.model_id,
    modelName: row.display_name,
    slug: row.openrouter_slug,
    content: row.content,
    stance: row.stance,
    latencyMs: row.latency_ms,
    provider: row.provider,
    errorText: row.error_text,
    createdAt: row.created_at,
  };
}

/**
 * One round. Shaped to match `toPublicRound` field for field where the fields
 * overlap, so the client's `roundFromDetail` reads a shared round and an owned
 * one with the same code — the read-only view reuses the debate view's
 * components rather than reimplementing them.
 *
 * The fields that are absent rather than null: `totalCost`, and the token counts
 * on each response. `lib/round.js` sums tokens to zero and carries a null cost,
 * and both footers already omit a figure they do not have.
 */
function toSharedRound(round, councilRows, responseRows) {
  const responses = responseRows.map(toSharedResponse);
  const chairmanId = round.chairman_model_id;

  return {
    id: round.id,
    prompt: round.user_prompt,
    status: round.status,
    chairmanModelId: chairmanId,
    chairmanAbstains: round.chairman_abstains,
    /** Stage 4's ruling — the user-facing outcome. */
    verdictType: round.verdict_type,
    finalAnswer: round.final_answer,
    openQuestions: round.open_questions,
    durationMs: round.duration_ms,
    createdAt: round.created_at,
    council: councilRows.map((row) => ({
      modelId: row.model_id,
      displayName: row.display_name,
      slug: row.openrouter_slug,
      role: row.role,
    })),
    /** Stage 2's blind evaluation, parsed from the persisted verdict row. The
     *  same reader the owned route uses, including its two traps. */
    verdict: verdictFromResponses(responses.map((row) => ({ ...row, errorText: row.errorText }))),
    labels: labelsFromResponses(responses),
    responses,
  };
}

/** The label -> model mapping, from the draft rows. Withheld from the chairman
 *  during the debate, never from a reader afterwards. */
function labelsFromResponses(responses) {
  const seen = new Map();

  for (const row of responses) {
    if (row.stage !== 'draft' || !row.label || seen.has(row.label)) continue;

    seen.set(row.label, {
      label: row.label,
      modelId: row.modelId,
      modelName: row.modelName,
      slug: row.slug,
    });
  }

  return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function toSharedSession(session, councilRows, rounds) {
  const chairmanRow = councilRows.find((row) => row.is_chairman);

  return {
    title: session.title,
    chairmanAbstains: session.chairman_abstains,
    rebuttalEnabled: session.rebuttal_enabled,
    createdAt: session.created_at,
    updatedAt: session.updated_at,
    council: {
      chairmanId: chairmanRow?.model_id ?? null,
      models: councilRows.map((row) => toSharedCouncilModel(row, chairmanRow?.model_id ?? null)),
    },
    roundCount: rounds.length,
    rounds,
  };
}

/**
 * §8: "Public. Read-only session, no auth."
 *
 * UNKNOWN AND REVOKED ARE THE SAME 404, and that is the whole point rather than
 * a convenience. A 403 for "this token existed once" confirms to a caller
 * holding a leaked or guessed string that it was real — which is exactly the
 * fact a revoked link must stop telling anyone. There is only one branch here
 * because there is only one answer.
 *
 * Four queries, the same shape as `getSessionDetail`: a twenty-round session is
 * not forty-one round trips.
 */
export async function getSharedSession(token) {
  const notFound = () =>
    httpError(404, 'NOT_FOUND', 'This shared debate does not exist, or the link has been revoked.');

  if (typeof token !== 'string' || token.length === 0) throw notFound();

  const session = await findSessionByShareToken(token);

  if (!session) throw notFound();

  const [councilRows, rounds, roundCouncils, responses] = await Promise.all([
    listSessionModels(session.id),
    listRoundsBySession(session.id),
    listRoundModelsBySession(session.id),
    listResponsesBySession(session.id),
  ]);

  const councilsByRound = groupBy(roundCouncils, 'round_id');
  const responsesByRound = groupBy(responses, 'round_id');

  return toSharedSession(
    session,
    councilRows,
    rounds.map((round) =>
      toSharedRound(round, councilsByRound.get(round.id) ?? [], responsesByRound.get(round.id) ?? []),
    ),
  );
}

function groupBy(rows, key) {
  const grouped = new Map();

  for (const row of rows) {
    if (!grouped.has(row[key])) grouped.set(row[key], []);
    grouped.get(row[key]).push(row);
  }

  return grouped;
}
