/**
 * Thin by policy: read the request, call one service, send the response.
 *
 * Every :id handler here runs behind requireOwnership, so `req.resource` is the
 * session row already loaded and already proven to belong to req.user. Fetching
 * it again would be a second round trip for an answer we hold.
 */
import * as sessionService from '../services/sessionService.js';

export async function createSession(req, res, next) {
  try {
    const session = await sessionService.createSession({ userId: req.user.id, ...req.body });

    res.status(201).json({ session });
  } catch (error) {
    next(error);
  }
}

export async function listSessions(req, res, next) {
  try {
    const { limit, offset, search } = req.query;
    const result = await sessionService.listSessions({ userId: req.user.id, limit, offset, search });

    res.json(result);
  } catch (error) {
    next(error);
  }
}

export async function getSession(req, res, next) {
  try {
    res.json({ session: await sessionService.getSessionDetail(req.resource.id) });
  } catch (error) {
    next(error);
  }
}

export async function updateSession(req, res, next) {
  try {
    const session = await sessionService.updateSession({ current: req.resource, ...req.body });

    res.json({ session });
  } catch (error) {
    next(error);
  }
}

export async function deleteSession(req, res, next) {
  try {
    await sessionService.deleteSession(req.resource.id);

    res.status(204).end();
  } catch (error) {
    next(error);
  }
}
