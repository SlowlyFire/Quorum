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

**The chairman's vocabulary is not the database's.** `server/prompts/` asks for `pick` / `merge` /
`synthesise`; §7 and the CHECK constraint say `picked` / `merged` / `synthesised`. Both files are
frozen, so `VERDICT_TYPE_MAP` in `debateService.js` is the single place they meet — normalise at
parse time, and never let a model's word reach a column (decision 18).

**THE TEMPLATES LIVE AT `server/prompts/`, AND ANY PATH TO A FILE ON DISK IS RESOLVED FROM
`import.meta.url` — NEVER `process.cwd()`.** Railway builds with its root directory set to `server`,
so `/app` IS the server folder and nothing above it exists in the image. The templates used to sit at
the repository root and `promptService` reached them with `../../../prompts`, which resolved to
`/prompts` in the container and killed the process at import with ENOENT — a boot failure, because
the templates are parsed at import on purpose. The working directory is different in all four places
this code runs (repo root under `npm run dev`, `server/` under the verify scripts, `server/scripts/`
under some of them, `/app` in the container), so a cwd-relative path works exactly where it was
tested. **`server/` must stay self-contained**: anything the server needs to boot goes inside it, and
a new runtime file read is a new chance to make this mistake (decision 64).

## Stack

- **Database** — Supabase Postgres, accessed with the `pg` driver and **plain SQL migrations**.
  No ORM, no query builder. Migrations are numbered files in `server/src/db/migrations/`, applied
  with `npm run migrate`. `npm run psql -- -c '...'` opens a client against the same database.
- **LLM gateway** — **OpenRouter is the only one.** One key, one OpenAI-compatible endpoint for
  every model. **Stages 1–3 are non-streaming** (`callModel`, `stream: false`) — each feeds the next
  stage, which needs the complete previous output. **Stage 4 streams** (`callModelStreaming`), because
  it is the one output that goes to a human rather than into another prompt. Token counts and real
  cost come back in the response body — **in the LAST SSE message on a streamed call** — and that is
  what we debit. Adding a model is a row in `models`, never a new adapter.
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
- **THE PUBLIC SHARE ROUTE'S PAYLOAD IS BUILT BY ALLOW-LIST, NEVER BY STRIPPING.**
  `GET /api/share/:token` is the only unauthenticated data route in the product, and `shareService`
  constructs its response field by field rather than deleting keys from `toPublicSession`'s output.
  The two produce identical bytes today and behave oppositely the next time a field is added
  upstream: a strip-list leaks it by default, an allow-list drops it. Withheld: `user_id`, `email`,
  `display_name`, every cost field, both token counts (a token count times a published price is the
  cost with an extra step), `share_token`, and a round's `session_id`. `latencyMs` stays, because it
  belongs to the debate rather than to the account. `verify:sharing` walks the response structurally
  and asserts the same fields ARE present on the owner's route, so the absence is provably this
  working (decision 40).
- **An unknown share token and a revoked one are the same 404, byte for byte.** A 403 would confirm
  to whoever holds a leaked link that the string was real — the fact revoking exists to stop telling
  people. Revoking writes NULL rather than a tombstone, so there is no revoked state to check for and
  no way to forget to check it; re-sharing mints a fresh token and the old link stays dead. Sharing
  is **idempotent** — POST twice returns the same token rather than breaking a link already sent
  (decisions 41 and 42).
- **A council lives in three tables at three lifetimes, and the wrong one is silently wrong
  rather than an error.** `preset_models` is a reusable template that applies to nothing until it
  is loaded — and since Session 10 it is loaded, by the picker on `/new`, which restores the
  line-up AND both debate settings; a preset that restored who was on the council but not whether
  the chairman abstains would produce a different debate from the one that was saved. `session_models` is the session's **default** and is mutable — PATCH replaces it, and
  every round created *after* that inherits the new line-up. `round_models` is the **immutable**
  per-round snapshot the engine writes at round creation and never updates. Any historical
  question — who debated, who won, what a round cost — reads `round_models`. Changing a session's
  council must never alter a round already run, and a council passed in a `POST /rounds` body wins
  for that round only and must not write back to `session_models` (decision 22).
- - **THE QUOTE PRICES ATTACHMENTS ON STAGE 1 ONLY, AND ONLY FOR MODELS THAT CAN SEE THEM.**
  `IMAGE_INPUT_TOKENS` (1000) is added to a DRAFTER's stage-1 prompt tokens and to no other call —
  attachments reach stage 1 alone (decision 47) — and `canSee` filters by the same two modality flags
  `partsFor` uses, so a council seating the text-only model is not quoted for an image it will never
  receive. The constant ships on `GET /api/models`; the client mirrors the arithmetic, never the
  constant (decision 70).
- **A RESEARCH SAMPLE IS DEFINED BY `rounds.research_tag`, NEVER BY WHO OWNS THE ROUND.** NULL is
  ordinary traffic; a slug names the sample (`'self-preference-v1'` is Session 13's 48 rounds,
  migration 009). The study selected by `user_id` until Session 17, which is correct exactly until
  somebody runs anything else under that account — and Session 17 was one instruction from doing it.
  The tag is written at INSERT (`insertRound` takes `researchTag`), never afterwards: a round tagged a
  moment later is untagged if the process dies, and an untagged study round is invisible to the
  analysis AND to the resume check, so the next run silently repeats a cell it paid for. **Not
  `prompt_version`** — that answers which template produced a round and `calibrate:estimate` reads it.
  The leaderboard's research exclusion still keys on `users.role` and is a different question
  (decisions 54 and 68).
- **`leaderboard-seed@quorum.local` ("Quorum Benchmarks") IS INFRASTRUCTURE, NOT A FIXTURE.** It owns
  40 of the leaderboard's ~53 ranked rounds; **deleting it collapses the board** to four models with
  5–14 drafts each, one of them unranked. `npm run seed:leaderboard` rebuilds it — dry run by default,
  `--confirm` to spend, deterministic council rotation so every active model draws equal drafting
  seats. Its questions are contestable on purpose: an obvious question returns `unanimous`, which
  scores nobody and leaves the board flat however many rounds run (decision 69).
- **THE LEADERBOARD'S WIN COMES FROM STAGE 2's `winner_labels`, NEVER FROM
  `rounds.verdict_type`.** Stage 2 is the blind evaluation of anonymised, shuffled drafts — the
  only point in a round where a model is judged on its answer rather than on its concessions.
  Stage 4 frequently returns `unanimous` once every drafter has conceded (three of four rounds in
  Session 6), which would erase the fact that a model won and score a decisive round as a draw.
  Read the **last** `model_responses` row for stage `verdict` with a null `error_text`, parse its
  `content`, and map `winner_labels` back through `anon_label`. `rounds.verdict_type` stays as the
  user-facing outcome; the two answer different questions and both are kept.
  `GET /api/rounds/:id` returns both, as `verdictType` and `verdict` (decisions 20 and 26).
  **Both traps are now IN `src/models/leaderboardModel.js`**, restated above the SQL, and
  `verify:leaderboard` proves each on real data rather than asserting it: 14 of Gemini's 33 drafted
  rounds ended stage 4 `unanimous` and 9 of those were stage-2 scores, and Claude Haiku's denominator
  is 11 with `role IN (...)` against 7 with the bare equality. That file exports
  `draftDenominatorComparison`, which IS the wrong query — kept beside the right one so the
  difference can be printed, because a trap described only in a comment is one the next person still
  falls into. **On the board, `wins` and `merged` are DISJOINT**, so `score = wins + merged / 2` and
  a reader can check the win rate off the row; what decides between them is the LENGTH of
  `winner_labels`, not stage 2's `verdictType` (decision 44).
- **AN ATTACHMENT'S TYPE IS DECIDED BY MAGIC BYTES, AND THE CLIENT'S FILENAME IS NOT USED AT ALL.**
  Not for the type, not for the storage path (`userId/uuid.ext`), not even in the log line for a
  refused upload — it is the part of an upload an attacker fully controls and we have no use for it.
  A declared Content-Type that DISAGREES with the bytes is a 415 refusal rather than a silent
  correction, even when the real type is one we accept (decision 48). `application/octet-stream` and
  a missing type are not disagreements.
