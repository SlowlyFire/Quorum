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

---

## Session 5 — 2026-08-11 · The four-stage debate engine

**Goal:** the core of the product. `runRound` as a callable service — four stages, real models,
every call persisted — with no HTTP and no SSE. Session 6 mounts it behind
`POST /api/sessions/:id/rounds` and turns its event stream into SSE frames.

**Six real debates ran end to end.** Five completed, one failed on purpose. 48 checks, exit 0,
34 OpenRouter calls, $0.033.

### The conflict resolved before any code was written

`prompts/02-verdict.md` asks the chairman for `"verdict_type": "pick" | "merge" | "synthesise"`.
§7's enumerated values, and the CHECK constraint that has been in the database since migration 001,
are `picked` / `merged` / `synthesised`. Both files are frozen, so "write `verdict_type` from the
chairman's response" could not be done literally — it would have failed every round on the
constraint.

Resolved by asking rather than choosing. One exported map in `debateService.js`,
`VERDICT_TYPE_MAP`, normalising at parse time; the four templates are the models' vocabulary and §7
is the system's, and that map is the only place they meet. Aliases (`synthesize`, and the past-tense
forms) are accepted but log a warning with the raw value; a word in neither map raises
`MODEL_JSON_INVALID` and takes the retry-once path rather than being guessed at. Decision 18.

### Built

**Migration 003** — three columns, no constraint changes, so RLS is untouched.

- `rounds.prompt_version text NOT NULL DEFAULT 'v1'` — `prompts/README.md` rule 4, which had had
  nowhere to land since Session 4. `PROMPT_VERSION` lives in `promptService.js` and must be bumped
  by hand when a template changes materially.
- `rounds.open_questions text` — 04-final.md returns it, and §2 argues a stated open question beats
  false consensus, so it needs somewhere to live other than inside the chairman's raw JSON.
- `model_responses.provider text` — which upstream OpenRouter routed to. See "what the provider
  column immediately showed" below.

**Models layer** — `sessionModel`, `roundModel`, `roundModelModel`, `modelResponseModel`. Seven of
eleven model files now exist. All SQL is still confined to `src/models/`.

- `roundModelModel.insertRoundModels` writes the whole council in one statement, via
  `unnest($2::uuid[], $3::text[])` rather than a built-up `VALUES` list — the row count varies per
  round, and assembling placeholders by string concatenation is how a parameterised query stops
  being one.
- `sessionModel.touchSession` — `sessions.updated_at` has existed since migration 001 with nothing
  maintaining it, which Session 2 flagged as waiting for the first service to mutate a session.
  Starting a round is that mutation, and it is what "last activity" on a conversation means.
- `roundModel` has `setRoundVerdict` (stage 2), `completeRound` (stage 4) and `failRound`. The last
  writes `total_cost` and `duration_ms` on the way out: the calls that ran before a round died were
  still billed, and a failed round showing `total_cost` 0 would understate what it spent.

**`src/services/debateService.js`** — `runRound({ sessionId, userId, prompt, council, onEvent })`.

*Before anything is spent:* `planCouncil` resolves the line-up or throws. The chairman must be in
the council; a model may appear only once (`round_models` is keyed `(round_id, model_id)`, so a
duplicate would otherwise fail on the primary key several statements later with a much worse error);
and there must be at least two drafters, or `INSUFFICIENT_COUNCIL` names both minimums — 3 models
when the chairman abstains, 2 when it drafts. No round row is created, so nothing is billed and
nothing is left half-written.

*Stage 1.* Round row and `round_models` first, with roles `chairman` / `drafter`, or `both` when the
chairman drafts. Drafters are **shuffled and then labelled** in shuffled order, so a label carries
no information about the council's own ordering. The label→model array stays in memory; what reaches
the chairman is `formatDrafts()` output and nothing else. `Promise.allSettled` fans out; every
outcome is persisted in label order, successes and failures alike, so `created_at` reads A, B, C.
Fewer than two successful drafts is `INSUFFICIENT_DRAFTS` and a failed round — one voice is not a
debate, and a "verdict" over a single draft would be a much worse product than an honest failure.

*Stage 2.* `{{DRAFTS}}` as `### Response A\n<content>`, in label order. Parsed, then shape-checked:
`verdict_type` normalised, `winner_labels` an array containing only labels actually issued in this
round, `answer` a non-empty string, and `picked`/`merged` required to name at least one winner. A
shape failure raises the same `MODEL_JSON_INVALID` as a parse failure, so **one** catch covers both
and both get the same single retry with a corrective instruction appended. **Both attempts are
persisted** — the failed one keeping the unparseable text in `content` and the reason in
`error_text` — so a stage can legitimately have two rows, and the last one without an error is the
one that counts.

*Stage 3.* Skipped, with a `stage_skipped` event, when `rebuttal_enabled` is false or the verdict is
`unanimous` (decision 19). Otherwise **every model that drafted** gets a call, not just the ones
that lost: a merge or a synthesise has no single loser, and treating all drafters alike removes a
special case rather than adding one (§2). Each is parsed independently, and a drafter that returns
bad JSON loses its voice in stage 4 without taking the round down. `revised_answer` is required when
the stance is `revise`, since a revision with nothing to adopt is not a revision.

*Stage 4.* `{{REBUTTALS}}` as `### Response A — CONCEDE\n<argument>`, and a revision carries its
corrected answer too — 04-final.md tells the chairman a revision "may contain a correction worth
adopting", which it cannot judge from the argument alone. When stage 3 was skipped, or ran and
produced nothing usable, the block says so **in words**: a blank `{{REBUTTALS}}` would read as "the
drafters said nothing", which is a different claim from "no rebuttals were invited".

*Error policy.* One `try` around all four stages: any throw marks the round `failed` with its cost
and duration, emits `round_failed`, and rethrows. `failRound` is itself wrapped, so a database
failure is logged without masking the error that explains the round. `onEvent` is wrapped per call
— a debate's narration must never be able to kill the thing it narrates, or a client that
disconnects mid-round would take a paid-for round with it.

### What the `provider` column immediately showed

Within a single round, `Llama 4 Maverick` drafted via **Novita** and rebutted via **DeepInfra**.
Same model, same round, two upstreams, two price points. Decision 16 predicted this from three
consecutive calls in Session 4; it is now visible per row in the ledger, which is exactly what the
column was added for.

### Verified

`npm run verify:debate` — 48 checks, exit 0. It writes to the database on purpose and leaves
everything behind, because step 7 is only meaningful if the rows are still there.

