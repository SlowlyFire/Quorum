/**
 * §8's four preset endpoints, and §4.7's "save a council preset and reuse it
 * later (create, rename, duplicate, delete)".
 *
 * A preset is a template and nothing else. It applies to no session and no round
 * until a client loads it into the council picker, which is why nothing here
 * touches `session_models` or `round_models` — see CLAUDE.md's note on the three
 * council tables and their three lifetimes.
 *
 * Duplicate is not an endpoint. §4.7 lists it as a user action, and it is a GET
 * the client already has plus a POST it already has: the sessions page reads the
 * preset it is duplicating out of the list it is rendering and posts it back
 * with a new name. An endpoint would be a third writer of preset_models with
 * nothing of its own to say.
 */
import { withTransaction } from '../db/pool.js';
import { httpError } from '../lib/httpError.js';
import { listActiveModels } from '../models/llmModel.js';
import {
  deletePreset as deletePresetRow,
  deletePresetModels,
  findPresetById,
  insertPreset,
  insertPresetModels,
  listPresetModels,
  listPresetModelsForUser,
  listPresetsByUser,
  updatePreset as updatePresetRow,
} from '../models/presetModel.js';
import { resolveCouncil, toPublicCouncilModel, toSessionModelEntries } from './councilService.js';
import { planCouncil } from './debateService.js';

const UNIQUE_VIOLATION = '23505';

/** The requireOwnership loader for every /api/presets/:id route. */
export async function loadPresetForOwnership(id) {
  return findPresetById(id);
}

// ---------------------------------------------------------------------------
// Wire shape
// ---------------------------------------------------------------------------

/**
 * The single place a presets row becomes wire shape, as `toPublicSession` is
 * for sessions. The council block is byte-identical in shape to a session's, so
 * the client's council picker can be filled from either without a translation
 * step — which is the entire point of a preset.
 */