- **`supports_documents` IS NOT IMPLIED BY `supports_vision`.** OpenRouter carries a PDF as a `file`
  content part rather than an `image_url` one, and the set of models accepting a file is smaller —
  Llama 4 Maverick reads images and refuses documents. Two columns, one per modality (decision 49).
- **A model that cannot see an attachment is TOLD SO, never silently given less**, and the marker in
  the UI is **derived rather than stored**: `lib/attachments.js`'s `canSee` compares an attachment's
  `mimeType` against a council member's two modality flags, which `round_models`' reads join. Live
  round, reload and public shared view all call it, so they cannot disagree (decision 50). A
  text-only council member must never turn an attached image into a 400.
- **Attachments reach STAGE 1 and no other stage.** `01-draft.md` is the only template with an
  `{{ATTACHMENTS}}` block and `server/prompts/` is frozen, so an image alongside a verdict prompt that never
  mentions it would be a prompt we never validated — and would multiply its input tokens across every
  remaining stage. Adding the block to `03-rebuttal.md` is the fix if a revision ever needs the image
  again (decision 47).
- **`errorHandler` is the only place an error becomes a response**, and **`lib/httpError.js` is the
  only place one is constructed** — `httpError(status, code, message, { cause, details })`, then
  throw it or pass it to `next`. Never `res.status(500).json(...)` inline. Response shape is always
  `{ error: { message, code } }`, plus an optional `details` array on validation failures only.
- **Validate at the edge** with Zod, via the `validate({ body, params, query })` middleware, before
  a controller or service runs. Schemas live in `src/validation/`. **`councilSchema` is imported,
  never restated** — `presetSchemas` takes it from `sessionSchemas`, because a preset's line-up and
  a session's are the same object with the same three rules and the point of a preset is that one
  loads into the other. Two copies would drift, and the drift would surface as a preset that saves
  and then cannot be used.
- **"Filter by verdict" means the LATEST round's verdict.** A session has many rounds, so *any round
  merged* puts one session under several chips at once and their counts stop summing to the total,
  while *all rounds merged* makes a session leave a filter the moment a follow-up is asked — the one
  action the sessions page most encourages. The latest round is also what the row already shows in
  its VERDICT and WHEN columns (decision 39).
- **Authorization reads the database, never the JWT.** The token's `role` claim is seven days stale
  by design; `requireAuth` loads the row and `req.user` is the only source of truth. Guard owned
  resources with `requireOwnership(loaderFn)`, whose loader is a **service** function — middleware
  imports services, never models or `db/pool.js`.
- **Never log an email address next to a failure reason**, and never attach a pg error as `cause`
  on a 409: its `detail` contains the conflicting value.
- **ONE PAGE CONTAINER, AND PAGES DO NOT CHOOSE A WIDTH.** `components/PageContainer.jsx` is the
  only full-page wrapper — one width (1140), one horizontal padding, `py` the only prop a page sets.
  Before it, seven surfaces used `lg`, the leaderboard `xl` and the shared view `md`; every one was
  individually CENTRED, so nothing looked wrong on any single screen and the fault only appeared when
  moving between them, as the column jumping 180px. A per-page width is not a decision made once, it
  is one each page makes again slightly differently. Body copy inside uses `.quorum-measure` (68ch)
  rather than an ad-hoc `maw`, which is how the landing page ended up with four different right edges
  (decisions 75 and 76). `scripts/measure-layout.mjs` prints each block's left and right margin, so
  "is it centred" is answered with a number.
- **On the client, the palette is written down in exactly two files** — `src/theme.js` (the
  `PALETTE` object and the Mantine ramps) and `src/global.css` (the same eight as `--quorum-*`
  variables, which is how a `style` prop reaches one without importing the theme). A hex literal
  anywhere else is a bug. `theme.js` is also the single export of the **model badge colours**
  (`MODEL_BADGE_COLORS`, `modelBadgeColor`, `modelBadgeLetter`), keyed on the vendor rather than
  the slug, because Sessions 8 and 11 both need them.
- **The streamed final answer renders as PLAIN TEXT and swaps to markdown once.** Half a code fence
  renders as a paragraph and then reflows into a block when the closing fence arrives; markdown on
  partial input does not degrade, it flickers. `stages.final` carries `streamingAnswer` and
  `streaming` on **both** paths (a persisted round states them empty rather than omitting them), and
  `FinalCard` has three states: parsed answer as markdown, else preview with a caret, else skeleton.
  The swap happens at `response_ready`, one frame after `final_done`, so the caret stops before it
  rather than blinking through it. `.quorum-stream-text` matches the rendered type exactly
  (16px/25.6px measured) and its `overflow-wrap: anywhere` is load-bearing on phones — a 420-character
  unbroken URL in a 320px column holds `scrollWidth` at 320 with it and 2715 without. `round_failed`
  clears the preview: half a sentence under a failure alert reads as an answer the council stands
  behind (decision 62).
- **`AuthContext.loading` starts `true`, and nothing may change that.** There is no token to read —
  it lives in an httpOnly cookie — so "am I signed in?" is only answerable by asking the server.
  Start it `false` and, for the one render before `GET /api/auth/me` answers, every
  `<ProtectedRoute>` sees an anonymous visitor: a refresh on `/sessions` redirects to `/login` and
  snaps back, **taking the intended location with it**. Access control lives in `App.jsx` and
  nowhere else, so adding a route cannot accidentally add an unguarded one.
- **THE COOKIE IS FIRST-PARTY NOW, AND WHAT MAKES IT SO IS THE SHARED APEX — NOT ANY ATTRIBUTE.**
  Session 24 moved the client to `app.askthequorum.com` and the API to `api.askthequorum.com`. Both
  are subdomains of one registrable domain, so a request from the app to the API is **same-site** and
  Safari's ITP has no grounds to touch the cookie. Verified on a real iPhone: signed in, tab closed,
  reopened, still signed in. Decision 77 is closed (decision 92).
  **The old shape is what to keep in mind, because it is the one a future move could recreate.**
  `vercel.app` and `up.railway.app` are both Public Suffix List entries, so those two hosts were
  different registrable domains and the cookie was third-party; `SameSite=None; Secure` was necessary
  and NOT sufficient, because ITP blocks third-party cookies outright and every browser on iOS is
  WKWebView, Chrome included. Desktop Chrome was unaffected, which was the whole shape of the bug and
  is why it survived so long. **Any future host that is not a subdomain of `askthequorum.com` brings
  all of it back** — a client on a preview URL, a second front end, an API moved to a new provider.
  CHIPS/`Partitioned` was never the workaround: Safari does not treat it as an ITP bypass, so it
  would have changed nothing on the broken platform while looking like a fix.
  **`COOKIE_DOMAIN` IS NOT WHAT FIXED IT, AND SETTING IT ONLY WIDENS THE COOKIE.** Unset, the cookie
  is host-only on `api.askthequorum.com` — the narrowest scope available, and iOS works. Set, it
  gains `Domain` and is sent to the apex and every present and future subdomain, and `tokenService`
  moves SameSite `none → lax` in the same step, because `lax` is correct exactly when every client is
  same-site and declaring a shared cookie domain is that assertion. The two move together on purpose:
  splitting them leaves a combination that signs every user out with nothing in the logs.
- **SIGN OUT ON THE REASON, NEVER ON THE STATUS, AND SAY WHICH REASON.** `AUTH_REQUIRED` means no
  cookie arrived; `UNAUTHENTICATED` means one arrived and was rejected. Both call sites in
  `api/client.js` — the fetch path AND the XHR upload path — check `AUTH_FAILURE_CODES` rather than
  `status === 401`, so the first endpoint to 401 for another reason cannot log everyone out. The
  notice is built from the error by `signedOutNotice`, never from a constant: telling a user whose
  browser blocked the cookie that their session expired is false, and telling them to sign in again
  loops them through a failure that cannot resolve (decision 78).
