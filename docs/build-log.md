# Build log

One section per build session, appended in order. Earlier sections are never rewritten — if
something recorded here later turns out to be wrong, correct it in a later section.

---

## Session 1 — 2026-08-11 · Scaffolding

**Goal:** stand up the client and server skeletons and the documentation system. No auth, no
business logic, no LLM calls.

### Built

**`server/`** — Express 4, ES modules, Node 20+.

- `src/app.js` — cors (`credentials: true`, origin from `CLIENT_URL`), cookie-parser,
  `express.json`, `/api` router, then `notFound` and `errorHandler` last.
- `src/server.js` — listen only.
- `src/config/env.js` — dotenv + Zod. Empty strings are treated as absent so a copied
  `.env.example` cannot masquerade as configured. Throws with a per-key list on invalid config.
- `src/db/pool.js` — one `pg` Pool from `DATABASE_URL` with `ssl: { rejectUnauthorized: false }`,
  an `idle client error` listener, a `query(text, params)` helper that logs duration and row count
  in development, and `closePool()`.
- `src/middleware/errorHandler.js` — the only place an error becomes a response. Emits
  `{ error: { message, code } }`, status from `err.status || 500`, no stack in the body ever, and
  a generic message for unexpected 500s when `NODE_ENV=production`.
- `src/middleware/notFound.js` — converts unmatched routes into a 404 error so they flow through
  the same handler.
- Routes: `GET /api/health`, `GET /api/health/db`.
- `.env.example` with all eight keys, empty.

**`client/`** — Vite 7 + React 18 + React Router 6 + Mantine 8.

- Nine placeholder pages, one heading each: Landing, Login, Register, NewSession, Chat, Sessions,
  Wallet, Leaderboard, Shared.
- `App.jsx` routes all nine, using the spec's §6 paths (`/s/:shareToken`, `/chat/:sessionId`).
- `api/client.js` — fetch wrapper, `credentials: 'include'`, base URL from `VITE_API_URL`, throws
  an `ApiError` carrying `status` and `code` parsed from the server's error envelope.
- `context/AuthContext.jsx` — provider skeleton with `user`/`status`, plus a `useAuth` hook that
  throws outside the provider. No session bootstrap yet.
- `main.jsx` — `MantineProvider` → `BrowserRouter` → `AuthProvider` → `App`.

**Root** — `CLAUDE.md`, `README.md`, `.gitignore`, `docs/build-log.md`, `docs/decisions.md`.

### Key decisions

- **Versions.** Mantine pinned to **8.x**, not the current 9.x: Mantine 9 requires React 19 and
  the spec calls for React 18. Vite 7 with `@vitejs/plugin-react` 5 — the Vite 8 / plugin-react 6
  pairing pulls in extra required peer dependencies (`@rolldown/plugin-babel`,
  `babel-plugin-react-compiler`) that are outside the approved dependency list. Express held at
  4.x per spec. Nothing was installed beyond the approved lists.
- **No `models/` layer**, and **feature secrets optional in development** — both recorded with
  full reasoning in `docs/decisions.md`.
- **`notFound` produces an error rather than a response**, so the "errorHandler is the only place
  errors become responses" rule has no exception.
- **Health lives in a service**, not the controller, so the "all DB access via a service" rule is
  established by the first endpoint rather than retrofitted.

### Verified

- `npm install && npm run dev` in `server/` — starts clean, 0 vulnerabilities.
- `curl localhost:3000/api/health` → 200 `{"status":"ok","timestamp":"2026-08-11T10:04:43.979Z"}`,
  with `Access-Control-Allow-Credentials: true` and the origin header present.
- `curl localhost:3000/api/nope` → 404 `{"error":{"message":"Route not found: GET /api/nope",
  "code":"NOT_FOUND"}}` — confirms the error envelope.
- `npm install && npm run dev` in `client/` — Vite ready in 441 ms. `npm run build` succeeds,
  760 modules. Loaded `/` in Chrome: the Landing heading renders with Mantine styles applied.
  `/chat/demo-session-123` renders the Chat page, so param routes resolve.

### Left unfinished / known issues

- **`GET /api/health/db` has never run against a real database.** `DATABASE_URL` is unset, so it
  returns 503 `DATABASE_NOT_CONFIGURED` — which is the correct behaviour, but the actual
  `SELECT now()` path and the Supabase SSL setting are unproven. Re-verify as soon as the
  Supabase connection string exists.
- **`npm audit` reports 2 moderate advisories in react-router 6.x** (open redirect via backslash
  in `<Link>`/`useNavigate`; `deserializeErrors` constructor injection during SSR hydration).
  Both are fixed only in react-router 7, which the spec's "React Router v6" rules out. Neither is
  reachable here — the app is client-rendered with no SSR, and no user-controlled value is passed
  to `navigate()` yet. **Revisit before deployment**, and keep user input out of `navigate()`.
