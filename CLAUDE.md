# CLAUDE.md — Quorum

This file is reloaded at the start of every session. Keep it current.

## Product

Quorum turns a single question into a debate between AI models, then delivers one answer they
have argued their way to. A signed-in user assembles a council of models, nominates one as
chairman, and asks a question; the platform runs a structured four-stage deliberation and returns
a single final answer alongside the full record of how it got there — every draft, the chairman's
reasoning, and who conceded. The premise is that disagreement between models is a signal that is
invisible when you paste the same prompt into three chat apps by hand. Everyone signs in; the only
unauthenticated surface is a read-only shared result page. Every user has a wallet: funded
accounts are billed per call, empty ones get two debates per UTC day.

## The four debate stages

For a council of N models with the chairman abstaining from drafting:

| # | Stage | What happens | Calls |
|---|---|---|---|
| 1 | Drafts | Every drafting model answers independently, in parallel | N−1 |
| 2 | Verdict | Chairman receives the drafts **anonymised and shuffled**, then picks one, merges two, or synthesises its own | 1 |
| 3 | Rebuttals | Each drafter sees the verdict and may **defend, revise, or concede** | N−1 |
| 4 | Final | Chairman rules on the rebuttals and produces the final answer | 1 |

**2N calls per round is the ceiling, not the count** — stage 3 is skipped when the verdict is
`unanimous` or the session has rebuttals off, which makes it N+2 (decision 19). Stages 1 and 3 fan
out with `Promise.allSettled` — a provider failure is recorded in `model_responses.error_text` and
the round continues without it, unless fewer than two drafts survive, which fails the round.

Two invariants: the chairman abstains from drafting by default (LLMs favour their own output when
judging), and rebuttals permit concession, not just defence (defence-only makes models entrench
and stage 4 learns nothing).

**The chairman's vocabulary is not the database's.** `prompts/` asks for `pick` / `merge` /
`synthesise`; §7 and the CHECK constraint say `picked` / `merged` / `synthesised`. Both files are
frozen, so `VERDICT_TYPE_MAP` in `debateService.js` is the single place they meet — normalise at
parse time, and never let a model's word reach a column (decision 18).

## Stack

- **Database** — Supabase Postgres, accessed with the `pg` driver and **plain SQL migrations**.
  No ORM, no query builder. Migrations are numbered files in `server/src/db/migrations/`, applied
  with `npm run migrate`. `npm run psql -- -c '...'` opens a client against the same database.
- **LLM gateway** — **OpenRouter is the only one.** One key, one OpenAI-compatible endpoint for
  every model. Calls are non-streaming (`stream: false`) — each stage needs the complete previous
  output. Token counts and real cost come back in the response body; that is what we debit.
  Adding a model is a row in `models`, never a new adapter.
- **Auth** — our own: `bcryptjs` at cost 10, **JWT (HS256, 7 days) in an httpOnly cookie** named
  `quorum_token`. Not a hosted auth product; implementing auth is a project requirement. **Google
  OAuth is deferred, not dropped** — `users.google_id` and the model functions for it stay (see
  `docs/decisions.md` 10).
- **Client** — React 18 + Vite, React Router v6, **Mantine** for UI.
- **Validation** — **Zod**, on both server request bodies and server env config.
- **Also planned** — Stripe (test mode) for top-ups, Supabase Storage for attachments, SSE for
  streaming round progress to the client.

## Conventions

- **ES modules** everywhere (`"type": "module"`). `.js`/`.jsx` extensions are required in imports.
- **async/await only.** Never `.then()` chains.
- **Named exports.** No default exports.
- **Thin controllers, fat services.** A controller reads the request, calls one service, and
  sends the response. All logic, orchestration and error construction live in services.
- **Only `src/models/` contains SQL.** One file per table. Services call models; controllers,
  routes and middleware never import a model or `db/pool.js`. The single exception is
  `src/db/migrate.js`, which executes migration files rather than querying application tables.
- **Model functions take the query executor last**, defaulting to the `query` helper from
  `db/pool.js`. Passing a transaction client's `query` instead is what makes several writes
  atomic — a round debiting the wallet and writing its ledger row, for example.
- **`round_models.role` is three-valued** (`drafter`, `chairman`, `both`). Any query about
  drafting must use `role IN ('drafter', 'both')`; any query about judging must use
  `role IN ('chairman', 'both')`. A bare `role = 'drafter'` silently excludes every round in
  which the chairman also drafted, which would skew the leaderboard denominator.
- **`errorHandler` is the only place an error becomes a response**, and **`lib/httpError.js` is the
  only place one is constructed** — `httpError(status, code, message, { cause, details })`, then
  throw it or pass it to `next`. Never `res.status(500).json(...)` inline. Response shape is always
  `{ error: { message, code } }`, plus an optional `details` array on validation failures only.
- **Validate at the edge** with Zod, via the `validate({ body, params, query })` middleware, before
  a controller or service runs. Schemas live in `src/validation/`.