- **A 401 is not always an accident.** In `api/client.js` a 401 from any path outside
  `/api/auth/{me,login,register,logout}` clears the user; those four are exempt because `me`'s 401
  is how the bootstrap discovers there is no session and `login`'s is a wrong password, and
  redirecting on either means the login page redirecting to itself. The handler only sets `user` to
  null — that *is* the redirect, since every `<ProtectedRoute>` reads it, and it keeps routing
  decisions in the router rather than in a fetch wrapper that does not know where the user is.
- **STAGE 4 STREAMS AND NO OTHER STAGE DOES, AND THE PREVIEW IS NEVER THE RECORD.**
  `callModelStreaming` is a **second function** beside `callModel`, not a flag on it, so a caller
  cannot land on a different code path by accident; stage 4 is its only caller. Both settle through
  **`settleCall`**, the single place tokens and cost are read off a response — the wallet debits what
  it reads, and a second copy is a second place for streamed rounds to be billed differently.
  `readStream` rebuilds a chat-completion-shaped body from its chunks so `settleCall` cannot tell the
  paths apart, and it keeps the **LAST** `usage` block it sees: taking the first would debit every
  streamed round zero, silently, with the answer looking perfect (decision 59).
  Because `server/prompts/` is frozen and `04-final.md` asks for a JSON object, the preview is scanned out of
  half-arrived JSON by `services/jsonFieldStream.js` — a resumable state machine over `"final_answer"`
  that handles escapes split across chunk boundaries and **degrades to silence, never to garbage**.
  When the stream ends the COMPLETE buffer goes through `parseModelJson` exactly as before; the parsed
  object is what is persisted, billed and sent. `verify:streaming` asserts the two are identical
  **character for character** on a real round. **Only the first stage-4 attempt streams** — a retry
  that streamed too would restart the answer on screen (decision 60).
  `STREAM_FINAL_ANSWER` in `config/llm.js` reverts all of it; `runRound` takes an override so a
  verification script need not edit config (decision 63).
- **`final_delta` frames are COALESCED at 24 characters, and the replay buffer was raised for them.**
  Every frame is buffered as well as pushed, so one frame per token would overflow the replay a
  reconnecting client depends on. Granularity is the **provider's** decision and spans thirty-fold —
  GPT-5 Mini ~5 characters a chunk, Claude Haiku ~11, Gemini 2.5 Flash ~152 — so the threshold does
  real work on one and nothing on another, and **we do not pace frames to compensate**: holding text
  back to look smoother is a typing animation, not streaming. `MAX_BUFFERED_EVENTS` is 2500 because
  the ceiling case is ~500 delta frames; raise `FINAL_DELTA_FLUSH_CHARS` before raising it again
  (decision 61).
- **A round reaches the screen two ways and must render as one thing.** `lib/round.js` is where a
  persisted round (`roundFromDetail`) and a live stream (`applyStreamEvent`) become the same object;
  every component downstream renders that object and knows nothing about where it came from. Add a
  field to one and you must add it to the other, or a refresh mid-round will silently show less than
  the stream did. `applyStreamEvent` must stay **idempotent per frame** — replay and live fan-out are
  the same frames arriving twice — and `useRoundStream` drops any frame id it has already applied.
- **`max_tokens` is a ceiling, not a spend, and NO FRACTION OF IT IS A COST ESTIMATE.** We are
  billed for what a model generates, so headroom is free and a truncation costs the whole call —
  which means `MAX_TOKENS` tracks the worst case a stage could need and says nothing about what one
  typically uses. The pre-flight estimate reads `STAGE_TOKEN_AVERAGES` in `config/llm.js`, measured
  from our own `model_responses` (decision 31). Session 6's `COMPLETION_ESTIMATE_RATIO` took 0.4 of
  the ceiling and quoted **4.32× the billed cost on average, 8.87× at worst**; the measured averages
  quote 1.64×, and that residual overshoot is deliberate — a quote under the bill is the error that
  surprises a user. **This is not cosmetic: the estimate decides who pays**, since §3's threshold is
  `max($0.05, estimate × 1.5)` and a quote 4× high pushes a funded user onto the free tier.
  **VERBOSITY FOLLOWS HOW OPEN A QUESTION IS, NOT ONLY HOW LONG IT IS — and the estimator cannot see
  that.** Session 17's 40 benchmark rounds asked short but genuinely contestable questions: the draft
  PROMPT came in at 148 tokens against the configured 150, so `PROMPT_LENGTH_SCALING` had the length
  exactly right — while the draft COMPLETION was 523 against 275, and that cascades, doubling the
  prompt of every stage that reads the drafts back. The quote came to $0.32 against $0.49 billed. It
  is NOT a pricing gap: over those 311 calls GPT-5 Mini, Gemini and Claude billed at exactly 1.00x
  catalogue, Llama 4 Maverick at 1.19x (down from 2.12x) and Llama 3.1 8B at 0.50x, which roughly
  cancel. **`STAGE_TOKEN_AVERAGES` has an expiry — refresh it when it drifts.** It is an average over four
  models at one council size; a new model or a template edit moves it. `config/llm.js` carries the
  query that produced it, and **`npm run calibrate:estimate` is now the check** — it re-quotes every
  round in the database against what it was actually billed and prints the before/after. That is
  cheaper and blunter than `verify:wallet`, which still shows the estimate beside one real round.
- **THE QUOTE SCALES WITH THE LENGTH OF THE QUESTION, and it did not until Session 13.** The
  averages above were measured on short factual questions; the self-preference study asked open
  judgement calls averaging 141 characters and **cost $0.90 against a $0.35 quote**. Across all 106
  rounds the old estimator under-quoted **83 of them**, median 0.71×. `PROMPT_LENGTH_SCALING` in
  `config/llm.js` fixes it with two separate effects, and they are separate on purpose (decision 56):
  the question is interpolated into every stage's prompt once, so its tokens are **added** and never
  saturate — an 8,000-character question really does add ~2,000 prompt tokens to all four stages;
  and models write longer answers to richer questions, which stages 2–4 then pay to read back, so
  verbosity **multiplies** and is **capped at 3.5×** because `MAX_TOKENS` caps a draft. Long-form
  rounds now under-quote 1 in 28 instead of 24 in 28. **It does not change who pays** at realistic
  council sizes: a three-model round quotes $0.008 short and $0.023 long, and `max($0.05, est × 1.5)`
  is the $0.05 floor either way.
- **ONE SEATED MODEL IS BILLED AT TWICE ITS LISTED PRICE, and no token model can fix it.** Measured
  over every call: Gemini 1.03×, Claude Haiku 0.99×, GPT-5 Mini 1.00× — and **Llama 4 Maverick
  2.12×**. OpenRouter's listed price for that slug is exactly what `models` carries, so this is
  decision 16 in the flesh: the listed price is the cheapest route's, and we were billed a dearer
  one. It is the whole of the residual under-quote on short questions, and the catalogue price has
  deliberately NOT been changed — doing so would make the council picker disagree with OpenRouter's
  published number. Reprice it or accept it, but do not mistake it for a token-model problem.
- **The estimate's inputs travel with the prices, and the arithmetic happens twice on purpose.**
  `GET /api/models` returns `{ models, estimate }`, where `estimate` carries `stageTokens`,
  `maxTokens`, `lengthScaling` and `imageInputTokens` straight from config. The client multiplies (so
  a toggle re-quotes with no round trip) and `costEstimateService` multiplies (so the gate decides
  from the same figure). Duplicating the arithmetic is fine; duplicating a *constant* is not, and
  would drift silently since the quote still renders (decisions 28 and 31).
  **§3'S THRESHOLDS RIDE THERE TOO, AND THERE IS NO SUCH THING AS AN ACCOUNT TIER.** The gate is
  `balance >= max(minimum, estimate × multiple)`, and the estimate moves with the COUNCIL — the same
  balance is paid for a two-model round and free for a five-model one, and one toggle can cross the
  line. So any sentence naming a tier is about the ROUND, and `/new` used to render the constant
  string "Free plan: 2 debates per day" to everyone, funded or not, under a header chip reading
  $5.00. `estimate.threshold` (`{ minimum, multiple }`) and `estimate.freeRoundsPerDay` now ship, and
  `lib/cost.js`'s `billingModeFor` mirrors `entitlementService.thresholdFor` — **checked against that
  function over 42 combinations, not against a reading of it**. It returns **null** when the
  constants are absent rather than defaulting them: a default is the second copy the rule exists to
  prevent, and it is the copy that would decide who pays (decision 93).
