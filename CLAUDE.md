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
- **Client** — React 18 + Vite, React Router v6, **Mantine 8** for UI (8, not 9: Mantine 9 needs
  React 19 — every `@mantine/*` package must be installed with an explicit `@^8` or npm resolves
  9 and `ERESOLVE`s). Plus `@mantine/notifications` and `@tabler/icons-react`.
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
- **A council lives in three tables at three lifetimes, and the wrong one is silently wrong
  rather than an error.** `preset_models` is a reusable template that applies to nothing until it
  is loaded. `session_models` is the session's **default** and is mutable — PATCH replaces it, and
  every round created *after* that inherits the new line-up. `round_models` is the **immutable**
  per-round snapshot the engine writes at round creation and never updates. Any historical
  question — who debated, who won, what a round cost — reads `round_models`. Changing a session's
  council must never alter a round already run, and a council passed in a `POST /rounds` body wins
  for that round only and must not write back to `session_models` (decision 22).
- **THE LEADERBOARD'S WIN COMES FROM STAGE 2's `winner_labels`, NEVER FROM
  `rounds.verdict_type`.** Stage 2 is the blind evaluation of anonymised, shuffled drafts — the
  only point in a round where a model is judged on its answer rather than on its concessions.
  Stage 4 frequently returns `unanimous` once every drafter has conceded (three of four rounds in
  Session 6), which would erase the fact that a model won and score a decisive round as a draw.
  Read the **last** `model_responses` row for stage `verdict` with a null `error_text`, parse its
  `content`, and map `winner_labels` back through `anon_label`. `rounds.verdict_type` stays as the
  user-facing outcome; the two answer different questions and both are kept.
  `GET /api/rounds/:id` returns both, as `verdictType` and `verdict` (decisions 20 and 26).
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
- **On the client, the palette is written down in exactly two files** — `src/theme.js` (the
  `PALETTE` object and the Mantine ramps) and `src/global.css` (the same eight as `--quorum-*`
  variables, which is how a `style` prop reaches one without importing the theme). A hex literal
  anywhere else is a bug. `theme.js` is also the single export of the **model badge colours**
  (`MODEL_BADGE_COLORS`, `modelBadgeColor`, `modelBadgeLetter`), keyed on the vendor rather than
  the slug, because Sessions 8 and 11 both need them.
- **`AuthContext.loading` starts `true`, and nothing may change that.** There is no token to read —
  it lives in an httpOnly cookie — so "am I signed in?" is only answerable by asking the server.
  Start it `false` and, for the one render before `GET /api/auth/me` answers, every
  `<ProtectedRoute>` sees an anonymous visitor: a refresh on `/sessions` redirects to `/login` and
  snaps back, **taking the intended location with it**. Access control lives in `App.jsx` and
  nowhere else, so adding a route cannot accidentally add an unguarded one.
- **A 401 is not always an accident.** In `api/client.js` a 401 from any path outside
  `/api/auth/{me,login,register,logout}` clears the user; those four are exempt because `me`'s 401
  is how the bootstrap discovers there is no session and `login`'s is a wrong password, and
  redirecting on either means the login page redirecting to itself. The handler only sets `user` to
  null — that *is* the redirect, since every `<ProtectedRoute>` reads it, and it keeps routing
  decisions in the router rather than in a fetch wrapper that does not know where the user is.
- **A round reaches the screen two ways and must render as one thing.** `lib/round.js` is where a
  persisted round (`roundFromDetail`) and a live stream (`applyStreamEvent`) become the same object;
  every component downstream renders that object and knows nothing about where it came from. Add a
  field to one and you must add it to the other, or a refresh mid-round will silently show less than
  the stream did. `applyStreamEvent` must stay **idempotent per frame** — replay and live fan-out are
  the same frames arriving twice — and `useRoundStream` drops any frame id it has already applied.
