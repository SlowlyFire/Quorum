import { env } from '../config/env.js';
import { selectNow } from '../models/healthModel.js';

export function getHealth() {
  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
  };
}

export async function getDatabaseHealth() {
  if (!env.DATABASE_URL) {
    throw createUnavailable('DATABASE_URL is not configured', 'DATABASE_NOT_CONFIGURED');
  }

  try {
    return {
      status: 'ok',
      now: await selectNow(),
    };
  } catch (cause) {
    throw createUnavailable(`Database is unreachable: ${cause.message}`, 'DATABASE_UNAVAILABLE', cause);
  }
}

function createUnavailable(message, code, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.status = 503;
  error.code = code;
  return error;
}