- **Authorization reads the database, never the JWT.** The token's `role` claim is seven days stale
  by design; `requireAuth` loads the row and `req.user` is the only source of truth. Guard owned
  resources with `requireOwnership(loaderFn)`, whose loader is a **service** function — middleware
  imports services, never models or `db/pool.js`.
- **Never log an email address next to a failure reason**, and never attach a pg error as `cause`
  on a 409: its `detail` contains the conflicting value.

## Documentation duties (every session)

- Update **Current state** below.
- Append a section to `docs/build-log.md`. Never rewrite earlier sections.
- Log any spec deviation in `docs/decisions.md`.
- **Never modify `docs/quorum-product-document.md` or `.pdf`.** They are the frozen approved v1.0.

## Current state

_Last updated: end of Session 5 (2026-08-11) — the four-stage debate engine._

**Exists and verified running:**

- `server/` — Express 4 on Node 20+, ES modules. `src/app.js` wires cors (credentials, origin from
  `CLIENT_URL`), cookie-parser, `express.json`, `/api` routes, `notFound`, `errorHandler`.
  `src/config/env.js` validates env with Zod and throws on a bad config; **`DATABASE_URL`,
  `JWT_SECRET` and `OPENROUTER_API_KEY` are required in every environment**, the two Supabase keys
  only in production. `src/db/pool.js` exports a single `pg` Pool
  (`ssl: { rejectUnauthorized: false }`) plus a `query()` helper that logs duration in development.
- Routes: `GET /api/health` → `{ status, timestamp }`; `GET /api/health/db` → `SELECT now()`,
  now **verified 200 against the live Supabase database**.
- **Auth is live and verified with real requests.** `POST /api/auth/register` (201),
  `POST /api/auth/login` (200), `POST /api/auth/logout` (204), `GET /api/auth/me` (200 / 401) —
  all four setting or reading `quorum_token`. Login returns a byte-identical 401 with the same
  timing whether the email exists or not (unknown emails still run a real bcrypt compare against a
  fixed hash). `bcryptjs` cost 10, `$2b$` confirmed in the database.
- `src/services/tokenService.js` — `sign` / `verify` (HS256 pinned on both sides), `cookieOptions`
  and `clearCookieOptions`. `src/services/authService.js` — `register`, `login`,
  `getAuthenticatedUser`, and `toPublicUser`, the single place a row becomes wire shape.
- `src/middleware/` — `requireAuth`, `requireRole`, `requireOwnership` (a factory taking a loader),
  `validate`, `createAuthRateLimiter` (10 per IP per 15 min, one instance per route, 429 through
  our envelope). `src/lib/httpError.js` is the single error constructor.
- `src/validation/authSchemas.js` — `registerSchema`, `loginSchema`. Email is trimmed and
  lower-cased before the format check; login's password rule is non-empty, not min-8, so a short
  password fails as 401 rather than 400.
- **Database is live.** All ten tables from the §7 ERD exist in Supabase — `users`, `models`,
  `presets`, `preset_models`, `sessions`, `rounds`, `round_models`, `model_responses`,
  `attachments`, `credit_transactions` — plus `_migrations`. Every one has RLS enabled with zero
  policies. `rounds.user_id` is denormalised (see `docs/decisions.md`).
- `src/db/migrate.js` (`npm run migrate`) — applies unapplied `migrations/*.sql` in filename
  order, one transaction each, tracked in `_migrations`. Idempotent; exits non-zero on failure.
- `scripts/psql.js` (`npm run psql -- -c '...'`) — psql with the connection passed through the
  child's environment, never on the command line.
- `src/models/` — `userModel.js`, `llmModel.js`, `healthModel.js`. Every function exercised
  against the live database inside a rolled-back transaction.
- `models` seeded with four real OpenRouter models, one per provider: `anthropic/claude-haiku-4.5`,
  `openai/gpt-5-mini`, `google/gemini-2.5-flash`, `meta-llama/llama-4-maverick`. All support
  vision; prices are real, taken from the live OpenRouter catalogue.
- **The LLM layer is live and verified against real calls.** `src/services/openrouterService.js` —
  `callModel({ modelSlug, system, user, maxTokens, temperature, images, timeoutMs })` returning
  exactly `{ content, promptTokens, completionTokens, cost, latencyMs, finishReason, raw }`, plus
  `fetchCatalogue()`. Non-streaming, 90s `AbortController` timeout, one retry on 429/5xx after 2s
  and never on 400/401/402/404 or a timeout, six mapped error codes, `usage.cost` read straight off
  the body with a `models`-table fallback. Never logs prompt or completion text.
- `src/services/promptService.js` — the four `prompts/*.md` templates parsed at **import**, so a
  missing or section-less file is a boot failure. `getPrompt(stage)`, `render(tpl, vars)`,
  `renderStage(stage, vars)`; stage keys match `model_responses.stage`. **`prompts/` is read-only
  to the server** — never write to it.
- `src/services/jsonResponse.js` — `parseModelJson`: fence stripping, outermost-brace recovery,
  then 502 `MODEL_JSON_INVALID` with the raw text on `error.rawContent`.
