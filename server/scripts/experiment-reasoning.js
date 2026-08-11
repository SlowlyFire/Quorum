#!/usr/bin/env node
/**
 * EXPERIMENT — does `reasoning: { effort: 'low' }` on the DRAFTING stage buy
 * latency without costing draft quality?
 *
 * Drafting only, and explicitly not the chairman. A weak draft is recoverable:
 * the chairman weighs it against the others and the rebuttal round can correct
 * it. The verdict is the product and has no stage after it, so a chairman that
 * thinks less is a worse answer with nothing to catch it.
 *
 * Why stage 1 in isolation rather than three whole rounds: a full round's
 * duration is dominated by two chairman calls this experiment does not change,
 * so measuring end-to-end would bury the effect under noise from stages 2 and 4
 * and cost four times as much. Every drafting call each stage would have made is
 * made here, under both conditions, on the same three questions.
 *
 * Reads the models table, writes nothing anywhere. About $0.01 a run.
 *
 *   npm run experiment:reasoning
 */
import { closePool } from '../src/db/pool.js';
import { MAX_TOKENS, TEMPERATURE } from '../src/config/llm.js';
import { listActiveModels } from '../src/models/llmModel.js';
import { callModel } from '../src/services/openrouterService.js';
import { renderStage } from '../src/services/promptService.js';

/** The drafting pool of a typical four-model council: Claude chairs, these draft. */
const DRAFTER_SLUGS = [
  'openai/gpt-5-mini',
  'google/gemini-2.5-flash',
  'meta-llama/llama-4-maverick',
];

const QUESTIONS = [
  'Should a small team building an internal tool write end-to-end tests, or is that effort better spent elsewhere?',
  'A service is slow under load. What is the first thing you measure, and why that first?',
  'Is it ever right to keep a feature flag permanently rather than removing it after the rollout?',
];

const CONDITIONS = [
  { key: 'baseline', label: 'default (no reasoning parameter)', reasoning: null },
  { key: 'low', label: "reasoning: { effort: 'low' }", reasoning: { effort: 'low' } },
];

function heading(text) {
  console.log(`\n${'='.repeat(78)}\n${text}\n${'='.repeat(78)}`);
}

function words(text) {
  return String(text ?? '').trim().split(/\s+/).filter(Boolean).length;
}

function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/**
 * OpenRouter reports reasoning tokens separately where the upstream does, which
 * is the only direct evidence of whether the parameter did anything at all —
 * an unchanged reasoning-token count means the model or its provider ignored it.
 */
function reasoningTokens(result) {
  return result.raw?.usage?.completion_tokens_details?.reasoning_tokens ?? null;
}

async function drafts() {
  const models = await listActiveModels();

  const drafters = DRAFTER_SLUGS.map((slug) => {
    const row = models.find((model) => model.openrouter_slug === slug);
    if (!row) throw new Error(`Seeded model ${slug} is missing — run npm run migrate.`);
    return row;
  });

  const results = [];

  for (const [questionIndex, question] of QUESTIONS.entries()) {
    const rendered = renderStage('draft', { QUESTION: question, ATTACHMENTS: '' });

    heading(`Question ${questionIndex + 1}: ${question}`);

    for (const drafter of drafters) {
      // Conditions alternate per model rather than running all of one then all
      // of the other, so a provider having a slow ten minutes cannot land
      // entirely on one arm of the comparison.
      for (const condition of CONDITIONS) {
        const record = {
          question: questionIndex + 1,
          model: drafter.display_name,
          slug: drafter.openrouter_slug,
          condition: condition.key,
        };

        try {
          const result = await callModel({
            modelSlug: drafter.openrouter_slug,
            system: rendered.system,
            user: rendered.user,
            temperature: TEMPERATURE.drafting,
            maxTokens: MAX_TOKENS.draft,
            reasoning: condition.reasoning,
          });

          Object.assign(record, {
            ok: true,
            latencyMs: result.latencyMs,
            completionTokens: result.completionTokens,
            reasoningTokens: reasoningTokens(result),
            characters: result.content.length,
            words: words(result.content),
            provider: result.raw?.provider ?? null,
            finishReason: result.finishReason,
            cost: result.cost,
            content: result.content,
          });
        } catch (error) {
          Object.assign(record, { ok: false, error: `${error.code}: ${error.message}` });
        }

        results.push(record);

        console.log(
          record.ok
            ? `  ${record.model.padEnd(20)} ${condition.key.padEnd(9)} ` +
                `${String(record.latencyMs).padStart(6)}ms  ` +
                `${String(record.completionTokens).padStart(4)} completion` +
                `${record.reasoningTokens === null ? '' : ` (${record.reasoningTokens} reasoning)`}` +
                `  ${String(record.words).padStart(4)} words  via ${record.provider}`
            : `  ${record.model.padEnd(20)} ${condition.key.padEnd(9)} FAILED — ${record.error}`,
        );
      }
    }
  }

  return results;
}

