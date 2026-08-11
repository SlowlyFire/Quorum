# Decisions — deviations from the approved spec

`docs/quorum-product-document.md` is **frozen as the approved v1.0**. It is never edited.
When the build departs from it, the departure is recorded here instead — what the spec said,
what we did, and why.

One entry per change, newest section last. If a decision is later reversed, add a new entry
rather than deleting the old one.

---

## Session 1 — 2026-08-11 (scaffolding)

### 1. No `models/` layer; services own the SQL

**Spec (§8):** "Express, MVC (`routes → controllers → services → models`)."

**What we did:** Four directories — `routes/`, `controllers/`, `services/`, `db/` — with no
`models/` layer. Services write SQL directly and call `db/pool.js`.

**Why:** With plain SQL and no ORM, a `models/` layer would be a thin pass-through wrapping each
query in a function that only its own service calls. The invariant the spec is protecting is
"nothing outside the service layer touches the database", and that holds as stated: controllers,
routes and middleware never import `db/pool.js`. Revisit if a table ends up queried by three or
more services and the SQL starts being copy-pasted.

### 2. Feature secrets are optional in development, required in production

**Spec:** silent — this is an implementation detail, recorded because it softens the session
instruction that `config/env.js` "throws on missing".

**What we did:** `PORT`, `NODE_ENV` and `CLIENT_URL` have sane development defaults.
`DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `OPENROUTER_API_KEY` and `JWT_SECRET` are
optional when `NODE_ENV !== 'production'` and **required — the process throws — when
`NODE_ENV=production`**. Empty values are treated as absent, so a copied `.env.example` does not
pass as configured.

**Why:** No code path uses those five secrets yet. Requiring all of them unconditionally would
mean the API cannot boot on a fresh clone until someone provisions Supabase, OpenRouter and a JWT
secret — which contradicts a scaffolding session that must start clean with none of them. Making
them mandatory in production keeps the real guarantee: a deployment cannot start half-configured.
As each feature lands, move its key into the always-required block in `server/src/config/env.js`.

### 3. `GET /api/health/db` reports a missing `DATABASE_URL` distinctly

**Spec:** silent (health endpoints are not in the spec's endpoint tables).

**What we did:** With no `DATABASE_URL`, the endpoint returns 503 with code
`DATABASE_NOT_CONFIGURED` rather than attempting a connection that would fail against localhost
with a misleading message. A configured-but-unreachable database returns 503
`DATABASE_UNAVAILABLE`. Both go through `errorHandler`.

**Why:** Follows from decision 2, and it keeps the two failure modes — "not set up yet" versus
"database is down" — distinguishable during the build.

---

## Session 2 — 2026-08-11 (schema, migrations, model catalogue)

### 4. Reversal of decision 1 — the `models/` layer is added after all

**Spec (§8):** "Express, MVC (`routes → controllers → services → models`)."

**Session 1 decided:** no `models/` layer; services write SQL directly.

**What we did now:** created `server/src/models/` and moved every line of SQL into it. The rule is
narrower than "DB access goes through a service" and easier to check: **only files in
`src/models/` may contain SQL.** Services call models and never import `db/pool.js`. The one
exception is `src/db/migrate.js`, which executes migration files rather than querying application
tables.

`healthService` was refactored the same day it stopped being the only service — its `SELECT now()`
moved to `models/healthModel.js`, so the rule holds with no grandfathered exception.

**Why the reversal:** the spec names the layer explicitly and "Express MVC Architecture" is a hard
bootcamp requirement, so the layer has to exist regardless of whether a thin pass-through is
justified on its own merits. Session 1's counter-argument — that each query would be called by
exactly one service — also weakens as the schema lands: `rounds` is read by the debate engine, the
free-tier check and the leaderboard; `models` by the catalogue endpoint, the pre-flight cost
estimate and the debate engine. That is the "three or more services" condition decision 1 named as
the trigger to revisit, and the schema makes it visible before the duplication happens rather than
after.

**Consequence:** the CLAUDE.md convention "All DB access goes through a service" is replaced by
"Only `src/models/` contains SQL".

### 5. `rounds.user_id` is denormalised from `sessions`

**Spec (§7):** the ERD gives `rounds` a `session_id` FK only. `user_id` is reachable as
`rounds → sessions → users`.

**What we did:** added `rounds.user_id`, a NOT NULL FK to `users`, `ON DELETE CASCADE`, indexed
together with `created_at` as `(user_id, created_at)`.

**Why:** §3 makes the free-tier allowance "a query against `rounds`, not a stored counter", and
that query — count a user's rounds so far in the current UTC day — runs before every single
debate. Through `sessions` it is a join on the hottest path in the product. The denormalisation
costs one uuid per round and cannot drift: a round's session never changes owner, because
`sessions.user_id` is immutable in every endpoint in §8.

### 6. `round_models.role` takes three values, not two

**Spec (§7):** the ERD types `round_models.role` as `text`. The enumerated-values table lists
`users.role`, `rounds.verdict_type`, `rounds.status`, `model_responses.stage`,
`model_responses.stance` and `credit_transactions.type` — but not this column.

**What we did:** `CHECK (role IN ('drafter', 'chairman', 'both'))`.

**Why:** the table's primary key is `(round_id, model_id)`, so a model appears at most once per
round. When `chairman_abstains` is false — a user-facing toggle in §2, kept so the
self-preference effect can be observed — the chairman drafts as well as judges, and there is no
second row available to say so. `'both'` is what makes that line-up representable at all.

**How to query it, always:** drafting is `role IN ('drafter', 'both')`; judging is
`role IN ('chairman', 'both')`. A bare `role = 'drafter'` silently drops every round in which the
chairman also drafted, which is precisely the population the leaderboard's win-rate denominator
("rounds drafted, excluding rounds served as chairman") is measuring. Recorded in the CLAUDE.md
conventions for the same reason.

### 7. `attachments.round_id` is nullable

**Spec (§7, §8):** the ERD shows `attachments.round_id` as an FK to `rounds`. §8 has
`POST /api/attachments` upload the file and return a signed URL, and
`POST /api/sessions/:id/rounds` create the round afterwards.

**What we did:** left `round_id` nullable, still `ON DELETE CASCADE`.

**Why:** the two endpoints run in that order, so between them the attachment exists and its round
does not. NOT NULL would make the documented upload flow impossible. Deleting a round still takes
its attachments with it; rows never claimed by a round stay null and are a housekeeping concern,
not a correctness one.

### 8. `model_id` foreign keys are `ON DELETE RESTRICT`

**Spec:** silent on delete behaviour for `models`.

**What we did:** every FK to `models` — from `preset_models`, `rounds.chairman_model_id`,
`round_models` and `model_responses` — is `ON DELETE RESTRICT`. Only the `users → sessions →
rounds → model_responses/attachments` chain cascades.

**Why:** `models` carries `is_active` precisely so a model is retired rather than deleted. Deleting
a row would otherwise erase the identity of every draft it ever wrote, taking the leaderboard and
the wallet ledger's line items with it. RESTRICT turns that into an error instead of silent data
loss.

### 9. The spec says "nine tables"; the ERD contains ten

**Spec (§7):** "See `quorum-06-db-diagram.png`. **Nine tables** in four groups". The diagram's own
subtitle also reads "PostgreSQL · 9 tables".

**What is actually there:** ten table boxes — `users`, `models`, `presets`, `preset_models`,
`sessions`, `rounds`, `round_models`, `model_responses`, `attachments`, `credit_transactions`.

**What we did:** built all ten. Nothing was dropped to reach nine.

**Why:** every one of the ten is load-bearing for a §4 use case, and the enumerated-values table in
the same section constrains columns on tables that the count of nine cannot accommodate. The
count is an erratum in the frozen document, not an instruction. Recorded here rather than fixed
there, since the product document is never edited.

**Note for verification:** `\dt` therefore shows **eleven** relations — the ten above plus
`_migrations`.

---

## Session 3 — 2026-08-11 (authentication and authorization)

### 10. Google OAuth is deferred, not dropped

**Spec (§3, §8, §9):** "Authentication is email + password *and* Google OAuth". §8 lists
`GET /api/auth/google` and `GET /api/auth/google/callback`.

**What we did:** built email + password only. The two Google routes are not mounted.

**Why:** OAuth is sign-in *convenience*. Everything the project is actually assessed on —
credential handling, session issuance, and the authorization layer — is exercised in full by the
password path, and none of it changes when a second identity provider is added. The cost of
building it tonight is a Google Cloud project, a second credential in `.env`, and redirect URIs
that have to be re-registered for every environment the app is ever deployed to. That is
configuration work with no new logic behind it, spent on the session that has the most logic in it.

**Deferred, not dropped — what is already in place for it:**

- `users.google_id`, unique and nullable, with `users_credential_present` allowing a Google-only
  account (`password_hash IS NULL`).
- `userModel.findUserByGoogleId` and `userModel.attachGoogleId` — the latter exists precisely so
  signing in with Google under an email that already has a password account links the two rather
  than failing on the unique constraint.
- `tokenService` is provider-agnostic: it signs `{ userId, role }` and knows nothing about how the
  user was identified. The callback route issues a session with the same `sign()` the password
  path uses.
- `cookieOptions.sameSite` is `'lax'` rather than `'strict'` specifically so the cookie survives
  the top-level GET navigation back from Google's consent screen.

Adding it later is a route file, a service that exchanges the code for a profile, and one env key.
No schema change, no change to any existing endpoint.

**Consequence to note:** §11 lists Google OAuth as part of the mitigation for "free tier abused by
repeat sign-ups", on the grounds that it raises the cost of creating throwaway accounts. Without
it, the only friction on mass sign-up is the new rate limiter on `POST /api/auth/register`
(10 per IP per 15 minutes). At demo scale that is adequate; it is the thing to strengthen first if
the free tier is ever actually abused.

### 11. `DATABASE_URL` and `JWT_SECRET` are required unconditionally

**Spec:** silent. This supersedes part of decision 2.

**Decision 2 said:** the five feature secrets are optional in development and required in
production, and each moves into the always-required block "in the session that starts using it".

**What we did now:** `DATABASE_URL` and `JWT_SECRET` are required in every environment — the
process refuses to boot without them. `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` and
`OPENROUTER_API_KEY` stay production-only, because still nothing reads them.

**Why:** this is decision 2 working as designed, not a reversal of it. Both keys are now on the
path of essentially every request — the models layer opens a pool from one, `requireAuth` verifies
a signature with the other. Left optional, a missing key is not an absent feature; it is a
`ReferenceError`-shaped 500 at the first request that happens to need it, which is a worse failure
than refusing to start.

**Additionally:** `JWT_SECRET` must be at least 32 characters when `NODE_ENV=production`. An HS256
key shorter than the 256-bit digest it authenticates weakens the MAC, and a JWT secret is exactly
the key people are tempted to type by hand. Development is left alone so the check cannot block
local work.

**Consequence — decision 3 is partly retired.** `GET /api/health/db` returned 503
`DATABASE_NOT_CONFIGURED` when `DATABASE_URL` was unset. That state is now unreachable, so the
branch is deleted rather than left as dead code that documents an impossible condition. A missing
connection string fails the process; a present-but-unreachable database still returns 503
`DATABASE_UNAVAILABLE`, which was the half of decision 3 that was actually about health.

### 12. The error envelope gains an optional `details` array

**Spec (§8):** "All responses pass through unified error-handling middleware." The shape this
project settled on is `{ error: { message, code } }`.

**What we did:** a 400 `VALIDATION_ERROR` may additionally carry
`error.details: [{ in, field, message }]`, one entry per failing field.

```json
{"error":{"message":"Request validation failed","code":"VALIDATION_ERROR",
  "details":[{"in":"body","field":"password","message":"must be at least 8 characters"}]}}
