import pino from 'pino';
import { config, redactSecrets } from './config.js';

export const logger = pino({
  level: config.logLevel,
  redact: {
    paths: ['req.headers["x-api-key"]', 'req.headers.authorization', 'req.headers["x-admin-token"]'],
    censor: '***',
  },
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  mixin() {
    return {};
  },
});

/** Child logger (secret redaction happens at call sites via redactSecrets). */
export function safeLogger(bindings: Record<string, unknown> = {}) {
  return logger.child(bindings);
}
