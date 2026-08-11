# Quorum

**Quorum turns a single question into a debate between AI models, then delivers one answer they've
argued their way to.**

You assemble a council of models, nominate one as chairman, and ask a question. Quorum runs a
four-stage deliberation and returns a single final answer — along with the full record of how it
got there. The point is not that more models are always better; it is that disagreement between
models is a signal, and today that signal is invisible.

Final project · Elevation Academy.

| Stage | What happens | Calls |
|---|---|---|
| 1 · Drafts | Every drafting model answers the question independently, in parallel | N−1 |
| 2 · Verdict | The chairman receives the drafts anonymised and shuffled, then picks one, merges two, or synthesises its own | 1 |
| 3 · Rebuttals | Each drafter sees the verdict and may defend, revise, or concede | N−1 |
| 4 · Final | The chairman rules on the rebuttals and produces the final answer | 1 |

## Status

**Scaffolding.** The client and server boot and talk to each other. Auth, the debate engine,
OpenRouter calls, the wallet and the database schema are not built yet — see **Current state**
in [`CLAUDE.md`](CLAUDE.md).

## Stack

- **Client** — React 18, Vite, React Router v6, Mantine
- **Server** — Express 4, ES modules, Node 20+, MVC (routes → controllers → services)
- **Database** — Supabase Postgres via `pg` with plain SQL migrations (no ORM)
- **LLM gateway** — OpenRouter, sole gateway for every model
- **Auth** — bcrypt + Google OAuth, JWT in an httpOnly cookie
- **Validation** — Zod
- **Planned** — Stripe (test mode) for top-ups, Supabase Storage for attachments, SSE for live
  round progress

## Getting started

Requires Node 20 or newer.

### Server

```bash
cd server
npm install
cp .env.example .env     # fill in what you have; see below
npm run dev              # http://localhost:3000
```

`PORT`, `NODE_ENV` and `CLIENT_URL` fall back to development defaults, so the API starts with an
empty `.env`. `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `OPENROUTER_API_KEY` and
`JWT_SECRET` are optional in development and **required when `NODE_ENV=production`** — the process
refuses to start without them. Never commit `.env`.

### Client

```bash
cd client
npm install
cp .env.example .env     # VITE_API_URL=http://localhost:3000
npm run dev              # http://localhost:5173
```

### Health check

```bash
curl localhost:3000/api/health
# {"status":"ok","timestamp":"..."}

curl localhost:3000/api/health/db
# {"status":"ok","now":"..."}  — or 503 if DATABASE_URL is unset or the database is unreachable
```

## Layout

```
client/
  src/
    api/          fetch wrapper — credentials: 'include', throws on non-2xx
    components/   shared components
    context/      AuthContext
    pages/        one file per route
    App.jsx       route table
    main.jsx      MantineProvider + BrowserRouter
server/
  src/
    config/       env.js — Zod-validated environment
    controllers/  request/response only
    db/           pool.js + migrations/
    middleware/   errorHandler.js, notFound.js
    routes/       route definitions only
    services/     business logic and all SQL
    app.js        express app
    server.js     listen
docs/
  quorum-product-document.md   approved spec, frozen at v1.0 — never edited
  build-log.md                 one section per build session
  decisions.md                 deviations from the spec
prompts/                       the four debate-stage prompt templates
CLAUDE.md                      working context, reloaded every session
```

## Conventions

ES modules; `async`/`await` never `.then()`; named exports; thin controllers and fat services; all
database access through a service; every error response shaped `{ error: { message, code } }` by
`errorHandler` and nowhere else.