- **`max_tokens` is a ceiling, not a spend** — we are billed for what a model generates, so
  headroom is free and a truncation costs the whole call. **The pre-flight cost estimate must
  therefore NOT use `MAX_TOKENS` as its worst case.** With the Session 6 values that would roughly
  double every quote and push paying users onto the free tier. Use
  `COMPLETION_ESTIMATE_RATIO` (0.4) from `config/llm.js` — and in Session 9, replace it: by then
  `model_responses` holds hundreds of rows, and a per-stage average measured from our own traffic
  beats a constant (decision 23). **Session 8 measured the gap: the quote runs 2.4–2.7× high**
  (~$0.019 against $0.0071), because 0.4 of a ceiling is 800 draft tokens against 301 measured.
- **The estimate's inputs travel with the prices, and the arithmetic happens on the client.**
  `GET /api/models` returns `{ models, estimate }`, where `estimate` is `completionRatio`,
  `maxTokens` and `PROMPT_ESTIMATE_TOKENS` straight from `config/llm.js`. Restating any of those
  three in the client would create a copy that drifts the first time a ceiling moves — and drifts
  silently, since the quote still renders (decision 28).

## Documentation duties (every session)

- Update **Current state** below.
- Append a section to `docs/build-log.md`. Never rewrite earlier sections.
- Log any spec deviation in `docs/decisions.md`.
- **Never modify `docs/quorum-product-document.md` or `.pdf`.** They are the frozen approved v1.0.

## Current state

_Last updated: end of Session 8 (2026-08-11) — council setup and the live debate view: mockups 01
and 02, the model catalogue endpoint, and the SSE transcript._

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
  with its cost and duration. `onEvent` emits the nine events that are now SSE frames, and is
  wrapped per call so telemetry can never kill a debate. Session 6 added two things and changed
  nothing else: **`planCouncil` is exported**, so the HTTP layer raises the same 400s before it
  answers 202, and **`runRound` accepts an optional pre-created `round` row** so the id in that 202
  already resolves. Absent, the engine still creates its own row.
- **The HTTP surface for a debate is live, verified with 86 checks and four real rounds.**
  All eight routes behind `requireAuth`, all `:id` routes behind `requireOwnership` — which finally
  has callers. Middleware order is always `requireAuth`, `validate`, `requireOwnership`: the
  ownership loader passes `req.params.id` into a query, so a non-uuid must be a 400 from Zod rather
  than a 500 from Postgres.

  | Method | Path | Result |
  |---|---|---|
  | POST | `/api/sessions` | 201 `{ session }` — council required |
  | GET | `/api/sessions` | `{ sessions, pagination }`, newest activity first, `?limit&offset&search` |
  | GET | `/api/sessions/:id` | session + every round + every response, 5 queries flat |
  | PATCH | `/api/sessions/:id` | rename, re-crew, or change either debate setting |
  | DELETE | `/api/sessions/:id` | 204, cascades |
  | POST | `/api/sessions/:id/rounds` | **202** `{ roundId, sessionId, status, streamUrl }` in ~265ms |
  | GET | `/api/rounds/:id` | full round, both verdicts, the label→model map |
  | GET | `/api/rounds/:id/stream` | SSE |

- **`GET /api/models` is live** (Session 8) — §8's "active model catalogue with pricing", behind
  `requireAuth`, no `:id` and so no ownership check. `{ models, estimate }`;
  `modelCatalogueService.toPublicModel` is the single place a `models` row becomes wire shape, and
  prices leave as numbers rather than pg's numeric strings. See the estimate convention above for
  why the second block is there.

- **`POST /rounds` answers 202 and does not wait** (decision 25). Rounds take 8–47s, no request
  should be held open that long, and `EventSource` can only issue a GET with no body — so starting
  and watching are two calls. Every refusal belonging to the caller is raised *before* the 202 by
  calling the engine's own exported `planCouncil`; the `rounds` row is inserted before the response
  too, so the id in the 202 already resolves.
