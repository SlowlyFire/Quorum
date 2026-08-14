/**
 * The four-stage debate engine.
 *
 *   1  Drafts     every drafting model answers independently, in parallel
 *   2  Verdict    the chairman sees the drafts anonymised and shuffled
 *   3  Rebuttals  each drafter may defend, revise or concede
 *   4  Final      the chairman rules on the rebuttals and answers the user
 *
 * Two invariants from §2, both of which are the reason the product works:
 * the chairman abstains from drafting by default, because LLMs favour their own
 * output when judging; and rebuttals permit concession, not just defence,
 * because defence-only makes models entrench and stage 4 learns nothing.
 *
 * No HTTP here. runRound is a callable service — Session 6 mounts it behind
 * POST /api/sessions/:id/rounds and turns `onEvent` into SSE frames.
 */
import {
  FINAL_DELTA_FLUSH_CHARS,
  MAX_TOKENS,
  STREAM_FINAL_ANSWER,
  TEMPERATURE,
} from '../config/llm.js';
import { httpError } from '../lib/httpError.js';
import { titleFromPrompt } from '../lib/titleFromPrompt.js';
import { insertModelResponse } from '../models/modelResponseModel.js';
import {
  completeRound,
  failRound,
  insertRound,
  setRoundVerdict,
  updateRoundStatus,
} from '../models/roundModel.js';
import { insertRoundModels } from '../models/roundModelModel.js';
import { setTitleIfBlank, touchSession } from '../models/sessionModel.js';
import { createFieldScanner } from './jsonFieldStream.js';
import { parseModelJson } from './jsonResponse.js';
import { callModel, callModelStreaming } from './openrouterService.js';
import { PROMPT_VERSION, renderStage } from './promptService.js';
import { debitForRound } from './walletService.js';

/**
 * The models' vocabulary, from prompts/, to the system's, from §7's enumerated
 * values. Both files are frozen — the templates ask the chairman for `pick` and
 * the CHECK constraint on rounds.verdict_type accepts only `picked` — so this
 * map is the single place the two meet. See docs/decisions.md 18.
 */
export const VERDICT_TYPE_MAP = Object.freeze({
  pick: 'picked',
  merge: 'merged',
  synthesise: 'synthesised',
  unanimous: 'unanimous',
});

/**
 * Variants models produce regardless of what the prompt asked for: the American
 * spelling, and the §7 past tense a model may echo back if it has seen it.
 * Accepted, but never silently — normalising one of these logs a warning with
 * the raw value, because a warning that fires often means the template needs
 * tightening rather than the map needing another entry.
 */
const VERDICT_TYPE_ALIASES = Object.freeze({
  synthesize: 'synthesised',
  synthesized: 'synthesised',
  picked: 'picked',
  merged: 'merged',
  synthesised: 'synthesised',
});

const STANCES = Object.freeze(['defend', 'revise', 'concede']);

/** Appended to the chairman's user message on the single retry. */
const JSON_RETRY_NUDGE = `

---

Your previous response could not be parsed. Return **only** the JSON object described above:
no markdown fence, no preamble, no commentary after the closing brace. Use only the response
labels shown above, and only the exact values listed for each field.`;

// ---------------------------------------------------------------------------
// Council planning — everything here runs before a single call is paid for
// ---------------------------------------------------------------------------

/**
 * Resolves the line-up into a chairman, a drafting pool and the round_models
 * roles, or throws. Nothing in this function touches the database or OpenRouter:
 * a council that cannot debate must cost nothing to reject.
 *
 * Exported because POST /api/sessions/:id/rounds answers 202 and then runs the
 * debate in the background — so every refusal that should reach the client as a
 * 400 has to be raised before that response is sent, and raising it by calling
 * the same function the engine calls is the only way the two cannot drift.
 */
