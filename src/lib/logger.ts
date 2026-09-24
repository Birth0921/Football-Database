import pino from 'pino';
import { config, redactSecrets } from '../config.js';

export const logger = pino({
  level: config.logLevel,
  redact: {
    paths: [
      'req.headers["x-api-key"]',
      'req.headers["x-apisports-key"]',
      'apiFootballKey',
      'API_FOOTBALL_KEY',
      'key',
      'apiKey',
      'secret',
      'password',
    ],
    censor: '***REDACTED***',
  },
  hooks: {
    logMethod(args, method) {
      // Belt and braces: scrub secrets from string args
      const scrubbed = args.map((a) => (typeof a === 'string' ? redactSecrets(a) : a));
      return method.apply(this, scrubbed as Parameters<typeof method>);
    },
  },
  transport:
    config.nodeEnv === 'development'
      ? { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } }
      : undefined,
});

export function childLogger(bindings: Record<string, unknown>) {
  return logger.child(bindings);
}
