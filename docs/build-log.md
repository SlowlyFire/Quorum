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

---

## Session 3 — 2026-08-11 · Authentication and authorization

**Goal:** email + password auth end to end — register, login, logout, `me` — with the JWT in an
httpOnly cookie, and the four pieces of authorization middleware that every later feature route
will be built on. No LLM calls, no debate logic.

**Scope decision taken at the start of the session: Google OAuth is deferred, not dropped.** The
reasoning and the full list of what is already in place for it are in `docs/decisions.md`,
decision 10. In short: the password path exercises every part of auth the project is assessed on,
and OAuth costs a Google Cloud project and per-environment redirect URIs for no new logic. It is
listed under **Extensions** at the foot of this section.

### Housekeeping done first

- **The seven §5 mockup images are committed** (`docs/mockups/`), closing the gap Session 2
  flagged. §7's ERD, `quorum-06-db-diagram.png`, is now in the repository rather than only inside
  the PDF. §5's prose says "Six diagrams are attached" and then lists seven — the list is right,
  the count is an erratum of the same family as decision 9's "nine tables" for ten. No decisions
  entry, since nothing in the build depends on it.
- **`DATABASE_URL` and `JWT_SECRET` are now required in every environment** (decision 11). Both are
  on the path of essentially every request, so a missing key should stop the process rather than
  surface as a 500 at the first request that needs it. `JWT_SECRET` additionally has to be ≥32
  characters when `NODE_ENV=production`. `.env.example` is regrouped into always-required,
  production-required and defaulted, with a one-liner for generating a secret.
- Consequently the `DATABASE_NOT_CONFIGURED` branch in `healthService` is **deleted** — that state
  is now unreachable, and dead code documenting an impossible condition is worse than no code.
  `DATABASE_UNAVAILABLE` stays.

### Dependencies added

`bcryptjs`, `jsonwebtoken`, `express-rate-limit`. Three, exactly as scoped. 0 vulnerabilities.

`bcryptjs` rather than `bcrypt` (decision 13): the native addon needs node-gyp and a compiler at
install time, which is a build failure waiting for the first deploy image whose toolchain differs.
Pure JS installs everywhere. Same `$2b$` format, so the choice is reversible with no data
migration.

### Built

**`src/services/tokenService.js`** — minting and reading the session JWT.

- `sign({ userId, role })` → HS256, 7-day expiry, secret from validated env.
- `verify(token)` → payload, or a 401 `UNAUTHENTICATED`. **`algorithms: ['HS256']` is passed
  explicitly**; verifying without an algorithm list lets a forged header pick the algorithm, which
  is the classic `alg: none` downgrade.
- Every failure mode — bad signature, wrong algorithm, expired, malformed, garbage — becomes the
  same 401 with the same message. The client has one remedy for all of them.
- Cookie `quorum_token`: `httpOnly`, `sameSite: 'lax'`, `secure` only in production, `path: '/'`,
  `maxAge` equal to the token's own expiry so the cookie and the claim inside it die together.
  `'lax'` rather than `'strict'` is deliberate — it is what will let the cookie survive the
  top-level navigation back from Google's consent screen.
- A separate `clearCookieOptions` (same attributes, no `maxAge`) for logout: a browser only
  replaces a cookie when name, path and the security attributes all match.

**`src/services/authService.js`** — the logic.

- `register` hashes at cost 10, then inserts. **Uniqueness is the database's `UNIQUE` constraint,
  caught as `23505` → 409 `CONFLICT`, not a `SELECT` first** — check-then-insert loses the race
  between two simultaneous sign-ups; the constraint cannot. The pg error is deliberately *not*
  attached as `cause`, because its `detail` reads `Key (email)=(...) already exists` and
  `errorHandler` prints the whole error object in development.
- `login` returns one message, one code, one timing for every failure. When the email is unknown it
  still runs a real bcrypt compare, against `ABSENT_USER_HASH` — a hash of a fixed string,
  generated at import so it always tracks `BCRYPT_COST`. Without it, an unknown email returns in
  ~2ms and a wrong password in ~70ms, and the response time is an account-enumeration oracle. A
  Google-only account (`password_hash IS NULL`) takes the same path.