function report(results) {
  heading('Per model: latency and draft size, averaged over the three questions');

  const slugs = [...new Set(results.map((result) => result.slug))];

  console.log('\n  model                 condition   calls   mean latency   mean words   mean reasoning tok');
  console.log(`  ${'-'.repeat(92)}`);

  const summary = [];

  for (const slug of slugs) {
    for (const condition of CONDITIONS) {
      const rows = results.filter(
        (result) => result.slug === slug && result.condition === condition.key && result.ok,
      );

      const entry = {
        slug,
        model: results.find((result) => result.slug === slug).model,
        condition: condition.key,
        calls: rows.length,
        latency: mean(rows.map((row) => row.latencyMs)),
        words: mean(rows.map((row) => row.words)),
        reasoning: mean(rows.filter((row) => row.reasoningTokens !== null).map((row) => row.reasoningTokens)),
        hasReasoningData: rows.some((row) => row.reasoningTokens !== null),
      };

      summary.push(entry);

      console.log(
        `  ${entry.model.padEnd(20)}  ${entry.condition.padEnd(10)}  ${String(entry.calls).padStart(4)}   ` +
          `${entry.latency.toFixed(0).padStart(9)}ms   ${entry.words.toFixed(0).padStart(10)}   ` +
          `${entry.hasReasoningData ? entry.reasoning.toFixed(0).padStart(18) : '(not reported)'.padStart(18)}`,
      );
    }
  }

  heading('The two numbers asked for');

  console.log('\n  Seconds saved, per model, mean over 3 questions:\n');

  for (const slug of slugs) {
    const base = summary.find((entry) => entry.slug === slug && entry.condition === 'baseline');
    const low = summary.find((entry) => entry.slug === slug && entry.condition === 'low');

    if (!base?.calls || !low?.calls) {
      console.log(`    ${base?.model ?? slug}: not comparable — a call failed under one condition`);
      continue;
    }

    const savedMs = base.latency - low.latency;
    const percent = (savedMs / base.latency) * 100;

    console.log(
      `    ${base.model.padEnd(20)} ${(savedMs / 1000).toFixed(1).padStart(6)}s ` +
        `(${percent >= 0 ? '-' : '+'}${Math.abs(percent).toFixed(0)}% latency)`,
    );
  }

  console.log('\n  Did the drafts get thinner? Mean words per draft:\n');

  for (const slug of slugs) {
    const base = summary.find((entry) => entry.slug === slug && entry.condition === 'baseline');
    const low = summary.find((entry) => entry.slug === slug && entry.condition === 'low');

    if (!base?.calls || !low?.calls) continue;

    const change = ((low.words - base.words) / base.words) * 100;

    console.log(
      `    ${base.model.padEnd(20)} ${base.words.toFixed(0).padStart(4)} -> ${low.words.toFixed(0).padStart(4)} words ` +
        `(${change >= 0 ? '+' : ''}${change.toFixed(0)}%)`,
    );
  }

  /**
   * A word count is a proxy and a weak one. A drafting stage is only worth
   * anything if the chairman has something to weigh, so one pair of full drafts
   * is printed for reading rather than counting.
   */
  heading('Question 1, one model, both conditions — read these rather than count them');

  const sample = results.filter((result) => result.question === 1 && result.slug === DRAFTER_SLUGS[0] && result.ok);

  for (const record of sample) {
    console.log(`\n  --- ${record.model}, ${record.condition} (${record.words} words, ${record.latencyMs}ms) ---\n`);
    console.log(record.content.replace(/^/gm, '    '));
  }

  const totalCost = results.filter((result) => result.ok).reduce((sum, result) => sum + (result.cost ?? 0), 0);
  const failed = results.filter((result) => !result.ok);

  heading('Spend');
  console.log(`\n  ${results.length} calls, ${failed.length} failed, $${totalCost.toFixed(8)}\n`);

  for (const failure of failed) {
    console.log(`    ${failure.model} / ${failure.condition}: ${failure.error}`);
  }
}

try {
  report(await drafts());
} catch (error) {
  console.error(`\nexperiment died: ${error.stack}`);
} finally {
  await closePool();
}
