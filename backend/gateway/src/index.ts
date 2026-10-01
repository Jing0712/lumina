import { app } from './app.js';
import { env } from './env.js';
import { log } from './log.js';

const server = app.listen(env.port, () => {
  log.info({ port: env.port, agentUrl: env.agentUrl, cors: env.corsOrigins, rateLimitPerMinute: env.rateLimitPerMinute }, 'gateway up');
});
// Keep idle upstream sockets open longer than the client pool keeps them.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
