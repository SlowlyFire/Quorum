/**
 * §8 Auth. GET /api/auth/google and its callback are deferred, not dropped —
 * see docs/decisions.md, decision 10. users.google_id and the model's
 * findUserByGoogleId / attachGoogleId are already in place for them.
 */
import { Router } from 'express';

import { login, logout, me, register } from '../controllers/authController.js';
import { createAuthRateLimiter } from '../middleware/rateLimit.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { validate } from '../middleware/validate.js';
import { loginSchema, registerSchema } from '../validation/authSchemas.js';

const router = Router();

// The limiter runs before validation, so a flood of malformed bodies is
// throttled too rather than being waved through as "not a real attempt".
router.post('/register', createAuthRateLimiter(), validate({ body: registerSchema }), register);
router.post('/login', createAuthRateLimiter(), validate({ body: loginSchema }), login);
router.post('/logout', logout);
router.get('/me', requireAuth, me);

export { router as authRoutes };
