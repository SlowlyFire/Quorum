/**
 * The HTTP half of a debate: starting one, and reading one back.
 *
 * WHY POST ANSWERS 202 AND DOES NOT WAIT
 *
 * Session 5 measured completed rounds at 8.3s to 46.7s. No HTTP request should
 * be held open for 47 seconds — proxies, load balancers and Render all cut idle
 * connections long before that, and a client that loses the socket loses the
 * result of a round it has already paid for. And EventSource can only issue a
 * GET with no body, so the stream cannot be the same call as the start.
 *
 * So POST creates the round row, answers 202 with its id, and runs the debate on
 * the process's own time. Every refusal that belongs to the caller — an unknown
 * model, a council too small to debate — is raised BEFORE that response is sent,
 * by calling the same planCouncil the engine calls. What happens after the 202
 * is the debate's business, and it is reported over the stream.
 */
import { httpError } from '../lib/httpError.js';
import { listResponsesByRoundWithModel } from '../models/modelResponseModel.js';
import { findRoundById, insertRound } from '../models/roundModel.js';
import { listRoundModels } from '../models/roundModelModel.js';
import { listSessionModels } from '../models/sessionModelModel.js';
import { councilFromSessionModels, resolveCouncil } from './councilService.js';
import { planCouncil, runRound } from './debateService.js';
import { PROMPT_VERSION } from './promptService.js';
import { failStream, makeStreamEmitter, openStream, streamState } from './roundStreamService.js';

/** The requireOwnership loader. rounds.user_id is denormalised from sessions
 *  (decision 5) precisely so this is one row and no join. */
export async function loadRoundForOwnership(id) {
  return findRoundById(id);
}

// ---------------------------------------------------------------------------
// Starting a round
// ---------------------------------------------------------------------------

/**
 * `session` is the row requireOwnership already loaded, so this does not fetch
 * it again. `council` is the optional per-round override from the body.
 */
export async function startRound({ session, userId, prompt, council }) {
  /**
   * An explicit council wins for this round and does NOT touch session_models.
   * That asymmetry is the point of having both tables: asking one question of a
   * different line-up must not silently rewrite the session's default, and
   * changing the default must not rewrite history. Only PATCH
   * /api/sessions/:id edits session_models.
   */
  const resolved = council
    ? await resolveCouncil(council)
    : councilFromSessionModels(await listSessionModels(session.id));

  const councilInput = {
    models: resolved.models,
    chairmanId: resolved.chairmanId,
    // Both are session-level settings snapshotted onto the round by the engine.
    chairmanAbstains: session.chairman_abstains,
    rebuttalEnabled: session.rebuttal_enabled,
  };

  /**
   * The same function runRound will call, called here so its 400s arrive as the
   * response to this POST rather than as a round_failed frame thirty seconds
   * later. Nothing has been written or spent at this point.
   */
  const plan = planCouncil(councilInput);

  /**
   * The row is inserted here rather than inside runRound so that the id in the
   * 202 already resolves: a client that follows the response straight to
   * GET /api/rounds/:id must not race the engine's first INSERT. runRound is
   * handed the row and skips creating one.
   */
  const round = await insertRound({
    sessionId: session.id,
    userId,
    userPrompt: prompt,
    chairmanModelId: plan.chairman.id,
    chairmanAbstains: plan.chairmanAbstains,
    promptVersion: PROMPT_VERSION,
  });

  // Opened before the debate is launched, so the buffer exists before the first
  // event can fire. This is the whole reason a client can connect late.
  openStream(round.id);

  void runInBackground({ round, userId, prompt, councilInput });

  return {
    roundId: round.id,
    sessionId: session.id,
    status: round.status,
    streamUrl: `/api/rounds/${round.id}/stream`,
  };
}

/**
 * Deliberately not awaited, and deliberately unable to reject: an unhandled
 * rejection here would take the process down and every other user's round with
 * it. runRound already emits round_failed and marks the row failed before it
 * rethrows, so there is nothing left to do but log and make sure the stream
 * cannot be left waiting for a terminal frame that will never arrive.
 */
