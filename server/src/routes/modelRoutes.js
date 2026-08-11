/**
 * §8 Models — the catalogue the council picker is built from.
 *
 * Behind requireAuth, though the rows are not anyone's private data: assembling
 * a council is a signed-in action, this is the only screen that reads it, and
 * an endpoint that lists what we pay per token is not something to leave open
 * for scraping. There is no :id route, so no ownership check and no param
 * schema — the catalogue is the same for every user.
 */
import { Router } from 'express';

import { listModels } from '../controllers/modelController.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = Router();

router.get('/', requireAuth, listModels);

export { router as modelRoutes };