- `getAuthenticatedUser(userId)` for `requireAuth`. A valid signature over a deleted user is a 401,
  not a crash.
- **Nothing in this file logs.** An email address next to a failure reason is a record of who tried
  to sign in and failed, sitting in a log file held to a lower standard than the `users` table.
- `toPublicUser` is the single place a row becomes wire shape: snake_case → camelCase, and the
  allow-list that keeps `password_hash` and `google_id` out. `credit_balance` is `numeric(12,6)`,
  which pg returns as a string; six decimals fit a double exactly, so the API hands out a number.

**Middleware.**

- `requireAuth` — cookie → verify → **load the user from the database** → `req.user`. The role in
  the payload is whatever was true when the token was minted, and a token lives seven days. Demote
  an admin and their old token still claims `admin`; the row wins, always.
- `requireRole(role)` — 403 `FORBIDDEN`. No caller yet; the admin catalogue routes in §10.
- `requireOwnership(loaderFn, { param })` — the factory Session 10 will mount on every session
  route. Takes an async `(id, req) => resource`, 404s if missing, 403s if the owner is not
  `req.user.id`, attaches `req.resource` so the handler does not fetch the same row twice. The
  loader is a **service** function — middleware never imports a model. Accepts `user_id` or
  `userId` on the resource, and a resource carrying neither fails closed to 403.
- `validate({ body, params, query })` — Zod at the edge. Writes the parsed value back over the raw
  one, so services receive the trimmed and coerced version. Reports **every** failing field, not
  just the first.
- `createAuthRateLimiter()` — a factory, so `/login` and `/register` get an instance each rather
  than sharing a budget; ten failed sign-ins should not also block creating an account. 10 per IP
  per 15 minutes, `standardHeaders: true`, and a `handler` that calls `next(httpError(429, …))` so
  a throttled client parses the same envelope as every other failure instead of the library's
  plain-text default. Mounted **before** `validate`, so a flood of malformed bodies is throttled
  too.

**`src/lib/httpError.js`** — new, and the counterpart to `errorHandler`: the one place an error is
*constructed*, as `errorHandler` is the one place it becomes a response. It exists so `status` and
`code` are never misspelled or forgotten — an `Error` without them is a 500 `INTERNAL_ERROR`, which
is right for a genuine bug and wrong for an expected refusal.

**`src/validation/authSchemas.js`** — email trimmed, lower-cased and *then* format-checked (piped
in that order, so `"  Ada@Example.COM "` validates rather than being rejected for its spaces),
capped at RFC 5321's 254. Password 8–200, length only, no composition rules. `displayName` 1–60,
trimmed. Both schemas are `.strict()`.

**Login deliberately does not reuse the 8-character minimum** — its password rule is "non-empty".
A short password must fail as 401 `INVALID_CREDENTIALS`, identical to any other wrong password; a
400 would say something about the input that a 401 does not.

**Routes and controller.** `POST /api/auth/register` → 201, `POST /api/auth/login` → 200, both
setting the cookie and returning `{ user }`; `POST /api/auth/logout` → 204, always, without reading
the incoming cookie (logging out cannot fail, and confirming whether someone was signed in is worth
nothing to them and something to an attacker); `GET /api/auth/me` → 200 `{ user }` behind
`requireAuth`. Controllers are four lines each — parse, call one service, respond. No SQL, no
bcrypt.

**`errorHandler`** now emits `error.details` when present and the status is below 500 (decision 12).

**`userModel.js` was not extended.** Session 2 had already built exactly the four functions this
session needed — `insertUser`, `findUserById`, `findUserCredentialsByEmail`, and the
`PUBLIC_COLUMNS` projection that keeps `password_hash` out of everything else. Worth recording as
a small vindication of writing the models layer ahead of its callers.

### Verified

Real curl against the running server and the live Supabase database. All thirteen checks, in order.

