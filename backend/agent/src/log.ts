import pino from 'pino';
import { env } from './env.js';

/** One JSON-lines logger for the whole service. Never log a key or the Mongo URI. */
export const log = pino({ level: env.logLevel, base: { service: 'agent' } });