- **A CLAMPED PREVIEW RENDERS AS PLAIN TEXT — decision 62's rule, in its second place.** The streamed
  final answer swaps to markdown once because markdown on partial input does not degrade, it
  flickers; a three-line clamp is partial input by construction and fails worse. The stage-1 draft
  card wrapped `<Markdown>` in a `-webkit-box`, and `-webkit-line-clamp` only clamps **inline**
  content — so `h1`, `p` and `li` were laid out on top of one another and a draft opening with a
  heading printed its first paragraph through it. `lib/excerpt.js`'s `plainExcerpt` supplies the text
  node that Mantine's `<Text lineClamp>` wants, which is what every other clamp in the client already
  uses. **`plainExcerpt` is not a markdown parser and must not become one** — the full answer is one
  click away and `react-markdown` renders it there (decision 94).
- **A wallet write is `withTransaction` + `lockUserForUpdate`, always, and the lock is about
  `balance_after`.** `adjustCreditBalance` does its arithmetic in the database, so two concurrent
  debits cannot lose one another even unlocked — but both can read the same intermediate balance and
  write it into two ledger rows, leaving a running total that goes sideways while the balance is
  right. The lock makes the update and its row one step. Two invariants hold and `verify:wallet`
  asserts both: `SUM(amount) = users.credit_balance`, and the newest row's `balance_after` equals it.
- **`credit_transactions` is one row per ROUND and every row is money that moved.** Not one per call
  — `model_responses` already holds per-call cost, tokens, provider and latency, and eight rows per
  debate makes `balance_after` meaningless on seven of them (decision 33). And a free round writes
  **no row at all**, not a `bonus` of zero: a zero row restates the previous `balance_after` and
  makes the invariant above be carried by rows that assert nothing. `rounds.total_cost` still records
  what a free round cost us (decision 34). Debits are stored **negative**, so `SUM(amount)` is the
  balance and the CSV reads the way mockup 04 renders it.
- **A balance may go marginally negative and §3 allows it.** The check is before the round and the
  debit is after it, with nothing held in between and no reservations. Every *display* clamps at
  zero (`displayBalance`, the header chip); the column does not, because an audit needs the figure.
- **THE STRIPE WEBHOOK IS MOUNTED IN `app.js` ABOVE `express.json()` AND THAT ORDER IS THE WHOLE
  POINT.** Stripe signs the exact bytes it sent; `express.json()` consumes the stream and leaves an
  object, and re-serialising it cannot reproduce them. The failure reads as "No signatures found
  matching the expected signature", which looks like a wrong secret — so the obvious next move is to
  change a secret that was already correct. `express.raw({ type: 'application/json' })` is scoped to
  `/api/webhooks` alone, and that is why the route is outside `routes/index.js` despite its path.
- **A refusal to spend explains itself with numbers.** The 402 from `POST /rounds` carries a third
  key on the envelope, `billing` — `{ mode, estimate, threshold, balance, freeRemaining }` — emitted
  by `errorHandler` under the same `status < 500` guard as `details`, and set nowhere else. It is
  not `details` in disguise: `details` is an array of Zod field complaints the client reads *by field
  name*, and a balance belongs to no field (decision 32).

## Documentation duties (every session)

- Update **Current state** below.
- Append a section to `docs/build-log.md`. Never rewrite earlier sections.
- Log any spec deviation in `docs/decisions.md`.
- **Never modify `docs/quorum-product-document.md` or `.pdf`.** They are the frozen approved v1.0.

## Current state

_Last updated: end of Session 24 (2026-08-15) — **the product moved to one apex**:
`app.askthequorum.com` and `api.askthequorum.com`, which makes the session cookie first-party and
closes decision 77, the oldest open bug in the project. Confirmed on a real iPhone. CORS is now an
exact-match allow-list and the cookie's scope is env-driven; `COOKIE_DOMAIN` is deliberately unset.
§5 has no unbuilt screens and §8 no unbuilt endpoints; §10's streaming extension is built.
`docs/security.md` is the security review and the README carries the endpoint audit table._

**`CORS_ORIGINS` IS EMPTY, SO THE ALLOW-LIST IS EXACTLY `[CLIENT_ORIGIN]` — AND A SHARE LINK ON ANY
OTHER HOST IS DEAD BY DESIGN.** `sessions` stores only the token; `shareService` rebuilds the URL per
request from `CLIENT_URL`, so a link minted before Session 24 reads
`https://quorum-gal-giladi.vercel.app/s/<token>` for ever. That host still SERVES the page, but the
page fetches `GET /api/share/:token` from `api.askthequorum.com` — cross-origin — and that origin is
no longer allowed. **Keeping a domain attached is necessary and not sufficient**; the origin has to
be in the list too, and it deliberately is not.
**This was checked before it was done, and the check is the reusable part.** Ownership of every
`share_token` was read first: two belonged to `leaderboard-seed@quorum.local`, one to the owner, one
to that day's throwaway — no third party held a link, so nothing anyone else relied on was broken.
**Any future move of the client must run that query before emptying the list**, because the answer
will not always be the same.
**The failure shape, measured rather than predicted.** The server still answers **200** — CORS is a
browser control, not an authorization one, and nothing appears in the access log. The browser
discards the response for want of an `Access-Control-Allow-Origin`, `fetch` rejects with
`TypeError: Failed to fetch`, and `api/client.js` maps that to `status: 0` / `NETWORK_ERROR`, which
renders as **"Cannot reach the server"** in an inline alert and a toast. A `mode: 'no-cors'` probe to
the same URL resolves `type: 'opaque'`, which is the proof the request arrived. So the copy is
literally wrong and behaviourally right: the server was reached, and the real remedy — use
`app.askthequorum.com` — is not something the old bundle can know. **The token is unchanged**, so
`https://app.askthequorum.com/s/<same token>` works; a dead link is fixed by swapping the host
(decision 92).

**`/new`'S MOBILE ORDER IS NOW A JS BRANCH, NOT A CSS TRICK, BECAUSE THE CSS TRICK COULD NOT DO IT.**
Session 21's `Grid.Col` `order` fix moved presets above the model list (fixing discoverability) and
broke the flow doing it — the plan and Start button appeared before any model was chosen. The
requested sequence (presets → models+settings → question → plan → Start) interleaves content split
across one desktop `Paper`, which `order` cannot reach into without changing desktop too.
`isMobile = useMediaQuery('(max-width: 62em)')`, declared with every other hook above the early
returns (a hook placed after one violates the Rules of Hooks — the first draft did this), now picks
which of two JSX trees renders; every piece (`CouncilPicker`, the question `Textarea`, `PresetPicker`,
`RoundPlanCard`, the Start button) is built exactly once and arranged differently, never mounted
twice — a CSS visibility toggle would have kept two live `PresetPicker`s, each with its own
"naming a preset" state. Decision 87. Desktop is byte-for-byte the same two-column grid as before.

**MODEL NAMES WRAP INSTEAD OF TRUNCATING, AND THE FIRST ATTEMPT MADE IT WORSE.** Removing `truncate`
so long names could wrap produced "Cla / ude / Hai / ku / 4.5" — `minWidth: 0` (already present, to
let the row shrink at all) permits shrinking below content size; it does not claim the row's leftover
space, and only wrapping exposed the gap between the two. `flex: 1` from the row's left `Group` down
to the name's own `Box` fixed 360–412px; 320px additionally needed the price column
(`w={{ base: 68, xs: 96 }}`) and the row's gaps to shrink, or names still broke into fragments rather
than words. Decision 88. "Save as preset" gained a `border-top` divider — it was already the last
thing in the presets card, contrary to the report, but nothing marked it as a different kind of
control from the preset rows above it.

