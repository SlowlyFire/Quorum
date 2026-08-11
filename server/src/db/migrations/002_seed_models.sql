-- 002_seed_models.sql
--
-- The starting model catalogue: one mid-tier model from each of the four
-- providers the product document names (Anthropic, OpenAI, Google, Meta).
--
-- Slugs, prices and vision flags were taken from a live
-- `GET https://openrouter.ai/api/v1/models` on 2026-08-11 — nothing here is
-- from memory. OpenRouter quotes per-token prices; these are per 1k tokens,
-- i.e. the quoted price × 1000.
--
--   provider   slug                          in/1k     out/1k    vision
--   Anthropic  anthropic/claude-haiku-4.5    0.001     0.005     yes
--   OpenAI     openai/gpt-5-mini             0.00025   0.002     yes
--   Google     google/gemini-2.5-flash       0.0003    0.0025    yes
--   Meta       meta-llama/llama-4-maverick   0.0002    0.000696  yes
--
-- All four take image input, which the attachments feature needs, and all four
-- are the working tier rather than the flagship — §9 of the spec runs
-- development against cheap models and switches flagships on for demos only.
-- A four-model council is 8 calls; at these prices a round costs well under a
-- cent, so the $0.05 free-tier floor covers many of them.

INSERT INTO models (provider, openrouter_slug, display_name, input_per_1k, output_per_1k, supports_vision, is_active)
VALUES
  ('anthropic', 'anthropic/claude-haiku-4.5',  'Claude Haiku 4.5',  0.00100000, 0.00500000, true, true),
  ('openai',    'openai/gpt-5-mini',           'GPT-5 Mini',        0.00025000, 0.00200000, true, true),
  ('google',    'google/gemini-2.5-flash',     'Gemini 2.5 Flash',  0.00030000, 0.00250000, true, true),
  ('meta',      'meta-llama/llama-4-maverick', 'Llama 4 Maverick',  0.00020000, 0.00069600, true, true)
ON CONFLICT (openrouter_slug) DO NOTHING;
