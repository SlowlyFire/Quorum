import { getDatabaseHealth, getHealth } from '../services/healthService.js';

export function health(req, res) {
  res.json(getHealth());
}

export async function databaseHealth(req, res, next) {
  try {
    res.json(await getDatabaseHealth());
  } catch (error) {
    next(error);
  }
}