**TWO LEADERBOARD LEAKS, BOTH CLOSED AT THE SOURCE.** "Ghost Model (test)" — Session 8's
deliberately unroutable fixture, `is_active = false` — kept every drafted seat it was ever given
(`models.id` is `ON DELETE RESTRICT`, never `CASCADE`) and `aggregateLeaderboard` had no predicate on
`is_active`, so it surfaced in the unranked list. One `WHERE m.is_active = true` on the query fixes
ranked, unranked and the podium at once, since all three are slices of the same rows — documented as
the leaderboard model's third trap (decision 90), alongside the two CLAUDE.md already named. Separately,
the self-preference card carried three screens of CIs, p-values and post-hoc analysis; every number it
no longer states was already in `docs/self-preference-study.md`, checked section by section before
cutting anything. What is left: heading, one sentence, the three bars, one line of qualification
("Most of that is draft quality, not preference: GPT-5 Mini's drafts also win 74% of rounds judged by
other models" — the one line that could not be cut, per decision 91), and "Read the study →". Runs
about 540px of a 900px viewport at 390px, down from three screens.

**SESSIONS NOW TITLE THEMSELVES, AND RENAME/DELETE/SHARE LIVE IN THE DEBATE VIEW TOO.** A session
created without a first prompt sat as "Untitled session" forever; `debateService.js`'s `runRound` now
calls `titleFromPrompt.js` (word-boundary truncation to ~50 chars, no LLM call) the moment a round
completes and writes it with `sessionModel.js`'s `setTitleIfBlank` — an atomic `WHERE title IS NULL`,
never a read-then-write, so a rename landing mid-round can never be clobbered by the question that
predates it. `updateSession` (rename) is untouched and always wins. Existing untitled sessions are
backfilled by `npm run backfill:session-titles` (dry run by default), which imports the same
truncation function rather than reimplementing it in SQL — decision 84 has the full reasoning,
including eight real prompts checked before the ~50-char limit was chosen.

Rename, delete and share were `/sessions`-only before this session; `RenameModal.jsx` and
`DeleteModal.jsx` moved out of `Sessions.jsx` into `components/sessions/` so `Chat.jsx` can render
the identical components against the identical `updateSession` / `deleteSession` calls, and the new
`SessionActionsMenu.jsx` replaces three separate copies of the same kebab `<Menu>` with one used by
`SessionsTable.jsx`, the debate view's own title (which had no header row on desktop before this),
and each row of `SessionSidebar.jsx`. The sidebar's per-row menu reveals on `@media (hover: hover)`
and stays on under `(hover: none)` — a pointer-capability query, not a width guess — and is wrapped in
a `stopPropagation` `Box` because the row is itself a `<Link>`: a click on a portalled `Menu.Item`
still bubbles through the React tree the JSX declares and would otherwise also fire the row's own
navigation. Deleting the session currently open navigates to `/new`; deleting a different one from
the sidebar just removes it from the list. Decision 85 has the rest.

**The `/sessions` VERDICT-column truncation Session 21 found and reported is now actually fixed** —
the first two attempts were not narrower where it mattered. `lib/verdictLabel.js` is the one map both
`lib/verdict.js`'s session-row chip and `lib/round.js`'s in-round chip read their word from, so the
two cannot describe an outcome differently. Measured with a canvas `measureText` against the real
column (`element.scrollWidth > clientWidth` reported zero truncation everywhere, including on a row a
screenshot showed truncated — Mantine's `Badge` is `width: fit-content` and never overflows itself;
what clips is the label inside a root the table has already shrunk): "Synthesised" (69px) truncates at
320/360/768px; "New answer" (68px) truncates identically; "Custom" (43px), genuinely shorter, still
truncated once the column's width shifted with the rest of the table's content. "New" (24px) and
"Same" (31px, for `unanimous`, which had the identical bug and was not named in the brief) hold with
real margin. **`Merged` was told to stay unchanged and was also wrong** — fine on local dev's fixture
data, truncating at 43px against the DEPLOYED app's real 39px column at 360px, caught only because
verification measured production rather than trusting the brief's "this one already fits." `Both`
(26px) replaces it. Only `Picked` was actually fine (decision 86).
**FIVE MOBILE FIXES THIS SESSION, ALL LIVE ON PRODUCTION.** Chairman selection was entirely
`display: none` below Mantine's `xs` (576px) — not squeezed, absent, with no second control anywhere
on `/new` — and presets sat ~1350px down a 360px-wide page, below the whole model list. Both
diagnosed on the deployed app with a full-page CDP capture before any code changed; both fixed and
re-verified the same way. See decisions 80–81 and the Session 21 build log for the full diagnosis,
including a nested-`<input>`-inside-`<button>` trap the first draft of the chairman fix hit.

**Approved, merged to `main`, deployed, and re-verified against the deployed app (not local):**
the 320px `AppShell` header overflow (the credits chip moved into the drawer below `sm`, freeing
enough room that the burger stops clipping), a 44px Button-height floor set once in `global.css`
rather than at ~30 call sites, `ModelBadge`'s six under-12px call sites raised to 12px, and — found
only because it was named in the verification ask, not one of the three fix items — the landing
header's own wrap between 360px and 393px. **Radio/Checkbox and Mantine `Badge` did NOT get the 44px
/ 12px treatment**: both were implemented, both visibly broke something (a 44px chairman radio pushed
its own "judging" badge into truncation; a 12px verdict badge made "Merged" start truncating on
`/sessions`, which — worth knowing — was **already** truncating "Synthesised"/"Picked one" before this
session touched anything), and both were reverted per decision 83 rather than shipped broken. The
session's earlier responsive/Firefox audit (widened `responsive-shots.mjs` to 320/360/393/412/768/1024
× all nine routes, plus a `geckodriver`-driven Firefox pass) found these issues in the first place;
see the "Next session" list below for what is still open, including the sessions-table truncation,
which is new.

**VERCEL NEEDS `client/vercel.json`, AND ITS ABSENCE IS INVISIBLE FROM INSIDE THE APP.** Without the
SPA rewrite every path but `/` returns 404 in production — including `/s/:token`, the one surface
built for people with no account. Clicking through the app works, because React Router never asks
Vercel for those paths; only a direct load, a refresh or a bookmark hits the static host. **Test deep
links by REQUESTING them, never by clicking to them** (decision 74). And check Vercel's Deployment
Protection before sharing the URL: with it on, the site redirects to Vercel SSO and no reviewer can
open it.

**LIVE, ON ONE APEX.** Client **`https://app.askthequorum.com`** (Vercel, `VITE_API_URL` → the API),
API **`https://api.askthequorum.com`** (Railway, root directory `server`, `NODE_ENV=production`).
DNS is Namecheap BasicDNS: two CNAMEs, `app` → Vercel's `…vercel-dns-017.com`, `api` → Railway's
`ayloifri.up.railway.app`. Both certificates are Let's Encrypt, issued by the platforms.
The **old hostnames stay attached as rollback targets and still serve** —
`quorum-gal-giladi.vercel.app`, `quorum-snowy-zeta.vercel.app` and
`quorum-production-9200.up.railway.app` — but **`CORS_ORIGINS` is empty, so none of the client ones
can call the API.** Know which rollback lever still pulls: pointing `VITE_API_URL` back at the old
Railway API **works**, because CORS keys on the client's origin and that stays `app.askthequorum.com`
(iOS breaks again, though — the cookie goes third-party). Rolling the *client* back to a `vercel.app`
host **does not work** without restoring `CORS_ORIGINS` first. Vercel **preview deployments** are
refused for the same reason; a preview that needs to sign in needs a temporary entry, never a suffix
test.
`npm run verify:deployed` drives the **deployed** URLs — 38 checks, one real debate — and is the
script to run after any production change. Its defaults are the canonical pair since Session 24;
`API=` / `CLIENT=` still override. The defaults were changed rather than left because the old
hostnames still answer, so a stale default would not fail — it would quietly verify the deployment
nobody uses and report 38 passes for it. It times SSE frames rather than counting them, because a
buffering proxy delivers every frame and only the arrival spread tells them apart.