export function toPublicPreset(row, modelRows = []) {
  const chairmanRow = modelRows.find((model) => model.is_chairman);

  return {
    id: row.id,
    name: row.name,
    chairmanAbstains: row.chairman_abstains,
    rebuttalEnabled: row.rebuttal_enabled,
    createdAt: row.created_at,
    council: {
      chairmanId: chairmanRow?.model_id ?? null,
      models: modelRows.map((model) =>
        toPublicCouncilModel(
          {
            id: model.model_id,
            slug: model.openrouter_slug,
            displayName: model.display_name,
            provider: model.provider,
          },
          chairmanRow?.model_id ?? null,
        ),
      ),
    },
    /**
     * A preset outlives the catalogue. A model retired since it was saved leaves
     * the preset readable but unloadable, and the card has to be able to say so
     * rather than filling the picker with a council every round would refuse.
     */
    hasRetiredModel: modelRows.some((model) => model.is_active === false),
  };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function listPresets(userId) {
  const [rows, modelRows] = await Promise.all([
    listPresetsByUser(userId),
    listPresetModelsForUser(userId),
  ]);

  const byPreset = new Map();

  for (const model of modelRows) {
    if (!byPreset.has(model.preset_id)) byPreset.set(model.preset_id, []);
    byPreset.get(model.preset_id).push(model);
  }

  return { presets: rows.map((row) => toPublicPreset(row, byPreset.get(row.id) ?? [])) };
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * `name` is unique per user, case-insensitively, and the check is migration
 * 006's index rather than a SELECT first — a check-then-insert loses the race
 * between two simultaneous creates and the constraint cannot.
 *
 * Deliberately no `cause` on the 409: the driver's error carries
 * `Key (user_id, lower(name))=(…) already exists`, and in development
 * errorHandler prints the whole error object. Same reasoning as register's 409.
 */
function conflict(name) {
  return httpError(409, 'CONFLICT', `You already have a preset called "${name}"`);
}

export async function createPreset({ userId, name, council, chairmanAbstains, rebuttalEnabled }) {
  const resolved = await resolveCouncil(council);

  /**
   * The engine's own rules, at save time. A preset that can never hold a debate
   * is worse than a rejected one: it saves happily, fills the picker on /new,
   * and disables the Start button with a reason the user did not cause.
   */
  planCouncil({ ...resolved, chairmanAbstains, rebuttalEnabled });

  try {
    const { row, modelRows } = await withTransaction(async (exec) => {
      const created = await insertPreset(
        { userId, name, chairmanAbstains, rebuttalEnabled },
        exec,
      );

      await insertPresetModels(created.id, toSessionModelEntries(resolved), exec);

      return { row: created, modelRows: await listPresetModels(created.id, exec) };
    });

    return toPublicPreset(row, modelRows);
  } catch (cause) {
    if (cause.code !== UNIQUE_VIOLATION) throw cause;
    throw conflict(name);
  }
}

/**
 * Rename, re-crew, or change either debate setting. `current` is the row
 * requireOwnership already loaded.
 *
 * Replacing the line-up is delete-then-insert rather than a diff, exactly as
 * updateSession does it: a council is at most eight rows, and the chairman flag
 * moving between two models is two updates and an ordering problem a rewrite
 * does not have.
 */
export async function updatePreset({ current, name, council, chairmanAbstains, rebuttalEnabled }) {
  const resolved = council ? await resolveCouncil(council) : null;

  if (resolved) {
    // Against the settings the preset will have AFTER the patch, not the ones it
    // has now — sending a two-model council and chairmanAbstains false together
    // is legal, and checking the stored flags would reject it.
    planCouncil({
      ...resolved,
      chairmanAbstains: chairmanAbstains ?? current.chairman_abstains,
      rebuttalEnabled: rebuttalEnabled ?? current.rebuttal_enabled,
    });
  }

  try {
    const { row, modelRows } = await withTransaction(async (exec) => {
      const updated = await updatePresetRow(
        current.id,
        {
          name: name ?? null,
          chairmanAbstains: chairmanAbstains ?? null,
          rebuttalEnabled: rebuttalEnabled ?? null,
        },
        exec,
      );

      if (resolved) {
        await deletePresetModels(current.id, exec);
        await insertPresetModels(current.id, toSessionModelEntries(resolved), exec);
      }

      return { row: updated, modelRows: await listPresetModels(current.id, exec) };
    });

    return toPublicPreset(row, modelRows);
  } catch (cause) {
    if (cause.code !== UNIQUE_VIOLATION) throw cause;
    throw conflict(name);
  }
}

export async function deletePreset(presetId) {
  const deleted = await deletePresetRow(presetId);

  if (!deleted) {
    // requireOwnership loaded the row moments ago, so losing the race with
    // another delete is the only way here.
    throw httpError(404, 'NOT_FOUND', 'Preset not found');
  }
}

// ---------------------------------------------------------------------------
// The two presets every new account starts with
// ---------------------------------------------------------------------------

/**
 * A NEW USER'S PRESET LIST IS EMPTY, AND AN EMPTY PRESET LIST MAKES /new LOOK
 * BROKEN. §4.7 has presets as something the user creates, so this is an
 * addition to the spec rather than an implementation of it (decision 38): two
 * presets built at registration from whatever is in the catalogue that day.
 *
 * BUILT BY QUERYING `models`, NEVER FROM HARD-CODED IDS. The catalogue is a
 * table and its ids are per-database uuids: a hard-coded id is wrong on every
 * machine but the one it was copied from, and wrong silently — the insert
 * succeeds against `models` only because of the FK, so it fails loudly, but the
 * first person to add or retire a model has to remember this file exists.
 *
 * "Cheap draft" sets chairmanAbstains FALSE, and that is not a preference. Two
 * models with the chairman abstaining leaves one drafter, which planCouncil
 * refuses — a two-model council only debates when the chairman drafts too. The
 * seed would otherwise create a preset that cannot be used.
 */
export async function seedPresetsForUser(userId) {
  const models = await listActiveModels();

  if (models.length < 2) return [];

  // Cheapest by output price: the completion side dominates a round's cost, and
  // a chairman speaks twice per round (stages 2 and 4) at the longest prompts.
  const byPrice = [...models].sort((a, b) => Number(a.output_per_1k) - Number(b.output_per_1k));
  const cheapest = byPrice[0];

  const wanted = [
    {
      name: 'Full council',
      description: 'every active model, the cheapest of them chairing and abstaining',
      models,
      chairmanId: cheapest.id,
      chairmanAbstains: true,
      // The full council needs three models for the chairman to abstain. With
      // two in the catalogue there is no "full council" worth the name.
      enabled: models.length >= 3,
    },
    {
      name: 'Cheap draft',
      description: 'the two cheapest, one chairing and drafting',
      models: byPrice.slice(0, 2),
      chairmanId: cheapest.id,
      chairmanAbstains: false,
      enabled: true,
    },
  ];

  const created = [];

  for (const preset of wanted) {
    if (!preset.enabled) continue;

    try {
      created.push(
        await createPreset({
          userId,
          name: preset.name,
          council: {
            modelIds: preset.models.map((model) => model.id),
            chairmanId: preset.chairmanId,
          },
          chairmanAbstains: preset.chairmanAbstains,
          rebuttalEnabled: true,
        }),
      );
    } catch (error) {
      /**
       * NEVER FAILS A REGISTRATION. The account is created and the response is
       * already owed to the caller; a starter preset is a convenience, and
       * trading a working sign-up for one is the wrong way round. The log is
       * loud because a failure here means the catalogue is in a state this
       * function did not expect.
       */
      console.error(
        `[presets] could not seed "${preset.name}" for a new user: ${error.code ?? 'ERROR'} ${error.message}`,
      );
    }
  }

  return created;
}
