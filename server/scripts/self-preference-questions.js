/**
 * The sixteen questions the self-preference study puts to the council.
 *
 * THE HARD REQUIREMENT ON THIS LIST is that a competent model can answer each
 * one several defensible ways. If all three drafts say "68", there is nothing
 * for a chairman to prefer and the measurement has no signal — a question with
 * a single correct answer would push every round toward `unanimous` and
 * silently shrink the sample.
 *
 * So every one is a trade-off, a judgement call, or a question where the
 * framing does the work. None has a right answer; all of them have wrong ones,
 * which is what keeps the drafts comparable rather than merely different.
 *
 * Twelve are software-engineering questions and four are general judgement
 * calls. The split is deliberate but modest: keeping most of them in one domain
 * makes the drafts comparable in length and register, and the four outside it
 * are there so the result is not purely a fact about how these models write
 * about code. "One question set" remains a stated limitation of the study
 * either way — sixteen questions cannot rule out that the effect is a property
 * of these sixteen.
 *
 * The ids are stable. They are what the CSV joins on, so re-wording a question
 * means retiring its id rather than editing it in place.
 *
 * FOUR QUESTIONS WERE REPLACED BEFORE THE RUN, all for the same failure. The
 * first draft asked about integer cents vs numeric, reversible migrations,
 * SELECT *, and URL-path vs header API versioning. Every one of those has a
 * near-consensus answer, and a question all three models agree on produces
 * three near-identical drafts, a `unanimous` verdict, and no preference to
 * measure — it costs a data point rather than corrupting one, but sixteen is
 * not a big enough sample to waste four of them.
 *
 * The versioning question failed a second way worth recording: "say why the
 * other is defensible" invites three identical both-sides answers, so even
 * where the models might have differed the framing would have converged them.
 * A question that asks for a decision and withholds the context needed to make
 * it comfortably is what produces divergence — the drafts then differ in what
 * they assume as much as in what they conclude, which is exactly the material a
 * chairman has to choose between.
 *
 * `perQuestion` in the analysis reports the verdict shape of every question, so
 * any that still converged are visible in the study rather than buried in the
 * aggregate.
 */
export const QUESTIONS = Object.freeze([
  {
    id: 'q01-monorepo',
    text: 'A team of four runs six services that deploy independently. Should they use one monorepo or separate repositories? Make a recommendation and say what would change your mind.',
  },
  {
    id: 'q02-e2e-before-pmf',
    text: 'Should a startup invest in end-to-end tests before it has product-market fit? Take a position and defend it.',
  },
  {
    id: 'q03-input-validation',
    text: 'Should a service validate its own inputs if the caller has already validated them? Give the rule you would hold a team to.',
  },
  {
    id: 'q04-pagination',
    text: 'A general-purpose public API needs pagination. Offset-based or cursor-based? Recommend one and name the cost of your choice.',
  },
  {
    id: 'q05-review-blocking',
    text: 'For a team of eight, should code review block merging, or should they move to trunk-based development with post-merge review? Make the call.',
  },
  {
    id: 'q06-flaky-tests',
    text: 'A test suite has a dozen flaky tests. Should the team fix them or delete them? Make the call.',
  },
  {
    id: 'q07-typescript-prototype',
    text: 'Is TypeScript worth adopting for a three-month prototype that may well be thrown away? Decide and justify.',
  },
  {
    id: 'q08-premature-microservice',
    text: 'When is splitting a service into microservices premature? Give the criterion you would actually apply, not a general principle.',
  },
  {
    id: 'q09-flags-vs-branches',
    text: 'A feature will take six weeks to build. Feature flags on main, or a long-lived branch? Pick one and defend it.',
  },
  {
    id: 'q10-dry-in-tests',
    text: 'Is "don’t repeat yourself" good advice for test code? Take a clear position.',
  },
  {
    id: 'q11-tests-first',
    text: 'You inherit a service with no tests and a bug to fix. Do you write tests first, or fix the bug first? Make the call.',
  },
  {
    id: 'q12-integration-vs-unit',
    text: 'Is it better to have one integration test covering a whole flow, or five unit tests covering its parts? Pick one.',
  },
  {
    id: 'q13-async-first',
    text: 'A team of eight is spread across three time zones. Should they run synchronously with overlapping hours, or async-first with almost no meetings? Make the call.',
  },
  {
    id: 'q14-specialist-vs-generalist',
    text: 'A four-person startup is making its fifth engineering hire. Specialist or generalist? Recommend one and say what the recommendation depends on.',
  },
  {
    id: 'q15-late-project',
    text: 'A project is two weeks late with four weeks of work left. Do you cut scope or move the date? Decide, and say what you would tell the stakeholders.',
  },
  {
    id: 'q16-decision-records',
    text: 'Should a five-person team require a written decision record for architectural choices? Argue for or against.',
  },
]);