```

**Why:** a registration form needs to know *which* field is wrong, and a single sentence cannot
say so for three simultaneous failures. `in` distinguishes a `body.id` from a `params.id`.

**Why it is safe:** `details` is set in exactly one place — the `validate()` middleware, from Zod's
own issue list — and `errorHandler` emits it only for statuses below 500. An unexpected server
error can never carry a payload out, which is the same reasoning that already suppresses its
message in production.

**Invariant preserved:** `message` and `code` are still always present, so a client that ignores
`details` behaves exactly as before.

### 13. `bcryptjs` rather than `bcrypt`

**Spec (§9):** "bcrypt password hashing."

**What we did:** the `bcryptjs` package, at cost 10. Same algorithm, same `$2b$` output format,
verifiable by either library.

**Why:** `bcrypt` is a native addon and needs node-gyp and a compiler at install time. That is a
build failure waiting for the first machine or deploy image whose toolchain differs — and Render
builds from a clean container. `bcryptjs` is pure JavaScript and installs everywhere. It is
slower, which at cost 10 means roughly 70ms per hash instead of roughly 20ms; login is not a hot
path, and a login that costs an attacker more is the direction we want to be wrong in.

**Known limitation, inherent to bcrypt itself and not to this choice:** bcrypt hashes the first 72
bytes of a password and silently ignores the rest. The schema permits 200 characters, so a
password longer than 72 bytes is accepted and stored, but only its first 72 bytes authenticate it.
Everything past that is decoration. Recorded rather than worked around: pre-hashing with SHA-256
to lift the ceiling is a real technique, but it is a non-standard hash format that no future
migration tool would recognise, in exchange for strength beyond 72 bytes that nobody's password has.

---

## Session 4 — 2026-08-11 (OpenRouter integration and the prompt loader)

### 14. `OPENROUTER_API_KEY` is required unconditionally

**Spec:** silent. This is decision 2 continuing to work as designed, as decision 11 was.

**What we did:** moved `OPENROUTER_API_KEY` out of the production-only block and into the
always-required one. `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` are now the only two left there,
because Storage is still unused.

**Why:** every LLM call in the product goes through one header built from this key. Left optional,
a missing key is not a degraded feature — it is `Bearer undefined` and a 401 from OpenRouter,
mapped to a 502, surfacing as a debate that fails halfway through and has already spent money on
the drafts that succeeded. Refusing to boot is both earlier and cheaper.

### 15. OpenRouter's status codes are not passed through

**Spec:** silent on error mapping.

**What we did:** provider failures map to our own statuses, and two of them deliberately do not
match the provider's:

| OpenRouter | Ours | Code |
|---|---|---|
| 400 | 502 | `OPENROUTER_BAD_REQUEST` |
| 401 / 403 | 502 | `OPENROUTER_AUTH` |
| 402 | 503 | `OPENROUTER_INSUFFICIENT_CREDIT` |
| 404 | 502 | `OPENROUTER_BAD_REQUEST` |
| 429 | 429 | `OPENROUTER_RATE_LIMIT` |
| 5xx, network failure | 502 | `OPENROUTER_UNAVAILABLE` |
| (no response in 90s) | 504 | `OPENROUTER_TIMEOUT` |

**Why the two that differ:**

- **401 must not become 401.** Ours means the `quorum_token` cookie is bad and the client's correct
  response is to send the user to the login page. OpenRouter's means *our* key is wrong, which no
  amount of signing in again will fix. Passing it through would log every user out during a
  key rotation.
- **402 must not become 402.** Ours will mean the user's wallet is empty — a state with a remedy,
  a top-up. OpenRouter's means the platform's own account is out of credit, which is an outage. The
  wallet lands in Session 8 and needs 402 to mean exactly one thing.

**Also:** the message on every one of these is fixed text. `errorHandler` only suppresses the
message of a 500 in production, so a 502 carrying the provider's own words would ship them to the
client — and OpenRouter's 402 message quotes our account balance. The provider's text is attached
as `error.providerMessage` instead, which nothing emits.

### 16. `usage.cost` is authoritative; the `models` table is only an estimate

**Spec (§9):** "Usage accounting is automatic: token counts and the actual cost come back in the
response body with no extra parameters, and that is what we debit."

**What we did:** exactly that — and this entry records *why* the fallback must stay a fallback.

**What verification found:** the same slug, at the same token count, came back at three different
prices on consecutive runs — `meta-llama/llama-4-maverick` served by Parasail at $0.0000107, by
Google at $0.0000115 and by DeepInfra at $0.0000060. OpenRouter routes a model to whichever
upstream is available and bills that upstream's price. `models.input_per_1k` holds one number per
model, so it cannot be right for every route by construction.

**Consequence:** the `models` table prices are for the pre-flight estimate §11 calls for, and for
the fallback when `usage.cost` is missing. The wallet debits `usage.cost` and nothing else. The
verification script's cost comparison is deliberately an order-of-magnitude check rather than an
equality assertion, and must not be tightened into one.

### 17. Retries are limited to 429 and 5xx, and never cover a timeout

**Spec (§11):** "One provider times out or errors → `allSettled`, not `all`."

**What we did:** one retry, after a 2s backoff, on 429 and 5xx only. 400, 401, 402 and 404 fail
immediately. A timeout is **not** retried either, which the session brief left open.

**Why not retry a timeout:** the ceiling is 90 seconds. A retried timeout makes one stalled model
cost the user three minutes before the round can continue without it — and stages 1 and 3 run
under `Promise.allSettled`, so the round is already waiting on the slowest member. Failing at 90s
and continuing with the models that answered is the behaviour §11 asks for.

**Why not retry a network failure:** an inference call whose connection dropped may already have
been billed. Charging twice for an answer received zero times is worse than reporting the failure.

---

## Session 5 — 2026-08-11 (the four-stage debate engine)

### 18. `prompts/` and §7 use different tenses; the engine normalises at the boundary

**Spec (§7):** `rounds.verdict_type` is one of `picked`, `merged`, `synthesised`, `unanimous`.

**`prompts/02-verdict.md` and `04-final.md`:** the chairman is asked for
`"verdict_type": "pick" | "merge" | "synthesise" | "unanimous"`.

**Both files are frozen** — the product document is never edited, and the prompt templates are
read-only to the server. So "write the chairman's `verdict_type` to the column" cannot be done
literally: the CHECK constraint would reject every round.

**What we did:** one exported map in `debateService.js`, and it is the only place the two
vocabularies meet.

```js
export const VERDICT_TYPE_MAP = Object.freeze({
  pick: 'picked', merge: 'merged', synthesise: 'synthesised', unanimous: 'unanimous',
});
```

Normalisation happens the moment the chairman's JSON is parsed. Everything downstream — the
`verdict` and `round_complete` events, `runRound`'s return value, the column, and the text
interpolated into `{{VERDICT_TYPE}}` for stage 3 — speaks §7's vocabulary. **The four templates are
the models' vocabulary and §7 is the system's**, and nothing carries the models' words past the
parse.

**Aliases, accepted but never silently.** `synthesize` and `synthesized` are accepted because models
produce the American spelling regardless of what the prompt asks for, and the four past-tense forms
are accepted in case a model echoes §7's own wording back. Normalising anything that is not already
a canonical key **logs a warning with the raw value**: if that fires often, the template needs
tightening and it should not be absorbed silently.

**A word that is in neither map is not guessed at.** It raises `MODEL_JSON_INVALID` and takes the
same retry-once path as unparseable JSON, because guessing at the nearest match is how a `merge`
verdict gets recorded as a `pick`.

### 19. Stage 3 is skipped when the verdict is unanimous

**Spec (§2):** the round table gives stage 3 as N−1 calls, unconditionally. `CLAUDE.md` states the
invariant as "Total per round: **2N calls**".

**What we did:** stage 3 is skipped, and a `stage_skipped` event is emitted, when the chairman's
verdict is `unanimous` — or when `rebuttal_enabled` is false for the session, which the schema has
allowed for since migration 001.

**Why:** a unanimous verdict is the chairman saying the drafts agree substantively and the
differences are cosmetic. There is nothing to defend, revise or concede, so the stage costs N−1
calls and a third of the round's latency to produce arguments about nothing. Measured on the
verification runs, the skip takes a 3-model round from 6 calls to 4.

**Consequence:** "2N calls" is now the ceiling, not the count. A round costs 2N calls, or N+2 when
stage 3 is skipped. The `rounds` table records the verdict that caused a skip but **not** the fact
of the skip itself — see the build log's unfinished list.

### 20. `rounds.verdict_type` is written twice

**Spec:** silent. §2 has the chairman "rule on the rebuttals" in stage 4.

**What we did:** stage 2 writes the verdict it reached as soon as it reaches it, and stage 4
overwrites it with the chairman's final ruling.

**Why:** stage 4's value is the authoritative one — the chairman may reverse itself on a good
defence, and that reversal is the entire purpose of the stage, so the column must come from stage 4.
But a round that dies in stage 3 or 4 has still reached a verdict, and a `failed` row showing
`picked` is far easier to explain than one showing `null` next to two `model_responses` rows that
plainly contain a verdict.

**Observed, and worth knowing before reading the data:** the chairman frequently returns
`unanimous` in stage 4 after a non-unanimous stage-2 verdict — three of five verification rounds
did, once every drafter had conceded. It is a defensible reading of "the council now agrees", but it
means **`rounds.verdict_type` is not a reliable record of what stage 2 decided**. Whoever builds the
leaderboard should take the win from stage 2's `winner_labels` inside `model_responses.content`,
not from this column. Fixing it means editing `04-final.md`, which is exactly what
`rounds.prompt_version` now exists to track.

### 21. A 200 with `finish_reason: 'error'` is a failed call

**Spec:** silent. This amends Session 4's `callModel` contract.

**What Session 4 did:** returned whatever the body contained whenever the HTTP status was 2xx.

**What we found:** `google/gemini-2.5-flash` answers **HTTP 200** with `finish_reason: 'error'`,
zero tokens, zero cost and empty content when the upstream it routed to falls over — four times
across today's verification runs, after 3 to 20 seconds. Returned as a success, `callModel` handed
back `content: ''`, and the debate engine counted it toward its two-draft quorum and would have sent
the chairman a headed but empty `### Response A`.