1. **Full 3-model round, chairman abstaining.** The event stream in order —
   `round_started` → `stage_started(draft)` → two `response_ready` → `stage_started(verdict)` →
   `response_ready` → `verdict` → `stage_started(rebuttal)` → … → `stage_started(final)` →
   `response_ready` → `round_complete`. Verdict `picked`, winner A; Llama conceded; final answer
   1692 characters; 6 calls, $0.00597293, 46.7s.
2. **Anonymity, proven on the exact string.** The `{{DRAFTS}}` block the chairman received is
   returned by `runRound` so it can be checked rather than asserted. Every display name, slug and
   vendor prefix of every seated model was searched for — `openai`, `gpt-5 mini`,
   `meta-llama`, and the rest — **zero hits**, and every `###` line matches
   `^### Response [A-Z]+$`.
3. **4-model round with the chairman drafting.** `round_models` shows Claude Haiku 4.5 as `both`
   and the other three as `drafter`; four drafts were produced and the chairman is among them.
4. **"What is 17 times 4?"** Both drafters said 68. The chairman returned **`picked`, not
   `unanimous`** — it preferred the draft that showed the working — so stage 3 ran and the skip was
   not exercised here. Recorded rather than retried into submission: the chairman's unanimity
   judgement is not something the engine controls.
4b. **`rebuttalEnabled: false`** takes the identical branch deterministically: `stage_skipped`
   fired, no rebuttal calls were made, the round completed in 4 calls, and the `{{REBUTTALS}}` block
   read "No rebuttal stage was held for this round — rebuttals are disabled for this session."
   A **genuine `unanimous` skip also occurred**, in step 5's round, so both routes into the branch
   are proven by live rounds.
5. **A drafter that fails.** A real `models` row carrying a slug OpenRouter refuses — the shape of a
   model retired upstream while still active in our catalogue. `response_failed` fired, two of three
   drafts succeeded, the round completed, and psql shows the failure row with
   `OPENROUTER_BAD_REQUEST … is not a valid model ID` in `error_text` and a null provider. The
   failed drafter got no rebuttal call.
5b. **`INSUFFICIENT_DRAFTS`** — two of three drafters sabotaged. The round threw, `round_failed`
   fired, **the chairman was never called**, the row is `failed` with `verdict_type` and
   `final_answer` null, all three draft calls are persisted, and the one that succeeded is still
   billed to the round (`total_cost 0.00026962`, `duration_ms 21418`).
6. **`INSUFFICIENT_COUNCIL`** — 2 models, chairman abstaining. 400, and the message names both
   minimums. `SELECT count(*) FROM rounds WHERE session_id = …` is **0 before and 0 after**: the
   council was rejected without creating a round or making a call.
7. **The whole round on disk, read through psql** rather than through our own model layer — a
   different client is what makes it a proof.

   ```
     stage   | anon_label | provider  | stance  |    cost
   ----------+------------+-----------+---------+------------
    draft    | A          | OpenAI    |         | 0.00158550
    draft    | B          | Novita    |         | 0.00016143
    verdict  |            | Google    |         | 0.00095370
    rebuttal | A          | OpenAI    |         | 0.00182050
    rebuttal | B          | DeepInfra | concede | 0.00022520
    final    |            | Google    |         | 0.00122660

     status  | verdict_type | prompt_version | total_cost | duration_ms | answer_chars
   ----------+--------------+----------------+------------+-------------+--------------
    complete | unanimous    | v1             | 0.00597293 |       46713 |         1692
   ```

   Plus: `total_cost` on disk matches the returned total to the eighth decimal; one row per call
   with all four stages present; every successful call recorded its upstream; `anon_label` set on
   drafts and rebuttals and null on chairman stages; `stance` only ever on rebuttal rows.
8. **34 calls, $0.03345251** for the whole script.

**`npm run verify:llm` re-run after the transport change: 51 checks, exit 0.**

### Two live-provider faults found by running it, and one still open

**Fixed — a 200 that is really a failure.** `google/gemini-2.5-flash` answered **HTTP 200 with
`finish_reason: 'error'`**, zero tokens and empty content four times across today's runs, after 3 to
20 seconds. Session 4's `callModel` returned that as a success with `content: ''`, which the engine
counted toward its two-draft quorum — it would have sent the chairman a headed but empty
`### Response A`. `callModel` now throws `OPENROUTER_UNAVAILABLE` for an errored finish reason or
empty content, and carries the tokens, cost, latency and upstream on `error.usage` so the engine can
still bill the failed call. Decision 21, and case (k) in `verify:llm` locks it down offline.

**Still open, and it needs a decision: `MAX_TOKENS.rebuttal = 800` is too low for a reasoning
model.** `openai/gpt-5-mini` hit `finish_reason: 'length'` on its rebuttal in **four calls across
three runs** — 800/800 and 768/800 among them — truncating the JSON mid-object, which
`parseModelJson` then correctly rejects. The round survives, as designed, but that drafter's
concession or defence is lost and the call is billed anyway: $0.0018 for nothing, twice in one
script. It is intermittent — the same model returned 774 and 666 completion tokens successfully on
other calls — which makes it the worst kind of failure.

The cause is that a reasoning model spends completion tokens on internal reasoning before it writes
a character of the JSON, so a ceiling sized for "2-3 sentences plus one revised answer" is sized for
the visible output only. **The value 800 was specified in the Session 4 brief, so it has not been
changed.** The recommendation is to raise `MAX_TOKENS.rebuttal` to 1500, matching verdict and final.

**Latency is well above §11's estimate.** §11 assumes 15–25s per round; the observed completed
rounds were 8.3s, 13.3s, 21.8s, 24.0s, 34.8s and 46.7s. The spread is almost entirely
`openai/gpt-5-mini`, which took 11.5s to draft and 15.9s to rebut in one round. Worth knowing before
Session 6 builds the SSE progress UI: the stage-by-stage stream is not a nicety at these durations.

### Left unfinished / known issues

- **The skip of stage 3 is not persisted.** `rounds` has no `rebuttal_enabled` column — it is on
  `sessions` and `presets` — so a round whose rebuttals were skipped is indistinguishable on disk
  from one where every rebuttal call failed: both have zero rebuttal rows. `runRound` returns
  `rebuttalSkipReason` and emits `stage_skipped`, but neither survives the request. A
  `rebuttal_enabled` column on `rounds`, snapshotted like `chairman_abstains` already is, is the
  fix.
- **`rounds.verdict_type` is not a reliable record of what stage 2 decided** (decision 20). The
  chairman returned `unanimous` in stage 4 in three of five completed rounds, after concessions. The
  leaderboard should take the win from stage 2's `winner_labels`, not from this column.
