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