**ONE APEX, BUT STILL TWO ORIGINS — SAME-SITE IS NOT SAME-ORIGIN.** `app.` and `api.` share a
registrable domain, which is what makes the cookie first-party; they are still different origins, so
**every API call is still cross-origin and CORS still governs all of it**. Nothing about the move
made CORS optional. The cookie's attributes are computed once in `tokenService` and spread into BOTH
`cookieOptions` and `clearCookieOptions` — a browser only replaces a cookie when the attributes
match, so a drifted logout leaves the old cookie in place and looks like it worked (decision 66).
**CORS IS AN EXACT-MATCH ALLOW-LIST, never `*`, never `origin: true`, and never a regex or a
`.endsWith('.askthequorum.com')` test** — a wildcard is illegal in a credentialed response,
reflecting the caller's origin is an allow-list with nothing in it, and a suffix test admits every
present and future subdomain, including one that gets taken over, to spend a user's session.
`ALLOWED_ORIGINS` in `config/env.js` is `CLIENT_ORIGIN` ∪ `CORS_ORIGINS`, **and CLIENT_ORIGIN is a
member by construction rather than by an operator repeating it** — excluding the canonical client is
the one mistake unrecoverable from outside the dashboard, and its symptom is a browser-side error
naming no cause. Every entry goes through `URL.origin`, so a trailing slash, a path or an upper-case
host becomes what a browser actually sends rather than a member that can never match (decision 65).
`CORS_ORIGINS` is for a **migration**, not a second client: empty is the steady state, and an origin
left there afterwards can still make credentialed calls with a user's cookie (decision 92).

**Deploying:** Railway, root directory `server`. `/app` is the contents of `server/` — see the
templates convention above, and keep `server/` self-contained. **Post-demo, one line:**
`server/package.json` says `engines.node: ">=20"`, which is what lets Railway pick Node 20, while
`@supabase/supabase-js@2.112.3` declares `">=22.0.0"`. It is an engines warning, not a failure —
everything runs — but bump it to `">=22"` when there is time to watch it, then re-run
`verify:leaderboard`, which is the script that exercises Supabase Storage end to end.

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
  Session 14 added **`callModelStreaming({ ..., onDelta })`** — the same returned shape, the same
  timeout, the same error mapping, and the retry restricted to a non-2xx **status**, which is known
  before any delta has gone out (a retry mid-body would replay a second answer into a client already
  rendering the first). `readStream` skips `: OPENROUTER PROCESSING` comment lines and `data: [DONE]`,
  maps a mid-stream `error` chunk to `OPENROUTER_UNAVAILABLE` — the streamed twin of Session 4's
  200-with-`finish_reason: error`, and it has fired in practice — and keeps the **LAST** `usage`
  block. Both paths settle through `settleCall`. `onDelta` is wrapped: one throw disables it for the
  rest of the call rather than aborting a generation the user has been quoted for.
- `src/services/jsonFieldStream.js` — `createFieldScanner(field)`, the resumable state machine that
  pulls `final_answer`'s text out of JSON that has not finished arriving. Seven states, escapes split
  across chunk boundaries included, `lost` on anything it does not understand. Reads; never consumes.
- `src/services/promptService.js` — the four `server/prompts/*.md` templates parsed at **import**,
  so a missing or section-less file is a boot failure. `getPrompt(stage)`, `render(tpl, vars)`,
  `renderStage(stage, vars)`; stage keys match `model_responses.stage`. **`server/prompts/` is
  read-only to the server** — never write to it. The directory is resolved from `import.meta.url`,
  never `process.cwd()` — see the deployment convention above.
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
  with its cost and duration. `onEvent` emits the eleven events that are now SSE frames, and is
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
  | GET | `/api/rounds/:id/stream` | SSE — eleven events, `final_delta` / `final_done` among them |

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

- **Billing is live and verified with 76 checks over seven real debates** (Session 9). §8's
  pre-flight cost check exists, and Session 7's temporary rate limiter is **deleted** — the note in
  `middleware/rateLimit.js` says not to bring one back.
  - `src/config/billing.js` — §3's numbers in one place: `FREE_ROUNDS_PER_DAY` 2,
    `MINIMUM_THRESHOLD` $0.05, `THRESHOLD_MULTIPLE` 1.5, `TOPUP_AMOUNTS` [5, 15, 50],
    `SPEND_CHART_DAYS` 7. Shared config rather than exports on `entitlementService`, which
    `walletService` would otherwise have to import in a cycle.
  - `src/services/entitlementService.js` — `canStartRound(userId, plan)` →
    `{ allowed, reason, mode, estimate, threshold, balance, freeRemaining }`. Never throws for a
    refusal; `roundService` turns `allowed: false` into the 402. **Two codes for one rule**:
    `INSUFFICIENT_CREDIT` when there is money but not enough for this council (the user can shrink
    it, which is free), `DAILY_LIMIT_REACHED` when the wallet is empty (decision 35).
  - `src/services/walletService.js` — `debitForRound`, `creditTopup`, `getBalance`,
    `getTransactions`, `getSpendByDay`, `getWalletSummary`, `transactionsToCsv`, `displayBalance`.
    `toPublicTransaction` is the single place a ledger row becomes wire shape, and the CSV renders
    the same object, so the table and the download cannot disagree.
  - `src/services/costEstimateService.js` — `estimateRoundCost(plan)` over a `planCouncil` result.
    Prices ride on the council member (`councilService.toCouncilMember` carries `inputPer1k` /
    `outputPer1k`, `listSessionModels` selects them) rather than being fetched again.
  - `src/services/stripeService.js` + `controllers/webhookController.js` + `routes/webhookRoutes.js`
    — hosted Checkout and a signed webhook. `TOPUP_AMOUNTS` is an allow-list checked by Zod **and**
    again in `createCheckoutSession`, because that is the function that names a price to Stripe.
  - `src/models/creditTransactionModel.js` (the twelfth model file), plus `lockUserForUpdate` on
    `userModel` and `countRoundsForUserToday` / `averageRoundCostForUser` on `roundModel`.
  - **Migration 005** — a partial unique index on `credit_transactions.stripe_payment_id`
    `WHERE stripe_payment_id IS NOT NULL`. The lock answers a retry clearly; the index is the
    guarantee for the case a lock cannot cover (decision 37).
  - `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` joined `REQUIRED_IN_PRODUCTION`, **not** the
    always-required block: everything but topping up works without them, and the two endpoints that
    need them raise 503 `STRIPE_NOT_CONFIGURED` (decision 36).

  | Method | Path | Result |
  |---|---|---|
  | GET | `/api/wallet` | balance, mode, 7-day spend, today's free remaining, the top-up amounts |
  | GET | `/api/wallet/transactions` | paginated ledger, plus `?format=csv` |
  | POST | `/api/wallet/checkout` | 201 `{ checkout: { id, url, amount } }` — $5 / $15 / $50 only |
  | POST | `/api/webhooks/stripe` | **outside `/api`'s router**, above `express.json()` |

  `POST /sessions/:id/rounds` now answers **402** with `error.billing` when refused, and its 202
  carries the same block so a client knows which side of the rule the round fell on.

- **`/wallet` is mockup 04 and live** — `pages/Wallet.jsx` plus `components/wallet/`
  (`BalanceCard`, which switches on `mode` because a free user has no balance and a bar filled to
  zero says the wrong thing; `AddCreditsCard`, whose three amounts come from the server;
  `SpendChart`, seven flex boxes and no charting library; `TransactionTable`). A 402 from the round
  endpoint renders `components/debate/TopUpPrompt.jsx` inline in the thread. The header's credits
  chip is live, refreshed by `AuthContext.refreshUser()` — called when a round settles and when the
  wallet page loads.
- `scripts/verify-wallet.js` (`npm run verify:wallet`) — 76 checks over seven real debates and a
  signed Stripe event, driving a **running server**. Three accounts, because the third has its
  balance set by hand exactly once so the reconciliation check asserts something about the wallet
  rather than about the fixture. **Writes to the database**; about $0.05 a run.

