import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';

import { env } from './config/env.js';
import { errorHandler } from './middleware/errorHandler.js';
import { notFound } from './middleware/notFound.js';
import { apiRoutes } from './routes/index.js';

export const app = express();

// credentials:true is required for the JWT httpOnly cookie to travel cross-origin.
app.use(cors({ origin: env.CLIENT_URL, credentials: true }));
app.use(cookieParser());
app.use(express.json());

app.use('/api', apiRoutes);

app.use(notFound);
app.use(errorHandler);