**What we did now:** `callModel` throws `OPENROUTER_UNAVAILABLE` when `finish_reason` is `error` or
the content is empty after trimming. Whatever the provider reported — tokens, cost, latency,
upstream name — is attached to the error as `error.usage`, and the engine writes those figures onto
the `model_responses` failure row. A call that failed after being billed is still billed.

**Why an empty completion is a failure and not an edge case:** every stage of the product needs
text. There is no caller for whom `content: ''` is a usable answer, so making each of them infer
failure from an empty string is strictly worse than one guard at the boundary.

---

## Session 6 — 2026-08-11 (the HTTP surface and SSE)

### 22. `session_models` — a gap in §7's ERD, not a departure from it

**Spec:** §4's second use case has a user "swap a model mid-conversation", and §6's Chat screen
shows the council on the session rather than on each message. §8 words two endpoints in the same
terms: `POST /api/sessions` "Create session with a council" and `PATCH /api/sessions/:id`
"Rename, or change the council". But §7's ERD has no table in which a session's council could
live — `sessions` carries only `chairman_abstains` and `rebuttal_enabled`, and `round_models` is
written per round by the engine.

**What we did:** migration 004 adds `session_models (session_id, model_id, is_chairman)`, shaped
to match `preset_models` exactly — same composite primary key, `ON DELETE CASCADE` to the parent,
`ON DELETE RESTRICT` to `models`, RLS enabled with zero policies like every other table.

