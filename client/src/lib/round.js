/**
 * One shape for a round, whichever end it arrived from.
 *
 * A round reaches the screen two ways: as SSE frames while it happens, and as
 * rows from GET /api/sessions/:id or GET /api/rounds/:id once it has. Both are
 * normalised here into the same object, so the transcript is rendered by one set
 * of components and a refresh mid-round cannot produce a subtly different view
 * from the one the user was already looking at.
 *
 * Everything below is pure. The EventSource lives in hooks/useRoundStream.js and
 * the fetches in api/quorum.js; this file only reshapes what they return.
 */

/** The four stages, in order, with what the rail draws for each. */
export const STAGES = [
  { key: 'draft', n: 1, title: 'Drafts', heading: 'Stage 1 · Drafts (anonymised, order shuffled)' },
  { key: 'verdict', n: 2, title: 'Verdict', heading: 'Stage 2 · Verdict', chairman: true },
  { key: 'rebuttal', n: 3, title: 'Rebuttals', heading: 'Stage 3 · Rebuttals' },
  { key: 'final', n: 4, title: 'Final', heading: 'Stage 4 · Final answer', chairman: true },
];

export const STAGE_KEYS = STAGES.map((stage) => stage.key);

/** A stage is one of these, and the rail draws each differently. */
export const STAGE_STATE = {
  pending: 'pending',
  running: 'running',
  done: 'done',
  skipped: 'skipped',
  failed: 'failed',
};

/** The stance chips: CONCEDES is the one that is green, per the mockup. */
export const STANCE_LABEL = {
  defend: 'DEFENDS',
  revise: 'REVISES',
  concede: 'CONCEDES',
};

/** The brass chip on the verdict card. `merged` names its two labels. */
export function verdictChip(verdictType, winnerLabels = []) {
  const labels = winnerLabels.join(' + ');

  switch (verdictType) {
    case 'picked':
      return labels ? `PICKED ${labels}` : 'PICKED';
    case 'merged':
      return labels ? `MERGED ${labels}` : 'MERGED';
    case 'synthesised':
      return 'SYNTHESISED';
    case 'unanimous':
      return 'UNANIMOUS';
    default:
      return String(verdictType ?? '').toUpperCase();
  }
}

