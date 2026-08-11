import { app } from './app.js';
import { env } from './config/env.js';

app.listen(env.PORT, () => {
  console.log(`[server] Quorum API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
  console.log(`[server] CORS origin: ${env.CLIENT_URL}`);
});
