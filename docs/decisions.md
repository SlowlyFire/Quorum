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