- **A chairman stage can have two `model_responses` rows** — the retry is persisted alongside the
  attempt that succeeded. Any reader of a round must take the last row for a stage with a null
  `error_text`, not "the row for that stage". Session 7's `GET /api/rounds/:id` has to know this.
- **Nothing debits the wallet.** `total_cost` is written to the round and no `credit_transactions`
  row is created; no pre-flight cost check and no free-tier count runs before stage 1. Session 8.
- **No `attachments` support in the engine.** `{{ATTACHMENTS}}` is rendered as an empty string and
  `callModel`'s `images` parameter is not passed. Session 11.
- **`chairman_abstains: false` is not the default and should not become one.** §2 keeps it as a
  toggle so the self-preference effect can be observed, and the 4-model round in step 3 is the only
  place it has been exercised. Worth watching whether a chairman that drafted picks its own draft:
  it did, in step 3 — winner C was its own — which is a single observation and not yet a finding.
- **`INSUFFICIENT_DRAFTS` leaves a `failed` round with a verdict of null and two paid-for draft
  rows.** Correct, but there is no refund path; the wallet session should decide whether a round
  that never reached a verdict is billable.
- **The verification script retries a round once** if it fails for an unplanned reason, and says so
  loudly when it does. That is not the engine retrying — it is the script refusing to score a live
  provider dropout as a defect. It fired once in the final run, on the gemini fault above.
- **`debate-verify@example.com` and its six sessions are left in the database**, by design.
- Everything Sessions 2–4 listed as unfinished that is not named above still stands.

### Next session

Session 6: the HTTP surface for a debate. `POST /api/sessions/:id/rounds` behind `requireAuth` and
`requireOwnership` — which finally gives that middleware its first real caller — Zod schemas for the
council body, `GET /api/rounds/:id`, and `GET /api/rounds/:id/stream` turning the nine `onEvent`
events into SSE frames. Then the client half of auth, deferred from Session 4.

---

## Session 6 — 2026-08-11 · The HTTP surface and SSE

**Goal:** put the Session 5 engine behind HTTP. Five session endpoints, three round endpoints, and
a Server-Sent Events channel that survives the race it exists for. No wallet and no free-tier check
(Session 9), no React (Session 7).

**86 checks, exit 0**, against a running server and the live Supabase database. Four real debates,
all four completed, $0.0316. Plus a timeboxed experiment: 18 more calls, $0.0212.

### Three decisions recorded before any code was written

**`MAX_TOKENS` raised** — draft 1200 → 2000, verdict 1500 → 2500, rebuttal 800 → 2000, final
1500 → 3000 (decision 23). `max_tokens` is a ceiling, not a spend: we are billed for what a model
generates, so headroom is free and a truncation costs the entire call. Session 5's 800 for
rebuttals was sized for the `argument` field and ignored `revised_answer`, which can be a full
replacement answer — and ignored that a reasoning model spends completion tokens before it writes a
visible character. `config/llm.js` now carries `COMPLETION_ESTIMATE_RATIO = 0.4` beside it, with a
comment saying what it is for and when to delete it.

**The pre-flight cost estimate must not use `max_tokens` as its worst case.** With the new ceilings
that would roughly double every quote and push paying users onto the free tier. Estimate completion
at 40% of the ceiling for now; Session 9 will have hundreds of `model_responses` rows and should
derive the figure per stage from our own traffic instead. Written into `CLAUDE.md` as well as
decision 23, because Session 9 will read the former and may not read the latter.

**Leaderboard scoring is stage 2's `winner_labels`, never `rounds.verdict_type`** (decision 26).
Decision 20 recorded this as an observation; it is now a rule, in bold, in `CLAUDE.md`'s
conventions. Stage 2 is the blind evaluation of anonymised drafts and the only place a model is
judged on its answer. Stage 4 returns `unanimous` once everyone has conceded — it did in three of
this session's four rounds — which would score a decisive round as a draw. Both columns are kept
and `GET /api/rounds/:id` returns both, as `verdictType` and `verdict`.

**And one deviation logged:** observed round latency is 8–47s against §11's 15–25s estimate
(decision 24). The spread is dominated by individual reasoning models rather than by the stage
count, and it is the reason a 47-second HTTP request was never an option.

### Built

**Migration 004 — `session_models`.** §7's ERD has nowhere for a session's council to live, while
§4, §6 and §8 all describe one; recorded as a gap in the diagram rather than a departure from it
(decision 22). Shaped to match `preset_models` exactly: composite primary key, `is_chairman`,
`ON DELETE CASCADE` to sessions and `ON DELETE RESTRICT` to models, RLS on with zero policies. All
twelve tables in `public` now report `rowsecurity = t`.

The migration's header comment carries the three-tier table, because this is the thing later
sessions will get wrong: `preset_models` is a reusable template, `session_models` is the session
default and is mutable, `round_models` is the immutable per-round snapshot. The same table now
appears in `CLAUDE.md`.

**Models layer** — `sessionModelModel.js` is new (insert / list / delete / list-for-many, the
insert through `unnest` like `roundModelModel`). `sessionModel` gains `listSessionsByUser` with a
correlated `round_count` subquery, `countSessionsByUser`, a COALESCE-based partial `updateSession`,
and `deleteSession`. `llmModel` gains `findModelsByIds` — the same query as
`findActiveModelsByIds` without the `is_active` filter, which is what lets a refusal say *unknown*
or *retired* rather than collapsing both into "missing". `modelResponseModel` and `roundModelModel`
each gain a by-session variant so `GET /api/sessions/:id` is five queries flat rather than one per
round.

**`db/pool.js` gains `withTransaction(run)`**, handing the callback an executor with the same
`(text, params)` shape as `query`. That is what every model function taking its executor last has
been for since Session 2, and creating a session with its council — or replacing one — is its first
real use. `BEGIN`/`COMMIT`/`ROLLBACK` is the one piece of SQL outside `src/models/`: it is
transaction control, not a statement against a table, and putting it in a model would mean choosing
a table it does not belong to.

**Two small changes to the Session 5 engine**, both to serve the 202:

- `planCouncil` is now exported. POST answers before the debate runs, so every refusal that belongs
  to the caller has to be raised in front of that response — and raising it by calling the same
  function the engine calls is the only way the two cannot drift.
- `runRound` accepts an optional pre-created `round` row. `roundService` inserts it so the id in
  the 202 already resolves; absent, the engine creates its own, which is how `verify:debate` and
  every direct caller still work unchanged.

**Services.** `councilService` — the two questions both sessions and rounds ask of a council (do
these models exist, are they active) plus the session-council reader, so the answers cannot differ
by route. `sessionService` — create, list, detail, update, delete, and `toPublicSession`, the one
place a sessions row becomes wire shape. `roundService` — `startRound`, `getRoundDetail`, and the
round-shaping helpers `sessionService` borrows for its own detail view. `roundStreamService` — the
registry, below.

