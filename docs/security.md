# Security review

Session 18, 2026-08-13. Written against the deployed product, not a plan for it.
Every claim below is either a command whose output is quoted or a line of code
named by file. Where something is deliberately *not* done, the reason is here
too — an unexplained gap and a considered decision look identical six months
later.

**Scope.** The API on Railway, the client on Vercel, the Postgres and Storage on
Supabase. Not in scope: OpenRouter's handling of prompt text, and Stripe's
handling of card data — both are third parties holding data we deliberately
never touch.

---

## 1. Transport and headers

`helmet` is the first middleware in `server/src/app.js`, ahead of CORS and the
body parsers, so its headers are on error responses too. Measured on the
deployed API:

```
strict-transport-security: max-age=31536000; includeSubDomains
x-content-type-options: nosniff
referrer-policy: no-referrer
x-frame-options: SAMEORIGIN
cross-origin-opener-policy: same-origin
x-dns-prefetch-control: off
x-permitted-cross-domain-policies: none
```

`nosniff` is the one that earns its place here: this API returns user-supplied
bytes in a few places, and a browser second-guessing a declared
`application/json` is the classic route to stored XSS.

**Two defaults are off, deliberately.**

`contentSecurityPolicy` — this origin renders no markup. Helmet's default policy
constrains a page's own script and style sources, and there is no page; leaving
it on would put a long header on every JSON response to constrain nothing. The
client's CSP is Vercel's to set and is where a policy would actually bind.

`crossOriginResourcePolicy` — its default is `same-origin`, and this API is
deliberately cross-origin. Left on, it instructs the browser to refuse exactly
the requests the product is made of. CORS below is what governs who may read
these responses, and it names one origin rather than blanket-denying every other.

**Verified on the SSE route too.** `GET /api/rounds/:id/stream` writes its
headers with `res.writeHead`, which merges rather than replaces, so `nosniff`
and the CORS headers survive on the stream — checked, not assumed.

---

## 2. CORS

`app.js` passes **one exact origin string**, derived as `new URL(CLIENT_URL).origin`:

```
access-control-allow-origin: https://quorum-gal-giladi.vercel.app
access-control-allow-credentials: true
vary: Origin, Access-Control-Request-Headers
```

**A wildcard was never available.** `Access-Control-Allow-Origin: *` is illegal
in a credentialed response — the browser rejects the response rather than
ignoring the header — and the httpOnly session cookie makes `credentials: true`
non-negotiable. So `origin: '*'` and this product cannot coexist.

**`origin: true` is the subtler trap and is also not used.** It avoids the
wildcard by reflecting whatever `Origin` the request carried, which is to say it
permits every site on the internet to make credentialed calls with the user's
cookie. It is an allow-list with nothing in it.

**A foreign origin gets ours back, never its own** — confirmed with a request
carrying `Origin: https://evil.example.com`, which received
`access-control-allow-origin: https://quorum-gal-giladi.vercel.app`. The browser
compares that to its own origin and refuses the response, which is the entire
enforcement point.

**Trailing slashes are stripped in the env schema** (`config/env.js`), once,
rather than at each of `CLIENT_URL`'s five consumers. A stray slash would make
the echoed origin match no `Origin` any browser sends, and the resulting CORS
failure names no cause.

---

## 3. Secrets are not in the client bundle

The client is a static bundle; anything compiled into it is public. Vite only
exposes variables prefixed `VITE_`, and the only one used is `VITE_API_URL`.

**Required patterns — zero hits:**

```
files scanned:
  dist/index.html
  dist/favicon.svg
  dist/assets/index-<hash>.js
  dist/assets/index-<hash>.css

  sk_            0 hit(s)
  whsec_         0 hit(s)
  service_role   0 hit(s)
  eyJ            0 hit(s)
```

**And the literal value of every variable in `server/.env`.** The scanner reads
each value from the file and greps for it; values are never echoed, never passed
as an argument and never visible in the process list — only the name, the length
and a count are printed:

```
  VARIABLE                 CHARS  SECRET?  HITS IN client/dist
  ---------------------------------------------------------------
  PORT                     4      no       1
  NODE_ENV                 11     no       2
  CLIENT_URL               21     no       0
  DATABASE_URL             112    yes      0
  SUPABASE_SERVICE_KEY     219    yes      0
  OPENROUTER_API_KEY       73     yes      0
  JWT_SECRET               64     yes      0
  STRIPE_SECRET_KEY        107    yes      0
  STRIPE_WEBHOOK_SECRET    70     yes      0
  SUPABASE_URL             40     no       0

  HITS ACROSS EVERY SECRET VALUE: 0
  RESULT: PASS — no secret value appears anywhere in the built client.
```