- React Router prints two v7 future-flag warnings in the console. Left alone deliberately —
  opting into `v7_startTransition` / `v7_relativeSplatPath` changes runtime behaviour, which is
  not a scaffolding decision.
- `server/src/db/migrations/` is empty (`.gitkeep` only). No tables exist.
- `client/src/components/` is empty (`.gitkeep` only).
- No protected-route wrapper on the client; every route is currently reachable.
- No test runner, linter or formatter — none were in the approved dependency list.

### Next session

Database schema and the first migrations, then auth.

---

## Session 2 — 2026-08-11 · Schema, migrations, model catalogue

**Goal:** the whole §7 schema live on Supabase, a migration runner that can be trusted to run
twice, a real model catalogue, and the `models/` layer the spec asks for. No auth, no debate
engine, no endpoints beyond the health checks already in place.

### Built

**Migration runner** — `server/src/db/migrate.js`, `npm run migrate`.

- Reads `src/db/migrations/*.sql`, sorted by filename.
- Tracks applied files in `_migrations (filename PRIMARY KEY, applied_at timestamptz)`.
- Each unapplied file runs inside its own `BEGIN`/`COMMIT`; on error it rolls back that file and
  exits 1, so the database is never left half-migrated. Failures re-throw with the filename
  attached.
- Logs each file with its duration; prints "nothing to apply" and exits 0 when up to date.
- Enables RLS on `_migrations` too, so `pg_tables.rowsecurity` is uniformly true across `public`.

**`001_initial_schema.sql`** — ten tables, uuid PKs with `gen_random_uuid()`, every timestamp
`timestamptz DEFAULT now()`, enums as CHECK constraints rather than Postgres enum types, costs
`numeric(14,8)` and wallet balances `numeric(12,6)`. Seven indexes. RLS enabled with zero policies
on every table.

Constraints worth naming:

- `users_credential_present` — `password_hash IS NOT NULL OR google_id IS NOT NULL`, so an
  account that can never be authenticated cannot exist.
- `model_responses_stance_is_rebuttal_only` — `stance IS NULL OR stage = 'rebuttal'`, enforcing
  §7's "(rebuttal stage only)" rather than trusting it.
- `sessions.share_token` uniqueness is declared as a unique **index**, not a column constraint, so
  the one object serves both the constraint and the `GET /api/share/:token` lookup.
- `credit_transactions.round_id` is `ON DELETE SET NULL` while everything else on the
  `users → sessions → rounds` chain cascades — deleting a session must not destroy the ledger.

**`002_seed_models.sql`** — four models, one per provider, from a live
`GET https://openrouter.ai/api/v1/models` (402 models in the response). Nothing typed from memory.

| Provider | Slug | in / 1k | out / 1k | Vision |
|---|---|---|---|---|
| Anthropic | `anthropic/claude-haiku-4.5` | 0.00100000 | 0.00500000 | yes |
| OpenAI | `openai/gpt-5-mini` | 0.00025000 | 0.00200000 | yes |
| Google | `google/gemini-2.5-flash` | 0.00030000 | 0.00250000 | yes |
| Meta | `meta-llama/llama-4-maverick` | 0.00020000 | 0.00069600 | yes |

All four are the working tier rather than the flagship, per §9's "development runs against cheap
small models". All four accept image input, which the attachments feature needs — that ruled out
otherwise-attractive options like `openai/gpt-oss-120b` and the text-only Llama 3.x line. Stable
slugs were preferred over `:preview` and `:batch` variants, which is why Google is 2.5 Flash rather
than the newer `gemini-3-flash-preview`. A four-model council is 8 calls and costs well under a
cent at these prices, so the $0.05 free-tier floor covers many rounds.

**`server/src/models/`** — the layer §8 asks for.

- `llmModel.js` — `listActiveModels`, `findModelById`, `findModelBySlug`, `findActiveModelsByIds`
  (resolves a whole council in one round trip; the caller compares lengths to spot a retired id).
- `userModel.js` — `insertUser`, `findUserById`, `findUserByEmail`, `findUserByGoogleId`,
  `findUserCredentialsByEmail`, `attachGoogleId`, `adjustCreditBalance`. `password_hash` is outside
  the default projection; exactly one function returns it and only login should call it.
  `adjustCreditBalance` does the arithmetic in SQL (`credit_balance = credit_balance + $2`) so two
  concurrent rounds cannot read the same starting balance and lose a debit.
- `healthModel.js` — `selectNow()`, so `healthService` holds no SQL either.
- Every function takes the query executor as its last argument, defaulting to the pool helper.
  Passing a transaction client's `query` is what will let the debate engine debit the wallet and
  write its ledger row atomically — and it is what let this session's verification run against the
  live database and roll back.

