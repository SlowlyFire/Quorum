-- 003_debate_engine_columns.sql
--
-- Three columns the four-stage engine needs. No table is created and no
-- constraint changes, so RLS — already enabled with zero policies on both
-- tables — is unaffected: a new column on an RLS-enabled table inherits the
-- table's protection.

-- prompts/README.md rule 4: "Version the prompts. Store a prompt_version on
-- each round. When output quality moves, you will want to know which template
-- produced which result." The templates in prompts/ are expected to be
-- rewritten several times; without this column a change in answer quality is
-- indistinguishable from a change in the question.
--
-- NOT NULL DEFAULT 'v1' rather than nullable: every round ran against *some*
-- version of the templates, and the rounds that predate this column ran against
-- the first one.
ALTER TABLE rounds
  ADD COLUMN prompt_version text NOT NULL DEFAULT 'v1';

-- 04-final.md returns open_questions alongside final_answer: "Any surviving
-- disagreement worth flagging, or null." §2's argument is that a stated open
-- question is more useful than false consensus, so it needs somewhere to live
-- other than inside the chairman's raw JSON.
ALTER TABLE rounds
  ADD COLUMN open_questions text;

-- Which upstream OpenRouter actually routed the call to. Session 4 found the
-- same slug billed at three different prices depending on the route — Parasail,
-- Google and DeepInfra all served meta-llama/llama-4-maverick at different
-- rates (docs/decisions.md 16). Without this column two identical-looking calls
-- in the ledger differ in cost for no recorded reason.
--
-- Nullable: a call that failed before reaching a provider has none.
ALTER TABLE model_responses
  ADD COLUMN provider text;