**Validation** — `sessionSchemas.js` and `roundSchemas.js`. The division with the service is
deliberate: everything checkable from the request alone is Zod's (shape, uuid format, duplicate
model ids, and whether the nominated chairman is one of the models listed, which is reported as a
field-level `details` entry naming the id); whether those uuids name live models is the database's
and comes back as `UNKNOWN_MODEL` or `INACTIVE_MODEL`. Councils are capped at 8 models because a
round is up to 2N calls, and pagination at 50 because `?limit=100000` on a list that loads a
council per row is a denial-of-service lever handed to any signed-in user.

**Routes.** `requireOwnership` finally has callers — seven of them. Middleware order on every `:id`
route is `requireAuth`, `validate`, `requireOwnership`, and the middle one is not cosmetic: the
ownership loader passes `req.params.id` straight into a query, so a non-uuid would reach Postgres
and return as a 500 `invalid input syntax for type uuid` instead of the 400 it is. Verified — a
malformed id is `400 VALIDATION_ERROR`.

| Method | Path | Result |
|---|---|---|
| POST | `/api/sessions` | 201 `{ session }` |
| GET | `/api/sessions` | `{ sessions, pagination }`, newest activity first |
| GET | `/api/sessions/:id` | session + rounds + every response |
| PATCH | `/api/sessions/:id` | rename, re-crew, or change either debate setting |
| DELETE | `/api/sessions/:id` | 204 |
| POST | `/api/sessions/:id/rounds` | **202** `{ roundId, sessionId, status, streamUrl }` |
| GET | `/api/rounds/:id` | full round, both verdicts, the label→model map |
| GET | `/api/rounds/:id/stream` | SSE |

### The SSE registry, and the race it exists for

A client cannot connect before POST returns, so events *are* emitted before anyone is listening.
Measured: 5.0 seconds after the 202, with no client attached, the server had already buffered
`round_started` and `stage_started`. Without a buffer those two frames are lost every single time,
and the bug presents as "sometimes the first draft never arrives" rather than as a race.

So `roundStreamService` keys a Map on roundId holding `{ events, subscribers, status, createdAt,
nextId }`. Every event is appended to `events` **and** pushed to subscribers, and a new subscriber
is written the whole buffer before it joins the fan-out — with no `await` between the two, which is
what makes it impossible to connect into the gap. Each frame carries a monotonic id, so a client
that drops can send `Last-Event-ID` and receive only what it missed.

- **Frame format** `id: 7\nevent: response_ready\ndata: {…}\n\n`. `JSON.stringify` cannot emit an
  unescaped newline, so `data:` is always exactly one line and the multi-line folding the SSE
  grammar allows for is never needed.
- **Headers** `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache,
  no-transform`, `Connection: keep-alive`, `X-Accel-Buffering: no`, then `res.flushHeaders()`.
  `no-transform` is the documented opt-out that the `compression` middleware honours — no
  compressor is mounted today, and `app.js` now carries a comment saying what would happen if one
  were and why that header must not be tidied away.
- **Heartbeat** `:\n\n` every 15s. Two fired during the 33-second transcript below.
- **Close** on `round_complete` or `round_failed`; the buffer is kept 15 more minutes so a client
  reconnecting just after the end still gets the whole round, then the entry is dropped and the
  route 404s — which is what stops an `EventSource` retrying a dead round forever, and what tells
  the client to fetch `GET /api/rounds/:id` instead.
- **Leak** `req.on('close')` removes the subscriber and clears its heartbeat. A writer left in the
  set after its socket has gone is the classic SSE leak: every later frame is written into a dead
  connection and the timer keeps the entry referenced for the life of the process.
- **Ownership** applies to the stream exactly as to the read — `requireAuth` then
  `requireOwnership`. Verified rather than assumed: another user gets 403 with
  `Content-Type: application/json`, not a half-open stream, and no cookie gets 401.

**The registry is per-process and in memory.** A restart mid-debate orphans the stream: the round
still completes and is readable through `GET /api/rounds/:id`, but its remaining frames go nowhere
and a client watching sees the connection drop. Acceptable on a single instance. The fix if this is
ever scaled out is a shared bus — Postgres `LISTEN`/`NOTIFY` or Redis — not a bigger Map.

### Verified

`npm run verify:http` — 86 checks, exit 0. It writes to the database and leaves everything behind,
because step 10 is only meaningful if the rows are still there.

1. **`POST /api/sessions` → 201**, council of three returned with the nominated chairman flagged,
   `roundCount: 0`. `GET` it back → 200 with a byte-identical council; `GET /api/sessions?limit=5`
   has it first with `{ limit: 5, offset: 0, total, hasMore }`.
2. **A chairman not on the council → 400**, and the id is named in a field-level detail:
   `{"in":"body","field":"council.chairmanId","message":"9dcc2bc6-… is not one of the models on
   this council"}`. An unknown id → `400 UNKNOWN_MODEL` naming it. A model flipped to
   `is_active = false` in SQL for the duration of the check → `400 INACTIVE_MODEL`, *"Llama 4
   Maverick (9dcc2bc6-…) is no longer available"*, and the model was restored and re-checked. A
   two-model council with the chairman abstaining → `400 INSUFFICIENT_COUNCIL` naming both minimums,
   at creation rather than at the first round.
3. **`POST /api/sessions/:id/rounds` → 202 in 265ms**, returning `roundId`, `sessionId`, `status`
   and `streamUrl`. `GET /api/rounds/:id` **immediately** afterwards → 200 `status: drafting`: the
   id in the 202 already resolves.
4. **The race, demonstrated.** 5.0s after the POST and before any client existed, the server had
   buffered 2 events. The subscriber then connected and received them both inside 250ms, starting
   at `id: 1`, followed by 13 live frames — ids 1..15 with no gaps.
