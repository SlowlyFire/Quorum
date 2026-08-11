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