async function runInBackground({ round, userId, prompt, councilInput }) {
  try {
    await runRound({
      sessionId: round.session_id,
      userId,
      prompt,
      council: councilInput,
      round,
      onEvent: makeStreamEmitter(round.id),
    });
  } catch (error) {
    console.error(`[round] ${round.id} failed — ${error.code ?? 'ERROR'}: ${error.message}`);
    failStream(round.id, error);
  }
}

// ---------------------------------------------------------------------------
// Reading a round back
// ---------------------------------------------------------------------------

export async function getRoundDetail(roundId) {
  const round = await findRoundById(roundId);

  if (!round) {
    throw httpError(404, 'NOT_FOUND', 'Round not found');
  }

  const [councilRows, responseRows] = await Promise.all([
    listRoundModels(roundId),
    listResponsesByRoundWithModel(roundId),
  ]);

  return toPublicRound(round, councilRows, responseRows);
}

/** numeric(14,8) arrives from pg as a string; the wire gets a number. */
function money(value) {
  return value === null || value === undefined ? null : Number(value);
}

export function toPublicResponse(row) {
  return {
    id: row.id,
    stage: row.stage,
    label: row.anon_label,
    modelId: row.model_id,
    modelName: row.display_name,
    slug: row.openrouter_slug,
    content: row.content,
    stance: row.stance,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    cost: money(row.cost),
    latencyMs: row.latency_ms,
    provider: row.provider,
    errorText: row.error_text,
    createdAt: row.created_at,
  };
}

/**
 * The stage-2 verdict, which is NOT rounds.verdict_type.
 *
 * rounds.verdict_type is written by stage 4 and is the user-facing outcome; the
 * chairman frequently returns `unanimous` there once every drafter has conceded.
 * Stage 2 is the blind evaluation of anonymised drafts, and its winner_labels
 * are the only record of which draft actually won. Both are kept and they answer
 * different questions — see docs/decisions.md 20.
 *
 * Note which row is read: the LAST stage-2 row with no error_text. A chairman
 * stage can have two rows, because a retried parse failure is persisted
 * alongside the attempt that succeeded.
 */
export function verdictFromResponses(responses) {
  const usable = responses.filter((row) => row.stage === 'verdict' && !row.errorText);
  const latest = usable[usable.length - 1];

  if (!latest?.content) return null;

  try {
    const parsed = JSON.parse(latest.content);

    return {
      verdictType: parsed.verdictType ?? null,
      winnerLabels: parsed.winnerLabels ?? [],
      reasoning: parsed.reasoning ?? '',
      answer: parsed.answer ?? '',
    };
  } catch {
    // The engine writes canonical JSON to this column, so this is unreachable
    // for any row it wrote. A null verdict is still a readable round.
    return null;
  }
}

/**
 * The label -> model mapping, reconstructed from the draft rows. It was withheld
 * from the chairman, never from the user: §2 promises the full record of who
 * said what, and a transcript of anonymous letters is not that.
 */
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

export function toPublicRound(round, councilRows, responseRows) {
  const responses = responseRows.map(toPublicResponse);

  return {
    id: round.id,
    sessionId: round.session_id,
    prompt: round.user_prompt,
    status: round.status,
    chairmanModelId: round.chairman_model_id,
    chairmanAbstains: round.chairman_abstains,
    /** Stage 4's ruling — the user-facing outcome. */
    verdictType: round.verdict_type,
    finalAnswer: round.final_answer,
    openQuestions: round.open_questions,
    totalCost: money(round.total_cost),
    durationMs: round.duration_ms,
    promptVersion: round.prompt_version,
    createdAt: round.created_at,
    council: councilRows.map((row) => ({
      modelId: row.model_id,
      displayName: row.display_name,
      slug: row.openrouter_slug,
      role: row.role,
    })),
    labels: labelsFromResponses(responses),
    /** Stage 2's blind evaluation. See verdictFromResponses. */
    verdict: verdictFromResponses(responses),
    responses,
    /** Present only while the round is live and its buffer has not expired. */
    stream: streamState(round.id),
  };
}