- **Presets, sharing and the sessions page are live, verified with 89 checks** (Session 10). The two
  §8 blocks that had tables and no code against them now have both.
  - `src/models/presetModel.js` — the twelfth and last model file, covering `presets` and
    `preset_models` together as `sessionModelModel` does for its pair. **Migration 006** adds a
    unique index on `(user_id, lower(name))`, so a duplicate name is a 409 from the constraint rather
    than a SELECT that would lose the race.
  - `src/services/presetService.js` — CRUD plus `seedPresetsForUser`, which registration calls. Every
    new account starts with **"Full council"** and **"Cheap draft"**, built by *querying* `models`
    (decision 38). "Cheap draft" carries `chairmanAbstains: false` because two models with the
    chairman abstaining leaves one drafter, which `planCouncil` refuses. Seeding catches its own
    failures and logs them — it can never fail a registration.
  - **Duplicate is not an endpoint** (decision 43): the client POSTs the preset it is already
    rendering, with a new name. §8 lists four preset endpoints and this is why there are four.
  - `src/services/shareService.js` — a 24-byte base64url token, idempotent minting, revoke-by-NULL,
    and the public read. `src/routes/shareRoutes.js` is its own file so that the absence of
    `router.use(requireAuth)` reads as a decision rather than an omission.
  - `createShareRateLimiter()` — 60 per IP per hour, keyed on the IP because this is the one route
    with no user behind it. It is **not** the defence against guessing a token (192 bits is); it
    bounds what one machine can pull out of the only endpoint where an anonymous caller makes the
    database work.

  | Method | Path | Result |
  |---|---|---|
  | GET | `/api/presets` | `{ presets }`, each with a session-shaped `council` block |
  | POST | `/api/presets` | 201 — 409 on a duplicate name, case-insensitively |
  | PATCH | `/api/presets/:id` | rename and/or replace the line-up |
  | DELETE | `/api/presets/:id` | 204 |
  | POST | `/api/sessions/:id/share` | 200 `{ shareToken, url, created }` — idempotent |
  | DELETE | `/api/sessions/:id/share` | 204, writes NULL |
  | GET | `/api/share/:token` | **PUBLIC.** Allow-listed payload, 404 for unknown *and* revoked |

  `GET /api/sessions` gained `?verdict=`, and its rows gained `latestVerdictType` and `totalSpend` —
  both correlated subqueries, so LIMIT applies to sessions rather than to joined rows.

- **`/sessions` is mockup 03 and live** — `SessionsTable`, `ShareModal` (which mints on open, because
  the user decided by pressing Share), `PresetCards`, `PresetModal` (reusing `CouncilPicker`, so the
  refusals are the same three), and `lib/verdict.js` for the chip labels and relative time.
  `PresetPicker` on `/new` replaced the Session 8 placeholder, and the page now **opens on the "Full
  council" preset** — the same default it always had, now visibly a preset.
- **`/s/:shareToken` is the real read-only view.** It renders its own header, reuses `RoundView`, and
  read-only is the *absence* of things rather than a mode: no composer, no council editor, no
  sidebar, no rail. `lib/round.js` carries `totals.cost` as **null** when the payload has none and
  `FinalCard` omits the figure — `formatCost(null)` is "$0.00", and telling a stranger a debate was
  free is worse than telling them nothing. A 404 renders its own page, not the ErrorBoundary.
- `scripts/verify-sharing.js` (`npm run verify:sharing`) — 89 checks, and the first verify script
  here that **costs nothing to run**: everything it checks is lists, filters, links and cascades, so
  the fixture rounds are INSERTed rather than debated. Requires `npm run dev`. **Writes to the
  database.**

- **The leaderboard and attachments are live, verified with 84 checks** (Session 11). §5's last
  unbuilt screen and §8's last unbuilt endpoints.
  - `src/config/leaderboard.js` — §4's numbers: `MIN_DRAFTS_TO_RANK` 5, `DEFAULT_WINDOW_DAYS` 30,
    `MAX_WINDOW_DAYS` 365 (the window is the only bound on how much of `model_responses` one request
    aggregates), `PODIUM_SIZE` 3.
  - `src/models/leaderboardModel.js` — the thirteenth model file and the first named for a QUESTION
    rather than a table (decision 45): six CTEs over `rounds`, `round_models`, `model_responses` and
    `models` in ONE statement, ~80ms. Read the two traps above it before touching it. Also exports
    `explainLeaderboard` and `draftDenominatorComparison`, which the application never calls.
  - `src/services/leaderboardService.js` — `toPublicStanding` is the single place a standing becomes
    wire shape, and the ranked/unranked split. `concessionRate` is over rebuttals MADE, not rounds
    drafted, and is **null** rather than 0 when a model never rebutted. `avgCost` is the model's own
    draft call, never the round total (decision 46).
  - `src/config/attachments.js` — the magic-byte table, 8 MB, 4 per round, and the two signed-URL
    TTLs (10 minutes for the owner, 5 for the public shared view).
  - `src/services/storageService.js` — the only file that talks to Supabase Storage. The bucket is
    **private** and every read is a signed URL minted at request time; nothing stores one, because a
    signed URL is a credential with an expiry. `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` stay optional
    outside production exactly as Stripe's are, and the endpoints 503 `STORAGE_NOT_CONFIGURED`.
    `npm run storage:init` creates the bucket; the server never provisions at boot.
  - `src/services/attachmentService.js` — `sniffMimeType`, the claim/bind lifecycle,
    `loadAttachmentParts` (downloaded and base64-encoded ONCE per round, not once per drafter), and
    `toPublicAttachment`, the single wire shape. **One 403 for three cases** — not yours, does not
    exist, already on another round — for the same reason an unknown share token and a revoked one
    are the same 404.
  - `src/models/attachmentModel.js` — the thirteenth table file, and the last: every table in §7's
    ERD now has one.
  - `src/middleware/upload.js` — multer, memory storage, **no `fileFilter`**: a filter runs on the
    declared type and the filename, which are the two things about an upload nobody should believe,
    and a check that looks like a defence and is not one is worse than none.
  - **Migration 007** — `models.supports_documents`, plus a fifth active model,
    `meta-llama/llama-3.1-8b-instruct`, which is **text-only**. Every model seeded before it supports
    vision, which left the "a council member that cannot see the image" path with nothing to run it
    against (decision 49).

  | Method | Path | Result |
  |---|---|---|
  | GET | `/api/leaderboard` | `{ leaderboard }` — `?scope=mine\|all&days=30`, ranked + unranked |
  | POST | `/api/attachments` | 201 multipart — 415 on a bad or mislabelled type, 413 over 8 MB |
  | DELETE | `/api/attachments/:id` | 204, object first and row second |

  `POST /sessions/:id/rounds` takes `attachmentIds`, claimed before the 202 and bound after it.
  `GET /api/rounds/:id`, `GET /api/sessions/:id` and `GET /api/share/:token` all carry a round's
  `attachments` with freshly signed URLs, and their `council` entries carry `supportsVision` /
  `supportsDocuments`.

- **`/leaderboard` is mockup 07 and live** — `components/leaderboard/` (`Podium`, three stepped
  blocks in flexbox with no charting library; `StandingsTable`; `UnrankedList`) plus
  `lib/leaderboard.js`. The page **opens on "All time", not the mockup's "My council"** (decision
  52), and the empty state explains the five-draft rule rather than drawing three blank blocks.
  Avg cost is formatted to two SIGNIFICANT FIGURES, because `toFixed(4)` renders $0.00051 and
  $0.00095 as $0.0005 and $0.0010 and rounds a factor of two into nothing.
- **The composer's attachment button is live.** `usePendingAttachments` uploads on CHOOSE rather than
  on send — by the time Send is pressed there is an id to name in the body — and `AttachmentChip` is
  one component for three states (uploading with a progress bar, failed, ready). `api/client.js`
  gained `upload()`, the only call in the client that is not `fetch`: `fetch` reports nothing until
  the request body has gone out, so progress needs XMLHttpRequest.