function emptyRound(overrides = {}) {
  return {
    id: null,
    prompt: '',
    status: 'running',
    chairmanName: null,
    error: null,
    stages: {
      draft: { state: STAGE_STATE.pending, items: [], expected: null },
      verdict: { state: STAGE_STATE.pending },
      rebuttal: { state: STAGE_STATE.pending, items: [], skipReason: null },
      final: { state: STAGE_STATE.pending },
    },
    totals: { cost: 0, durationMs: null, callCount: 0, tokens: 0 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// From the database
// ---------------------------------------------------------------------------

/**
 * A persisted round — from GET /api/rounds/:id, or from the `rounds` array on
 * GET /api/sessions/:id, which carries the identical shape.
 *
 * TWO TRAPS, both of which the server's roundService documents and both of which
 * bite again here. A chairman stage can have TWO `model_responses` rows, because
 * a retried parse failure is persisted alongside the attempt that succeeded — so
 * the row that counts is the LAST one for a stage with no `errorText`. And
 * `verdictType` on the round is stage 4's ruling, while `verdict.verdictType` is
 * stage 2's blind evaluation of the anonymised drafts; they disagree often and
 * legitimately, so both are kept and each is rendered where it belongs.
 */
export function roundFromDetail(round) {
  const responses = round.responses ?? [];
  const byStage = (stage) => responses.filter((response) => response.stage === stage);

  const drafts = byStage('draft').map((response) => ({
    key: response.id,
    label: response.label,
    modelName: response.modelName,
    slug: response.slug,
    content: response.content,
    error: response.errorText,
    cost: response.cost,
    latencyMs: response.latencyMs,
  }));

  const rebuttals = byStage('rebuttal').map((response) => ({
    key: response.id,
    label: response.label,
    modelName: response.modelName,
    slug: response.slug,
    stance: response.stance,
    ...parseRebuttal(response),
    error: response.errorText,
    cost: response.cost,
    latencyMs: response.latencyMs,
  }));

  const isDone = round.status === 'complete';
  const isFailed = round.status === 'failed';

  /**
   * Why stage 3 has no rows is not stored anywhere — `rounds` has no
   * rebuttal_enabled column — so it is inferred from the only other thing that
   * skips it. Stage 2 returning `unanimous` is one of the engine's exactly two
   * reasons; the other is the session setting, and its wording says so without
   * claiming to have read a column that does not exist.
   */
  const rebuttalSkipped = (isDone || isFailed) && rebuttals.length === 0;
  const skipReason = !rebuttalSkipped
    ? null
    : round.verdict?.verdictType === 'unanimous'
      ? 'The chairman found the drafts substantively unanimous, so there was nothing to rebut.'
      : 'The rebuttal round is switched off for this session.';

  const chairman = (round.council ?? []).find((member) => member.role !== 'drafter');

  /**
   * `rounds.status` names the stage the engine is standing in, so it is what
   * decides the rail: everything before it has happened, it is happening, and
   * everything after it has not. On a complete round `at` is past the end and
   * every stage reads done.
   */
  const at = STAGE_KEYS.indexOf(round.status);
  const stateAt = (index) => {
    if (isDone) return STAGE_STATE.done;
    if (at < 0) return isFailed ? STAGE_STATE.failed : STAGE_STATE.pending;
    if (index < at) return STAGE_STATE.done;
    if (index > at) return STAGE_STATE.pending;
    return isFailed ? STAGE_STATE.failed : STAGE_STATE.running;
  };

  return {
    id: round.id,
    prompt: round.prompt,
    status: round.status,
    chairmanName: chairman?.displayName ?? null,
    error: isFailed ? 'This round failed. The record below is what completed before it did.' : null,
    verdictType: round.verdictType,
    council: round.council ?? [],
    labels: round.labels ?? [],
    createdAt: round.createdAt,
    stages: {
      draft: { state: stateAt(0), items: drafts, expected: null },
      verdict: {
        state: stateAt(1),
        ...(round.verdict ?? {}),
        modelName: chairman?.displayName ?? null,
        raw: round.verdict ? JSON.stringify(round.verdict, null, 2) : null,
      },
      rebuttal: {
        state: rebuttalSkipped ? STAGE_STATE.skipped : stateAt(2),
        items: rebuttals,
        skipReason,
      },
      final: {
        state: stateAt(3),
        modelName: chairman?.displayName ?? null,
        answer: round.finalAnswer,
        openQuestions: round.openQuestions,
      },
    },
    totals: {
      /**
       * NULL, not 0, when the payload carries no cost — which is exactly the
       * public shared view, whose response omits every cost field by allow-list.
       * Defaulting to 0 would render "$0.00" in the footer, and telling a
       * stranger a debate was free is a worse answer than telling them nothing.
       * A live round starts this at 0 legitimately, because 0 is what has been
       * spent so far.
       */
      cost: round.totalCost ?? null,
      durationMs: round.durationMs,
      callCount: responses.length,
      tokens: responses.reduce(
        (sum, response) => sum + (response.promptTokens ?? 0) + (response.completionTokens ?? 0),
        0,
      ),
    },
  };
}

/**
 * A rebuttal row's `content` is the canonical JSON the engine wrote —
 * `{ stance, argument, revised_answer }` — except on the failure path, where it
 * is whatever the model actually said. A parse failure is therefore expected
 * rather than exceptional: the raw text is the argument, which is the most
 * useful thing to show.
 */
function parseRebuttal(response) {
  if (!response.content) return { argument: '', revisedAnswer: null };

  try {
    const parsed = JSON.parse(response.content);

    return {
      argument: parsed.argument ?? '',
      revisedAnswer: parsed.revised_answer ?? null,
    };
  } catch {
    return { argument: response.content, revisedAnswer: null };
  }
}

// ---------------------------------------------------------------------------
// From the stream
// ---------------------------------------------------------------------------

/**
 * The reducer behind useRoundStream: the nine engine events, folded into the
 * same object roundFromDetail produces.
 *
 * It is a pure function of (state, frame) and it is idempotent for a frame it
 * has already seen — the hook drops those on the id before calling — because a
 * replayed buffer and a live fan-out are the same frames arriving twice, and a
 * reducer that appends would render every draft of a resumed round twice.
 */
export function applyStreamEvent(state, { event, data }) {
  const next = { ...state, stages: { ...state.stages } };

  switch (event) {
    case 'round_started':
      next.id = data.roundId ?? state.id;
      next.chairmanName = data.chairman ?? null;
      next.status = 'running';
      next.stages.draft = { ...next.stages.draft, expected: data.drafterCount ?? null };
      return next;

    case 'stage_started':
      if (!next.stages[data.stage]) return state;
      next.stages[data.stage] = { ...next.stages[data.stage], state: STAGE_STATE.running };
      return next;

    case 'stage_skipped':
      if (!next.stages[data.stage]) return state;
      next.stages[data.stage] = {
        ...next.stages[data.stage],
        state: STAGE_STATE.skipped,
        // Capitalised into a sentence: the engine's reasons are clause-shaped
        // ("the chairman found the drafts substantively unanimous") because they
        // are written into a log line and a prompt, not onto a card.
        skipReason: sentence(data.reason),
      };
      return next;

    case 'response_ready':
      return applyResponse(next, data, null);

    case 'response_failed':
      return applyResponse(next, data, data.error ?? 'This call failed.');

    case 'verdict':
      next.stages.verdict = {
        ...next.stages.verdict,
        state: STAGE_STATE.done,
        verdictType: data.verdictType,
        winnerLabels: data.winnerLabels ?? [],
        reasoning: data.reasoning ?? '',
      };
      return next;

    case 'stance': {
      const items = (next.stages.rebuttal.items ?? []).map((item) =>
        item.label === data.label ? { ...item, stance: data.stance } : item,
      );

      next.stages.rebuttal = { ...next.stages.rebuttal, items };
      return next;
    }

    case 'round_complete':
      next.status = 'complete';
      next.verdictType = data.verdictType;
      next.stages.final = {
        ...next.stages.final,
        state: STAGE_STATE.done,
        answer: data.finalAnswer,
      };
      next.totals = {
        ...next.totals,
        cost: data.totalCost ?? next.totals.cost,
        durationMs: data.durationMs ?? null,
      };
      // A stage still marked running when the round is over never happens on a
      // healthy stream, but a dropped frame should not leave a spinner forever.
      settleRunningStages(next);
      return next;

    case 'round_failed':
      next.status = 'failed';
      next.error = data.error ?? 'The round failed.';
      settleRunningStages(next, STAGE_STATE.failed);
      return next;

    default:
      // stream_closed and anything a later engine adds. The hook acts on
      // stream_closed itself; there is nothing for the transcript to change.
      return state;
  }
}

/**
 * A draft, a rebuttal, or a chairman stage — the event carries the stage, so one
 * branch covers all four. Keyed on label for the fan-out stages, which is what
 * makes it idempotent: a replayed `response_ready` overwrites its own card
 * rather than adding a second one.
 */
function applyResponse(next, data, error) {
  const { stage, label } = data;

  /**
   * Every response frame is one call we were billed for, including the failed
   * ones and including a chairman retry — "we paid for it, so we record it" is
   * the engine's rule and the footer says the same. Safe to add rather than
   * recompute because the hook has already dropped any frame id it has seen, so
   * no frame reaches this twice. `round_complete` overwrites the cost with the
   * engine's own total, which is authoritative.
   */
  next.totals = {
    ...next.totals,
    callCount: next.totals.callCount + 1,
    cost: next.totals.cost + Number(data.cost ?? 0),
  };

  if (stage === 'draft' || stage === 'rebuttal') {
    const items = next.stages[stage].items ?? [];
    const existing = items.findIndex((item) => item.label === label);

    const item = {
      key: `${stage}-${label}`,
      label,
      modelName: data.modelName,
      content: stage === 'draft' ? data.content : undefined,
      argument: stage === 'rebuttal' ? data.content : undefined,
      // A stance frame may already have arrived for this label; a retry of the
      // response must not wipe it.
      stance: existing >= 0 ? items[existing].stance : undefined,
      error,
      cost: data.cost ?? null,
      latencyMs: data.latencyMs ?? null,
    };

    next.stages[stage] = {
      ...next.stages[stage],
      state: STAGE_STATE.running,
      items: existing >= 0 ? items.map((old, i) => (i === existing ? { ...old, ...item } : old)) : [...items, item],
    };

    return next;
  }

  if (stage === 'verdict' || stage === 'final') {
    /**
     * The chairman's content is the canonical JSON the engine validated. It is
     * parsed rather than shown raw, and a failure here is the retried attempt
     * whose text would not parse — which is exactly the row we do not want to
     * overwrite the good one with, so a failure only sets `lastError`.
     */
    const current = next.stages[stage];

    if (error) {
      next.stages[stage] = { ...current, lastError: error, modelName: data.modelName ?? current.modelName };
      return next;
    }

    const parsed = safeParse(data.content);

    next.stages[stage] = {
      ...current,
      state: STAGE_STATE.done,
      modelName: data.modelName ?? current.modelName,
      raw: data.content ? prettyJson(data.content) : current.raw,
      ...(stage === 'verdict'
        ? {
            verdictType: parsed?.verdictType ?? current.verdictType,
            winnerLabels: parsed?.winnerLabels ?? current.winnerLabels ?? [],
            reasoning: parsed?.reasoning ?? current.reasoning ?? '',
            answer: parsed?.answer ?? current.answer,
          }
        : {
            answer: parsed?.finalAnswer ?? current.answer,
            openQuestions: parsed?.openQuestions ?? current.openQuestions ?? null,
          }),
    };

    return next;
  }

  return next;
}

function settleRunningStages(state, to = STAGE_STATE.done) {
  for (const key of STAGE_KEYS) {
    if (state.stages[key].state === STAGE_STATE.running) {
      state.stages[key] = { ...state.stages[key], state: to };
    }
  }
}

function safeParse(text) {
  if (typeof text !== 'string') return null;

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function prettyJson(text) {
  const parsed = safeParse(text);
  return parsed ? JSON.stringify(parsed, null, 2) : text;
}

function sentence(text) {
  if (!text) return null;

  const trimmed = String(text).trim();
  const capitalised = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);

  return /[.!?]$/.test(capitalised) ? capitalised : `${capitalised}.`;
}

/**
 * The starting point for a live round: what POST /rounds already told us, plus
 * the question the user typed. Everything else arrives as frames.
 */
export function liveRoundSeed({ roundId, prompt }) {
  return emptyRound({ id: roundId, prompt, status: 'running' });
}
