import { app } from './app.js';
import { ALLOWED_ORIGINS, env } from './config/env.js';
/**
 * Imported for its side effect as much as its export: promptService reads and
 * validates all four debate templates at import. A missing or malformed one
 * takes the process down here, at start-up, rather than mid-round at 2am.
 */
import { PROMPT_STAGES } from './services/promptService.js';

app.listen(env.PORT, () => {
  console.log(`[server] Quorum API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
  /**
   * The allow-list and the cookie's scope, printed because they are the two
   * settings whose failure mode is a browser-side error with no server-side
   * trace: a rejected credentialed request logs a plain 200 here, and a cookie
   * the browser declined to store logs nothing at all. Reading them off the
   * boot line is how a deploy is checked without guessing.
   */
  console.log(`[server] CORS allow-list: ${ALLOWED_ORIGINS.join(', ')}`);
  console.log(`[server] client URL (links, redirects): ${env.CLIENT_URL}`);
  console.log(`[server] session cookie: domain=${env.COOKIE_DOMAIN ?? '(host-only)'}`);
  console.log(`[server] prompt templates loaded: ${PROMPT_STAGES.join(', ')}`);
});
