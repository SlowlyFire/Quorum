# Prompt templates

Four stages, four files. Loaded once at server boot, cached, interpolated per call.

| File | Sent to | When |
|---|---|---|
| `01-draft.md` | Every drafting model, in parallel | Stage 1 |
| `02-verdict.md` | Chairman | Stage 2 |
| `03-rebuttal.md` | Every drafter, in parallel | Stage 3 |
| `04-final.md` | Chairman | Stage 4 |

## Interpolation

```js
const render = (tpl, vars) =>
  tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");
```

Each file has a `## System` and a `## User` section; split on those headings to build the
two `messages` entries.

## Rules that must hold in code, not just in the prompt

1. **Shuffle draft order per round** before labelling A/B/C, and use a fresh mapping each
   round. Position bias in judges is real — do not let A always be the same model.
2. **Store the label→model mapping server-side.** The chairman must never receive it.
3. **Parse defensively.** Strip ``` fences, then `JSON.parse` inside a try/catch. On
   failure, retry the call once; if it fails again, record the error in
   `model_responses.error_text` and continue the round without that model.
4. **Version the prompts.** Store a `prompt_version` on each round. When output quality
   moves, you will want to know which template produced which result.

## Editing

Expect to rewrite these several times. Change one thing at a time and re-run the same
test question, or you will not know what caused the change.
