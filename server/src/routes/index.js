import { Router } from 'express';

import { authRoutes } from './authRoutes.js';
import { healthRoutes } from './healthRoutes.js';
import { roundRoutes } from './roundRoutes.js';
import { sessionRoutes } from './sessionRoutes.js';

const router = Router();

router.use('/auth', authRoutes);
router.use('/health', healthRoutes);
router.use('/rounds', roundRoutes);
router.use('/sessions', sessionRoutes);

export { router as apiRoutes };