**Why this is a gap rather than a deviation:** three sections of the frozen spec describe the
thing; only the diagram omits it. The same family as decision 9's "nine tables" for ten and §5's
"six diagrams" for seven. Building it as an eleventh table is the reading that makes the prose and
the endpoint list true, and no alternative was available: a council held only on rounds cannot be
read from a session that has not run one yet, which is exactly the session that `POST /rounds`
without a council has to serve.

**The three-tier relationship, which is the part to keep hold of.** A council now exists at three
lifetimes, and a query against the wrong one is silently wrong rather than an error:

| Table | Lifetime | Mutable? | Written by |
|---|---|---|---|
| `preset_models` | a reusable template | yes | the presets endpoints (Session 10) |
| `session_models` | the session's default | **yes** — PATCH replaces it | `sessionService` |
| `round_models` | the per-round snapshot | **never** | `debateService`, at round creation |

A preset applies to nothing until it is loaded into a session. A session's council is the default
that every round created *after* it changes will inherit. A round's council is what that round
actually ran with and is never updated again — which is what makes "change models mid-conversation"
safe, and what any historical query (the leaderboard above all) must read.

**Consequence, and it is verified rather than assumed:** replacing a session's council must leave
every existing `round_models` row untouched, and a council supplied in a `POST /rounds` body must
win for that round without writing back to `session_models`. Both directions are checked in
`verify:http` step 10, read back through psql.

### 23. `MAX_TOKENS` raised across all four stages

**Spec:** silent. This revises the values given in the Session 4 brief and flagged as too low at
the end of Session 5.

**What we did:** draft 1200 -> **2000**, verdict 1500 -> **2500**, rebuttal 800 -> **2000**,
final 1500 -> **3000**.

**Why:** `max_tokens` is a ceiling, not a spend. We are billed for the tokens a model actually
generates, so a generous ceiling costs nothing and a truncation costs the whole call —
`finish_reason: 'length'` mid-JSON loses the entire response and is billed in full. The asymmetry
is total, and the old numbers were sized as though it were not.

