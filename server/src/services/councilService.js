/**
 * Turning a list of model ids into a council the engine will accept.
 *
 * Shared by sessions and rounds because they ask the same two questions of a
 * council — do these models exist, and are they still active — and the answers
 * must not differ depending on which route asked. What this file does NOT do is
 * decide whether a council can hold a debate; that is planCouncil in
 * debateService, which owns the chairman and drafter-count rules.
 */
import { httpError } from '../lib/httpError.js';
import { findModelsByIds } from '../models/llmModel.js';

/**
 * The engine's council member shape: { id, slug, displayName }. `provider` rides
 * along for the wire, and planCouncil ignores anything it does not need.
 *
 * The two prices ride along for costEstimateService, which quotes the round
 * before it is allowed to start. They are on the member rather than fetched
 * again because the row they come from has already been read to answer "does
 * this model exist and is it active" — a second query for a number that is
 * already in hand is a second chance for the two to disagree. `numeric(10,8)`
 * arrives from pg as a string, so both are cast here rather than at each use.
 *
 * The two modality flags ride along for the same reason, and Session 11 is what
 * needs them: the engine decides per drafter whether an attachment can be put
 * in front of it, and asking the catalogue again at that point would be a query
 * inside a fan-out. They default to false rather than undefined, because the
 * consequence of not knowing is "do not send it", and a missing column must not
 * become a truthy `undefined` somewhere downstream.
 */
function toCouncilMember(row) {
  return {
    id: row.id,
    slug: row.openrouter_slug,
    displayName: row.display_name,
    provider: row.provider,
    inputPer1k: Number(row.input_per_1k),
    outputPer1k: Number(row.output_per_1k),
    supportsVision: row.supports_vision === true,
    supportsDocuments: row.supports_documents === true,
  };
}

/** What a client is shown. Prices belong to GET /api/models, not to a council. */
export function toPublicCouncilModel(member, chairmanId) {
  return {
    id: member.id,
    slug: member.slug,
    displayName: member.displayName,
    provider: member.provider,
    isChairman: member.id === chairmanId,
  };
}

/**
 * Validates ids that a client supplied against the catalogue.
 *
 * Both refusals name the offending ids, because the only useful thing a client
 * can do with "your council is invalid" is ask which part — and the two are
 * genuinely different problems: an id that never existed is a client bug, while
 * an id that has been retired since it was saved is a stale preset or a session
 * created before a model was withdrawn.
 *
 * Order is preserved from the request. Nothing downstream depends on it — the
 * engine shuffles its drafters — but a response that reorders what it was given
 * for no reason is a small lie.
 */
export async function resolveCouncil({ modelIds, chairmanId }) {
  const rows = await findModelsByIds(modelIds);
  const byId = new Map(rows.map((row) => [row.id, row]));

  const unknown = modelIds.filter((id) => !byId.has(id));

  if (unknown.length > 0) {
    throw httpError(
      400,
      'UNKNOWN_MODEL',
      `No model exists with ${unknown.length === 1 ? 'id' : 'ids'} ${unknown.join(', ')}`,
    );
  }

  const inactive = modelIds.filter((id) => !byId.get(id).is_active);

  if (inactive.length > 0) {
    throw httpError(
      400,
      'INACTIVE_MODEL',
      `${inactive
        .map((id) => `${byId.get(id).display_name} (${id})`)
        .join(', ')} ${inactive.length === 1 ? 'is' : 'are'} no longer available`,
    );
  }

  return { models: modelIds.map((id) => toCouncilMember(byId.get(id))), chairmanId };
}

/**
 * The session's stored council, as the engine wants it.
 *
 * No second query: listSessionModels already joined `models`, so the rows carry
 * the slug and is_active this needs. The checks are the same ones resolveCouncil
 * makes of a client-supplied council, because a model can be retired between the
 * session being created and the next round being run — the council was valid
 * when it was saved and is not valid now, and that has to surface as a 400
 * naming the model rather than as an OpenRouter 404 halfway through stage 1.
 */
export function councilFromSessionModels(rows) {
  if (rows.length === 0) {
    throw httpError(
      400,
      'SESSION_HAS_NO_COUNCIL',
      'This session has no council. Send one with the round, or set one with PATCH /api/sessions/:id.',
    );
  }

  const retired = rows.filter((row) => !row.is_active);

  if (retired.length > 0) {
    throw httpError(
      400,
      'INACTIVE_MODEL',
      `This session's council includes ${retired
        .map((row) => `${row.display_name} (${row.model_id})`)
        .join(', ')}, which ${retired.length === 1 ? 'is' : 'are'} no longer available. ` +
        'Update the council with PATCH /api/sessions/:id.',
    );
  }

  const chairman = rows.find((row) => row.is_chairman);

  if (!chairman) {
    // Unreachable through the API — every write of session_models goes through
    // a validated council — so it means a row was edited by hand in SQL.
    throw httpError(
      409,
      'SESSION_COUNCIL_INVALID',
      "This session's council has no chairman. Set one with PATCH /api/sessions/:id.",
    );
  }

  return {
    models: rows.map((row) =>
      toCouncilMember({
        id: row.model_id,
        openrouter_slug: row.openrouter_slug,
        display_name: row.display_name,
        provider: row.provider,
        input_per_1k: row.input_per_1k,
        output_per_1k: row.output_per_1k,
        supports_vision: row.supports_vision,
        supports_documents: row.supports_documents,
      }),
    ),
    chairmanId: chairman.model_id,
  };
}

/** session_models rows, from a council the engine has accepted. */
export function toSessionModelEntries({ models, chairmanId }) {
  return models.map((model) => ({ modelId: model.id, isChairman: model.id === chairmanId }));
}