1. **Register** → `201 Created`. `Set-Cookie: quorum_token=…; Max-Age=604800; Path=/; HttpOnly;
   SameSite=Lax` — and no `Secure`, correct for `NODE_ENV=development`. Body:
   `{"user":{"id":"2cfde3fc-…","email":"ada@example.com","displayName":"Ada Lovelace",
   "role":"user","creditBalance":0,"createdAt":"2026-08-11T11:35:10.100Z"}}`. Posted as
   `"  Ada@Example.COM "` and `"  Ada Lovelace  "`, so this also proves normalisation. The string
   `password` occurs **0 times** in the response body.
2. **Same email again** → `409` `{"error":{"message":"An account with that email already exists",
   "code":"CONFLICT"}}`. Retried as `ADA@EXAMPLE.COM` → also `409`, so normalisation closes the
   duplicate rather than creating a second account.
3. **Password `"short"`** → `400` with
   `"details":[{"in":"body","field":"password","message":"must be at least 8 characters"}]`. A body
   bad in three places returns all three entries.
4. **Correct credentials** → `200` + a fresh `Set-Cookie`.
5. **Wrong password** → `401` `{"error":{"message":"Invalid email or password",
   "code":"INVALID_CREDENTIALS"}}`.
6. **Unknown email** → `401`, and `cmp` reports the two bodies **identical**, 78 bytes each,
   sha256 `a8f23271…70b559` for both. Neither response carries a `Set-Cookie`.
   Timing, 5 samples each after warm-up: wrong password 0.117 / 0.170 / 0.117 / 0.117 s, unknown
   email 0.116 / 0.221 / 0.116 / 0.118 / 0.210 s. Indistinguishable — both dominated by the same
   bcrypt compare plus the same round trip to Supabase.
7. **`/me` with the cookie** → `200` with the user.
8. **`/me` with no cookie** → `401` `{"message":"Authentication required","code":"UNAUTHENTICATED"}`.
9. **`/me` with a tampered cookie** → `401` for all four variants: signature byte flipped; payload
   re-encoded as `role: "admin"` with the original signature kept; `alg: none` unsigned; and a
   cookie that is not a JWT at all.
10. **Logout** → `204` with `Set-Cookie: quorum_token=; Expires=Thu, 01 Jan 1970 …; HttpOnly;
    SameSite=Lax`. The cookie jar afterwards holds no `quorum_token`, and `/me` with that jar → `401`.
11. **Eleven rapid logins** → ten `200`s with `RateLimit-Remaining` counting 9 down to 0, then
    `429` `{"error":{"message":"Too many attempts. Please try again in a few minutes.",
    "code":"RATE_LIMITED"}}` with `Retry-After: 898`. Our envelope, not the library's default text.
    `POST /api/auth/register` immediately afterwards still answered (409), confirming the two
    routes hold separate budgets.
12. **psql** → the row exists; `password_hash` is 60 characters, prefix `$2b$10$`, matches
    `^\$2[aby]\$10\$[./A-Za-z0-9]{53}$`, is not equal to the plaintext, and does not contain it.
    `google_id` null, `role` `user`, `credit_balance` `0.000000`.
13. `git log --oneline` / `git status` — recorded in the commit for this session.

**Two checks beyond the list, both about the "never trust the JWT for role" rule:**

- A token signed **with the real secret** carrying `{"userId":"2cfde3fc-…","role":"admin"}` →
  `/api/auth/me` returns `"role":"user"`. The signature is genuine; the claim is ignored because
  the row is read.
- A validly-signed token for a userId that does not exist → `401`, not a 500.

**Regression:** `/api/health` and `/api/health/db` still `200` after the `healthService` edit;
`/api/nope` still `404 NOT_FOUND`. The server log contains **0** occurrences of an email address.

### Left unfinished / known issues

- **Google OAuth is not built** (decision 10). `GET /api/auth/google` and its callback return 404.
- **The client is untouched this session.** No login or register form, no session bootstrap in
  `AuthContext`, still no protected-route wrapper — every client route remains reachable. The
  server is ready for all of it: `GET /api/auth/me` is exactly the bootstrap call, and
  `api/client.js` already sends `credentials: 'include'`.
