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

Total per round: **2N calls**. Stages 1 and 3 fan out with `Promise.allSettled` — a provider
failure is recorded in `model_responses.error_text` and the round continues without it.

Two invariants: the chairman abstains from drafting by default (LLMs favour their own output when
judging), and rebuttals permit concession, not just defence (defence-only makes models entrench
and stage 4 learns nothing).

## Stack

- **Database** — Supabase Postgres, accessed with the `pg` driver and **plain SQL migrations**.
  No ORM, no query builder. Migrations are numbered files in `server/src/db/migrations/`, applied
  with `npm run migrate`. `npm run psql -- -c '...'` opens a client against the same database.
- **LLM gateway** — **OpenRouter is the only one.** One key, one OpenAI-compatible endpoint for
  every model. Calls are non-streaming (`stream: false`) — each stage needs the complete previous
  output. Token counts and real cost come back in the response body; that is what we debit.
  Adding a model is a row in `models`, never a new adapter.
- **Auth** — our own: bcrypt, Google OAuth 2.0, **JWT in an httpOnly cookie**. Not a hosted auth
  product; implementing auth is a project requirement.
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
- **`errorHandler` is the only place an error becomes a response.** Throw an `Error` with
  `.status` and `.code`, or call `next(error)`. Never `res.status(500).json(...)` inline.
  Response shape is always `{ error: { message, code } }`.
- **Validate at the edge** with Zod, in the controller, before touching a service.

## Documentation duties (every session)

- Update **Current state** below.
- Append a section to `docs/build-log.md`. Never rewrite earlier sections.
- Log any spec deviation in `docs/decisions.md`.
- **Never modify `docs/quorum-product-document.md` or `.pdf`.** They are the frozen approved v1.0.

## Current state

_Last updated: end of Session 2 (2026-08-11) — schema, migrations, model catalogue._

**Exists and verified running:**

- `server/` — Express 4 on Node 20+, ES modules. `src/app.js` wires cors (credentials, origin from
  `CLIENT_URL`), cookie-parser, `express.json`, `/api` routes, `notFound`, `errorHandler`.
  `src/config/env.js` validates env with Zod and throws on a bad config. `src/db/pool.js` exports
  a single `pg` Pool (`ssl: { rejectUnauthorized: false }`) plus a `query()` helper that logs
  duration in development.
- Routes: `GET /api/health` → `{ status, timestamp }`; `GET /api/health/db` → `SELECT now()`,
  now **verified 200 against the live Supabase database**.
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
- `client/` — Vite + React 18 + Mantine + React Router v6. Nine placeholder pages (one heading
  each), routes for all of them in `App.jsx`, `api/client.js` fetch wrapper
  (`credentials: 'include'`, throws `ApiError` on non-2xx), `context/AuthContext.jsx` provider
  skeleton. **Untouched this session.**

**Deliberately not built yet:** auth (register/login/OAuth/JWT), the debate engine, OpenRouter
calls, the wallet and Stripe, presets, sharing, the leaderboard, attachments, SSE. Only three of
the eleven model files exist — `presetModel`, `sessionModel`, `roundModel`, `roundModelModel`,
`modelResponseModel`, `attachmentModel` and `creditTransactionModel` arrive with the features that
need them. No protected-route logic on the client.

**Next session:** auth — register, login, Google OAuth, JWT in an httpOnly cookie, and the
ownership middleware. `JWT_SECRET` moves into the always-required block in `config/env.js`.