The two non-zero rows are the point of classifying rather than grepping blindly:
`NODE_ENV`'s value is the literal word `development`, which appears in React's
own build-mode comparison, and `PORT`'s is `3000`. Neither is a credential. A
scanner that treated every environment variable as a secret would have reported
a FAIL on the word "development" and taught everyone to ignore it.

---

## 4. Authentication and authorization

- **Passwords** — `bcryptjs` at cost 10. An unknown email still runs a real
  compare against a fixed hash, so a wrong address and a wrong password take the
  same time and return a byte-identical 401.
- **Session** — JWT, HS256 pinned on both sign and verify (an unpinned
  `verify` lets a forged header choose the algorithm), 7 days, in an httpOnly
  cookie.
- **Cookie attributes in production** — `HttpOnly; Secure; SameSite=None;
  Path=/; Max-Age=604800`, read off a real registration response. `None` is
  required because the client and API are different sites; `Secure` is required
  by `None`, and a browser silently drops the cookie without it. Both are
  computed once and spread into the set and clear paths so they cannot drift.
- **`JWT_SECRET` is 64 characters**, against a floor of 32 that `config/env.js`
  enforces at boot when `NODE_ENV=production` — a short key weakens the MAC
  below the digest it signs.
- **Authorization reads the database, never the token.** The `role` claim is
  seven days stale by design; `requireAuth` loads the row and `req.user` is the
  only source of truth.

**Every protected endpoint was probed without a cookie.** All 22 returned 401;
the six deliberately public ones behaved as designed (`/api/health` 200,
register/login 400 on an empty body, logout 204, an unknown share token 404, the
Stripe webhook 400 unsigned). The full table is in the README.

---

## 5. Rate limits

| route | limit | keyed on | why |
|---|---|---|---|
| `POST /api/auth/login` | 10 / 15 min | IP | unlimited free guesses at a secret |
| `POST /api/auth/register` | 10 / 15 min | IP | unlimited free account creation |
| `GET /api/share/:token` | 60 / hour | IP | the only route with no user behind it |
| `POST /api/attachments` | 30 / hour | **user** | added this session — see below |

The auth limiters are separate instances so ten failed sign-ins do not also
block creating an account.

**Uploads were the one unbounded expensive action.** Everything else a user can
do is priced — a round is quoted before it runs and debited after, so the balance
is the cap. An upload costs the user nothing, costs us storage, and **does not
have to be attached to anything**: `claimAttachments` requires `round_id IS
NULL`, so a file never sent with a round simply stays. There is no orphan sweep,
and this review found three such rows. Keyed on the account rather than the IP,
because `requireAuth` has already run — it does not punish a shared NAT and
cannot be escaped with a new address. The IP fallback goes through the library's
`ipKeyGenerator`, which flagged the naive version: keying on a bare IPv6 address
hands one user a /64 and therefore 2^64 separate budgets.

**Rounds are deliberately NOT rate-limited, and this is not an oversight.**
Session 9 deleted a 10-per-hour limiter and left a note in `middleware/rateLimit.js`
saying not to reinstate it. The entitlement check and the wallet are the real
guard: they refuse a round the user cannot afford and debit what it cost. A
per-user round cap says nothing about what a round costs and throttles a funded
user identically to an empty one, which is the thing the wallet exists to
distinguish.

---

## 6. Input validation

Everything checkable from the request alone is checked at the edge by Zod, via
`validate({ body, params, query })`, before a controller or service runs.

**One gap was found and closed this session.** `GET /api/share/:token` — the only
unauthenticated data route — reached its service without passing through
`validate()`. The token was never an injection risk (it is a parameterised query
argument), but an arbitrary-length string from an anonymous caller had no reason
to reach Postgres. It is now shape-checked against the 32-character base64url a
token actually is.

**A malformed token is a 400 and an unknown one is still a 404,** and that split
is safe. The invariant is that an unknown token and a **revoked** one are
indistinguishable — telling the holder of a leaked link that the string was once
real is what revoking exists to prevent. A token's *format* is not a secret; it
is visible in every share URL ever sent. So the 400 leaks nothing, and every
well-formed guess — live, revoked, or never issued — still gets the same 404.

