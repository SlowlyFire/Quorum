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
 * place a sampling default lives. Restating `MAX_TOKENS` and
 * COMPLETION_ESTIMATE_RATIO in the client would create a second copy that drifts
 * the first time a ceiling is raised, and it would drift silently — the quote
 * would still render, just wrongly. So the catalogue ships the arithmetic's
 * inputs alongside the prices, and the client does the multiplication.
 */
import { COMPLETION_ESTIMATE_RATIO, MAX_TOKENS, PROMPT_ESTIMATE_TOKENS } from '../config/llm.js';
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
     * spend one. `completionRatio` is deliberately separate from `maxTokens`
     * rather than pre-multiplied, so a client that wants the ceiling — to say
     * "at most" — still has it.
     */
    estimate: {
      completionRatio: COMPLETION_ESTIMATE_RATIO,
      maxTokens: MAX_TOKENS,
      promptTokens: PROMPT_ESTIMATE_TOKENS,
    },
  };
}