- `scripts/verify-leaderboard.js` (`npm run verify:leaderboard`) — 84 checks, including one model's
  numbers walked by hand against the raw rows, both denominators printed side by side, and TWO real
  debates (a PNG and a generated PDF) because the only way to prove a vision model read an image and
  a text-only one said it could not is to ask them. Requires `npm run dev`. **Writes to the database
  and to Supabase Storage**; about $0.02 a run.
- `scripts/verify-streaming.js` (`npm run verify:streaming`) — 65 checks, over a
  fourteen-case scanner corpus fed at seven chunk sizes each, three real streamed probe calls that
  print how coarse each provider's chunks are, and three real rounds: one over HTTP with three
  subscribers (from the start, joining at the first delta, and after `round_complete`) whose streamed
  text is asserted equal to the parsed `final_answer` character for character; one with the flag off;
  and one whose delta handler throws on every frame. Requires `npm run dev`. **Writes to the
  database**; about $0.018 a run.

**Deliberately not built yet:** Google OAuth (deferred — decision 10). `requireRole` still has no
caller. **§5 has no unbuilt screens and §8 no unbuilt endpoints.**

**BILLING IS PROVEN END TO END ON THE DEPLOYED PRODUCT, and the oldest open item in the project is
closed** (Session 16). It had stood since Session 9: everything around the card was verified and the
card itself never typed. A real `4242 4242 4242 4242` payment against the live Railway webhook wrote

```
topup  +5.00000000  balance_after 5.000000  stripe_payment_id pi_3U3vxbDXrVyVsqS60BWIYu2l
debit  -0.00395918  balance_after 4.996041  = rounds.total_cost of a paid round, exactly
```

— one topup row for that payment intent, so the idempotency guard held against Stripe's redelivery;
one debit row equal to the round's own `total_cost`; and `SUM(amount)` reconciling with
`credit_balance` to the two columns' precision difference. The `stripe_payment_id` is the proof it
came through the webhook: `creditTopup` is the only writer and the controller is its only caller.
**Money in, money out, both on production.** Nothing in billing is now unexercised.

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

**A pg `date` is a JS `Date` at LOCAL midnight, and `toISOString()` on one shifts it.** Session 9's
spend chart labelled every bar a day early on a UTC+3 machine, and six of the seven still looked
plausible — the verify script caught it, not a person looking at it. `walletService.isoDay` reads
the local components back out. Any future column typed `date` has the same trap.

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

**DELETING A USER ORPHANS ITS STORAGE OBJECTS, AND THERE IS NO USER-DELETE PATH IN THE PRODUCT.**
`DELETE /api/attachments/:id` and `DELETE /api/sessions/:id` both sweep the bucket correctly; nothing
else does, because nothing else exists. So any out-of-band deletion — direct SQL, a future admin
panel — must **remove the objects BEFORE the rows**, since `attachments.storage_path` is the only
record of which object belongs to which row and the cascade takes it. Two notes for whoever builds
the fix: paths are `userId/uuid.ext`, so one prefix listing is a whole user's objects and a sweep
needs no rows at all; and **a `downloadObject` right after `removeObject` can still succeed** off
Supabase's CDN, so verify with a listing or you will chase objects that are already gone
(decision 67).

**Deleting a session sweeps the bucket before Postgres cascades the rows.** The cascade takes the
`attachments` rows and knows nothing about Supabase Storage, so without `removeSessionObjects` a user
deleting a session to get rid of a document would not have got rid of it. Best effort and logged:
the rows are going either way, and a failed sweep must not turn a delete into an error the user
cannot get past. Any future table that points at an object outside Postgres has the same trap.

**Next session — the spec is finished, so what is left is depth, not breadth.** In the order they are
worth doing, updated after Session 21 shipped five mobile fixes and audited responsive/Gecko behaviour
(test-card Stripe Checkout was closed in Session 16 — see "BILLING IS PROVEN END TO END" below — and
no longer belongs on this list; the 320px header overflow and the landing header wrap, both formerly
here, are fixed and deployed — see above):

1. **`/sessions`' VERDICT column truncates "Synthesised"/"Unanimous"/"Picked one" at ~768–1024px.**
   New finding, not caused by Session 21 (confirmed against a pre-session screenshot) and not caught by
   the automated audit (it measures font-size and tap-target size, not rendered-text-vs-container
   width). Root cause: `<Table verticalSpacing="md" horizontalSpacing="md" miw={720}>`'s `table-layout:
   auto` gives the VERDICT column one shared width across every row, and Mantine's `Badge` sets
   `overflow: hidden; text-overflow: ellipsis` on itself rather than forcing the column wider — so a
   long label truncates instead of the table (which already scrolls horizontally by design, per
   `verify:sharing`'s Session 18 convention) growing to fit it.
2. **Radio and Checkbox still have no 44px floor, and now there's a reason not to reach for a theme
   variable.** Decision 83: Mantine ties `--radio-size`/`--checkbox-size` to both the clickable box and
   the drawn ring's diameter, so a theme-wide bump makes every radio visibly, not just tappably,
   bigger — tried, and it pushed the `/new` chairman radio's own "judging" badge into truncation.
   Session 21's `CouncilPicker` mobile-chairman fix (decision 80) is the pattern that actually works: a
   full-width tappable row with a small decorative indicator, not a bigger `<input>`. Left for the
   wallet's amount picker (already wrapped in a big `UnstyledButton`, lower priority) and the
   desktop-width (≥576px) chairman radio.
3. **The quote still misses two things.** Question length is handled (Session 13's
   `PROMPT_LENGTH_SCALING`), but **attachments** are not — an image is roughly a thousand input
   tokens per drafter and the estimate says nothing about it — and neither is **council size on the
   chairman's prompt**: a five-model verdict reads five drafts and is quoted the same as a
   three-model one. `npm run calibrate:estimate` measures both the moment there are rounds to
   measure. The other open item is Llama 4 Maverick's 2.12× routing gap, which is a price decision
   rather than a token one.
4. **The leaderboard has no index of its own.** At 139 drafted seats the plan is sequential scans
   over small tables at ~80ms, which is honest today. A partial index on
   `model_responses (round_id, stage)` is the first thing to try when it stops being.
5. **§10's remaining extension** is the admin panel; `requireRole` still has no caller. Streaming
   stage 4 was Session 14 and is done.
6. **`npm run verify:http` is broken and has been since Session 9** — found in Session 24 while using
   it as a regression check, not caused by anything there. It asks ONE unfunded account for THREE
   rounds; `FREE_ROUNDS_PER_DAY` is 2, so the third is a `402 DAILY_LIMIT_REACHED`,
   `startAndSettle` returns `{ round: null }` on any non-202, and line 781 dereferences it. The run
   dies **after** ~$0.02 of real debates have been paid for. Fix by handling the non-202 in
   `startAndSettle` plus an explicit `check()` that round 3 was refused — not by crediting the
   account, which would put a second `credit_balance` writer in the verify scripts. Two checks
   (council inheritance after a PATCH, the body-override round) are lost either way and the output
   should say so.
7. **The apex is still Namecheap's parking redirect.** Bare `askthequorum.com` does not reach the
   app. Add `askthequorum.com` and `www` to the **Vercel project as redirects to `app.`** — not
   Namecheap's URL Redirect Record, which cannot serve https for a name it holds no certificate for,
   so anyone typing `https://askthequorum.com` gets a certificate warning instead of the site.

**Streaming's own leftovers, such as they are.** The registry is per-process like every other frame,
so a restart mid-answer orphans the preview exactly as it orphans the rest — the round completes and
`GET /api/rounds/:id` returns it. And stage 4's visible stream lasts **1–5 seconds** on these models
(Claude Haiku wrote 2,755 characters in ~1.2s; GPT-5 Mini spends 92% of its call on hidden reasoning
before the first delta), so the feature buys the length of stage 4's generation, not the length of
the round. Do not describe it as more than that.

**The seeded catalogue is no longer uniformly sighted, and that was on purpose.** Until Session 11
every model supported vision, precisely so attachments could be built against them; now the five
active rows span all three cases — images and documents, images only (Llama 4 Maverick), and neither
(Llama 3.1 8B). Any code that asks "can this model see it" must ask about the modality it actually
has in hand, and there are now real rows that punish guessing.
