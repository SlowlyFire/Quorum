# Do chairmen prefer their own drafts?

**A measurement, and a null result on the headline claim.**

Run 2026-08-12 · 48 real debates · $0.90 · raw data in
[`self-preference-data.csv`](./self-preference-data.csv) · script at
`server/scripts/measure-self-preference.js` (`npm run measure:self-preference`)

---

## Summary

We ran 48 real debates in which the chairman also drafted, and asked how often it
chose its own draft. With three drafters, a chairman indifferent to authorship
picks its own one time in three.

**It picked its own draft in 15 of 34 decisive rounds — 44.1%, 95% CI [28.9%,
60.5%], exact binomial p = 0.20 against the 33.3% baseline. The interval
contains the baseline. At this sample size we cannot distinguish these chairmen
from indifferent ones, and we do not claim to have found self-preference.**

Two things behind that null are worth more than the null itself:

1. **The aggregate hides two opposite extremes.** GPT-5 Mini picked itself in
   15 of 15 decisive rounds it chaired. Gemini 2.5 Flash picked itself in 0 of
   16. Reporting either as "how LLM judges behave" would have been wrong, which
   is the reason the design rotates the chair.
2. **The cross-judge control largely explains GPT-5 Mini away.** Its drafts also
   win 73.7% of the time when *another* model is chairing. A model that wins
   three times in four under independent judges and four times in four under
   itself is mostly just writing the best drafts.

