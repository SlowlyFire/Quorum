import { Router } from 'express';

import { databaseHealth, health } from '../controllers/healthController.js';

const router = Router();

router.get('/', health);
router.get('/db', databaseHealth);

export { router as healthRoutes };
