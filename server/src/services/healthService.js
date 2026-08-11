import { selectNow } from '../models/healthModel.js';

export function getHealth() {
  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
  };
}

/**
 * DATABASE_URL is required at boot from Session 3 on, so the old
 * DATABASE_NOT_CONFIGURED branch (decision 3) is unreachable and gone: a
 * missing connection string now fails the process, not one endpoint.
 */
export async function getDatabaseHealth() {
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