5. **A full transcript**, t=0 at the moment of connection, 5.3s after the POST:

   ```
     id  t+ms     Δms   event            payload
      1     142     142  round_started    chairman=Claude Haiku 4.5 drafters=2
      2     143       1  stage_started    stage=draft
      3    9715    9572  response_ready   draft A GPT-5 Mini 14136ms
      4    9793      78  response_ready   draft B Gemini 2.5 Flash 5547ms
      5    9862      69  stage_started    stage=verdict
      6   18538    8676  response_ready   verdict (chairman) Claude Haiku 4.5 8600ms
      7   18619      81  verdict          merged winners=[A, B]
      8   18701      82  stage_started    stage=rebuttal
      9   28380    9679  response_ready   rebuttal A GPT-5 Mini 9613ms
     10   28380       0  stance           A GPT-5 Mini -> defend
     11   28458      78  response_ready   rebuttal B Gemini 2.5 Flash 1105ms
     12   28458       0  stance           B Gemini 2.5 Flash -> defend
     13   28539      81  stage_started    stage=final
     14   33283    4744  response_ready   final (chairman) Claude Haiku 4.5 4674ms
     15   33353      70  round_complete   unanimous $0.01578640 37931ms
   ```

   The gaps are the point: 9.6s, 8.7s, 9.7s and 4.7s of dead air between stages, on a round the
   spec estimated at 15–25s and which took 37.9s. Frames 1 and 2 arrived 142ms apart because they
   are replayed history; everything from frame 3 is live. Note frame 3 — GPT-5 Mini's draft took
   14.1s but is reported at t+9.7s, because its call started before this client connected.
6. **Two simultaneous subscribers**, both 15 frames, ids 1..15, same order, both ending on
   `round_complete`.
7. **Disconnected mid-round after 4 frames.** The round completed with nobody watching —
   `complete`, $0.00908120, 27950ms — and `GET /api/rounds/:id` afterwards returned a 1187-character
   final answer, 6 responses across all 4 stages, the label→model map (`A=GPT-5 Mini`,
   `B=Gemini 2.5 Flash`), and **both** verdicts: stage 2 `picked` winners `[A]`, `rounds.verdict_type`
   `unanimous`. That single line is decision 26 in one round.
8. **Another user → 403** on `GET /sessions/:id`, `POST /sessions/:id/rounds`, `GET /rounds/:id`,
   `GET /rounds/:id/stream`, `PATCH` and `DELETE`. The stream refusal came back as
   `application/json`, not a half-open event stream, and the owner's session was untouched
   afterwards.
9. **No cookie → 401** on the stream, on `GET /rounds/:id` and on `GET /sessions`. The same stream
   request **with** the cookie → 200, no header set: the httpOnly cookie authenticates an
   EventSource-shaped GET, which is the property the whole design leans on.
10. **A council change never rewrites history.** Round 1 ran with Claude (chairman) / Gemini / GPT.
    `PATCH` replaced the council with Gemini (chairman) / GPT / Llama → 200. Round 1's
    `round_models`, read through psql rather than our own model layer, is **byte-identical before
    and after**. Round 3, started with no council in the body, inherited the patched line-up with
    Gemini chairing. Round 4, started **with** a council in the body (Llama chairing), ran on that
    council — and `session_models` is byte-identical before and after it, so a per-round override
    does not write back. Round 1 was checked once more at the end and is still unchanged after two
    further rounds on two further councils.
11. The reasoning-effort experiment, below.
12. `git log --oneline` / `git status` — recorded in the commit for this session.

**Beyond the list:** `GET /api/sessions/:id` returns all four rounds with 20 responses and each
round's own council snapshot, oldest first. `DELETE` returns 204 with no body, the session 404s
afterwards and its `session_models` rows went with it. A stream opened after the round had finished
replayed all 15 frames and closed; the same with `Last-Event-ID: 5` returned 10 frames starting at
id 6. A stream for a nonexistent round is 404, and `/rounds/not-a-uuid/stream` is
`400 VALIDATION_ERROR`.

**The four rounds:**

```
  7df321e0  complete unanimous  6 responses  $0.01578640  37931ms  Claude(ch), Gemini, GPT-5 Mini
  f4e7818c  complete unanimous  6 responses  $0.00908120  27950ms  Claude(ch), Gemini, GPT-5 Mini
  c73ce3dd  complete picked     6 responses  $0.00485914  21868ms  Gemini(ch), GPT-5 Mini, Llama
  6ac33081  complete unanimous  4 responses  $0.00185140   7439ms  Llama(ch), Claude, Gemini
```

The last is a stage-3 skip on a unanimous verdict — 4 calls, not 6 — which is decision 19 arriving
through HTTP for the first time.

**An earlier run of the same script exercised the failure path for free.** Round 4 hit the
`google/gemini-2.5-flash` fault from decision 21 — HTTP 200, `finish_reason: 'error'`, zero tokens,
1286ms — which took the two-draft quorum with it. The round was marked `failed` with its
$0.00104400 of real cost recorded, `[round] … failed — INSUFFICIENT_DRAFTS` was logged, the stream
closed on `round_failed`, and step 10's assertions still held because `round_models` is written
before any model is called. The script now retries such a round once, loudly, exactly as
`verify:debate` does — that is the script refusing to score a provider outage as a defect, not the
engine retrying anything.

### The experiment: `reasoning: { effort: 'low' }` on drafting only — NOT adopted

Timeboxed to 15 minutes. Stage 1 in isolation rather than three whole rounds: a round's duration is
dominated by two chairman calls this experiment does not change, so end-to-end timing would bury the
effect under noise and cost four times as much. Three questions × three drafters × two conditions =
18 calls, $0.02116122, none failed. Conditions alternate per model so a provider having a slow ten
minutes cannot land entirely on one arm.

| Model | Mean latency | Mean words | Mean reasoning tokens |
|---|---|---|---|
| GPT-5 Mini — baseline | 11365ms | 312 | 448 |
| GPT-5 Mini — `effort: low` | **8134ms** | 328 | **128** |
| Gemini 2.5 Flash — baseline | 4255ms | 361 | **0** |
| Gemini 2.5 Flash — `effort: low` | 6225ms | 305 | **344** |
| Llama 4 Maverick — baseline | 3985ms | 269 | 0 |
| Llama 4 Maverick — `effort: low` | 7507ms | 252 | 0 |

**Seconds saved:** GPT-5 Mini −3.2s (−28%). Gemini +2.0s (+46%). Llama +3.5s (+88%).
**Did the drafts get thinner:** GPT-5 Mini 312 → 328 words (+5%). Gemini 361 → 305 (−16%).
Llama 269 → 252 (−6%).

**The parameter does three different things to three models, which is the finding.**

- **GPT-5 Mini reasons by default**, and `effort: low` cuts its reasoning budget — 448 → 128 tokens,
  measured directly from `completion_tokens_details.reasoning_tokens`. 28% faster and 27% cheaper,
  and the drafts did not get thinner. This is the win the experiment was looking for.
- **Gemini 2.5 Flash does not reason by default through OpenRouter** — 0 reasoning tokens on every
  baseline call. Setting `effort: low` **switches thinking on**: 0 → 344 tokens, 46% *slower*, more
  expensive, and 16% fewer words of actual answer. The parameter does the opposite of what it was
  reached for.