Two specific causes, both of which Session 5 measured. A reasoning model spends completion tokens
on internal reasoning before it writes a character of visible output, so a ceiling sized for the
visible answer is sized for a fraction of the call. And `revised_answer` on a rebuttal can be a
full replacement answer rather than a footnote — 800 was sized for the `argument` field alone.
`openai/gpt-5-mini` hit the rebuttal ceiling four times across three runs, each losing that
drafter's stance for about $0.0018.

**Consequence for Session 9, and it is a trap:** the pre-flight cost check must **not** estimate a
round at `max_tokens`. Doing so would now roughly double every quote and push paying users onto the
free tier for rounds they can comfortably afford. `COMPLETION_ESTIMATE_RATIO` in `config/llm.js` is
0.4 as a deliberate placeholder; by Session 9 there are hundreds of `model_responses` rows and the
estimate should be derived per stage from our own traffic instead of from a constant.

### 24. Round latency is 8–47s, not §11's 15–25s

**Spec (§11):** "A four-stage round is slow (~15–25s)", and §9 repeats it — "A round takes 15–25
seconds".

**What we measured:** across Sessions 5 and 6, completed rounds ran 8.3s, 13.3s, 21.8s, 24.0s,
29.6s, 34.8s, 37.9s, 43.7s, 46.7s and 48.5s. The spec's range is roughly the middle third of the
real distribution; the top of it is nearly double the top of the estimate.

**Why:** the spread is dominated by individual drafters rather than by the number of stages.
`openai/gpt-5-mini` has been observed taking 14.1s to draft and 15.9s to rebut in single rounds,
because a reasoning model's wall clock includes reasoning tokens the visible answer never shows.
Since stages 1 and 3 are `Promise.allSettled` fan-outs, a round is paced by its slowest member
twice over, and the chairman's two calls are serial on top of that.

**What follows from it, and it is not a documentation fix.** §11's own mitigation — "results stream
to the UI stage by stage, so the user always sees progress" — stops being a nicety at 47 seconds
and becomes the only thing standing between the user and a dead-looking page. It is also why
`POST /api/sessions/:id/rounds` answers 202 rather than holding the request open (decision 25):
a 47-second request is one an intermediary is entitled to cut. The 90s `callModel` timeout, chosen
in Session 4 against the spec's estimate, is comfortable against the real numbers and stays.

### 25. Starting a debate is two calls: 202 now, results over SSE

**Spec (§8):** `POST /api/sessions/:id/rounds` — "**Start a debate.** Pre-flight cost check, then
run stages 1–4", listed alongside `GET /api/rounds/:id/stream` without saying how the two relate.

**What we did:** POST validates the council, creates the `rounds` row, answers **202 Accepted**
with `{ roundId, sessionId, status, streamUrl }` in about 265ms, and runs the debate on the
process's own time. The client then opens the stream, or polls `GET /api/rounds/:id`.

**Why:** three reasons, any one of which is sufficient. A round takes up to 47 seconds and no HTTP
request should be held open that long. `EventSource` can only issue a GET with no body, so the
stream physically cannot be the same call that carries the prompt. And a client that loses the
socket mid-round would otherwise lose the result of a debate it has already been billed for.

**What this costs and how it is contained:** every refusal that belongs to the caller has to be
raised *before* the 202, or it would arrive thirty seconds later as a stream frame with no request
left to attach it to. So `startRound` calls the engine's own `planCouncil` — now exported for this
one purpose — before it writes anything, and `INVALID_COUNCIL` / `INSUFFICIENT_COUNCIL` /
`UNKNOWN_MODEL` / `INACTIVE_MODEL` are all synchronous 400s. What happens after the 202 is the
debate's business and is reported over the stream and in the row.

The round row is also inserted before the response rather than inside `runRound`, so the id in the
202 already resolves. A 202 naming a resource that 404s for the next 50ms is a race every client
would have to be told about.

### 26. The leaderboard scores from stage 2's `winner_labels`, never `rounds.verdict_type`

**Spec:** §8 gives `GET /api/leaderboard` as "win rate, concession rate, avg cost" without saying
where a win comes from.

**What we did:** ruled, ahead of the leaderboard being built, that a model's *win* is read from the
stage-2 `model_responses` row — `winner_labels` inside its content, mapped back through
`anon_label`. `rounds.verdict_type` is not a source for it.

**Why:** decision 20 recorded the observation; this promotes it to a rule because Session 11 will
otherwise reach for the column, which is right there and looks authoritative. Stage 2 is a blind
evaluation of anonymised, shuffled drafts — the only point in a round where a model is judged on
its answer rather than on its concessions. Stage 4 frequently returns `unanimous` once every
drafter has conceded (three of five rounds in Session 5, and again in Session 6), which would erase
the fact that a model won and score a decisive round as a draw.

**Both are kept, because they answer different questions.** `rounds.verdict_type` is the
user-facing outcome of the debate and stage 4 is rightly authoritative for it. Stage 2's
`winner_labels` is the record of which draft was better. `GET /api/rounds/:id` returns both, under
`verdictType` and `verdict` respectively, so no consumer has to choose blind.

### 27. A temporary per-user rate limit on `POST /rounds`, standing in for the wallet

**Spec:** §8 words `POST /api/sessions/:id/rounds` as "pre-flight cost check, then run stages 1–4",
and §3 gives every user a wallet with a two-debates-per-UTC-day free tier. Neither exists yet;
both are Session 9.

**What we did:** mounted `createRoundRateLimiter()` — 10 rounds per hour, **keyed on
`req.user.id`** — on that one route, returning 429 `RATE_LIMITED` through our own error envelope.
It is explicitly labelled temporary in `middleware/rateLimit.js`, in `sessionRoutes.js` and in
`CLAUDE.md`.

**Why now, in a client session:** Session 6 shipped the route and listed "nothing limits OpenRouter
spend" as the largest gap in its surface. Session 7 is the first session in which a *browser* can
reach that route, and a browser is where a retry loop, a double-submit or a stolen cookie turns an
unmetered endpoint into an unbounded bill. Ten rounds an hour is roughly $0.15 at Session 6's
observed cost per round: high enough that no honest user meets it, low enough that nothing can
empty the OpenRouter account overnight.

**Why per-user and not per-IP.** The auth limiter is per-IP because the caller has no identity yet.
Here the thing being rationed is one account's spend, and it follows the account: an office behind
one NAT must not share a budget, and a user on a phone must not get a fresh budget by changing
network. That is also why this limiter can only be mounted behind `requireAuth` — `req.user` is
what it keys on, and `requireAuth` reads the row rather than trusting the token.

