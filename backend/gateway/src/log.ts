import pino from 'pino';
import { env } from './env.js';

export const log = pino({ level: env.logLevel, base: { service: 'gateway' } });