- **`requireOwnership` and `requireRole` have no callers yet.** Both are verified by reading, not
  by request — there is no owned resource and no admin route to mount them on until Session 10.
  Neither should be trusted until its first real route exercises it.
- **`requireOwnership` returns 403, not 404, for a resource owned by someone else**, as specified.
  That confirms an id exists. The ids are uuids, so what leaks is "this uuid is somebody's" and
  nothing more; worth revisiting only if a resource ever gets a guessable id.
- **The rate-limit store is in-memory**, so it resets on restart and does not add up across
  processes. Fine for one instance; a shared store is the fix if this is ever scaled out. Note that
  steps 1–10 and step 11 above were run either side of a restart for exactly this reason — the
  counters had to be reset to demonstrate a clean run of eleven.
- **bcrypt truncates at 72 bytes** (decision 13). The schema permits 200 characters; only the first
  72 bytes authenticate. Accepted, not worked around.
- **`JWT_SECRET` in the current `.env` is 30 characters**, which is under the 32 the production
  check requires. Development is unaffected, but **it must be regenerated before deploying** —
  `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`, as noted in
  `.env.example`.
- **No token revocation.** Logout clears the cookie, but the JWT itself stays valid until it
  expires — anyone holding a copy could still use it. That is inherent to stateless JWTs. A
  `token_version` column on `users`, bumped on logout-everywhere and checked in `requireAuth`,
  is the standard fix if it is ever wanted.
- **`ada@example.com` is left in the database** as a usable development login (password
  `correct horse battery staple`). The throwaway probe row created during verification was deleted.
- Everything Session 2 listed as unfinished that is not named above still stands — the missing
  `updated_at` trigger on `sessions`, the unindexed FK columns, and the ledger's precision mismatch.

### Extensions (deferred, in priority order)

1. **Google OAuth 2.0** — `GET /api/auth/google` and `/api/auth/google/callback`. Everything it
   needs already exists: `users.google_id`, `findUserByGoogleId`, `attachGoogleId` for linking a
   Google identity to an existing password account, a provider-agnostic `tokenService`, and
   `sameSite: 'lax'` chosen so the cookie survives the redirect back. One route file, one service,
   one env key. No schema change.
2. **Password reset by email** — not in the spec at all, but the first thing a real user asks for.
3. **Token revocation** — a `token_version` claim checked against the row, as above.
4. **`requireRole('admin')` in anger** — the §10 admin catalogue panel is its only planned consumer.

### Next session

The client half of auth: login and register forms, `AuthContext` bootstrapping from
`GET /api/auth/me`, a `<ProtectedRoute>` wrapper, and redirect-after-login. Then the OpenRouter
service and the first single-model round.

---

## Session 4 — 2026-08-11 · OpenRouter integration and the prompt loader

**Goal:** the parts a debate is assembled from — a prompt template loader, one function that calls
one model, a JSON parser for what comes back, and the sampling defaults in one file. **No
orchestration.** Nothing in this session knows there are four stages or that models argue; that is
Session 5. Build the parts, prove they work, stop.

The client half of auth, named as next by Session 3, was **not** built — this session's brief
redirected to the LLM layer. It moves to Session 6.

### Housekeeping done first

**`OPENROUTER_API_KEY` is now required in every environment** (decision 14). `SUPABASE_URL` and
`SUPABASE_SERVICE_KEY` are the last two keys left in the production-only block, because Storage is
still unused. Same reasoning as decision 11: a key that every LLM call depends on should stop the
process at boot rather than become `Bearer undefined` and a 502 halfway through a round that has
already spent money on the drafts that succeeded.

### Built

**`src/services/promptService.js`** — the four templates, read once.

- Loads `prompts/01-draft.md` … `04-final.md` **at import**, not on first use, and caches the
  parsed pair. Stage keys are `draft` / `verdict` / `rebuttal` / `final`, which are the same four
  strings `model_responses.stage` accepts — the value written to a row and the key that fetched its
  prompt are one string, not two that have to agree.