export function planCouncil({ models, chairmanId, chairmanAbstains = true, rebuttalEnabled = true } = {}) {
  if (!Array.isArray(models) || models.length === 0) {
    throw httpError(400, 'INVALID_COUNCIL', 'A council needs at least one model');
  }

  for (const model of models) {
    if (!model?.id || !model?.slug) {
      throw httpError(400, 'INVALID_COUNCIL', 'Every council member needs an id and a slug');
    }
  }

  if (new Set(models.map((model) => model.id)).size !== models.length) {
    // round_models is keyed (round_id, model_id): a duplicate would fail on the
    // primary key several statements later, with a much worse error.
    throw httpError(400, 'INVALID_COUNCIL', 'A model may appear in a council only once');
  }

  const chairman = models.find((model) => model.id === chairmanId);

  if (!chairman) {
    throw httpError(400, 'INVALID_COUNCIL', 'The nominated chairman is not in the council');
  }

  const drafters = chairmanAbstains ? models.filter((model) => model.id !== chairmanId) : models;

  if (drafters.length < 2) {
    throw httpError(
      400,
      'INSUFFICIENT_COUNCIL',
      'A debate needs at least 3 models when the chairman abstains, or 2 when it drafts. ' +
        `This council has ${models.length} with the chairman ` +
        `${chairmanAbstains ? 'abstaining' : 'drafting'}, leaving ${drafters.length} to draft.`,
    );
  }

  const roles = models.map((model) => ({
    modelId: model.id,
    role: model.id === chairmanId ? (chairmanAbstains ? 'chairman' : 'both') : 'drafter',
  }));

  return { models, chairman, drafters, chairmanAbstains, rebuttalEnabled, roles };
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

/**
 * ATTACHMENTS REACH STAGE 1 AND NO OTHER STAGE, and that is the frozen prompts
 * deciding rather than an oversight. `01-draft.md` is the only template with an
 * `{{ATTACHMENTS}}` block; `prompts/` is read-only to the server, so the
 * verdict, rebuttal and final templates have nowhere to say what a model is
 * looking at. Sending an image alongside a prompt that never mentions it is a
 * different prompt from the one we validated, and it would multiply the image's
 * input tokens across every remaining stage. Stage 3 works from the drafts
 * block, which already contains what the drafters said about the attachment.
 *
 * A MODEL THAT CANNOT SEE A FILE IS TOLD SO, NEVER SILENTLY GIVEN LESS. §8's
 * attachment endpoints must not turn a text-only council member into a 400 — so
 * the round runs, that model's parts are withheld, and its `{{ATTACHMENTS}}`
 * block says an attachment exists that it cannot read and to answer from the
 * text alone. A drafter that quietly received nothing would answer confidently
 * about a question it had only half of, and the chairman would score that
 * answer against three that had all of it.
 */
function partsFor(model, attachments) {
  return attachments.filter((attachment) =>
    attachment.kind === 'document' ? model.supportsDocuments === true : model.supportsVision === true,
  );
}

const KIND_NOUN = { image: 'an image', document: 'a PDF document' };

function describeAttachment(attachment, index) {
  const kilobytes = Math.max(1, Math.round(attachment.sizeBytes / 1024));

  return `${index + 1}. ${KIND_NOUN[attachment.kind] ?? 'a file'} (${attachment.mediaType}, ${kilobytes} KB)`;
}

/**
 * The `{{ATTACHMENTS}}` interpolation for one drafter. Empty string when there
 * is nothing attached, which is what the template's "omit the block if none"
 * asks for.
 */
export function attachmentsBlockFor(model, attachments) {
  if (attachments.length === 0) return '';

  const visible = partsFor(model, attachments);
  const hidden = attachments.filter((attachment) => !visible.includes(attachment));

  const lines = ['---', ''];

  if (visible.length > 0) {
    lines.push(
      `The user attached ${visible.length === 1 ? 'this file' : 'these files'} to the question, included above:`,
      '',
      ...visible.map(describeAttachment),
      '',
    );
  }

  if (hidden.length > 0) {
    lines.push(
      `The user also attached ${hidden.length === 1 ? 'a file' : `${hidden.length} files`} that you cannot see, ` +
        'because this model does not accept ' +
        `${[...new Set(hidden.map((a) => (a.kind === 'document' ? 'documents' : 'images')))].join(' or ')}:`,
      '',
      ...hidden.map(describeAttachment),
      '',
      'Answer from the text of the question alone. Say plainly, in one line, that you could not ' +
        'see the attachment, and do not guess at what it contains — a confident answer about a ' +
        'file you have not read is worse than an incomplete one.',
      '',
    );
  }

  return lines.join('\n').trimEnd();
}

// ---------------------------------------------------------------------------
// Anonymity
// ---------------------------------------------------------------------------

/**
 * Fisher-Yates. A fresh shuffle every round, because position bias in judges is
 * real: if A were always the same model, stage 2 would be measuring seat order.
 */
function shuffle(items) {
  const shuffled = [...items];

  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  return shuffled;
}

/** A, B, … Z, AA, AB. A council that large is absurd, but it will not collide. */
function labelAt(index) {
  let label = '';
  let n = index;

  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);

  return label;
}

// ---------------------------------------------------------------------------
// Prompt blocks
// ---------------------------------------------------------------------------

/** "### Response A\n<content>", in label order. The chairman sees only this. */
function formatDrafts(drafts) {
  return drafts.map((draft) => `### Response ${draft.label}\n${draft.content.trim()}`).join('\n\n');
}

/**
 * "### Response A — CONCEDE\n<argument>". A revision carries its corrected
 * answer as well: 04-final.md tells the chairman a revision "may contain a
 * correction worth adopting", which it cannot judge from the argument alone.
 */