- **Llama 4 Maverick's +88% is not the parameter at all.** It reports 0 reasoning tokens under both
  conditions, and the per-call log shows why: the one question where both conditions routed to the
  same upstream (Parasail) came back 2240ms vs 2359ms — no difference. The other two questions
  routed baseline to DeepInfra and `low` to DigitalOcean, and the gap is entirely those two
  providers. Decision 16 turning up in a measurement it was not invited to.

**Not adopted.** The brief's bar was "the latency win is clear and quality holds", and the win
exists for exactly one of three models while a second is actively harmed. Adopting per-model would
mean a `reasoning` column on `models` and a per-slug policy, which is a real feature with a real
maintenance cost, not a one-line default — and thin drafts give the chairman less to work with,
which weakens the whole debate. `callModel` keeps the optional `reasoning` parameter, inert unless a
caller passes it; **no stage sets it**, and the request body for every debate call is byte-identical
to Session 5's. `scripts/experiment-reasoning.js` stays so the measurement can be repeated when a
model or a route changes.

### Left unfinished / known issues

- **No wallet, no pre-flight cost check, no free-tier limit.** §8 words `POST /rounds` as
  "Pre-flight cost check, then run stages 1–4" and the check is not there; a signed-in user can
  start unlimited rounds and nothing is debited. Session 9, and it is the largest gap in this
  session's surface.
- **The stream registry is per-process** (above). A restart mid-debate orphans the stream.
- **A dropped subscriber cannot be told the round is still running.** `req.on('close')` removes it,
  and if it never comes back the round completes silently into the database. That is correct
  behaviour, but there is no notification path — no email, no push — so a user who closes the tab
  learns the answer only by returning to the session.
- **`GET /api/sessions` has no verdict filter.** §8 asks for "search, filter by verdict"; `search`
  is implemented as a title `ILIKE` and the verdict filter needs an aggregate over a session's
  rounds. It belongs with the leaderboard work.
- **`rounds` still has no `rebuttal_enabled` column**, so a round whose stage 3 was skipped remains
  indistinguishable on disk from one where every rebuttal call failed. `stage_skipped` now reaches a
  client over SSE, which is new, but it still does not survive the request. Session 5 flagged this
  and it is unchanged.
- **`GET /api/sessions/:id` returns every response of every round in one document**, with no
  pagination. A long conversation with fifty rounds is a large JSON payload; §6's Chat screen will
  want the rounds paginated or the responses lazily fetched.
- **The council cap of 8 and the prompt cap of 8000 characters are guesses.** Both are cost guards
  rather than measured limits, and both are the sort of number a real user hits before we do.
- **No rate limit on `POST /api/sessions/:id/rounds`.** `createAuthRateLimiter` guards login and
  register only. Until the wallet lands, the only thing between a signed-in user and unlimited
  OpenRouter spend is the hard cap on OpenRouter's dashboard.
- **`http-verify-a@example.com` and `http-verify-b@example.com`, their sessions and their rounds are
  left in the database**, by design and matching `debate-verify@example.com` from Session 5.
- **The client is still untouched since Session 1.** No login form, no session bootstrap, no
  protected-route wrapper, and nothing consuming any of this session's endpoints.
- Everything Sessions 2–5 listed as unfinished that is not named above still stands: no Google
  OAuth, no attachments, no presets, no sharing, no leaderboard, no `updated_at` trigger, the
  unindexed FK columns, and the ledger's precision mismatch.

### Next session

Session 7: the client. The auth half deferred since Session 3 — login and register forms,
`AuthContext` bootstrapping from `GET /api/auth/me`, a `<ProtectedRoute>` wrapper — and then the
first screen that consumes this session's work: a session list, a council picker, and an
`EventSource` on `/api/rounds/:id/stream` rendering the debate as it happens. Note for that work:
the client's `EventSource` needs `withCredentials: true`, because the cookie is what authenticates
the stream and the two origins differ in development.

## Session 7 — 2026-08-11 · The React foundation: theme, auth pages, protected routing

**Goal:** the client, finally. A Mantine theme matching the §5 mockups, an API client that turns
every failure into one error type, `AuthContext` bootstrapping from `GET /api/auth/me`, protected
and public-only routing, the app shell from the mockup header, and the login and register forms.
**No debate view** (Session 8) and **no wallet** (Session 9).

Plus one server change, taken first: a temporary rate limit on `POST /rounds`.

### The stopgap, done before any React

`createRoundRateLimiter()` in `middleware/rateLimit.js` — **10 rounds per hour, keyed on
`req.user.id`**, mounted on `POST /api/sessions/:id/rounds`. Decision 27, and it is labelled
temporary in three places because Session 9 has to delete it rather than build on it.

Session 6 listed "nothing limits OpenRouter spend" as the largest gap in its surface. This session
is the first in which a *browser* can reach that route, and a browser is where a retry loop, a
double-submit or a stolen cookie turns an unmetered endpoint into an unbounded bill.

Two things about the mount are deliberate and are the opposite of the auth routes':

- **Keyed on the user, not the IP.** The auth limiter is per-IP because the caller has no identity
  yet. Here the thing rationed is one account's spend, and it follows the account — an office
  behind one NAT must not share a budget, and a phone must not get a fresh one by changing network.
- **Mounted last**, after `validate` and after `requireOwnership`. The auth limiter runs first
  because a malformed body is still a guess at a secret. This one guards money, and neither a 400
  nor a 403 spends any; counting them would let a user burn an hour of debates on typos.

**Verified for $0.00.** Because the limiter sits in front of `startRound` rather than behind it, a
body naming a well-formed uuid that is not a live model burns a count and *then* 400s inside the
service — no OpenRouter call, no round row. Ten such requests from user A, then an eleventh:

```
  A req  1 -> 400  remaining=9    UNKNOWN_MODEL
  ...
  A req 10 -> 400  remaining=0    UNKNOWN_MODEL
  A req 11 -> 429  remaining=0    {"error":{"message":"Too many debates started. You can start
                                    10 rounds per hour — please try again shortly.",
                                    "code":"RATE_LIMITED"}}

  -- same IP, different user --
  B req  1 -> 400                 UNKNOWN_MODEL
```

`RateLimit-Remaining` counts 9 down to 0, the 429 comes back through our envelope rather than the
library's plain text, and **user B on the same IP is untouched** — which is the per-user keying
demonstrated rather than asserted. `SELECT count(*) FROM rounds` for those sessions is **0**: no
round was created and nothing was spent. All ten counted requests reached `startRound` — the
`UNKNOWN_MODEL` is raised inside it — so the limiter's pass-through is proven by the same run.

### Dependencies added

`@mantine/notifications` and `@tabler/icons-react`. Exactly two, as scoped.

