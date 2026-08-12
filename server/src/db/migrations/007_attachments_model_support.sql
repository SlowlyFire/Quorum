-- 007_attachments_model_support.sql
--
-- What a model can be shown, and one model that can be shown nothing.
--
-- §7's `models` table has `supports_vision` and nothing else about modality,
-- which was enough while every attachment was going to be an image. §8's
-- attachment endpoints accept application/pdf as well, and a PDF is not an
-- image: OpenRouter carries it as a `file` content part rather than an
-- `image_url` one, and the set of models that accept a file is SMALLER than the
-- set that accepts an image. Measured against the live OpenRouter catalogue on
-- 2026-08-12, `architecture.input_modalities` for the four seeded models:
--
--   anthropic/claude-haiku-4.5    text, image, file
--   openai/gpt-5-mini             text, image, file
--   google/gemini-2.5-flash       text, image, file, audio, video
--   meta-llama/llama-4-maverick   text, image                     <- no file
--
-- So Llama 4 Maverick reads an image and cannot read a PDF, and without a
-- second column the engine would either send it a document it will reject or
-- withhold an image it can see. One boolean per modality, exactly as
-- supports_vision already is, and adding a model stays a row rather than a
-- code change.

ALTER TABLE models
  ADD COLUMN supports_documents boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN models.supports_documents IS
  'Accepts a PDF as an OpenRouter `file` content part — architecture.input_modalities contains "file". A superset check on supports_vision is wrong: Llama 4 Maverick takes images and not files.';

UPDATE models SET supports_documents = true
WHERE openrouter_slug IN (
  'anthropic/claude-haiku-4.5',
  'openai/gpt-5-mini',
  'google/gemini-2.5-flash'
);

-- A model that can be shown nothing at all.
--
-- Every model seeded so far supports vision — deliberately, so attachments
-- could be built against them (CLAUDE.md has said so since Session 2). That
-- leaves the product with no way to exercise the case §Attachments actually
-- specifies: a council containing a text-only model must NOT be refused when an
-- image is attached; the round runs, and the model that cannot see it is told
-- so in its prompt and marked in the UI.
--
-- Llama 3.1 8B Instruct is text-only on OpenRouter (input_modalities: text),
-- cheap, and widely available, so it makes that path a real council member
-- rather than a fixture. Prices are the live catalogue's, per 1k tokens.
INSERT INTO models (provider, openrouter_slug, display_name, input_per_1k, output_per_1k, supports_vision, supports_documents, is_active)
VALUES ('meta', 'meta-llama/llama-3.1-8b-instruct', 'Llama 3.1 8B', 0.00005000, 0.00008000, false, false, true)
ON CONFLICT (openrouter_slug) DO NOTHING;
