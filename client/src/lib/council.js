/**
 * The council rules, restated for the browser.
 *
 * The server owns these — `planCouncil` in debateService.js is the authority and
 * re-checks every one of them — but a picker that lets a user assemble an
 * impossible council and then explains it with a 400 is a worse picker. So the
 * same three refusals are computed here, live, as toggles move: the Start button
 * is disabled with the reason beside it and the request is never made.
 *
 * The wording deliberately echoes the server's INSUFFICIENT_COUNCIL message, so
 * a user who somehow reaches the 400 anyway is not told two different things.
 * As with validation/authFields.js, this is a courtesy and never a control.
 */

/** §8 caps a council at 8 models — a round is up to 2N calls. */
export const MAX_COUNCIL = 8;

/**
 * Who actually drafts. The chairman abstaining is the default and the reason
 * the whole product works (LLMs favour their own output when judging), and it
 * is also the arithmetic every other number on the screen depends on.
 */
export function draftersOf({ selected, chairmanId, chairmanAbstains }) {
  return chairmanAbstains ? selected.filter((model) => model.id !== chairmanId) : selected;
}

/**
 * The refusal, or null when the council can debate. One string, because the
 * mockup has one line under the button — and because listing every problem at
 * once tells a user who has selected nothing that they also have no chairman.
 */
export function councilProblem({ selected, chairmanId, chairmanAbstains }) {
  if (selected.length === 0) return 'Toggle on the models you want to answer.';

  if (selected.length > MAX_COUNCIL) {
    return `A council holds at most ${MAX_COUNCIL} models.`;
  }

  if (!chairmanId || !selected.some((model) => model.id === chairmanId)) {
    return 'Nominate one of them as chairman.';
  }

  const drafters = draftersOf({ selected, chairmanId, chairmanAbstains });

  if (drafters.length < 2) {
    return chairmanAbstains
      ? 'A debate needs at least 3 models when the chairman abstains — it leaves ' +
          `${drafters.length} to draft. Add another, or let the chairman draft too.`
      : 'A debate needs at least 2 models when the chairman drafts.';
  }

  return null;
}

/**
 * The call breakdown the "THIS ROUND" panel shows, and it is what will actually
 * happen rather than the 2N ceiling: stage 3 does not run when rebuttals are
 * off. The other route into that skip — a verdict of `unanimous` — cannot be
 * known before the round, so this is the upper bound of what is left.
 */
export function roundPlan({ selected, chairmanId, chairmanAbstains, rebuttalEnabled }) {
  const chairman = selected.find((model) => model.id === chairmanId) ?? null;
  const drafters = draftersOf({ selected, chairmanId, chairmanAbstains });

  const stages = [
    { stage: 'draft', label: 'draft', count: drafters.length, models: drafters },
    { stage: 'verdict', label: 'verdict', count: chairman ? 1 : 0, models: chairman ? [chairman] : [] },
    {
      stage: 'rebuttal',
      // The only stage whose noun is plural in the mockup, and the only one that
      // can legitimately be 1.
      label: rebuttalEnabled && drafters.length === 1 ? 'rebuttal' : 'rebuttals',
      count: rebuttalEnabled ? drafters.length : 0,
      models: rebuttalEnabled ? drafters : [],
      skipped: !rebuttalEnabled,
    },
    { stage: 'final', label: 'final', count: chairman ? 1 : 0, models: chairman ? [chairman] : [] },
  ];

  return {
    chairman,
    drafters,
    stages,
    callCount: stages.reduce((total, entry) => total + entry.count, 0),
  };
}

/** The POST body shape: `{ modelIds, chairmanId }`, in the order shown. */
export function councilBody({ selected, chairmanId }) {
  return { modelIds: selected.map((model) => model.id), chairmanId };
}
