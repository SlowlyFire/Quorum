import { getCatalogue } from '../services/modelCatalogueService.js';

export async function listModels(req, res, next) {
  try {
    res.json(await getCatalogue());
  } catch (error) {
    next(error);
  }
}
