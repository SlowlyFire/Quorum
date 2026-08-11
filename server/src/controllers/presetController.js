/**
 * §8's Models & presets block, the preset half.
 *
 * Thin, like every controller here: read the request, call one service, send
 * the response. `req.resource` on the two :id routes is the row requireOwnership
 * already loaded, so nothing below fetches it a second time.
 */
import * as presetService from '../services/presetService.js';

export async function listPresets(req, res, next) {
  try {
    res.json(await presetService.listPresets(req.user.id));
  } catch (error) {
    next(error);
  }
}

export async function createPreset(req, res, next) {
  try {
    const preset = await presetService.createPreset({
      userId: req.user.id,
      name: req.body.name,
      council: req.body.council,
      chairmanAbstains: req.body.chairmanAbstains ?? true,
      rebuttalEnabled: req.body.rebuttalEnabled ?? true,
    });

    res.status(201).json({ preset });
  } catch (error) {
    next(error);
  }
}

export async function updatePreset(req, res, next) {
  try {
    const preset = await presetService.updatePreset({
      current: req.resource,
      name: req.body.name,
      council: req.body.council,
      chairmanAbstains: req.body.chairmanAbstains,
      rebuttalEnabled: req.body.rebuttalEnabled,
    });

    res.json({ preset });
  } catch (error) {
    next(error);
  }
}

export async function deletePreset(req, res, next) {
  try {
    await presetService.deletePreset(req.resource.id);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
}