- `src/services/roundStreamService.js` — the SSE registry, keyed on roundId:
  `{ events, subscribers, status, createdAt, nextId }`. **Every event is buffered as well as
  pushed, and a new subscriber is replayed the whole buffer before it joins the fan-out** — the
  client cannot connect before POST returns, so without this the first frames are lost every time
  (measured: 2 events buffered 5s in, with nobody listening). Monotonic frame ids, so
  `Last-Event-ID` resumes rather than replaying. `:\n\n` heartbeat every 15s. Closes on
  `round_complete` / `round_failed`, keeps the buffer 15 minutes, then 404s — which is what stops
  an `EventSource` retrying a dead round forever. `req.on('close')` removes the subscriber and
  clears its heartbeat. **Per-process and in memory**: a restart mid-debate orphans the stream,
  though the round still completes and is readable via `GET /api/rounds/:id`.
- **`Cache-Control: no-cache, no-transform` on the stream is load-bearing.** It is the documented
  opt-out the `compression` middleware honours; a compressor would buffer the response and hold
  every frame until the round ended, which looks like a debate that produced nothing rather than
  like an error. `app.js` carries the matching note.
- `src/services/sessionService.js`, `roundService.js`, `councilService.js` — CRUD, round start and
  detail, and the two questions both ask of a council (do these models exist, are they active),
  answered in one place so they cannot differ by route. `toPublicSession` is the single place a
  sessions row becomes wire shape.
- `src/validation/sessionSchemas.js`, `roundSchemas.js` — Zod owns everything checkable from the
  request alone, including the chairman-not-on-the-council check, which is reported as a
  field-level `details` entry naming the id. Whether those uuids name live models is the database's
  question and returns `UNKNOWN_MODEL` / `INACTIVE_MODEL`. Councils capped at 8 models, prompts at
  8000 characters, pagination at 50 — all cost guards.
- `src/db/pool.js` gains **`withTransaction(run)`**, handing the callback an executor with the same
  `(text, params)` shape as `query`. That is what every model taking its executor last was for.
  `BEGIN`/`COMMIT`/`ROLLBACK` is the one piece of SQL outside `src/models/`.
- **Migration 004 added `session_models`** `(session_id, model_id, is_chairman)` — §7's ERD has no
  table for a session's council while §4, §6 and §8 all describe one (decision 22). Shaped to match
  `preset_models` exactly. All twelve tables in `public` have RLS enabled with zero policies.
- `src/models/` — nine of twelve files: `userModel`, `llmModel`, `healthModel`, `sessionModel`,
  `sessionModelModel`, `roundModel`, `roundModelModel`, `modelResponseModel`.
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
- `scripts/verify-http.js` (`npm run verify:http`) — 86 checks over four real rounds, driving a
  **running server** over fetch with a cookie jar and a hand-written SSE parser, so what is checked
  is the bytes we send. Covers the late-subscriber replay, two simultaneous subscribers, a
  disconnect mid-round, 403 and 401 on every route including the stream, and the council-history
  proof read back through psql. Requires `npm run dev` in another terminal. **Writes to the
  database**; about $0.032 a run.
- `scripts/experiment-reasoning.js` (`npm run experiment:reasoning`) — the Session 6 measurement of
  OpenRouter's `reasoning` parameter on the drafting stage. Reads the database, writes nothing,
  about $0.021 a run. Kept so the measurement can be repeated when a model or a route changes.
