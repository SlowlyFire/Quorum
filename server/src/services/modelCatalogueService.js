/**
 * §8's `GET /api/models` — "active model catalogue with pricing".
 *
 * Named modelCatalogueService rather than modelService: `src/models/` is a
 * directory of table modules, and a service called modelService would read as
 * one of them.
 *
 * The response carries a second block the endpoint's one-line spec does not
 * mention, and the reason is a convention this repo already holds. The council
 * picker has to quote a price before a round is run, which means multiplying a
 * price by "how many tokens a stage will use" — and every number in that
 * sentence is written down in `config/llm.js`, which CLAUDE.md names as the only
 * place a sampling default lives. Restating those token counts in the client
 * would create a second copy that drifts the first time they are re-measured,
 * and it would drift silently — the quote would still render, just wrongly. So
 * the catalogue ships the arithmetic's inputs alongside the prices, and the
 * client does the multiplication.
 */
import { MAX_TOKENS, PROMPT_LENGTH_SCALING, STAGE_TOKEN_AVERAGES } from '../config/llm.js';
import { listActiveModels } from '../models/llmModel.js';

/**
 * The single place a `models` row becomes wire shape, as `toPublicUser` and
 * `toPublicSession` are for theirs. `numeric(10,8)` arrives from pg as a string
 * and the wire gets a number, so a client can multiply without parsing first.
 */
export function toPublicModel(row) {
  return {
    id: row.id,
    provider: row.provider,
    slug: row.openrouter_slug,
    displayName: row.display_name,
    inputPer1k: Number(row.input_per_1k),
    outputPer1k: Number(row.output_per_1k),
    supportsVision: row.supports_vision,
    /**
     * NOT implied by supportsVision. OpenRouter carries a PDF as a `file`
     * content part rather than an `image_url` one, and the set of models that
     * take a file is smaller — Llama 4 Maverick reads images and refuses
     * documents. The council picker needs both so it can warn about the
     * attachment that is actually on the round.
     */
    supportsDocuments: row.supports_documents,
  };
}

/**
 * `is_active` is not on the wire because every row here has it true: §8 words
 * this endpoint as the *active* catalogue, and a retired model is not something
 * a client should be able to seat and then be refused for by `INACTIVE_MODEL`.
 */
export async function getCatalogue() {
  const rows = await listActiveModels();

  return {
    models: rows.map(toPublicModel),
    /**
     * Everything a caller needs to quote a round, and nothing about how to
     * spend one.
     *
     * `stageTokens` replaces Session 6's `{ completionRatio, promptTokens }`
     * pair, which quoted the completion side as a fraction of `maxTokens` and
     * ran 2.4-2.7x high (decision 31). `maxTokens` is still shipped, unchanged
     * and now unused by the quote, because it is the honest answer to "how
     * large can one call get" — a ceiling a client may want to state as "at
     * most", and a number no client should write down for itself.
     */
    estimate: {
      stageTokens: STAGE_TOKEN_AVERAGES,
      maxTokens: MAX_TOKENS,
      /**
       * The length scaling's constants, travelling with the averages for the
       * same reason they do: the client multiplies so a keystroke re-quotes
       * without a round trip, and the server multiplies so the gate decides from
       * the same figure. Duplicating the arithmetic is fine; duplicating a
       * constant is not, and this one would drift silently because the quote
       * still renders (decisions 28, 31 and 56).
       */
      lengthScaling: PROMPT_LENGTH_SCALING,
      /**
       * Input tokens an attached image adds to a DRAFTER's stage-1 call, and to
       * no other call: attachments reach stage 1 only (decision 47), and a
       * drafter that cannot see the file is not sent it (decision 50). Shipped
       * rather than written down on the client for the same reason as the two
       * blocks above — the arithmetic may be duplicated, the constant may not.
       */
      imageInputTokens: IMAGE_INPUT_TOKENS,
    },
  };
}