- Splitting is on `/^##[ \t]+System[ \t]*$/m` and the same for `User`, anchored to the start of a
  line. Everything above `## System` — the `# Stage N` title, the note listing which variables to
  interpolate, the `---` rule — is documentation for whoever edits the file, and slicing forward
  from the heading drops all of it without needing a rule per line.
- Throws on: a file that cannot be read, a missing `## System`, a missing `## User`, `## User`
  appearing before `## System`, and either section being empty. All five are plain `Error`s, not
  `httpError`s — they kill the process rather than becoming a response.
- `render(template, vars)` replaces `{{VAR}}` and renders an absent or null variable as an empty
  string. That is what lets `01-draft.md` carry an `{{ATTACHMENTS}}` block that simply disappears
  on a round with no attachments, instead of a second template for the no-attachment case.
- `renderStage(stage, vars)` returns both halves rendered — what the orchestrator will actually
  call. Returned templates are frozen, so a caller cannot mutate the copy every later round
  inherits.
- **Nothing in `prompts/` was edited.** The directory is read-only to the server, and to this
  session.

`src/server.js` imports `PROMPT_STAGES` and logs the four stage names at start-up. The import is
what triggers the load, so a broken template is a boot failure with someone watching rather than a
half-run debate at 2am.

**`src/services/openrouterService.js`** — the only place the server talks to OpenRouter.

- `callModel({ modelSlug, system, user, maxTokens, temperature, images, timeoutMs })` returns
  exactly `{ content, promptTokens, completionTokens, cost, latencyMs, finishReason, raw }`.
  `raw` is the whole response body, so a caller needing a field this shape does not carry has it
  without a second call — and `finishReason` is returned rather than discarded because
  `'length'` is the only signal that a `maxTokens` ceiling is set too low.
- `stream: false`, and **no `usage: { include: true }` and no `stream_options`** — usage accounting
  is automatic on OpenRouter and both of those parameters are deprecated no-ops. `usage.cost` is
  read straight off the body.
- Cost falls back to `models` table arithmetic when `usage.cost` is absent, and says which path
  produced the figure on every log line (`source=usage` / `source=models-table` /
  `source=unknown`). A `findModelBySlug` failure during the fallback is caught: the call succeeded,
  and a database hiccup must not retroactively turn it into an error.
- 90s timeout via `AbortController`, with the timer covering the **body read** as well as the
  headers — a provider that accepts a connection and then stalls mid-response hangs a stage just as
  effectively as one that never answers. `controller.signal.aborted` is what distinguishes a
  timeout from a network failure, rather than matching on the error's name.
- One retry, 2s backoff, on 429 and 5xx only. 400/401/402/404 fail immediately, and so does a
  timeout (decision 17).
- Six mapped error codes, two of which deliberately do not match the provider's status
  (decision 15): OpenRouter's 401 becomes our 502, because ours means "log in again" and this is
  not that; OpenRouter's 402 becomes our 503, because ours will mean the user's wallet is empty and
  this is an outage. Messages are fixed text — `errorHandler` only suppresses the message of a 500
  in production, so the provider's own words (its 402 quotes our account balance) are attached as
  `error.providerMessage`, which nothing emits.
- `images: [{ mediaType, base64 }]` builds the OpenAI-compatible parts array with `image_url` data
  URIs. A text-only turn stays a plain string rather than a one-element array, since some providers
  still treat those differently. Unused until Session 11 — built now so the day attachments land is
  not also the day this signature changes.
- `fetchCatalogue()` — `GET /api/v1/models`. Not called at boot and not on any request path.
- **Nothing logs prompt or completion text.** The log line is slug, latency, tokens, cost, cost
  source and finish reason.

**`src/services/jsonResponse.js`** — `parseModelJson(content)`.