- `docs/mockups/` — the seven §5 images, including the §7 ERD.
- **The client's foundation is live and verified in a real browser.** Vite + React 18 + Mantine 8 +
  React Router v6.
  - `src/theme.js` — the §5 palette, the Mantine ramps built so the default shade *is* the mockup's
    colour (`ink` at index 9 with `primaryShade: 9`, `brass` and `green` at 6), and the model badge
    map. `src/global.css` carries the same eight as `--quorum-*`.
  - `src/api/client.js` — `credentials: 'include'`, every failure an `ApiError` (a transport
    failure becomes `status: 0` / `NETWORK_ERROR` rather than a bare `TypeError`), `details` carried
    through with `fieldError` / `fieldErrorMap`, the 401 handler above, `get`/`post`/`patch`/`del`,
    and a deduped notification on transport failures and 5xx only — never on a 4xx.
  - `src/context/AuthContext.jsx` — `user`, `loading`, `error`, `login`, `register`, `logout`,
    `useAuth()`. Bootstraps from `GET /api/auth/me`. `logout` clears local state in a `finally`.
  - `src/App.jsx` — `<ProtectedRoute>` (loader → `<Navigate to="/login" state={{ from }} replace>`
    → page inside `<AppShell>`) and `<PublicOnlyRoute>` on `/login` and `/register`. `src/routes.js`
    holds the two destination constants so `Login` need not import `App`.
  - `src/components/` — `AppShell` (mockup header; burger + `Drawer` below `48em`), `Logo`,
    `ErrorBoundary` (resets on a path change), `ErrorAlert`, `PagePlaceholder`.
  - Pages: `Landing` (one screen, four stage cards, CTAs that become "Go to app"), `Login`,
    `Register` (sharing `AuthLayout`), `Shared` (own header — it is the only unauthenticated read
    surface). `Sessions`, `NewSession`, `Chat`, `Wallet`, `Leaderboard` are placeholders naming the
    session that builds them.
  - `src/validation/authFields.js` — the server's Zod rules restated, normalisation order included.
    Login's password rule is non-empty, not min-8, so a short password fails as 401 not 400.
  - **Three error paths, deliberately different:** a 400 with `details` renders against the named
    field; a 401 on login renders as an alert, because the server declines to say which half was
    wrong; a 409 on register is translated to "An account with that email already exists" under the
    Email box, since it belongs to a field but carries no `details`.

- **The two screens the product is are live, verified with six real debates.**
  - `/new` — mockup 01. `components/council/CouncilPicker.jsx` (a row per model: toggle, badge,
    name, chairman radio, price; the chairman is always a selected model, enforced in the component)
    and `RoundPlanCard` ("THIS ROUND" — what will happen, not the 2N ceiling, recomputed live).
    `lib/council.js` restates the server's three refusals and the Start button carries the reason;
    `lib/cost.js` prices a round per model per stage and labels every figure `est.`
  - `/chat/:sessionId` — mockup 02. Sidebar (`GET /api/sessions`, grouped Today / Yesterday /
    Earlier), thread, council-and-spend rail; below `62em` the sidebar is a drawer and the rail moves
    under the thread. `components/debate/` holds `StageBlock` (the numbered rail — brass for the
    chairman's stages, dim / pulsing / solid / struck through), `ResponseCards`, `VerdictCard` (with
    the rubric JSON behind a toggle), `FinalCard`, `Composer` (disabled while a round runs) and
    `SessionSidebar` / `CouncilRail`. Every round in a session renders in order and **all but the
    newest open collapsed** to the final answer.
  - `hooks/useRoundStream.js` — the EventSource, `withCredentials: true`, one application per frame
    id, closed on the terminal frames and on unmount, polling `GET /api/rounds/:id` every 3s after
    three failures or a `stream_closed` frame.
  - `components/Markdown.jsx` — `react-markdown` + `remark-gfm` and **no `rehype-raw`**: model
    output is the least trustworthy string in the product, so HTML stays escaped.

**Deliberately not built yet:** Google OAuth (deferred — decision 10), the wallet and Stripe,
presets, sharing, the leaderboard, attachments. `presetModel`, `attachmentModel` and
`creditTransactionModel` arrive with the features that need them. `requireRole` still has no
caller. **`/sessions`, `/wallet` and `/leaderboard` are still placeholders**, and the header links to
all three — the debate view's own sidebar is what covers session history today.