`@mantine/notifications` is pinned to **8.x**, not the 9.x that `npm install` resolves to by
default: Mantine 9 requires React 19, and Session 1 pinned the whole Mantine line to 8 for exactly
that reason. Installing the default produced an `ERESOLVE` against `@mantine/core@8.3.18`, which is
the lockfile catching the mistake rather than a problem.

### Built

**`src/theme.js`** — the palette, and the only place any of its twelve colours is written down.

- The eight named colours as `PALETTE`, and Mantine ten-shade ramps for `ink`, `brass` and `green`
  built so that **the shade Mantine reaches for by default is the mockup's colour**: index 9 for
  `ink` with `primaryShade: 9`, index 6 for `brass` and `green`, which is Mantine's default filled
  shade. `theme.colors.ink[9]` returning anything other than `#131A22` would mean the file is wrong.
- `MODEL_BADGE_COLORS` plus `modelBadgeColor()` and `modelBadgeLetter()`, exported from here
  because Sessions 8 and 11 both need them. Keyed on the **vendor**, not the slug — a slug changes
  with every model we seat, and the badge is really saying "this is the Anthropic one". Matching is
  a substring test over slug, provider and display name together, so `anthropic/claude-haiku-4.5`,
  `Anthropic` and `Claude Haiku 4.5` all land on the same blue. Anything unrecognised gets `mute`,
  never a random colour.
- System font stack — nothing to download, nothing blocking first paint, and one fewer external
  origin on a page that already has a cross-origin API.
- `src/global.css` carries the same eight colours as `--quorum-*` variables, which is how a `style`
  prop reaches one without importing the theme. Those two files are the only places a hex literal
  appears.

**`src/api/client.js`** — extended, and now the place where two invariants hold for every call.

- `credentials: 'include'` on everything, unchanged from Session 1.
- **Every failure arrives as an `ApiError`.** `fetch` rejects only for a transport failure, and a
  component should never have to tell a `TypeError: Failed to fetch` from a 500 — so that case is
  caught and given `status: 0`, `code: NETWORK_ERROR`, and a message a user can act on. `ApiError`
  now also carries `details` (the envelope's field-level array), with `fieldError(field)` and the
  `fieldErrorMap(error)` helper forms are built on.
- **A 401 on any non-auth call clears the user.** `/api/auth/me`, `/login`, `/register` and
  `/logout` are exempt: a 401 from `me` is the normal answer for a visitor with no cookie — it is
  how the bootstrap discovers there is no session — and a 401 from `login` is a wrong password.
  Redirecting on either would mean the login page redirecting to itself.
- The 401 handler is a module-level hook `AuthContext` registers, and all it does is set `user` to
  null. **That is the whole redirect**: every `ProtectedRoute` reads `user`, so the one the user is
  standing on navigates by itself, and routing decisions stay in the router rather than moving into
  a fetch wrapper that has no idea where the user is.
- **Transport failures and 5xx also raise a notification**, deduped on the error code, autoClose
  8s. A 4xx never does: "that password is wrong" belongs against the field, and a toast saying it
  as well is noise. The notification exists because those failures can happen on a call no form is
  waiting on — the session bootstrap, a background refresh — and those have nowhere to put an
  inline alert.
- Typed helpers `get`, `post`, `patch`, `del`.

**`src/context/AuthContext.jsx`** — replacing the Session 1 skeleton. `user`, `loading`, `error`,
plus `login`, `register`, `logout` and `useAuth()`.

**`loading` starts `true`, and that is the whole point of the file.** There is no token to read —
it is in an httpOnly cookie — so "am I signed in?" is only answerable by asking the server.
Starting `loading` at `false` means that for the one render before `GET /api/auth/me` answers,
`user` is null, every `ProtectedRoute` sees an anonymous visitor, and a refresh on `/sessions`
redirects to `/login` before snapping back. The flash is not cosmetic: the redirect is real, and it
takes the intended location with it.

`logout` clears local state in a `finally`. The server's logout is a 204 that cannot fail, but a
network error can still stop it arriving, and leaving someone looking signed in after they asked to
be signed out is worse than a cookie that outlives the click.

**`src/App.jsx`** — access control lives here rather than in the pages, so adding a route cannot
accidentally add an unguarded one: a page is protected by which block it sits in, and that is
visible in one screen.

- `<ProtectedRoute>` — centred loader while `loading`, then
  `<Navigate to="/login" state={{ from: location }} replace />`, then the page inside `<AppShell>`.
- `<PublicOnlyRoute>` on `/login` and `/register` — a signed-in visitor goes to `/sessions`.
- Public: `/`, `/login`, `/register`, `/s/:shareToken`. Protected: `/new`, `/chat/:sessionId`,
  `/sessions`, `/wallet`, `/leaderboard`. Anything unmatched redirects to `/`.
- `src/routes.js` holds `DEFAULT_SIGNED_IN_ROUTE` and `SIGNED_IN_HOME` so `Login` can import the
  post-sign-in destination without importing the component tree that renders `Login` — a cycle that
  works until the day it does not.

**`src/components/AppShell.jsx`** — the mockup header. Wordmark left (a solid ink square then
QUORUM in bold letterspaced caps, extracted as `<Logo>` because it appears on four screens), then
Sessions / Leaderboard / Wallet, then the brass-on-`brassBg` credits pill and an avatar menu
carrying the display name, the email, Wallet and Log out. Below `48em` the links collapse into a
burger and a right-hand `Drawer`, which is what `quorum-05-mobile.png` shows. The chip reads
`user.creditBalance` — it is not a placeholder, its balance is, until Session 9.

**Pages.** `Landing` — one screen, not a marketing site: the premise, the four stages as cards with
the mockup's numbered pips (ink for the drafting stages, brass for the chairman's two), and CTAs
that become "Go to app" for a signed-in visitor. `Login` and `Register` share `AuthLayout` so the
two cannot drift. `Shared` renders its own header rather than the shell, because it is the only
unauthenticated read surface and there is no user, no chip and no menu to put in one. The other
five are `PagePlaceholder` — a heading and the session that builds them, which is what someone
looking at an unfinished screen actually needs to know.

**`src/validation/authFields.js`** — the client's copy of the server's Zod rules, matching them
exactly *including the normalisation order*: the email is trimmed and lower-cased before the format
check, so `"  Ada@Example.COM "` is valid on both sides rather than on one. Duplicating a rule is a
cost; a round trip to learn that a password is seven characters is a bigger one. **Login's password
rule is non-empty, not min-8**, matching the server and for the server's reason — a short password
must come back as the same 401 as any other wrong one.