**Why it is mounted last, after `validate` and `requireOwnership`** — the reverse of the auth
routes. There, the limiter guards a secret, so a malformed body is still an attempt worth counting
and it runs first. Here it guards money, and neither a 400 nor a 403 spends any: counting them
would let a user burn an hour of debates on typos. The residue is that a request refused *inside*
`startRound` (`UNKNOWN_MODEL`, `INSUFFICIENT_COUNCIL`) does consume a count, because the limiter is
in front of the service — which is exactly what made it verifiable for free.

**What it is not.** It is not a cost check and not a free-tier count. It says nothing about what a
round will cost or whether the user can afford it, and a funded user is capped identically to an
empty one. **Session 9 must delete it** along with its mount, not build on top of it.

**Known limits:** the store is in-memory, so it resets on restart and does not add up across
processes — the same caveat Session 3 recorded for the auth limiter.

---

## Session 8 — 2026-08-11 (council setup and the live debate view)

### 28. `GET /api/models` carries the estimate's inputs alongside the prices

**Spec:** §8 gives the endpoint one line — "active model catalogue with pricing" — and §4's paying
user "sees a pre-flight estimate of what the next round will cost before sending it".

**What we did:** the response is `{ models, estimate }`, where `estimate` is
`{ completionRatio, maxTokens, promptTokens }` read straight from `config/llm.js`. The client does
the arithmetic — per model, per stage — and renders it as "est. ~$0.019" on both the council picker
and the composer.

**Why the extra block:** the estimate is a price multiplied by a token count, and every token count
in it is a server constant. `MAX_TOKENS` and `COMPLETION_ESTIMATE_RATIO` are written down exactly
once, in `config/llm.js`, which CLAUDE.md names as the only place a sampling default lives. A
second copy in the client would drift the first time a ceiling moves, and it would drift *silently*:
the quote would still render, just wrongly. Shipping the inputs keeps one source and still leaves
the recomputation on the client, where a toggle changes the figure with no round trip.

**`PROMPT_ESTIMATE_TOKENS` is new, and it is measured rather than assumed.** The completion side has
a ceiling to take a fraction of; the prompt side has nothing, so the four values are averages read
out of our own `model_responses` on the day — draft 147, verdict 862, rebuttal 1142, final 1211,
each rounded up to the nearest fifty. They are the smaller half of the quote at Session 6's prices.

**What the client is NOT given:** `is_active` (every row returned is active — §8 says so) and any
figure that would let it compute a wallet balance. The estimate is a quote, not an authorisation.

### 29. Why stage 3 was skipped is inferred on read, not stored

**Spec:** §7's `rounds` table has no column for either debate setting, and decision 19 skips stage 3
on two different conditions: the session has rebuttals off, or stage 2 returned `unanimous`.

**What we did:** the live view takes the reason from the `stage_skipped` frame, which carries the
engine's own words. A round read back from the database has no such frame, so the client infers:
zero rebuttal rows on a finished round, and stage 2's `verdictType === 'unanimous'` decides which of
the two sentences to render.

