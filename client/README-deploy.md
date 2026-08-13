# Deploying the client

Vercel, root directory `client`, framework preset **Vite**. `npm run build`
outputs to `dist`.

## `vercel.json` is not optional, and this is what it fixes

This is a single-page app: React Router owns every path, and the server has one
file to serve — `index.html`. Without a rewrite, Vercel looks for a *file* at the
requested path, finds none, and returns its own 404.

The symptom is specific and easy to miss, because **clicking through the app
works perfectly**. React Router handles in-app navigation in the browser and
never asks Vercel for those paths. Only a direct load fails:

| how you got there | without the rewrite |
|---|---|
| open `/`, click Sessions | works — the router navigated client-side |
| open `/sessions` directly | **404** |
| refresh anywhere but `/` | **404** |
| a bookmarked `/wallet` | **404** |
| **a shared `/s/:token` link** | **404** |

That last row is the one that matters most: the public share link is the only
part of this product built for someone who has no account, and it is the only
part nobody testing while signed in would ever notice was broken. Session 18
found it exactly that way — by requesting the paths rather than by clicking to
them.

`rewrites` rather than `redirects` on purpose: a rewrite serves `index.html` at
the original URL, so the router still sees `/s/abc` and the address bar does not
change. Vercel matches static files first, so `/assets/index-*.js` continues to
resolve as a file and only unmatched paths fall through to the SPA.

## Environment

| variable | value |
|---|---|
| `VITE_API_URL` | the Railway API origin, no trailing slash |

`VITE_*` is the only prefix Vite exposes to the browser, and everything under it
is **public** — it is compiled into the bundle. No secret belongs here; see
`docs/security.md`.

## Deployment Protection

If Vercel's Deployment Protection is enabled, the site redirects to Vercel SSO
and is unreachable to anyone outside the team — including a reviewer opening the
link in the README. Turn it off for a public demo, or share a protection bypass
token.