function formatRebuttals(rebuttals) {
  return rebuttals
    .map((rebuttal) => {
      const heading = `### Response ${rebuttal.label} — ${rebuttal.stance.toUpperCase()}`;
      const body =
        rebuttal.stance === 'revise' && rebuttal.revisedAnswer
          ? `${rebuttal.argument}\n\nRevised answer:\n\n${rebuttal.revisedAnswer}`
          : rebuttal.argument;

      return `${heading}\n${body}`;
    })
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// Shape validation
// ---------------------------------------------------------------------------

/**
 * A word not in the map is not guessed at — it throws MODEL_JSON_INVALID and
 * takes the same retry-once path as unparseable JSON. Guessing at the nearest
 * match is how a `merge` verdict gets recorded as a `pick`.
 */
function normaliseVerdictType(raw) {
  const key = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/^["'`]+|["'`]+$/g, '');

  const canonical = VERDICT_TYPE_MAP[key] ?? VERDICT_TYPE_ALIASES[key] ?? null;

  if (!canonical) {
    throw invalidShape(`verdict_type ${JSON.stringify(raw)} is not one of ${expectedVerdicts()}`);
  }

  if (!Object.hasOwn(VERDICT_TYPE_MAP, raw)) {
    console.warn(
      `[debate] verdict_type ${JSON.stringify(raw)} normalised to "${canonical}" — ` +
        `the template asks for ${expectedVerdicts()}`,
    );
  }

  return canonical;
}

function expectedVerdicts() {
  return Object.keys(VERDICT_TYPE_MAP).join(' / ');
}

/**
 * A shape failure is reported with the same code as a parse failure, so one
 * catch in the chairman helper covers both and both get the same single retry.
 */
function invalidShape(reason) {
  const error = httpError(502, 'MODEL_JSON_INVALID', `The chairman's JSON is unusable: ${reason}`);
  error.rawContent = reason;
  return error;
}

function validateVerdict(parsed, labels) {
  const verdictType = normaliseVerdictType(parsed.verdict_type);

  const winnerLabels = parsed.winner_labels ?? [];

  if (!Array.isArray(winnerLabels)) {
    throw invalidShape('winner_labels is not an array');
  }

  for (const label of winnerLabels) {
    // A label that was never issued means the chairman invented a draft. That is
    // a failure, not something to paper over — it makes winner_labels unusable
    // for the leaderboard and means the rest of the JSON is suspect too.
    if (!labels.includes(label)) {
      throw invalidShape(
        `winner_labels contains ${JSON.stringify(label)}, which is not a label in this round (${labels.join(', ')})`,
      );
    }
  }

  if ((verdictType === 'picked' || verdictType === 'merged') && winnerLabels.length === 0) {
    throw invalidShape(`verdict_type "${verdictType}" with no winner_labels`);
  }

  if (typeof parsed.answer !== 'string' || parsed.answer.trim() === '') {
    throw invalidShape('answer is missing or empty');
  }

  return {
    verdictType,
    winnerLabels,
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
    answer: parsed.answer,
  };
}

function validateFinal(parsed) {
  const verdictType = normaliseVerdictType(parsed.verdict_type);

  if (typeof parsed.final_answer !== 'string' || parsed.final_answer.trim() === '') {
    throw invalidShape('final_answer is missing or empty');
  }

  const openQuestions =
    typeof parsed.open_questions === 'string' && parsed.open_questions.trim() !== ''
      ? parsed.open_questions
      : null;

  return {
    verdictType,
    finalAnswer: parsed.final_answer,
    openQuestions,
    changedFromInitial: parsed.changed_from_initial === true,
  };
}

function validateRebuttal(parsed) {
  const stance = String(parsed.stance ?? '')
    .trim()
    .toLowerCase();

  if (!STANCES.includes(stance)) {
    throw invalidShape(`stance ${JSON.stringify(parsed.stance)} is not one of ${STANCES.join(' / ')}`);
  }

  if (typeof parsed.argument !== 'string' || parsed.argument.trim() === '') {
    throw invalidShape('argument is missing or empty');
  }

  const revisedAnswer =
    typeof parsed.revised_answer === 'string' && parsed.revised_answer.trim() !== ''
      ? parsed.revised_answer
      : null;

  if (stance === 'revise' && !revisedAnswer) {
    throw invalidShape('stance "revise" with no revised_answer');
  }

  return { stance, argument: parsed.argument, revisedAnswer };
}

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

/**
 * onEvent is a debate's narration, and narration must never be able to kill the
 * thing it narrates: a client that disconnects mid-round would otherwise take a
 * paid-for debate down with it.
 */
function makeEmitter(onEvent) {
  if (typeof onEvent !== 'function') return async () => {};

  return async (event, payload) => {
    try {
      await onEvent(event, payload);
    } catch (error) {
      console.warn(`[debate] onEvent("${event}") threw and was ignored: ${error.message}`);
    }
  };
}

/**
 * THE STAGE-4 PREVIEW — the thing that turns a chairman writing JSON into an
 * answer appearing on screen, and the only part of a round that renders before
 * it has been parsed.
 *
 * The chairman returns an object, not prose: `04-final.md` asks for
 * `verdict_type`, `changed_from_initial`, `final_answer` and `open_questions`,
 * and `prompts/` is frozen. So the deltas are scanned for the `final_answer`
 * string and only its decoded contents are emitted — the user watches the
 * answer, never the JSON around it.
 *
 * THREE RULES, AND THE ORDER MATTERS.
 *
 *   1. The preview is not the answer. When the stream ends the COMPLETE buffer
 *      goes through `parseModelJson` and `validateFinal` exactly as a
 *      non-streamed call's would, and that object is what is persisted, billed
 *      and sent as `round_complete`. `verify:streaming` asserts the two come out
 *      identical character for character; the parsed one still wins.
 *   2. A preview that goes wrong costs nothing. The scanner degrades to silence
 *      rather than to garbage, and everything here is inside a try — a throw
 *      switches the preview off and lets the round finish normally. There is no
 *      path from a bad preview to a failed debate.
 *   3. Frames are queued, not raced. `onDelta` is called synchronously from the
 *      transport while `emit` may be asynchronous, so two overlapping deltas
 *      would be free to arrive in either order. The chain makes that impossible
 *      without making the transport wait on the network.
 */
function makeFinalPreview(emit) {
  const scanner = createFieldScanner('final_answer');

  let held = '';
  let text = '';
  let frames = 0;
  let live = true;
  let closed = false;
  let queue = Promise.resolve();

  const send = (chunk) => {
    text += chunk;
    frames += 1;
    // Never awaited here, always awaited in finish(): the transport must not
    // block on a slow subscriber, and the round must not end before the last
    // delta has gone out.
    queue = queue.then(() => emit('final_delta', { text: chunk })).catch(() => {});
  };

  return {
    /** Handed straight to callModelStreaming. Must never throw. */
    onDelta(chunk) {
      if (!live) return;

      try {
        held += scanner.push(chunk);

        // Flushed early when the closing quote arrives, so the last words of the
        // answer are not held back waiting for a threshold the remaining JSON
        // will never reach.
        if (held.length >= FINAL_DELTA_FLUSH_CHARS || (scanner.done && held.length > 0)) {
          send(held);
          held = '';
        }

        if (scanner.done) live = false;
      } catch (error) {
        live = false;
        held = '';
        console.warn(`[debate] the final-answer preview stopped early: ${error.message}`);
      }
    },

    /**
     * Called the moment the stage-4 call returns, before its response is
     * persisted, so `final_done` reaches the client ahead of the frame carrying
     * the authoritative answer. Idempotent, and it never throws.
     */
    async finish() {
      if (closed) return summary();

      closed = true;

      if (live && held.length > 0) send(held);

      held = '';
      live = false;

      await queue;

      /**
       * No frames means no preview was ever shown — the scanner never found the
       * field, or the flag was off for this call — and a `final_done` for a
       * preview that never started would only tell the client to stop rendering
       * something it never began. The skeleton stays up, which is Session 8's
       * behaviour exactly.
       */
      if (frames > 0) {
        await emit('final_done', { chars: text.length, complete: scanner.complete });
      }

      return summary();
    },

    get text() {
      return text;
    },
    get frames() {
      return frames;
    },
  };

  function summary() {
    return { frames, chars: text.length, text, complete: scanner.complete, lost: scanner.lost };
  }
}

/**
 * What goes in error_text. Built from our own mapped code and fixed message plus
 * the provider's words — never from the prompt, which is the user's question.
 */
function describeError(error) {
  const parts = [`${error.code ?? 'ERROR'}: ${error.message}`];

  if (error.providerStatus) parts.push(`(provider ${error.providerStatus})`);
  if (error.providerMessage) parts.push(`— ${String(error.providerMessage).slice(0, 400)}`);

  return parts.join(' ');
}

/**
 * A call can fail after it has been billed — OpenRouter's 200-with-an-error-
 * finish-reason is the case that prompted this, and callModel attaches whatever
 * the provider reported to the error. "We paid for it, so we record it" applies
 * to the failures too, so those figures go on the error row.
 */
function billingOf(error) {
  const usage = error?.usage;

  if (!usage) return {};

  return {
    promptTokens: usage.promptTokens ?? null,
    completionTokens: usage.completionTokens ?? null,
    cost: usage.cost ?? null,
    latencyMs: usage.latencyMs ?? null,
    provider: usage.provider ?? null,
  };
}

// ---------------------------------------------------------------------------
// The round
// ---------------------------------------------------------------------------

export async function runRound({
  sessionId,
  userId,
  prompt,
  council,
  onEvent,
  round: existingRound,
  /**
   * Already downloaded and base64-encoded by attachmentService — once for the
   * round, not once per drafter, because four models on a council would
   * otherwise pull the same object four times for identical bytes.
   *
   * Shaped `{ id, mediaType, kind, sizeBytes, base64 }`. Defaults to empty, so
   * every caller that predates attachments — verify:debate, and every direct
   * call to the engine — runs exactly as it did.
   */
  attachments = [],
  /**
   * Which side of §3's rule this round fell on, decided by entitlementService
   * before the row was inserted. 'paid' bills the wallet when the round ends;
   * 'free' bills nothing and writes no ledger row (decision 34).
   *
   * Defaults to 'free' rather than 'paid', so a caller that does not know about
   * billing — verify:debate, and every direct call to the engine — runs a
   * debate without charging anyone for it. The alternative default would make
   * "forgot to pass it" mean "charged the user", which is the wrong way round
   * for a mistake to fail.
   */
  billingMode = 'free',
  /**
   * Whether stage 4 streams. Defaults to the config flag, which is what every
   * production caller uses; the override exists so `verify:streaming` can prove
   * the non-streamed path still runs without editing `config/llm.js`. See the
   * constant for why stage 4 and no other stage.
   */
  streamFinalAnswer = STREAM_FINAL_ANSWER,
}) {
  const emit = makeEmitter(onEvent);
  const plan = planCouncil(council);

  // Wall clock starts at round creation, which is what duration_ms measures.
  const startedAt = process.hrtime.bigint();
  const elapsedMs = () => Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6);

  /**
   * `round` is passed in by roundService, which inserts the row itself so that
   * POST can answer 202 with an id that already resolves — a 202 naming a
   * resource that 404s for the next 50ms is a race the client would have to
   * know about. Absent, the engine creates its own row, which is how
   * verify:debate and every direct caller still work.
   */
  const round =
    existingRound ??
    (await insertRound({
      sessionId,
      userId,
      userPrompt: prompt,
      chairmanModelId: plan.chairman.id,
      chairmanAbstains: plan.chairmanAbstains,
      promptVersion: PROMPT_VERSION,
    }));

  await insertRoundModels(round.id, plan.roles);
  await touchSession(sessionId);

  /**
   * Every persisted call, and what it cost. `cost` is written to
   * rounds.total_cost; `rows` is what walletService debits from, so the ledger
   * charges for exactly the calls the round recorded — including the failures,
   * which were billed to us all the same.
   */
  const ledger = { calls: 0, cost: 0, rows: [] };

  const persist = async (row) => {
    const saved = await insertModelResponse({ roundId: round.id, ...row });
    ledger.calls += 1;
    ledger.cost += Number(row.cost ?? 0);
    ledger.rows.push({ stage: row.stage, cost: Number(row.cost ?? 0) });
    return saved;
  };

  const totalCost = () => Number(ledger.cost.toFixed(8));

  /**
   * Settling the bill, and the one thing in this file that must never take a
   * round down with it.
   *
   * Called on both exits — the round completed, or the round failed after
   * spending something — because a failure is billed too. Everything inside is
   * caught and logged loudly: the user's answer has already been produced and
   * persisted at this point, and losing it because a wallet write failed would
   * trade a recoverable accounting gap for an unrecoverable one. A missing
   * debit is visible forever in `rounds.total_cost`, which is written either
   * way; a lost final answer is not visible anywhere.
   */
  const settle = async () => {
    if (billingMode !== 'paid') return;

    try {
      const transaction = await debitForRound(userId, round.id, ledger.rows);

      if (transaction) {
        console.log(
          `[wallet] ${round.id} debited $${Math.abs(Number(transaction.amount)).toFixed(6)} — ` +
            `balance now $${Number(transaction.balance_after).toFixed(6)}`,
        );
      }
    } catch (error) {
      console.error(
        `[wallet] ${round.id} COULD NOT BE DEBITED ($${totalCost().toFixed(6)} unbilled) — ` +
          `${error.code ?? 'ERROR'}: ${error.message}`,
      );
    }
  };

  try {
    await emit('round_started', {
      roundId: round.id,
      drafterCount: plan.drafters.length,
      chairman: plan.chairman.displayName ?? plan.chairman.slug,
      /**
       * What is attached, and which drafters cannot see it. Sent on the opening
       * frame rather than as a tenth event so the live view knows before the
       * first draft lands — a card that says "could not see the image" has to
       * be right the moment it appears, not once the round is persisted.
       *
       * `base64` is deliberately not here. A frame is a log line waiting to
       * happen, and the client already holds a signed URL for the preview.
       */
      attachments: attachments.map(({ id, mediaType, kind, sizeBytes }) => ({
        id,
        mediaType,
        kind,
        sizeBytes,
      })),
      blindDrafters: plan.drafters
        .filter((model) => partsFor(model, attachments).length < attachments.length)
        .map((model) => model.displayName ?? model.slug),
    });

    // -- Stage 1 : drafts ---------------------------------------------------

    await emit('stage_started', { stage: 'draft' });

    /**
     * Shuffle first, then label in shuffled order, so the label carries no
     * information about the council's own ordering. This array is the label ->
     * model mapping and it stays in memory: what reaches the chairman is
     * formatDrafts() output and nothing else.
     */
    const seated = shuffle(plan.drafters).map((model, index) => ({
      model,
      label: labelAt(index),
    }));

    const labels = seated.map((seat) => seat.label);

    /**
     * ONE PROMPT PER DRAFTER, NOT ONE PER ROUND. Until Session 11 every drafter
     * got byte-identical text, which is still true when nothing is attached —
     * `attachmentsBlockFor` returns '' and this renders exactly what Session 5
     * sent. With an attachment the block differs by what the model can see, and
     * the parts list differs with it.
     */
    const draftOutcomes = await Promise.allSettled(
      seated.map((seat) => {
        const rendered = renderStage('draft', {
          QUESTION: prompt,
          ATTACHMENTS: attachmentsBlockFor(seat.model, attachments),
        });

        return callModel({
          modelSlug: seat.model.slug,
          system: rendered.system,
          user: rendered.user,
          temperature: TEMPERATURE.drafting,
          maxTokens: MAX_TOKENS.draft,
          images: partsFor(seat.model, attachments),
        });
      }),
    );

    const drafts = [];

    // Persisted in label order, sequentially, so created_at reads as A, B, C.
    for (const [index, outcome] of draftOutcomes.entries()) {
      const { model, label } = seated[index];
      const modelName = model.displayName ?? model.slug;

      if (outcome.status === 'rejected') {
        const errorText = describeError(outcome.reason);

        await persist({
          modelId: model.id,
          stage: 'draft',
          anonLabel: label,
          errorText,
          ...billingOf(outcome.reason),
        });
        await emit('response_failed', { stage: 'draft', label, modelName, error: errorText });
        continue;
      }

      const result = outcome.value;

      await persist({
        modelId: model.id,
        stage: 'draft',
        anonLabel: label,
        content: result.content,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        cost: result.cost,
        latencyMs: result.latencyMs,
        provider: result.raw?.provider ?? null,
      });

      await emit('response_ready', {
        stage: 'draft',
        label,
        modelName,
        content: result.content,
        cost: result.cost,
        latencyMs: result.latencyMs,
      });

      drafts.push({
        label,
        modelId: model.id,
        modelName,
        slug: model.slug,
        content: result.content,
        provider: result.raw?.provider ?? null,
        cost: result.cost,
        latencyMs: result.latencyMs,
      });
    }

    if (drafts.length < 2) {
      // One voice is not a debate, and a "verdict" over a single draft would be
      // a much worse product than an honest failure.
      throw httpError(
        502,
        'INSUFFICIENT_DRAFTS',
        `Only ${drafts.length} of ${seated.length} drafts succeeded; a debate needs at least two answers to compare.`,
      );
    }

    const draftsBlock = formatDrafts(drafts);
    const draftedLabels = drafts.map((draft) => draft.label);

    // -- Stage 2 : verdict --------------------------------------------------

    await updateRoundStatus(round.id, 'verdict');
    await emit('stage_started', { stage: 'verdict' });

    const verdict = await callChairmanForJson({
      stage: 'verdict',
      chairman: plan.chairman,
      rendered: renderStage('verdict', { QUESTION: prompt, DRAFTS: draftsBlock }),
      temperature: TEMPERATURE.chairman,
      maxTokens: MAX_TOKENS.verdict,
      validate: (parsed) => validateVerdict(parsed, draftedLabels),
      persist,
      emit,
    });

    await setRoundVerdict(round.id, { verdictType: verdict.verdictType, status: 'verdict' });

    await emit('verdict', {
      verdictType: verdict.verdictType,
      winnerLabels: verdict.winnerLabels,
      reasoning: verdict.reasoning,
    });

    // -- Stage 3 : rebuttals -----------------------------------------------

    const rebuttals = [];
    let rebuttalSkipReason = null;

    if (!plan.rebuttalEnabled) {
      rebuttalSkipReason = 'rebuttals are disabled for this session';
    } else if (verdict.verdictType === 'unanimous') {
      // Nothing to argue about, and skipping saves a whole stage of latency and
      // cost — N-1 calls on a council that already agrees.
      rebuttalSkipReason = 'the chairman found the drafts substantively unanimous';
    }

    if (rebuttalSkipReason) {
      console.log(`[debate] ${round.id} stage 3 skipped: ${rebuttalSkipReason}`);
      await emit('stage_skipped', { stage: 'rebuttal', reason: rebuttalSkipReason });
    } else {
      await updateRoundStatus(round.id, 'rebuttal');
      await emit('stage_started', { stage: 'rebuttal' });

      /**
       * Every model that drafted, not just the ones that lost. A merge or a
       * synthesise has no single loser, and treating all drafters alike removes
       * a special case rather than adding one. (§2.)
       */
      const rebuttalOutcomes = await Promise.allSettled(
        drafts.map((draft) => {
          const rendered = renderStage('rebuttal', {
            QUESTION: prompt,
            YOUR_LABEL: draft.label,
            DRAFTS: draftsBlock,
            VERDICT_TYPE: verdict.verdictType,
            VERDICT_REASONING: verdict.reasoning,
            VERDICT_ANSWER: verdict.answer,
          });

          return callModel({
            modelSlug: draft.slug,
            system: rendered.system,
            user: rendered.user,
            temperature: TEMPERATURE.rebuttal,
            maxTokens: MAX_TOKENS.rebuttal,
          });
        }),
      );

      for (const [index, outcome] of rebuttalOutcomes.entries()) {
        const draft = drafts[index];

        if (outcome.status === 'rejected') {
          const errorText = describeError(outcome.reason);

          await persist({
            modelId: draft.modelId,
            stage: 'rebuttal',
            anonLabel: draft.label,
            errorText,
            ...billingOf(outcome.reason),
          });
          await emit('response_failed', {
            stage: 'rebuttal',
            label: draft.label,
            modelName: draft.modelName,
            error: errorText,
          });
          continue;
        }

        const result = outcome.value;
        const shared = {
          modelId: draft.modelId,
          stage: 'rebuttal',
          anonLabel: draft.label,
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          cost: result.cost,
          latencyMs: result.latencyMs,
          provider: result.raw?.provider ?? null,
        };

        let parsed;

        try {
          parsed = validateRebuttal(parseModelJson(result.content));
        } catch (error) {
          // A drafter that cannot produce JSON loses its voice in stage 4; it
          // does not take the round down. The call is still recorded — we paid
          // for it — with the raw text kept alongside the reason.
          const errorText = describeError(error);

          await persist({ ...shared, content: result.content, errorText });
          await emit('response_failed', {
            stage: 'rebuttal',
            label: draft.label,
            modelName: draft.modelName,
            error: errorText,
          });
          continue;
        }

        await persist({
          ...shared,
          content: JSON.stringify({
            stance: parsed.stance,
            argument: parsed.argument,
            revised_answer: parsed.revisedAnswer,
          }),
          stance: parsed.stance,
        });

        await emit('response_ready', {
          stage: 'rebuttal',
          label: draft.label,
          modelName: draft.modelName,
          content: parsed.argument,
          cost: result.cost,
          latencyMs: result.latencyMs,
        });

        await emit('stance', {
          label: draft.label,
          modelName: draft.modelName,
          stance: parsed.stance,
        });

        rebuttals.push({
          label: draft.label,
          modelId: draft.modelId,
          modelName: draft.modelName,
          stance: parsed.stance,
          argument: parsed.argument,
          revisedAnswer: parsed.revisedAnswer,
        });
      }
    }

    // -- Stage 4 : final ---------------------------------------------------

    await updateRoundStatus(round.id, 'final');
    await emit('stage_started', { stage: 'final' });

    /**
     * Never an empty string. A blank {{REBUTTALS}} block would read to the
     * chairman as "the drafters said nothing", which is a different claim from
     * "no rebuttals were invited" and would corrupt stage 4's reasoning.
     */
    const rebuttalsBlock = rebuttalSkipReason
      ? `No rebuttal stage was held for this round — ${rebuttalSkipReason}. Rule on the drafts and your own verdict alone.`
      : rebuttals.length > 0
        ? formatRebuttals(rebuttals)
        : 'The rebuttal stage was held, but no drafter returned a usable response. Rule on the drafts and your own verdict alone.';

    /**
     * The only streamed call in the product. `callChairmanForJson` closes the
     * preview the moment the model call returns — before the response is
     * persisted — so `final_done` reaches the client ahead of the frame carrying
     * the parsed answer, and the client's swap from preview to markdown happens
     * once rather than twice.
     */
    const preview = streamFinalAnswer ? makeFinalPreview(emit) : null;

    const final = await callChairmanForJson({
      stage: 'final',
      chairman: plan.chairman,
      rendered: renderStage('final', {
        QUESTION: prompt,
        DRAFTS: draftsBlock,
        VERDICT_REASONING: verdict.reasoning,
        VERDICT_ANSWER: verdict.answer,
        REBUTTALS: rebuttalsBlock,
      }),
      temperature: TEMPERATURE.chairman,
      maxTokens: MAX_TOKENS.final,
      validate: validateFinal,
      persist,
      emit,
      preview,
    });

    /** Idempotent, so this reads the summary rather than closing anything. */
    const previewSummary = preview ? await preview.finish() : null;

    if (previewSummary?.frames) {
      console.log(
        `[debate] ${round.id} streamed the final answer in ${previewSummary.frames} frames, ` +
          `${previewSummary.chars} chars, ` +
          `${previewSummary.text === final.finalAnswer ? 'matching' : 'DIFFERING FROM'} the parsed value`,
      );
    }

    const durationMs = elapsedMs();

    /**
     * verdict_type comes from stage 4, not stage 2: the chairman may have
     * reversed itself on a defence, and that reversal is the whole point of the
     * stage. Stage 2's value was written when it happened and is overwritten
     * here.
     */
    await completeRound({
      id: round.id,
      verdictType: final.verdictType,
      finalAnswer: final.finalAnswer,
      openQuestions: final.openQuestions,
      totalCost: totalCost(),
      durationMs,
    });

    /**
     * The session's title, the moment there is a question to make one from.
     * `setTitleIfBlank`'s `WHERE title IS NULL` is what makes "only if still
     * the default" true atomically rather than as a read-then-write race — a
     * rename landing in the seconds this round was running must never be
     * clobbered by the question that was typed before it (decision 84).
     * Silent on a failed round: nothing here runs on that path, so a session
     * whose first round failed still gets titled by whichever round succeeds.
     */
    const autoTitle = titleFromPrompt(prompt);
    if (autoTitle) await setTitleIfBlank(sessionId, autoTitle);

    // Before round_complete, so the frame that tells the client the debate is
    // over is also the point after which the balance it refetches is settled.
    await settle();

    await emit('round_complete', {
      roundId: round.id,
      finalAnswer: final.finalAnswer,
      verdictType: final.verdictType,
      totalCost: totalCost(),
      durationMs,
    });

    return {
      roundId: round.id,
      status: 'complete',
      promptVersion: PROMPT_VERSION,
      chairman: plan.chairman,
      chairmanAbstains: plan.chairmanAbstains,
      verdictType: final.verdictType,
      changedFromInitial: final.changedFromInitial,
      finalAnswer: final.finalAnswer,
      openQuestions: final.openQuestions,
      totalCost: totalCost(),
      callCount: ledger.calls,
      durationMs,
      /**
       * What the user was shown while stage 4 was still writing, and whether it
       * matched what was parsed. Null when the flag is off. Nothing in the
       * product renders this — it is here so a direct caller can assert on the
       * preview without reading it back off the wire.
       */
      finalPreview: previewSummary,
      /** The label -> model mapping. Withheld from the chairman, not the user:
       *  §2 promises the user the full record of who said what. */
      labels: seated.map(({ label, model }) => ({
        label,
        modelId: model.id,
        slug: model.slug,
        displayName: model.displayName ?? model.slug,
      })),
      /** The exact {{DRAFTS}} string the chairman received, so anonymity is
       *  checkable rather than merely asserted. */
      draftsBlock,
      rebuttalsBlock,
      drafts,
      verdict,
      rebuttals,
      rebuttalSkipReason,
      /** Without the base64, which the caller already has and no consumer of
       *  this object wants a copy of. */
      attachments: attachments.map(({ id, mediaType, kind, sizeBytes }) => ({
        id,
        mediaType,
        kind,
        sizeBytes,
      })),
    };
  } catch (error) {
    /**
     * A round never stays mid-status. Best effort: if the database itself is
     * what failed, log that and still surface the original error, which is the
     * one that explains the round.
     */
    try {
      await failRound({ id: round.id, totalCost: totalCost(), durationMs: elapsedMs() });
    } catch (dbError) {
      console.error(`[debate] ${round.id} could not be marked failed: ${dbError.message}`);
    }

    /**
     * A failed round is still billed for what it spent before it died. Stage 1
     * can cost four calls and then fail on INSUFFICIENT_DRAFTS; those calls
     * were made and we were charged for them, and absorbing that would make a
     * round that reliably fails the cheapest way to use the product.
     */
    await settle();

    await emit('round_failed', { roundId: round.id, error: describeError(error) });

    throw error;
  }
}

/**
 * A chairman call that must come back as JSON: parse, validate, and on failure
 * retry exactly once with the nudge appended.
 *
 * Both attempts are persisted. The failed one keeps the unparseable text in
 * `content` and the reason in `error_text`, so a stage can have two rows and the
 * last one without an error is the one that counts.
 *
 * `preview` is stage 4's and nothing else passes one. ONLY THE FIRST ATTEMPT
 * STREAMS: a retry that streamed as well would push a second answer into a
 * client already rendering the first, and the user would watch the final answer
 * start over. So the retry runs through `callModel` and the stale preview simply
 * stops moving until the parsed answer replaces it — which is the honest picture
 * of what is happening, and the failure the flag exists to make rare.
 */
async function callChairmanForJson({
  stage,
  chairman,
  rendered,
  temperature,
  maxTokens,
  validate,
  persist,
  emit,
  preview = null,
}) {
  const modelName = chairman.displayName ?? chairman.slug;
  let lastReason = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const user = attempt === 1 ? rendered.user : rendered.user + JSON_RETRY_NUDGE;
    const streaming = Boolean(preview) && attempt === 1;
    let result;

    try {
      const request = {
        modelSlug: chairman.slug,
        system: rendered.system,
        user,
        temperature,
        maxTokens,
      };

      result = streaming
        ? await callModelStreaming({ ...request, onDelta: preview.onDelta })
        : await callModel(request);
    } catch (error) {
      // The provider failed rather than the JSON. Record the call we paid for,
      // then let it take the round down — there is no round without a chairman.
      const errorText = describeError(error);

      if (streaming) await preview.finish();

      await persist({ modelId: chairman.id, stage, errorText, ...billingOf(error) });
      await emit('response_failed', { stage, label: null, modelName, error: errorText });

      throw error;
    }

    /**
     * Closed here rather than by the caller, so the ordering on the wire is
     * deltas, `final_done`, then the `response_ready` carrying the parsed
     * object. A client that swapped to the real answer and only then stopped
     * blinking would flicker.
     */
    if (streaming) await preview.finish();

    const shared = {
      modelId: chairman.id,
      stage,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      cost: result.cost,
      latencyMs: result.latencyMs,
      provider: result.raw?.provider ?? null,
    };

    try {
      const validated = validate(parseModelJson(result.content));

      /**
       * Canonical JSON rather than the model's exact bytes: Session 7 reads this
       * column with one JSON.parse, and a model that wrapped its object in a
       * fence would otherwise force every reader to re-run parseModelJson. The
       * exact bytes are preserved on the failure path, which is where they
       * matter.
       */
      await persist({ ...shared, content: JSON.stringify(validated) });

      await emit('response_ready', {
        stage,
        label: null,
        modelName,
        content: JSON.stringify(validated),
        cost: result.cost,
        latencyMs: result.latencyMs,
      });

      return validated;
    } catch (error) {
      if (error.code !== 'MODEL_JSON_INVALID') throw error;

      lastReason = describeError(error);

      await persist({ ...shared, content: result.content, errorText: lastReason });
      await emit('response_failed', { stage, label: null, modelName, error: lastReason });

      console.warn(`[debate] chairman ${stage} attempt ${attempt} unusable: ${lastReason}`);
    }
  }

  throw httpError(
    502,
    'CHAIRMAN_RESPONSE_INVALID',
    `The chairman's ${stage} response could not be read as usable JSON after two attempts. Last reason — ${lastReason}`,
  );
}
