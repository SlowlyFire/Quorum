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