**`server/scripts/psql.js`** — `npm run psql -- -c '...'`. `DATABASE_URL` is decomposed into
libpq's `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE`/`PGSSLMODE` and handed to the child
through its environment, never interpolated into a command string: a connection URI on the command
line lands in shell history and is visible to anyone who can run `ps`. Resolves the binary from
`PSQL_BIN`, then `PATH`, then the two Homebrew keg-only locations.

**Note on psql as a dependency:** psql was not installed on this machine and was added with
`brew install libpq`. It is a **local development convenience, not a project dependency** — the
server reaches Postgres through `pg`, so no deploy host needs libpq and nothing was added to
`package.json` dependencies.

### Key decisions

All recorded with full reasoning in `docs/decisions.md` (entries 4–9): the `models/` layer reverses
Session 1's decision 1; `rounds.user_id` is denormalised for the free-tier check;
`round_models.role` is three-valued; `attachments.round_id` is nullable; `model_id` FKs are
RESTRICT; and the spec's "nine tables" is an erratum for ten.

The one worth repeating here, because it is a trap rather than a trade-off: **`round_models.role`
is `drafter` / `chairman` / `both`.** Drafting queries must say `role IN ('drafter', 'both')` and
judging queries `role IN ('chairman', 'both')`. A bare `role = 'drafter'` silently excludes every
round in which the chairman also drafted — exactly the rounds the leaderboard denominator is
counting.

### Verified

Against the live Supabase database, not a local one.

- `npm run migrate` → `2 migration(s) pending`, `applied 001_initial_schema.sql (650ms)`,
  `applied 002_seed_models.sql (325ms)`, `done`. Exit 0.
- `npm run migrate` again → `nothing to apply — database is up to date`. Exit 0. Idempotent.
- `curl localhost:3000/api/health/db` → **200** `{"status":"ok","now":"2026-08-11T10:58:10.413Z"}`.
  This is the first time this endpoint has run against a real database; Session 1 left it unproven.
  The Supabase SSL setting in `db/pool.js` is now confirmed working.
- `npm run psql -- -c '\dt'` → 11 relations: the ten schema tables plus `_migrations`.
- `SELECT display_name, openrouter_slug, input_per_1k FROM models ORDER BY input_per_1k` → the four
  seeded rows, cheapest first: Llama 4 Maverick, GPT-5 Mini, Gemini 2.5 Flash, Claude Haiku 4.5.
- `SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname='public'` → all 11 rows `t`.
- Models layer: every exported function called against the live database inside a transaction that
  was then rolled back — `SELECT count(*) FROM users` is back to 0 afterwards. Confirmed
  `password_hash` is absent from `insertUser`'s returned row and present in
  `findUserCredentialsByEmail`'s. Confirmed `users_credential_present` rejects an account with
  neither credential, and `users_role_check` rejects `role = 'wizard'`.

### Left unfinished / known issues

- **`DATABASE_URL` is still optional in `config/env.js`.** Decision 2 said to move each key into
  the always-required block in the session that starts using it. This session started using it —
  but auth lands next and moves `JWT_SECRET` at the same time, so both are done together then. If
  that slips, `DATABASE_URL` should move regardless.
- **No `updated_at` trigger on `sessions`.** The column exists and defaults to `now()`, but nothing
  maintains it yet; whichever service first mutates a session must set it explicitly or a trigger
  must be added.
- **Only FK columns named in the session's index list are indexed.** `presets(user_id)`,
  `attachments(round_id)`, `round_models(model_id)`, `preset_models(model_id)` and
  `rounds(chairman_model_id)` have no index, so cascade deletes and reverse lookups on those do
  sequential scans. Harmless at demo scale; revisit if a delete ever feels slow.
- **`credit_transactions.amount` is `numeric(14,8)` but `balance_after` is `numeric(12,6)`**, to
  match `users.credit_balance`. A debit smaller than 0.000001 therefore rounds in the stored
  balance. That is inherent to the specified balance precision, not a bug, but the wallet service
  should be aware that the ledger's amounts carry two more decimal places than its balances.
- Seven of the eleven model files do not exist yet — they arrive with the features that need them.
- The ERD image `quorum-06-db-diagram.png` referenced by §7 is not in the repository; only the
  `.md` and `.pdf` are. The diagram was read out of the PDF to build this schema. Worth committing
  the six mockup images alongside the document at some point.

### Next session

Auth: register, login, Google OAuth, JWT in an httpOnly cookie, ownership middleware, and
`GET /api/auth/me`. `JWT_SECRET` and `DATABASE_URL` move into the always-required env block.