Three candidates in order: the trimmed text, the text minus its first fenced block, then whatever
sits between the outermost `{` and `}` of either. On total failure it throws 502
`MODEL_JSON_INVALID` with the raw text attached as `error.rawContent` — the field
`model_responses.error_text` will be written from. A value that parses but is not an object
(`"maybe"`, `42`, an array) is rejected here rather than failing two lines later in the caller;
every stage prompt asks for an object.

**`src/config/llm.js`** — `TEMPERATURE` (drafting 0.7, chairman 0.2, rebuttal 0.5), `MAX_TOKENS`
(draft 1200, verdict 1500, rebuttal 800, final 1500), and `STAGE_DEFAULTS` keyed by stage name so
the orchestrator holds one lookup key. Both chairman stages share the near-deterministic 0.2: a
chairman that returns a different verdict on the same drafts is measuring its own sampling noise
rather than the drafts.

**`scripts/verify-openrouter.js`** — `npm run verify:llm`. Reads the `models` table, writes nothing
anywhere, and costs about $0.0006 a run.

### Verified

47 checks, exit 0, against the live OpenRouter API and the live Supabase database.

1. **Templates.** All four load and split; the draft system section is 598 chars and its user
   section 29. The `# Stage 1` block and the `---` rule are gone from the loaded system text;
   `{{QUESTION}}` survives in the user section and renders to the question, with the absent
   `{{ATTACHMENTS}}` becoming empty rather than the literal `{{ATTACHMENTS}}`.
2. **Single call** — `meta-llama/llama-4-maverick`, 1079ms, 150/8 tokens, $0.00003557,
   `finishReason: 'stop'`, content `"The capital of France is Paris."`
3. **Parallel fan-out** — all four models, `Promise.allSettled`: 806ms, 1286ms, 1814ms, 4427ms.
   **Wall clock 4428ms against 8333ms of summed latency** — the fan-out overlaps, and the round is
   paced by its slowest member rather than the sum. That is the §11 mitigation, measured.
4. **`usage.cost` was present on all five real responses.** No call fell back.
5. **Cost maths** — 150 in / 8 out at the table's $0.0002/1k and $0.000696/1k computes
   $0.00003557; OpenRouter billed $0.00003557. Exact on this run, and *not* exact in general —
   see below.
6. **Failure paths.** A nonexistent slug → `OPENROUTER_BAD_REQUEST`, our 502 over provider 400,
   provider text `"quorum/model-that-does-not-exist is not a valid model ID"`. A 1ms deadline
   against a real model → `OPENROUTER_TIMEOUT`, 504, proving the abort path (`timeoutMs` is an
   override on `callModel` for exactly this; every real caller leaves it alone).
   Then the rest of the map, with `fetch` stubbed for the section and restored afterwards — no
   money spent, no request leaving the machine:

   | Stubbed | Attempts | Result |
   |---|---|---|
   | 500 then 200 | 2 | succeeds after a 2003ms backoff |
   | 503, 503 | 2 | `OPENROUTER_UNAVAILABLE` |
   | 429, 429 | 2 | `OPENROUTER_RATE_LIMIT` |
   | 401 | **1** | `OPENROUTER_AUTH` |
   | 402 | **1** | `OPENROUTER_INSUFFICIENT_CREDIT` |
   | 404 | **1** | `OPENROUTER_BAD_REQUEST` |
   | 200 with no `usage.cost` | 1 | cost computed from the models table, exact to the cent-fraction |
   | 200, no `usage.cost`, unknown slug | 1 | cost `null` — not a guess |

   The retry cases each measured ≥2000ms elapsed, so the backoff is real and not just intended.
7. **`parseModelJson`** — clean JSON, fenced JSON, and JSON preceded by "Certainly! Here is my
   response:" all parse to the right stance. Garbage throws `MODEL_JSON_INVALID` carrying the
   original string on `error.rawContent`.
8. **`fetchCatalogue`** — 402 models returned, all four seeded slugs still live with prices
   matching the seed.

**Boot-time guarantees, proven by breaking them.**

- `prompts/01-draft.md` moved aside → the process refuses to start:
  `Prompt template 01-draft.md could not be read: ENOENT`.