**`POST /api/attachments` has no Zod and does not need it.** The route carries no
body fields, no params and no query; the controller reads `req.file` and
`req.user`. The file is validated by **magic bytes**, deliberately not by the
declared Content-Type or the filename, which are the two things about an upload
nobody should believe. A declared type that disagrees with the bytes is a 415
refusal rather than a silent correction, and the client's filename is not used
for the type, the storage path, or even the log line for a refused upload.

---

## 7. The public surface

`GET /api/share/:token` is the only unauthenticated data route.

- **192 bits** of CSPRNG in the token — a search no rate limit meaningfully
  changes, which is why the limiter above is described as a bound on scraping
  rather than as the defence.
- **The payload is built by allow-list, never by stripping.** `shareService`
  constructs the response field by field. The two approaches produce identical
  bytes today and behave oppositely the next time a field is added upstream: a
  strip-list leaks it by default, an allow-list drops it. Withheld: `user_id`,
  `email`, `display_name`, every cost field, both token counts (a token count
  times a published price is the cost with an extra step), the `share_token`
  itself, and a round's `session_id`.
- **Revoking writes NULL** rather than a tombstone, so there is no revoked state
  to check for and no way to forget to check it.

---

## 8. Database

**RLS is enabled on all 12 tables in `public`, with zero policies:**

```
 _migrations t 0    models          t 0    rounds         t 0
 attachments t 0    preset_models   t 0    session_models t 0
 credit_transactions t 0            presets t 0           sessions t 0
 model_responses t 0                round_models t 0      users    t 0
```

Zero policies with RLS on is **deny-all**, which is the correct posture here:
the API is the only client and it connects with a role that owns the tables. The
policies would exist if the browser talked to Postgres directly, and it never
does.

**The Supabase Data API is not a way in.** PostgREST answers `401` for
`users`, `rounds`, `model_responses` and `credit_transactions` without a key, and
with an anon key RLS returns nothing because there are no policies. The service
key bypasses RLS by design, which is exactly why it is server-only and why §3
greps for it.

**Storage** is a private bucket. Every read is a signed URL minted at request
time and nothing stores one — a signed URL is a credential with an expiry.
Owner reads get 10 minutes, the public shared view 5.

---

## 9. Dependencies

`npm audit`, both packages.

**Server: 0 vulnerabilities** (production dependencies).

**Client: 2 moderate**, both in `react-router` 6.x. **Neither is reachable, and
neither was upgraded** — the fix is `react-router-dom@7`, a breaking major, and
an unreachable moderate does not justify a router rewrite days before a demo.

| advisory | reachable? | why |
|---|---|---|
| `GHSA-337j-9hxr-rhxg` — arbitrary constructor injection via `deserializeErrors()` in **SSR hydration** | **No** | There is no SSR. `vite build` emits static assets; the codebase contains no `StaticRouter`, `createStaticHandler`, `renderToString` or `hydrateRoot`. The vulnerable path never executes. |
| `GHSA-wrjc-x8rr-h8h6` — open redirect via backslash in `<Link>` / `useNavigate` | **No** | Requires an attacker-controlled navigation target. Every `navigate()` call site was enumerated: five are string literals, one is a template over an internal session id. The only computed target is `location.state?.from?.pathname` in `Login`, and `state.from` is set programmatically by `ProtectedRoute` from the router's own location object — it lives in history state, not in the URL, so a crafted link cannot set it. `useSearchParams` is read once, for a `topup` status string that is compared and never navigated to. |

**Schedule the upgrade after the demo**, with the router's v7 migration guide
open. Re-run `npm audit` then; do not `--force` it now.

---

## 10. Known and accepted

- **No orphan sweep for attachments.** Deleting a user cascades the
  `attachments` rows and leaves the storage objects, because
  `attachments.storage_path` is the only record of which object belongs to which
  row. `DELETE /api/attachments/:id` and `DELETE /api/sessions/:id` both sweep
  correctly and there is no user-delete path in the product, so this only bites
  out-of-band SQL. Recorded as decision 67 with the fix written down.
- **Rate-limit state is in-process.** It resets on restart and does not add up
  across instances. Correct for one instance; a shared store is the fix if this
  is ever scaled out.
- **The SSE registry is in-process** for the same reason.
- **`engines.node` is `">=20"`** while `@supabase/supabase-js@2.112.3` declares
  `">=22.0.0"`. An engines warning, not a runtime failure. One line to fix, with
  a whole-runtime blast radius; deferred deliberately.
- **Vercel Deployment Protection.** If it is enabled, the client redirects to
  Vercel SSO and is unreachable to anyone outside the team — including a reviewer
  opening the link. Not a vulnerability; a deployment setting that makes the demo
  URL private. Check it before sharing the link.