**Why not add the column:** `rounds.rebuttal_enabled` would be the honest fix and it is one
migration, but writing it now means a NULL for every round already run — so the inference would
still be needed for the history, and there would be two code paths instead of one. The inference is
exactly right for the unanimous case (stage 2's verdict is persisted) and right by elimination for
the other, since those are the only two reasons the engine skips. **If a third reason is ever
added, this inference becomes wrong and the column has to come with it.**

### 30. The debate view holds one round live and reconciles it from the database

**Spec:** §4 has the user "watch the four stages resolve live", and §8 gives both
`GET /api/rounds/:id/stream` and `GET /api/rounds/:id` without saying which the screen uses.

**What we did:** both, for the same round, at different times. `useRoundStream` renders from SSE
frames while a round runs; on `round_complete` the page refetches the session and only then drops
the live copy, so the persisted row — which carries the token counts no frame ever had — replaces it
without a blank frame in between. `lib/round.js` normalises both sources into one object, so one set
of components renders a debate happening and a debate remembered.

**Why the swap at all, rather than trusting the stream:** the stream is a narration and the database
is the record. Token totals are only in the rows; a frame dropped mid-round is invisible to a client
that never reads them; and a session with five rounds has four that were never streamed to this
page at all. Reconciling makes the live case the exception rather than a second implementation.

**The fallbacks, in order:** the browser reconnects on its own and sends `Last-Event-ID`, so the
server replays only what was missed. Three consecutive failures, or a `stream_closed` frame — the
round's buffer is released fifteen minutes after it ends, and the registry dies with the process —
stop the EventSource and poll `GET /api/rounds/:id` every three seconds instead. Every frame is
applied at most once, keyed on its monotonic id, because a replay and a live fan-out are the same
frames arriving twice.

---

## Session 9 — 2026-08-12 (billing: the wallet, the gate, and Stripe)

### 31. The pre-flight estimate is measured per stage, not taken as a fraction of `MAX_TOKENS`

**Spec:** §3 states the rule in terms of `estimated_round_cost`, and words the estimate as
"deliberately worst-case — for each planned call, estimated prompt tokens × input price plus
`max_tokens` × output price".

**What we did:** replaced `COMPLETION_ESTIMATE_RATIO` and `PROMPT_ESTIMATE_TOKENS` with a single
`STAGE_TOKEN_AVERAGES` in `config/llm.js`, measured on 2026-08-12 against every `model_responses`
row with a null `error_text` — 199 calls across Sessions 5 to 8. Prompts rounded up to the nearest
fifty, completions to the nearest twenty-five.

**Why this is a departure from §3's wording and why it is still §3's rule.** Taking `max_tokens` as
the completion is the worst case only if the ceiling tracks what a stage generates, and it does not:
decision 23 raised the four ceilings for reasons — a reasoning model's hidden tokens, a
`revised_answer` that is a whole replacement answer — that say nothing about a typical call. At
0.4 of the ceiling Session 8 measured the quote running 2.4–2.7× high; at the full ceiling it would
have been six times. This session measured the old figures at **4.32× the billed cost on average
across five real rounds, and 8.87× on one**, against **1.64× for the measured averages**.

That gap is not cosmetic, because §3 uses the estimate to decide *who pays*: the threshold is
`max($0.05, estimate × 1.5)`, so a quote 4× high pushes a funded user onto the free tier and refuses
a round they could easily afford. An estimate that overshoots is not conservative here — it is a
different rule.

**The direction of the remaining error is deliberate.** 1.64× still leans high, and it should: a
quote under the bill is the error that surprises a user, and a debate that skips stage 3 on a
unanimous verdict is cheaper than any quote can know in advance.

**It has an expiry, and this time the expiry is written into the code.** It is an average over four
models at one council size and one prompt length, so a new model, a longer question or a template
edit moves it. `config/llm.js` carries the query that produced it and `verify:wallet` prints the
before/after against real rounds, which is the cheapest way to notice drift.

### 32. A 402 carries a third key on the error envelope: `billing`

**Spec:** §8 gives `POST /sessions/:id/rounds` a pre-flight cost check and §3 gives the rule, but
neither says what a refusal tells the client. CLAUDE.md's convention is
`{ error: { message, code } }` plus an optional `details` array on validation failures only.

**What we did:** added `billing` — `{ mode, estimate, threshold, balance, freeRemaining }` — set only
by that 402, emitted by `errorHandler` under the same `status < 500` guard as `details`. `httpError`
takes it as a named option, so it is still constructed in one place. The 202 carries the same block
on success.

**Why not reuse `details`.** `details` is an array of Zod field complaints and the client reads it
*by field name* — `fieldError('password')`, `fieldErrorMap`. A balance belongs to no field, and
putting it there would mean the form-error path trying to render money under an input box. They are
different shapes for different readers and the wire says so.

**Why the numbers travel at all.** §4 has the user "prompted to top up" rather than blocked, and a
prompt that cannot say what the round would cost, what the wallet holds, or how many free debates
are left cannot tell a user which of the three to change. The client renders exactly those three
figures and picks one of two remedies from the code.

### 33. The ledger is one row per round, not one per call — which is not what mockup 04 draws

**Spec:** §5's mockup 04 is captioned "credits, top-up, per-call ledger" and its table shows a row
per model call: `Gemini 2.5 Pro · 1,240 tokens · final · −$0.008`.

**What we did:** `credit_transactions` gets one `debit` row per round. The table keeps the mockup's
MODEL and TOKENS columns and fills them from the round — the council's size, and every token the
debate spent.

**Why:** the per-call detail already exists, in `model_responses`, with cost, tokens, provider and
latency on each row, and the debate view already renders it — which is where a user actually asks
"what did this model say and what did it cost". This table answers a different question: where the
balance went. A round is up to 2N calls, so a per-call ledger is eight rows per debate, an export
nobody can add up, and — the decisive one — a `balance_after` that is meaningless on seven of the
eight, because seven of them are mid-round intermediate states of a single atomic settlement.

**What is lost:** a user cannot see from the wallet that the chairman's final cost more than a
draft. That is one click away in the transcript, and the wallet's job is the balance.

### 34. A free round writes no ledger row at all

**Spec:** §3 gives an empty wallet two debates a day and says nothing about recording them.

**What we did:** nothing is debited and nothing is written. `rounds.total_cost` still holds exactly
what the round cost us.

**Why not a `bonus` row of amount 0**, which was the first design and is the more explicit-looking
one: a row of zero moves no balance, so its `balance_after` restates the previous row's, and the
ledger's one real invariant — `SUM(amount) = users.credit_balance`, with the newest row's
`balance_after` equal to both — comes to be carried by rows that assert nothing. The property worth
having is that **every row in `credit_transactions` is a row where money moved**, because that is
what makes a financial ledger readable and auditable at a glance.

**Nothing is lost.** The round is its own record, the free-tier count is a query against `rounds`
rather than against the ledger, and what a free round cost *us* is on the round. The wallet page
says so where the table would otherwise look broken: "Free debates do not appear here."

### 35. Two refusal codes for one rule, because they have different remedies

**Spec:** §3's rule has a single denial — the wallet cannot cover the round and the allowance is
spent.

**What we did:** `DAILY_LIMIT_REACHED` when the balance is zero or below, `INSUFFICIENT_CREDIT` when
there is money in the wallet but not enough for this council. Both are 402 and both carry the same
`billing` block.

**Why:** the second user has a third option the first does not — drop a model and the council may
already be affordable — and it is free and immediate. One code would mean the client offering
"top up" to someone who has already topped up and needs to be told the council is the problem.

### 36. Both Stripe keys are optional outside production, and the endpoints 503

**Spec:** §9 has Stripe in test mode with a production-shaped integration.

**What we did:** `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` joined `REQUIRED_IN_PRODUCTION`
rather than the always-required block, and `stripeService` builds its client lazily and raises a 503
`STRIPE_NOT_CONFIGURED` if asked to work without them.

**Why not always-required, which is what Sessions 3 and 4 did for `JWT_SECRET` and
`OPENROUTER_API_KEY`:** those two are on the path of every request and every debate, so an unset key
is a crash at the first request rather than an absent feature — failing at boot is strictly better.
Stripe is not. A fresh clone can sign in, assemble a council, debate, and be billed against a
balance with no Stripe credentials at all; only *adding* to the balance needs them. Requiring them
in development would mean a contributor cannot start the API without someone's test keys, to run a
feature they may not be touching.

### 37. Idempotency is a lock and an index, not one or the other

**Spec:** §8 lists `POST /api/webhooks/stripe` as "confirm payment, credit the account".

**What we did:** `creditTopup` takes the user row's write lock, looks up `stripe_payment_id`, and
returns without writing if it finds one. Migration 005 adds a partial unique index on that column.

**Why both.** The lock answers the retry clearly — the second delivery waits for the first to
commit, sees its row, and reports `credited: false` with a 200. The index answers the case the lock
cannot: two processes, no shared lock, both past the SELECT. There it turns a double credit into a
failed insert and a rolled-back transaction, Stripe retries, and the next attempt sees the committed
row. A clear answer and a guarantee are different things and money is worth having both.

**The index is partial, `WHERE stripe_payment_id IS NOT NULL`.** Every debit has a null there and a
plain UNIQUE would treat those as distinct — true in Postgres, but true by accident. The predicate
says what is meant: at most one row per real payment.

**The replay is a 200, deliberately.** Stripe redelivers on any non-2xx, so answering 409 to "I have
already credited this" would earn a retry of something that will never change.

---

## Session 10 — 2026-08-12 (sessions, presets and public share links)

### 38. Every new account is seeded with two presets

**Spec:** §4.7 lists presets as something the user does — "save a council preset and reuse it later
(create, rename, duplicate, delete)". Nothing in §4 or §8 says an account starts with any.

**What we did:** registration creates "Full council" (every active model, the cheapest chairing,
abstaining) and "Cheap draft" (the two cheapest, one chairing and drafting), both built by querying
`models` at registration time.

**Why:** an empty preset list makes /new look broken. It is the first screen a new account sees, the
mockup shows a presets panel on it, and a panel that says "you have no presets" teaches a user
nothing about what a preset is or why they would want one. Two real ones do — and "Full council" is
exactly the default the picker already opened with since Session 8, so the page now opens on a
highlighted preset and the feature explains itself by being in use.

**Built by querying, never from hard-coded ids.** The catalogue is a table and its ids are per-database
uuids; a hard-coded id is wrong on every machine but the one it was copied from. It also means the
seed tracks the catalogue: add a model and the next account's "Full council" has it.

**"Cheap draft" sets `chairmanAbstains: false`, and that is not a preference.** Two models with the
chairman abstaining leaves one drafter, which `planCouncil` refuses. The seed would otherwise create
a preset that saves happily, fills the picker, and disables the Start button for a reason the user
did not cause.

**It can never fail a registration.** `seedPresetsForUser` catches per preset and logs loudly. The
account exists and the response is already owed to the caller; trading a working sign-up for a
starter preset is the wrong way round.

### 39. "Filter by verdict" means the LATEST round's verdict

**Spec:** §8 gives `GET /api/sessions` a one-line "List (search, filter by verdict)". §5's mockup 03
draws four chips: All / Merged / Picked one / Synthesised.

**What we did:** the filter matches on the verdict of the session's most recent round.

**Why, out of three readings.** A session has many rounds and each has its own `verdict_type`, so
"sessions with a merged verdict" could mean any round merged, all rounds merged, or the latest one.
*Any* puts one session under several chips at once, so the four stop partitioning anything and their
counts sum past the total. *All* makes a session silently leave a filter the moment a follow-up
question is asked — the single action the sessions page most encourages. *Latest* is also the only
one consistent with the row it filters: the VERDICT chip and the WHEN column already show the latest
round, so filtering on anything else would filter on a value that is not on screen.

`verify:sharing` proves it rather than asserting it: a fixture whose rounds went `picked` then
`merged` must appear under Merged and be absent from Picked one.

**`unanimous` has no chip** — the mockup draws four and it is a legal value of the column that three
of Session 6's four rounds produced. It renders in the table and the API accepts it as a filter
value, so the two never disagree about what exists; the chip row simply does not offer it.

### 40. The public payload is built by allow-list, and the leak check is structural

**Spec:** §8 — "GET /api/share/:token. **Public.** Read-only session, no auth." §11 — "the shared
view excludes wallet and account data."

**What we did:** `shareService` constructs the response field by field — `toSharedSession`,
`toSharedRound`, `toSharedResponse` — rather than deleting keys from `toPublicSession`'s output.

**Why the direction matters more than the list.** A strip-list and an allow-list produce the same
bytes today and behave oppositely tomorrow: when somebody adds a field upstream, a strip-list leaks
it by default and an allow-list drops it by default. This is the only route in the product with no
authentication in front of it, and a link that has been sent cannot be unsent, so the one that fails
safe is the one that guards it.

**What is withheld and why.** `user_id`, `email`, `display_name` — a link shares a debate, not an
identity. Every cost field and both token counts — a token count times a published per-token price
is the cost with an extra step. `share_token` — already in the caller's URL, and echoing a
credential into a body that does not need it is how it reaches a log. A round's `session_id` — an
internal id a public reader can do nothing with.

**`latencyMs` stays**, deliberately: it is a property of the debate rather than of the account, it is
already on every draft card, and "Gemini took 4.1s" is the kind of thing sharing a debate is *for*.

**The check is a structural walk, not a reading.** `verify:sharing` recurses the entire response and
flags any key at any depth matching an identity-or-price pattern, plus any string value that looks
like an email address — then checks the raw bytes for the owner's actual email and uuid, and asserts
the same fields ARE present on the owner's own route so the absence is provably the allow-list
working rather than the data being missing. Reading the JSON proves the payload of the day; this
keeps being true after the next person adds a field.

### 41. An unknown token and a revoked one are the same 404

**Spec:** §8 has `DELETE /api/sessions/:id/share` revoke a token and says nothing about what the
public route then answers.

**What we did:** revoking writes NULL, so the row simply stops matching the lookup; both cases hit
one branch that raises 404 with an identical body. `verify:sharing` asserts the two responses are
byte-identical.

**Why not 403 for a revoked token,** which is arguably the more informative code: it would confirm to
whoever is holding a leaked or forwarded link that the string was real. That is precisely the fact
revoking exists to stop telling people. There is one branch because there is one honest answer, and
the /s/:token page's copy says both possibilities in one sentence for the same reason.

**Revoking writes NULL rather than a tombstone**, so there is no "revoked" state to check for and
therefore no way to forget to check it. Re-sharing mints a fresh token; the old link stays dead.

### 42. Sharing is idempotent, and the modal mints on open

**Spec:** §8: "POST /api/sessions/:id/share — Generate a public share token."

**What we did:** POST returns the existing token if there is one, rather than rotating it, and
reports `created: false`. 200 either way, not 201.

**Why:** the button that calls it says "Share", and a user who presses it again after sending the
link expects the same link — not to have silently broken the one they sent. Rotation is revoke then
share: two deliberate actions that say what they do. The status code stays 200 because the caller
asked for the session to be shared and it now is; a 201/200 split would make the code the only way
to tell the difference, which no caller needs.

**The client mints on open** rather than behind a "Generate link" button inside the modal, because
the user already made the decision by pressing Share and a second confirmation is a step with no
question in it. The cost is a token existing for someone who then closed the modal — visible on the
row as "Shared", and revocable in one click in the same modal.

### 43. Duplicate is not an endpoint

**Spec:** §4.7 lists "create, rename, duplicate, delete" as user actions; §8 gives four endpoints and
duplicate is not among them.

**What we did:** the sessions page duplicates a preset by POSTing the row it is already rendering
with a new name.

**Why:** an endpoint would be a third writer of `preset_models` with nothing of its own to say — the
client holds the whole preset already, and "duplicate" is a create whose body it can assemble
without a round trip. The one thing it does add is the name, which has to be different anyway
because migration 006 makes names unique per user, so the user is involved regardless.
