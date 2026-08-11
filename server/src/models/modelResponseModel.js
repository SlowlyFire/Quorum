/**
 * model_responses table — one row per OpenRouter call, including the ones that
 * failed.
 *
 * §7: "model_responses stores every single API call, including failures, with
 * its own token counts and cost. Cost is therefore derived from real usage,
 * never estimated, and the wallet ledger is auditable line by line." A failure
 * carries error_text and no content; the round continues without it.
 *
 * anon_label is the shuffled identity the chairman saw — 'A', 'B', 'C'. The real
 * model_id stays on the row but never goes upstream.
 */
import { query } from '../db/pool.js';

const COLUMNS = `
  id,
  round_id,
  model_id,
  stage,
  anon_label,
  content,
  stance,
  prompt_tokens,
  completion_tokens,
  cost,
  latency_ms,
  error_text,
  provider,
  created_at
`;

export async function insertModelResponse(
  {
    roundId,
    modelId,
    stage,
    anonLabel = null,
    content = null,
    stance = null,
    promptTokens = null,
    completionTokens = null,
    cost = null,
    latencyMs = null,
    errorText = null,
    provider = null,
  },
  exec = query,
) {
  const { rows } = await exec(
    `
      INSERT INTO model_responses (
        round_id, model_id, stage, anon_label, content, stance,
        prompt_tokens, completion_tokens, cost, latency_ms, error_text, provider
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING ${COLUMNS}
    `,
    [
      roundId,
      modelId,
      stage,
      anonLabel,
      content,
      stance,
      promptTokens,
      completionTokens,
      cost,
      latencyMs,
      errorText,
      provider,
    ],
  );

  return rows[0];
}

/**
 * Ordered by created_at, which is insertion order — the engine persists in
 * stage order and, within a stage, in label order, so this reads as the round
 * happened.
 */
export async function listResponsesByRound(roundId, exec = query) {
  const { rows } = await exec(
    `SELECT ${COLUMNS} FROM model_responses WHERE round_id = $1 ORDER BY created_at`,
    [roundId],
  );

  return rows;
}

export async function listResponsesByRoundAndStage(roundId, stage, exec = query) {
  const { rows } = await exec(
    `SELECT ${COLUMNS} FROM model_responses WHERE round_id = $1 AND stage = $2 ORDER BY created_at`,
    [roundId, stage],
  );

  return rows;
}