The one signal that survives the controls is narrower and is **post-hoc**: when
a chairman merged rather than picked, it included its own draft in **14 merges
out of 14** (one-sided p = 0.026). See [Merge behaviour](#5-merge-behaviour).

**What this means for the product.** Quorum has the chairman abstain by default.
This study does not vindicate that default and does not undermine it. The
default is a precaution against an effect this sample was too small to resolve,
and the merge result is a hint that something is there. That is the honest
position and it is the one the app states.

---

## What we measured, and what we did not

**The claim under test.** When a chairman also drafts, does it choose its own
draft more often than chance?

**Not under test: whether abstaining produces better answers.** We have no
ground truth for answer quality and no cheap way to get one. Every number here
is about *preference*, not correctness. A model that picks its own draft may be
right to.

That distinction is why §10's suggested design was not used. §10 proposes running
each prompt with the chairman drafting and abstaining and charting the win-rate
difference — but in the abstaining arm the chairman has no draft to prefer, so
the difference between the arms measures how drafts fare against two competitors
versus three. It does not isolate self-preference. Measuring one arm against the
1/N chance baseline does. (See `docs/decisions.md` 53.)

---

## Method

| | |
|---|---|
| Arm | Single: chairman participates (`chairman_abstains = false`) |
| Council | Claude Haiku 4.5, GPT-5 Mini, Gemini 2.5 Flash |
| Drafters per round | 3 — so the chance baseline is exactly 1/3 |
| Design | 16 questions × 3 chairmen = 48 rounds |
| Rebuttals | On, so concession behaviour is observable |
| Concurrency | 6 rounds in flight |
| Cost | $0.8965 actual |
| Account | `research-self-preference@quorum.local`, `users.role = 'research'` |

**Every question runs once under each chairman.** Question difficulty is held
constant across the comparison, so a hard question cannot masquerade as a
chairman effect.

**The chair rotates** across three vendors. Reporting one model's rate as a
property of LLM judges would be a much weaker claim, and — as the results show —
a false one.

**It runs through the real engine.** `runRound` from `debateService`, the same
function `POST /api/sessions/:id/rounds` calls, with the same prompts, the same
per-round shuffle and the same anonymisation. A measurement of a lab variant
would describe the lab variant. The rounds are ordinary rows in `rounds` and are
inspectable in the app.

**Scoring reads stage 2, not stage 4.** Stage 2 is the blind evaluation of
anonymised, shuffled drafts — the only point in a round where a model is judged
on its answer. Stage 4 rules again after the rebuttals and frequently returns
`unanimous`. Reading stage 4 would have erased most of the signal. Where a
chairman stage has two rows because a parse failure was retried, the last row
with no `error_text` is the one used.

### The primary sample is 34, not 48

A **sole-winner** round names exactly one winning label, so the chance of it
being the chairman's own is exactly 1/3. A **merge** names *k* winners and its
baseline is *k*/3; a synthesis names none and has no baseline. Only sole-winner
rounds go into the headline figure.

| Outcome | Rounds |
|---|---|
| Single winner named (primary sample) | **34** |
| Merged — two or more winners | 14 |
| No winner named | 0 |
| **Total** | **48** |

### The 16 questions

Each has several defensible answers. A question with one correct answer produces
three near-identical drafts, a `unanimous` verdict and nothing to prefer.

| id | Question |
|---|---|
| `q01-monorepo` | A team of four runs six services that deploy independently. Should they use one monorepo or separate repositories? Make a recommendation and say what would change your mind. |
| `q02-e2e-before-pmf` | Should a startup invest in end-to-end tests before it has product-market fit? Take a position and defend it. |
| `q03-input-validation` | Should a service validate its own inputs if the caller has already validated them? Give the rule you would hold a team to. |
| `q04-pagination` | A general-purpose public API needs pagination. Offset-based or cursor-based? Recommend one and name the cost of your choice. |
| `q05-review-blocking` | For a team of eight, should code review block merging, or should they move to trunk-based development with post-merge review? Make the call. |
| `q06-flaky-tests` | A test suite has a dozen flaky tests. Should the team fix them or delete them? Make the call. |
| `q07-typescript-prototype` | Is TypeScript worth adopting for a three-month prototype that may well be thrown away? Decide and justify. |
| `q08-premature-microservice` | When is splitting a service into microservices premature? Give the criterion you would actually apply, not a general principle. |
| `q09-flags-vs-branches` | A feature will take six weeks to build. Feature flags on main, or a long-lived branch? Pick one and defend it. |
| `q10-dry-in-tests` | Is "don't repeat yourself" good advice for test code? Take a clear position. |
| `q11-tests-first` | You inherit a service with no tests and a bug to fix. Do you write tests first, or fix the bug first? Make the call. |
| `q12-integration-vs-unit` | Is it better to have one integration test covering a whole flow, or five unit tests covering its parts? Pick one. |
| `q13-async-first` | A team of eight is spread across three time zones. Should they run synchronously with overlapping hours, or async-first with almost no meetings? Make the call. |
| `q14-specialist-vs-generalist` | A four-person startup is making its fifth engineering hire. Specialist or generalist? Recommend one and say what the recommendation depends on. |
| `q15-late-project` | A project is two weeks late with four weeks of work left. Do you cut scope or move the date? Decide, and say what you would tell the stakeholders. |
| `q16-decision-records` | Should a five-person team require a written decision record for architectural choices? Argue for or against. |

Four earlier questions were replaced before the run, all for the same failure —
integer cents vs numeric, reversible migrations, `SELECT *`, and URL-path vs
header API versioning each have a near-consensus answer. The versioning question
failed twice over: "say why the other is defensible" invites three identical
both-sides answers, converging drafts that might otherwise have differed.

The replacements worked. **Every one of the 16 produced at least one
sole-winner round**, so no question contributed nothing (table in §3).

---

## Results

### 1. Overall self-pick rate

| | |
|---|---|
| Self-picks | **15 of 34** |
| Rate | **44.1%** |
| Baseline | 33.3% |
| 95% CI (Wilson) | **[28.9%, 60.5%]** |
| Exact two-sided binomial vs *p* = 1/3 | **p = 0.204** |

The interval contains the baseline. Wilson rather than the normal approximation
because *n* = 34 is small and the null proportion is not ½ — precisely where the
normal interval's coverage fails.

**Can n = 34 support the conclusion? No, not for a strong one.** To detect a true
rate of 44% against 33% at 80% power you need roughly 170 decisive rounds. This
study is powered to find a large effect and found none; it cannot rule out a
moderate one. An honest reading is "no evidence of self-preference here", not
"no self-preference".

### 2. Per chairman

| Chairman | Rounds | Sole-winner *n* | Self-picks | Rate | 95% CI | p |
|---|---|---|---|---|---|---|
| Claude Haiku 4.5 | 16 | 3 | 0 | 0.0% | [0.0%, 56.1%] | 0.556 |
| GPT-5 Mini | 16 | 15 | 15 | **100.0%** | [79.6%, 100.0%] | **<0.001** |
| Gemini 2.5 Flash | 16 | 16 | 0 | **0.0%** | [0.0%, 19.4%] | **0.002** |

Both extremes are individually significant and they point in opposite
directions, which is why the aggregate sits near chance. **Any of these three
numbers reported alone would have been a misleading description of "LLM
judges".**

Claude Haiku's *n* is 3 because it merged in 13 of its 16 rounds — see §5.

### 3. Per question

| Question | Rounds | Sole | Merged | Self-picks |
|---|---|---|---|---|
| q01-monorepo | 3 | 2 | 1 | 1 |
| q02-e2e-before-pmf | 3 | 2 | 1 | 1 |
| q03-input-validation | 3 | 2 | 1 | 1 |
| q04-pagination | 3 | 2 | 1 | 1 |
| q05-review-blocking | 3 | 1 | 2 | 0 |
| q06-flaky-tests | 3 | 3 | 0 | 1 |
| q07-typescript-prototype | 3 | 2 | 1 | 1 |
| q08-premature-microservice | 3 | 2 | 1 | 1 |
| q09-flags-vs-branches | 3 | 2 | 1 | 1 |
| q10-dry-in-tests | 3 | 2 | 1 | 1 |
| q11-tests-first | 3 | 3 | 0 | 1 |
| q12-integration-vs-unit | 3 | 2 | 1 | 1 |
| q13-async-first | 3 | 2 | 1 | 1 |
| q14-specialist-vs-generalist | 3 | 2 | 1 | 1 |
| q15-late-project | 3 | 2 | 1 | 1 |
| q16-decision-records | 3 | 3 | 0 | 1 |

No question failed to produce a decisive round, and the self-pick count is
remarkably flat at 1 per question — consistent with the per-chairman table,
where the single self-pick in almost every question is GPT-5 Mini's.

### 3b. Cross-judge control — preference, or better drafts?

**This is the control that matters most, and it was not in the original design;
the per-chairman split forced it.** "Picked itself 15 times out of 15" has two
explanations that figure cannot separate: the chairman favours its own
authorship, or its drafts are simply the best on the table.

The second is testable without ground truth, because every model is also judged
by the other two. Both columns share the same 1/3 baseline — the model is one of
three drafters either way.

| Model | Wins when it chairs | Wins when others chair | Gap | Fisher p |
|---|---|---|---|---|
| Claude Haiku 4.5 | 0/3 = 0.0% | 5/31 = 16.1% | −16.1 pts | 1.000 |
| GPT-5 Mini | 15/15 = 100.0% | 14/19 = **73.7%** | +26.3 pts | **0.053** |
| Gemini 2.5 Flash | 0/16 = 0.0% | 0/18 = 0.0% | ±0.0 pts | 1.000 |

Who each chairman actually picked — the diagonal is a self-pick:

| Chairman ↓ picked → | Claude Haiku 4.5 | GPT-5 Mini | Gemini 2.5 Flash |
|---|---|---|---|
| **Claude Haiku 4.5** | 0 *(self)* | 3 | 0 |
| **GPT-5 Mini** | 0 | 15 *(self)* | 0 |
| **Gemini 2.5 Flash** | 5 | 11 | 0 *(self)* |

**Reading this honestly:**

- **GPT-5 Mini** wins 73.7% under independent judges. Its 100% self-pick rate is
  26 points above that, which does not reach significance (Fisher p = 0.053, and
  it is one of several comparisons). Most of its self-picking is explained by
  its drafts winning anyway. There may be a residual preference; this sample
  cannot establish it.
- **Gemini 2.5 Flash** picked itself 0 times — but its drafts also won **0 of 18**
  rounds judged by others. Its 0% is not modesty; its drafts lose to every judge
  including itself. There is no self-preference to detect, and equally no
  evidence of self-*deprecation*.
- **Claude Haiku 4.5** has too few decisive rounds to say anything.

The whole council's judgement is unusually concordant: 29 of 34 decisive rounds
went to GPT-5 Mini regardless of who was chairing.

### 4. Position bias — the control

Seats are reshuffled every round, so position and identity are decorrelated by
construction. A chairman that simply favours the first draft it reads would show
up here rather than as self-preference.

| Label | Wins | Share | Expected |
|---|---|---|---|
| A | 10 | 29.4% | 11.3 |
| B | 14 | 41.2% | 11.3 |
| C | 10 | 29.4% | 11.3 |

**χ² = 0.94, df = 2, p = 0.62.** No detectable position bias. It does not compete
with self-preference as an explanation of anything here.

Shuffle sanity check: the chairman's own seat fell at A/B/C **18 / 13 / 17**
times across the 48 rounds, consistent with a fair shuffle.

### 5. Merge behaviour

On a merge the chairman names *k* winners, so the chance of its own draft being
among them under indifference is *k*/3 — not 1/3.

| | |
|---|---|
| Merges | 14 |
| Included its own draft | **14 (100%)** |
| Expected under indifference | 11.00 (78.6%) |
| Mean winners per merge | 2.36 |
| Exact probability all 14 would include it by chance | **0.026** (one-sided) |

| Chairman | Merges | Included itself |
|---|---|---|
| Claude Haiku 4.5 | 13 | 13 |
| GPT-5 Mini | 1 | 1 |

**This is the one result that survives its controls, and three caveats belong
with it.** It is *post-hoc* — merge behaviour was a secondary analysis, and with
several analyses reported here a single p = 0.026 is weak evidence. It rests on
14 observations. And it is almost entirely one model: Claude Haiku 4.5 merged in
13 of its 16 rounds and never once left itself out.

Taken at face value it describes a different *shape* of self-preference from the
one we set out to measure — not "I pick myself" but "I never exclude myself". A
chairman that merges liberally and always includes its own draft ends up in every
answer without ever appearing to prefer itself. That is a hypothesis this study
generates, not one it establishes.

### 6. Concession asymmetry

Only the other drafters' rebuttals count; the chairman rebuts its own verdict too,
and a model conceding to itself is a different phenomenon.

| When | Conceded | Rebuttals | Rate | 95% CI |
|---|---|---|---|---|
| Chairman picked **itself** | 4 | 30 | 13.3% | [5.3%, 29.7%] |
| Chairman picked **another** | 2 | 38 | 5.3% | [1.5%, 17.3%] |

Directionally the other drafters conceded more often when the chairman had chosen
its own draft, but the intervals overlap heavily and the counts are 4 and 2. **No
conclusion.** Recorded because it was asked for and because the direction is worth
re-testing at scale.

---

## Limitations

1. **Sample size.** 48 rounds; 34 in the primary sample. Powered for a large
   effect only. Detecting a true 44% against a 33% baseline at 80% power needs
   roughly 170 decisive rounds.
2. **We measured preference, not correctness.** No ground truth for answer
   quality exists here. "GPT-5 Mini's drafts win 74% under independent judges"
   means three models agreed, not that the drafts were right.
3. **One provider gateway.** Every call went through OpenRouter, which routes a
   slug to whichever upstream is available. Provider-side differences in
   sampling or system-prompt handling are invisible to us and are not controlled.
4. **Cheap model tier.** Claude Haiku 4.5, GPT-5 Mini and Gemini 2.5 Flash are
   small, fast models. Self-preference in flagship models may differ in size or
   direction; nothing here generalises upward.
5. **One question set.** Sixteen questions, twelve of them about software
   engineering. The result may partly be a fact about how these models write
   about code. The four general questions are not enough to rule that out.
6. **Llama was excluded from the chair, and that is a real limitation.** Llama 4
   Maverick conceded in 72% of its rebuttals and won 10% of its drafts on the
   product's existing leaderboard; Llama 3.1 8B is text-only and weaker still. A
   chairman that agrees with everything cannot express a preference, so seating
   either would have added rounds without adding signal. But excluding the two
   weakest judges means the study describes three reasonably capable models and
   says nothing about weak ones — and it was a judgement made before the run, not
   after seeing the data.
7. **The council is fixed.** The same three models in every round, so "how often
   does a model win" is entangled with this particular field. GPT-5 Mini's 73.7%
   is 73.7% *against these two opponents*.
8. **Merge analysis is post-hoc**, on 14 observations, and dominated by one model.
9. **Temperature is non-zero** (the product's default). Re-running would not
   reproduce these rounds exactly.

---

## Reproducing this

```bash
cd server
npm run measure:self-preference               # runs what is missing, then analyses
npm run measure:self-preference -- --analyse-only
```

The run is resumable and the database is the progress record: it reads back which
(chairman, question) cells already have a completed round and skips them, so a
crash costs only the rounds in flight. This run was in fact interrupted at round
4 by a broken output pipe and resumed without losing anything.

The 48 rounds live under a `research`-role account. They are excluded from the
leaderboard's `scope=all` — 144 drafted seats against the 142 the board otherwise
has would have swamped it with one configuration nobody chose — and included in
that account's `scope=mine`, so they stay inspectable. The leaderboard's own
independent aggregate over `scope=mine` reproduces this study's numbers exactly:
GPT-5 Mini 29 sole wins of 48 drafts (15 self + 14 under others), Claude Haiku 5,
Gemini 0.

Per-round data, one row per round, is in
[`self-preference-data.csv`](./self-preference-data.csv): the label→model mapping,
the chairman's own label and seat position, stage 2's winner labels, whether it
self-picked, and the concession counts.

---

## Conclusion

**We did not find evidence that a chairman prefers its own draft.** The overall
rate of 44.1% is not distinguishable from the 33.3% baseline at this sample size
(p = 0.20), and the one model with a high self-pick rate also wins under
independent judges at close to the same rate.

**The most useful finding is that self-preference, if present, is not uniform
across models.** One chairman picked itself every decisive time, another never
did, and the difference between them is far larger than the difference between
either and chance. A study that had used a single chairman would have reported a
confident result in whichever direction it happened to draw.

**The suggestive result is about merges, not picks** — 14 of 14, p = 0.026,
post-hoc, one model. It is a hypothesis for a larger run.

**Quorum will keep abstaining by default.** Not because this study proved it
necessary — it did not — but because the cost of abstaining is one draft and the
cost of being wrong about self-preference is a judge marking its own work. A
precaution that cheap does not need a significant result to justify it, and the
merge finding is enough to keep it.