- A stand-in template with no `## System` → `Prompt template 01-draft.md has no "## System"
  heading. Looked in /Users/…/prompts.` Restored with `git checkout`; `git status prompts/` is
  clean and the file is byte-identical to before.
- `OPENROUTER_API_KEY=` → `Invalid environment configuration: - OPENROUTER_API_KEY: is required`.

**Log hygiene.** The verification log contains **0** occurrences of the question text on any
`[openrouter]` line. The six occurrences in the file are all the script's own deliberate printouts.

**Regression.** `/api/health` 200, `/api/health/db` 200, `/api/nope` 404 `NOT_FOUND`, and
`POST /api/auth/login` with the Session 3 development account still 200.

### The finding worth keeping

**The same model, at the same token count, costs different amounts on different calls.** Three
consecutive calls to `meta-llama/llama-4-maverick` came back served by Parasail ($0.0000107),
Google ($0.0000115) and DeepInfra ($0.0000060); a later one routed to DigitalOcean and matched our
table exactly. OpenRouter picks whichever upstream is available and bills that upstream's price,
and `models.input_per_1k` holds one number per model — so our table cannot be right for every route
by construction.

This is why `usage.cost` is what the wallet debits and the table is only an estimate, and why the
verification script's cost comparison is an order-of-magnitude check that **must not** be tightened
into an equality assertion. Recorded as decision 16.

### Left unfinished / known issues

- **No orchestration, by design.** Nothing calls `callModel` except the verification script. The
  four-stage engine, the shuffling and anonymising of drafts, the label→model mapping kept
  server-side, and the `Promise.allSettled` fan-out over a real council are all Session 5.
- **`prompts/README.md` rule 4 has nowhere to land.** It says to store a `prompt_version` on each
  round; `rounds` has no such column. Either a migration adds one in Session 5 or the rule is
  formally dropped — but leaving the templates unversioned while iterating on them is exactly the
  situation the rule warns about.
- **Parse-failure retry is not implemented.** README rule 3 says to retry a call once when its JSON
  will not parse, then record the failure in `model_responses.error_text` and continue.
  `parseModelJson` throws with the raw content attached, which is everything that retry needs, but
  the retry itself belongs to the orchestrator that does not exist yet.
- **The 90s timeout has never fired for real.** It has been proven at 1ms; the real ceiling is a
  guess informed by §11's "15–25 seconds" per round. Watch it once real four-stage rounds run.
- **`fetchCatalogue` has no refresh script.** It returns 402 models and nothing consumes them. The
  script that reconciles OpenRouter's prices against the `models` table is the obvious next use,
  and would have caught the routing-price finding above on its own.
- **The cost fallback reads the database on a path that otherwise does not.** Harmless — it only
  runs when `usage.cost` is missing, which happened zero times in real calls — but it does mean a
  provider outage and a database outage can now compound on the same call. The catch returns
  `cost: null` rather than failing the call.
- **`images` is untested against a real model.** The parts array is built and the shape is the
  documented OpenAI-compatible one, but no image has been sent. Session 11 is its first real
  exercise and should treat it as unproven until then.
- **`errorHandler` will emit these 502/503/504 messages to clients in production.** That is
  deliberate and the messages are fixed text, but it is worth re-reading them once the client
  renders errors — "The model provider is unavailable" is what a user will see.
- Everything Sessions 2 and 3 listed as unfinished still stands, other than the `OPENROUTER_API_KEY`
  promotion done above: no `updated_at` trigger on `sessions`, the unindexed FK columns, the
  ledger's precision mismatch, no client-side auth, no Google OAuth, and `requireOwnership` /
  `requireRole` still without a caller.

### Next session

Session 5: the debate engine. `sessionModel`, `roundModel`, `roundModelModel` and
`modelResponseModel`; the four stages wired together with `Promise.allSettled` on stages 1 and 3;
drafts anonymised and shuffled with the mapping kept server-side; and the first real four-stage
round persisted end to end.
