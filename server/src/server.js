import { app } from './app.js';
import { env } from './config/env.js';
/**
 * Imported for its side effect as much as its export: promptService reads and
 * validates all four debate templates at import. A missing or malformed one
 * takes the process down here, at start-up, rather than mid-round at 2am.
 */
import { PROMPT_STAGES } from './services/promptService.js';

app.listen(env.PORT, () => {
  console.log(`[server] Quorum API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
  console.log(`[server] CORS origin: ${env.CLIENT_URL}`);
  console.log(`[server] prompt templates loaded: ${PROMPT_STAGES.join(', ')}`);
});
