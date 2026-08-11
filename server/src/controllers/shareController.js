/**
 * Sharing a session, revoking it, and the public read.
 *
 * The first two run behind requireAuth and requireOwnership and take
 * `req.resource` — the row already loaded. The third runs behind neither, and
 * the difference is the whole design: `getSharedSession` is handed a string off
 * the URL and everything it returns is built by allow-list. See shareService.
 */
import * as shareService from '../services/shareService.js';

/**
 * 200 rather than 201 even when a token is minted, because the operation is
 * idempotent: the caller asked for this session to be shared and it now is,
 * whether or not that took a write. A 201 on the first call and 200 on the
 * second would make the status code the only way to tell, which is a difference
 * no caller has a use for.
 */
export async function shareSession(req, res, next) {
  try {
    res.json(await shareService.shareSession(req.resource));
  } catch (error) {
    next(error);
  }
}

export async function revokeShare(req, res, next) {
  try {
    await shareService.revokeShare(req.resource);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
}

/**
 * PUBLIC. No cookie, no user, no ownership check — the token is the
 * authorisation. An unknown token and a revoked one are the same 404, raised by
 * the service, because a 403 would confirm that a string somebody is holding was
 * once real.
 */
export async function getSharedSession(req, res, next) {
  try {
    res.json({ session: await shareService.getSharedSession(req.params.token) });
  } catch (error) {
    next(error);
  }
}