- `src/config/llm.js` — `TEMPERATURE` / `MAX_TOKENS` / `STAGE_DEFAULTS`. The only place a sampling
  default is written down.
- **The debate engine runs, verified with six real debates.**
  `src/services/debateService.js` — `runRound({ sessionId, userId, prompt, council, onEvent })`.
  Validates the council before spending anything (`INVALID_COUNCIL`, `INSUFFICIENT_COUNCIL`);
  shuffles then labels drafters so the label leaks no ordering; keeps the label→model map in memory
  and sends the chairman `### Response A` blocks only; `Promise.allSettled` on stages 1 and 3;
  `INSUFFICIENT_DRAFTS` if fewer than two drafts survive; one retry with a corrective nudge on a
  chairman response that will not parse or fails its shape check, with **both attempts persisted**;
  every call written to `model_responses` including failures; any throw leaves the round `failed`
  with its cost and duration. `onEvent` emits the nine events Session 6 turns into SSE frames, and
  is wrapped per call so telemetry can never kill a debate.
- `src/models/` — seven of eleven files: `userModel`, `llmModel`, `healthModel`, `sessionModel`,
  `roundModel`, `roundModelModel`, `modelResponseModel`.
- Migration 003 added `rounds.prompt_version` (`'v1'`, bumped by hand in `promptService.js` when a
  template changes), `rounds.open_questions`, and `model_responses.provider` — which showed one
  model drafting via Novita and rebutting via DeepInfra inside a single round.
- `scripts/verify-openrouter.js` (`npm run verify:llm`) — 51 checks over templates, a real call, a
  four-model parallel fan-out, cost accounting, every mapped failure, and `parseModelJson`. Reads
  the database, writes nothing, costs about $0.0006 a run.
- `scripts/verify-debate.js` (`npm run verify:debate`) — 48 checks over six real debates: a full
  round with its event stream, anonymity proven on the exact `{{DRAFTS}}` string, a chairman that
  drafts, both routes into the stage-3 skip, a failing drafter, `INSUFFICIENT_DRAFTS`,
  `INSUFFICIENT_COUNCIL`, and the whole round read back through psql. **Writes to the database** and
  leaves it behind; about $0.033 a run.
- `docs/mockups/` — the seven §5 images, including the §7 ERD.
- `client/` — Vite + React 18 + Mantine + React Router v6. Nine placeholder pages (one heading
  each), routes for all of them in `App.jsx`, `api/client.js` fetch wrapper
  (`credentials: 'include'`, throws `ApiError` on non-2xx), `context/AuthContext.jsx` provider
  skeleton. **Untouched since Session 1.**

**Deliberately not built yet:** Google OAuth (deferred — decision 10), every HTTP route for a
debate, SSE, the wallet and Stripe, presets, sharing, the leaderboard, attachments. `presetModel`,
`attachmentModel` and `creditTransactionModel` arrive with the features that need them.
`requireOwnership` and `requireRole` are written but still have no caller. **No client-side auth at
all** — no forms, no session bootstrap, no protected-route wrapper. **Nothing calls `runRound`
outside `verify:debate`**, nothing debits the wallet, and no pre-flight cost or free-tier check runs
before a round.

**Two traps when reading a persisted round.** A chairman stage may have **two** `model_responses`
rows, because a retried parse failure is persisted alongside the attempt that succeeded — take the
last row for a stage whose `error_text` is null, not "the row for that stage". And
`rounds.verdict_type` comes from stage 4, where the chairman often returns `unanimous` after
concessions; the leaderboard's win must come from stage 2's `winner_labels` inside
`model_responses.content` (decision 20).

**Two things about cost that are easy to get wrong.** OpenRouter routes a slug to whichever
upstream provider is available and bills that upstream's price, so the same model at the same token
count costs different amounts on different calls — `usage.cost` is what the wallet debits, and the
`models` table prices are an estimate for pre-flight checks and the fallback only (decision 16).
And OpenRouter's 401 and 402 must **never** be passed through as ours: our 401 means "log in
again" and our 402 will mean the user's wallet is empty, neither of which is what the provider
meant (decision 15).

**One open decision from Session 5:** `MAX_TOKENS.rebuttal = 800` truncates `openai/gpt-5-mini`
mid-JSON — four calls across three verification runs hit `finish_reason: 'length'`, each losing that
drafter's stance and costing ~$0.0018 for nothing. A reasoning model spends completion tokens on
internal reasoning before writing any visible output, so a ceiling sized for the visible answer is
too small. The value was specified in the Session 4 brief and has not been changed; the
recommendation is 1500, matching verdict and final.

**Next session:** the HTTP surface — `POST /api/sessions/:id/rounds` behind `requireAuth` and
`requireOwnership` (its first real caller), Zod schemas for the council body, `GET /api/rounds/:id`,
and `GET /api/rounds/:id/stream` turning the nine `onEvent` events into SSE frames. Then the client
half of auth, deferred from Session 4.
