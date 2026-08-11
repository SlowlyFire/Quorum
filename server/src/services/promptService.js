/**
 * The four debate prompt templates, read from `prompts/` once at boot.
 *
 * The load runs at import, not on first use, and throws rather than degrading.
 * A template that is missing or has lost one of its two sections is a
 * deployment fault, and a deployment fault should stop the process at start-up
 * where someone is watching — not surface at 2am as a debate that half-runs.
 *
 * Nothing here writes to `prompts/`. The files are edited by hand and read by
 * this module, in that direction only.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));

/** server/src/services -> repo root. The templates live outside server/. */
const PROMPTS_DIR = path.resolve(currentDir, '../../../prompts');

/**
 * Stage names match `model_responses.stage`, so the value written to a row and
 * the key used to fetch its prompt are the same string.
 */
const TEMPLATE_FILES = Object.freeze({
  draft: '01-draft.md',
  verdict: '02-verdict.md',
  rebuttal: '03-rebuttal.md',
  final: '04-final.md',
});

export const PROMPT_STAGES = Object.freeze(Object.keys(TEMPLATE_FILES));

/**
 * Stamped on every round as `rounds.prompt_version`, per `prompts/README.md`
 * rule 4. **Bump this by hand whenever a template changes in a way that could
 * move output quality** — that is the entire value of the column: without it, a
 * change in answer quality between two rounds is indistinguishable from a change
 * in the question.
 */
export const PROMPT_VERSION = 'v1';

/**
 * Anchored to the start of a line so the `## System` heading is found but a
 * literal "## System" inside a section body could not be mistaken for one.
 */
const SYSTEM_HEADING = /^##[ \t]+System[ \t]*$/m;
const USER_HEADING = /^##[ \t]+User[ \t]*$/m;

/** `{{QUESTION}}`, `{{DRAFTS}}`, and the rest. */
const PLACEHOLDER = /\{\{(\w+)\}\}/g;

/**
 * Everything above `## System` — the `# Stage N` title, the note about which
 * variables to interpolate, and the `---` rule under it — is documentation for
 * whoever edits the file. Slicing forward from the heading drops all of it
 * without needing a rule per line.
 */
function parseTemplate(raw, filename) {
  const system = SYSTEM_HEADING.exec(raw);
  const user = USER_HEADING.exec(raw);

  if (!system) throw invalidTemplate(filename, 'has no "## System" heading');
  if (!user) throw invalidTemplate(filename, 'has no "## User" heading');
  if (user.index < system.index) {
    throw invalidTemplate(filename, 'has "## User" before "## System"');
  }

  const systemText = raw.slice(system.index + system[0].length, user.index).trim();
  const userText = raw.slice(user.index + user[0].length).trim();

  if (!systemText) throw invalidTemplate(filename, 'has an empty "## System" section');
  if (!userText) throw invalidTemplate(filename, 'has an empty "## User" section');

  return Object.freeze({ system: systemText, user: userText });
}

function invalidTemplate(filename, problem) {
  return new Error(`Prompt template ${filename} ${problem}. Looked in ${PROMPTS_DIR}.`);
}

function loadAll() {
  const loaded = {};

  for (const [stage, filename] of Object.entries(TEMPLATE_FILES)) {
    const file = path.join(PROMPTS_DIR, filename);
    let raw;

    try {
      raw = readFileSync(file, 'utf8');
    } catch (cause) {
      throw new Error(`Prompt template ${filename} could not be read: ${cause.message}`, { cause });
    }

    loaded[stage] = parseTemplate(raw, filename);
  }

  return Object.freeze(loaded);
}

/** Runs at import. A broken template takes the process down here. */
const templates = loadAll();

/**
 * The cached `{ system, user }` pair for a stage, frozen — a caller that wants
 * to change one interpolates a copy through render() instead of editing the
 * template every later round would then inherit.
 */
export function getPrompt(stage) {
  const template = templates[stage];

  if (!template) {
    throw new Error(`Unknown prompt stage "${stage}". Known stages: ${PROMPT_STAGES.join(', ')}.`);
  }

  return template;
}

/**
 * `{{VAR}}` -> `vars.VAR`, and an absent or null variable renders as an empty
 * string rather than the literal `{{VAR}}`. That is what lets `01-draft.md`
 * carry an `{{ATTACHMENTS}}` block that simply disappears when a round has no
 * attachments, without a second template for the no-attachment case.
 */
export function render(template, vars = {}) {
  return template.replace(PLACEHOLDER, (_, key) => {
    const value = vars[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

/** Both halves of a stage, rendered — what the orchestrator actually wants. */
export function renderStage(stage, vars = {}) {
  const { system, user } = getPrompt(stage);

  return {
    system: render(system, vars),
    user: render(user, vars),
  };
}
