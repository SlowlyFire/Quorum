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
import {
  bindAttachmentsToRound,
  claimAttachments,
  getRoundAttachments,
  isImage,
  loadAttachmentParts,
} from './attachmentService.js';
import { councilFromSessionModels, resolveCouncil } from './councilService.js';
import { planCouncil, runRound } from './debateService.js';
import { canStartRound, denialMessage } from './entitlementService.js';
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
export async function startRound({ session, userId, prompt, council, attachmentIds }) {
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
   * Attachments are resolved here, next to planCouncil and before the
   * entitlement check, for the same reason planCouncil is: an id that belongs
   * to somebody else must be the answer to this POST, not a round_failed frame
   * thirty seconds later. Nothing is written or spent yet — the rows are only
   * read, and claiming them for the round happens after it exists.
   */
  const claimed = await claimAttachments(attachmentIds, userId);

  /**
   * §8's pre-flight cost check, and it runs BEFORE the row is inserted — the
   * free-tier allowance is a count of today's rounds, so a round inserted first
   * would be counted against the allowance it is asking permission from.
   *
   * It also runs after planCouncil rather than before it, and that ordering is
   * the same judgement Session 7 made when it mounted the deleted limiter after
   * `validate`: an impossible council is a 400 that spends nothing, and
   * charging a free debate for one would let a user lose the day's allowance to
   * a typo. Quoting the round needs the resolved council in any case.
   */
  // The question is part of the quote: a long one produces longer drafts, which
  // stages 2-4 then pay to read back. See PROMPT_LENGTH_SCALING (decision 56).
  /**
   * Shaped to `{ kind }` here rather than in the estimator, which must not
   * import the attachment stack to price a round — and derived with the same
   * `isImage` the engine uses, so the quote and `partsFor` cannot disagree about
   * which drafters are actually sent the file.
   */
  const attachmentKinds = claimed.map((row) => ({
    kind: isImage(row.mime_type) ? 'image' : 'document',
  }));

  const decision = await canStartRound(userId, plan, prompt, attachmentKinds);

  if (!decision.allowed) {
    throw httpError(402, decision.reason, denialMessage(decision), {
      // The numbers the client needs to explain the refusal and offer the right
      // remedy. See errorHandler for why this is its own key.
      billing: {
        mode: decision.mode,
        estimate: decision.estimate,
        threshold: decision.threshold,
        balance: decision.balance,
        freeRemaining: decision.freeRemaining,
      },
    });
  }

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

  /**
   * The claim is turned into a write only now that there is a round to point
   * at. It is the one thing between the insert and the 202 that can still fail
   * the request — a concurrent POST naming the same attachment — and failing
   * here leaves a `rounds` row nothing will ever run. That is the better half
   * of the trade: an abandoned row in `drafting` is a visible orphan that cost
   * nothing, while running the debate anyway would answer a question about an
   * image the models never saw.
   */
  const attached = await bindAttachmentsToRound(claimed, round.id, userId);

  // Opened before the debate is launched, so the buffer exists before the first
  // event can fire. This is the whole reason a client can connect late.
  openStream(round.id);

  void runInBackground({
    round,
    userId,
    prompt,
    councilInput,
    billingMode: decision.mode,
    attachmentRows: attached,
  });

  return {
    roundId: round.id,
    sessionId: session.id,
    status: round.status,
    streamUrl: `/api/rounds/${round.id}/stream`,
    /** Echoed back so the client can render the chips against the round it just
     *  started without re-reading them. Signed URLs are not minted here: the
     *  client uploaded these and already holds one for each. */
    attachmentIds: attached.map((row) => row.id),
    /**
     * What this round will be charged to, decided above and reported here so
     * the client can say "1 free debate left today" without a second call —
     * and so a user on the free tier is never billed silently in either
     * direction. `freeRemaining` is the count BEFORE this round, so the client
     * subtracts one for the round it just started.
     */
    billing: {
      mode: decision.mode,
      estimate: decision.estimate,
      threshold: decision.threshold,
      balance: decision.balance,
      freeRemaining: decision.freeRemaining,
    },
  };
}

/**
 * Deliberately not awaited, and deliberately unable to reject: an unhandled
 * rejection here would take the process down and every other user's round with
 * it. runRound already emits round_failed and marks the row failed before it
 * rethrows, so there is nothing left to do but log and make sure the stream
 * cannot be left waiting for a terminal frame that will never arrive.
 */
async function runInBackground({ round, userId, prompt, councilInput, billingMode, attachmentRows }) {
  try {
    /**
     * The download and base64 happen here rather than before the 202, because
     * they are the debate's work and not the caller's: up to 32 MB off Supabase
     * is not something to hold a POST open for, and a storage failure at this
     * point is a round_failed frame like any other stage failure. The rows were
     * already validated and claimed, so nothing about who may use them is still
     * in question.
     */
    await runRound({
      sessionId: round.session_id,
      userId,
      prompt,
      council: councilInput,
      round,
      billingMode,
      attachments: await loadAttachmentParts(attachmentRows),
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

  const [councilRows, responseRows, attachments] = await Promise.all([
    listRoundModels(roundId),
    listResponsesByRoundWithModel(roundId),
    /** Signed at read time, never stored — see attachmentService. */
    getRoundAttachments(roundId),
  ]);

  return toPublicRound(round, councilRows, responseRows, attachments);
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
 * One `round_models` row on the wire.
 *
 * The two modality flags are catalogue facts, not round facts, and they are here
 * so that a reader of a persisted round can work out which council member could
 * not see the attachment — without asking the catalogue, and without a column
 * recording per round what the model could do at the time. Session 11's client
 * derives the "could not see this" marker from exactly these two fields and the
 * round's `attachments`, which is what makes the live view and the reloaded one
 * agree.
 */
function toPublicCouncilMember(row) {
  return {
    modelId: row.model_id,
    displayName: row.display_name,
    slug: row.openrouter_slug,
    role: row.role,
    supportsVision: row.supports_vision === true,
    supportsDocuments: row.supports_documents === true,
  };
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

export function toPublicRound(round, councilRows, responseRows, attachments = []) {
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
    council: councilRows.map(toPublicCouncilMember),
    labels: labelsFromResponses(responses),
    /** Stage 2's blind evaluation. See verdictFromResponses. */
    verdict: verdictFromResponses(responses),
    /**
     * Already signed by the caller. A refresh mints new URLs, which is the
     * point of a signed URL: this array is a view of the objects, not a
     * permanent handle on them.
     */
    attachments,
    responses,
    /** Present only while the round is live and its buffer has not expired. */
    stream: streamState(round.id),
  };
}