**Error handling.** `<ErrorBoundary>` wraps the routes and resets on a path change, so a crash on
one page does not follow the user to the next; it renders a recoverable page with the message and a
"Try again". `<ErrorAlert>` is the one way an `ApiError` is shown, and it lists any `details` entry
the form did not claim, so a validation failure cannot render as an empty box. `<Notifications>` is
mounted in `main.jsx`.

**Two error paths are deliberately different.** A 400 carrying `details` renders against the field
the envelope names. A 401 on login renders as an alert above the form, because it is *not* the
email that is wrong and *not* the password — the server declines to say which, and putting the
message under one box would claim more than it said. A 409 on register is the third case: it
belongs to a field but carries no `details`, because `authService` deliberately does not attach the
pg error whose detail line quotes the conflicting address. It is translated to "An account with
that email already exists" under the Email box.

### Verified

Against a running server, the live Supabase database and a real Chrome.

1. **Register through the UI → signed in.** `POST /api/auth/register` → **201**, landed on `/new`
   with the shell rendering "$0.00 credits" and the avatar. Repeated for a second account; the
   network panel shows `OPTIONS 204` then `POST 201`.
2. **Refresh → still signed in, and no flash — proven, not assumed.** A temporary probe in
   `index.html` recorded every `pushState`/`replaceState` and delayed `GET /api/auth/me`. After a
   reload on `/sessions`, `window.__NAV` is **`["/sessions"]`** — not one navigation occurred
   during the 1.5s bootstrap. With the delay raised to 6s, the screen shows the **centred loader at
   `/sessions`**, never the login form. The probe was removed; `index.html` is byte-identical to
   before.
3. **Log out → redirected to `/login`**, and `/sessions` afterwards bounces to `/login`.
4. **Wrong password → the server's own message inline.** "That did not work / Invalid email or
   password" in the alert above the form. No crash, no raw code.
5. **Existing email on register → "An account with that email already exists"** in red under the
   Email box. Submitted as `BARBARA@Example.com` against the stored `barbara@example.com`, so this
   also proves the client and server normalise identically.
6. **The from-location round trip.** Visited `/sessions` signed out → redirected to `/login`, and
   `history.state.usr.from.pathname` is `"/sessions"`. Signed in → landed on **`/sessions`**, not
   on the default `/new`.
7. **`/login` while signed in → redirected to `/sessions`.** Exercised twice, once by direct
   navigation to `/register` which bounced the same way.
8. **Server killed, then submit → a notification, not a white screen.** The top-right toast
   "Cannot reach the server" *and* the inline alert, from one `ApiError` with `status: 0`.
9. **A deliberate `throw` inside `Landing` → the ErrorBoundary caught it**, rendering "Something
   broke" with the message and Try again / Go home. The throw was removed immediately after.
10. **Screenshots at 1440 and 390 CSS px** of Landing, Login and the shell, plus the mobile drawer
    open. See the note below on how they were taken.
11. **`npm run build` → clean.** 6993 modules, 382 kB JS (121 kB gzip), 205 kB CSS (30 kB gzip),
    2.0s.
12. `git log --oneline` / `git status` — recorded in the commit for this session.

**Two things found while verifying, neither a defect in our code.** The browser extension reports
`POST /api/auth/logout` as **503**; `curl` against the same route returns `204 No Content` with the
cookie-clearing `Set-Cookie`, so it is the extension mislabelling a no-content response. And
`@mantine/notifications` 8.x renders **six** position containers and files each notification into
the one matching `position` — reading "the" notifications root finds the empty `top-center` box and
looks like a bug that is not there.

**On the screenshot widths.** This machine's display caps a real Chrome window at **1075 CSS px**,
so 1440 is not reachable in the interactive browser; every functional check above was run at 1075,
which is comfortably above the `48em` breakpoint and therefore the same desktop layout. The
exact-width captures were taken by driving a **headless Chrome through `puppeteer-core`**, run from
a scratch directory with `npx`. That is a **local development convenience, not a project
dependency** — same standing as `libpq`/`psql` in Session 2 — and nothing was added to either
`package.json`.

### Left unfinished / known issues

- **The 10-rounds-per-hour cap is a stopgap and must be deleted in Session 9**, not built on. It is
  not a cost check and not a free-tier count: it says nothing about what a round costs or whether
  the user can afford it, and a funded user is capped identically to an empty one. Its store is
  in-memory, so it resets on restart and does not add up across processes.
- **A request refused *inside* `startRound` still consumes a count**, because the limiter is in
  front of the service. That is what made it verifiable for free, and it is also a small unfairness
  a real wallet check would not have.
- **`AuthContext.error` is set but nothing renders it.** It holds a non-401 failure from the
  bootstrap — the server being down at first paint. Today that surfaces as a notification from the
  API client instead, so the state is part of the contract without a consumer. Session 8 should
  either render it or drop it.
- **No `EventSource` anywhere yet.** The note from Session 6 still stands and is the first thing
  Session 8 needs: the stream is authenticated by the httpOnly cookie and the two origins differ in
  development, so it must be constructed with `withCredentials: true`.
- **Five screens are placeholders**, and nothing in the client consumes any of the eight session
  and round endpoints. The client's only API calls are the four auth routes.
- **Client-side validation duplicates the server's Zod rules by hand.** They match today, including
  normalisation order; nothing enforces that they still match tomorrow. The server remains the
  authority — `authFields.js` is a courtesy, never a control.
- **React Router's two v7 future-flag warnings are still in the console**, untouched since Session
  1 for the same reason: opting in changes runtime behaviour. `npm audit`'s two moderate
  react-router advisories are also unchanged, and now slightly more relevant — this session
  introduced the first `navigate()` calls. None of them takes user input: every destination is a
  literal or `location.state.from.pathname`, which the router itself wrote.
- **`grace@example.com`, `barbara@example.com` and their probe sessions are left in the database**,
  matching the convention from Sessions 5 and 6. `offline@example.com` was never created — that
  submit was the one made against a dead server.
- Everything Sessions 2–6 listed as unfinished that is not named above still stands: no wallet, no
  Google OAuth, no attachments, no presets, no sharing, no leaderboard, the per-process SSE
  registry, no `rebuttal_enabled` column on `rounds`, no `updated_at` trigger, the unindexed FK
  columns, and the ledger's precision mismatch.

### Next session

Session 8: the debate view — mockups 01 and 02, which are the product. A council picker over
`GET /api/sessions`, `POST /api/sessions` and `POST /api/sessions/:id/rounds`, the session list,
and the four-stage transcript rendered from an `EventSource` on `/api/rounds/:id/stream` with
`withCredentials: true`, falling back to `GET /api/rounds/:id` when the stream has already closed.
The model badge colours it needs are already exported from `theme.js`.