**The biggest gap in the current surface is still billing, and what stands in for it is
temporary.** §8 words `POST /rounds` as "Pre-flight cost check, then run stages 1–4" and there is
no check: nothing is debited, no `credit_transactions` row is written, and no free-tier count runs.
Session 7 mounted **`createRoundRateLimiter()` — 10 rounds per hour, keyed on `req.user.id`** — on
that route as a stopgap, because Session 7 is the first session in which a browser can reach it and
a browser is where a retry loop or a stolen cookie becomes an unbounded bill (decision 27).

**Session 9 must delete that limiter and its mount, not build on it.** It is not a cost check and
not a free-tier count: it says nothing about what a round costs or whether the user can afford it,
and a funded user is capped identically to an empty one. Two notes for whoever removes it — it is
keyed on the user rather than the IP because the thing rationed is one account's spend, and it is
mounted **after** `validate` and `requireOwnership` (the reverse of the auth routes) because
neither a 400 nor a 403 spends anything and counting them would burn a user's hour on typos.

**Two traps when reading a persisted round**, both of which `roundService.verdictFromResponses`
now handles — read it before writing another reader. A chairman stage may have **two**
`model_responses` rows, because a retried parse failure is persisted alongside the attempt that
succeeded, so take the **last** row for a stage whose `error_text` is null, not "the row for that
stage". And `rounds.verdict_type` comes from stage 4, where the chairman often returns `unanimous`
after concessions — see the leaderboard convention above (decisions 20 and 26).

**Two things about cost that are easy to get wrong.** OpenRouter routes a slug to whichever
upstream provider is available and bills that upstream's price, so the same model at the same token
count costs different amounts on different calls — `usage.cost` is what the wallet debits, and the
`models` table prices are an estimate for pre-flight checks and the fallback only (decision 16).
And OpenRouter's 401 and 402 must **never** be passed through as ours: our 401 means "log in
again" and our 402 will mean the user's wallet is empty, neither of which is what the provider
meant (decision 15).

**Session 5's open decision is closed.** `MAX_TOKENS` is now draft 2000 / verdict 2500 /
rebuttal 2000 / final 3000 (decision 23), and no call has hit `finish_reason: 'length'` since. See
the `max_tokens` convention above for what that does *not* license the cost estimate to do.

**The reasoning-effort experiment was run and NOT adopted.** `reasoning: { effort: 'low' }` on the
drafting stage does three different things to three models: it cuts GPT-5 Mini's reasoning budget
(448 → 128 tokens) for 28% less latency with no loss of draft quality; it *switches thinking on*
for Gemini 2.5 Flash (0 → 344 tokens) for 46% more latency and 16% fewer words of answer; and
Llama 4 Maverick's apparent 88% regression is entirely OpenRouter routing between DeepInfra and
DigitalOcean, not the parameter. `callModel` keeps an optional `reasoning` argument, inert unless
passed — **no stage sets it**, and every debate request body is byte-identical to Session 5's.

**Two client behaviours that are not obvious from the code.** A round left running by a refresh or a
closed tab is picked up on load — the session detail names a round whose status is not `complete` or
`failed`, and subscribing to its stream replays the whole buffer. And **why stage 3 was skipped is
inferred when reading from the database**, because `rounds` has no `rebuttal_enabled` column: zero
rebuttal rows plus stage 2's verdict decides which of the engine's exactly two reasons is shown. A
third skip reason would make that inference wrong and must come with the column (decision 29).

**Next session:** the wallet — mockup 04. **Delete `createRoundRateLimiter` and its mount** rather
than building on it (decision 27), and put §8's actual pre-flight check on `POST /rounds`: debit
`credit_transactions`, count the two-debates-per-UTC-day free tier as a query against `rounds`
rather than a stored counter, and 402 on an empty wallet. While there, replace
`COMPLETION_ESTIMATE_RATIO` with per-stage averages read from `model_responses` — Session 8 measured
the constant quoting 2.4–2.7× high, and the rows to do better with are already in the table.
