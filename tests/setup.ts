// Test environment: local/embedded Postgres + Redis (or provided URLs).
process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/football_test';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379/1';
process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? 'test-admin-token';
process.env.API_KEY_PEPPER = process.env.API_KEY_PEPPER ?? 'test-pepper';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'error';
process.env.API_PORT = process.env.API_PORT ?? '3999';
process.env.SCHEDULER_ENABLED = 'false';
process.env.SYNC_INLINE = 'true';
process.env.IMPORT_LEAGUE_IDS = '39,140';
process.env.PROVIDER_DAILY_LIMIT = '1000';
process.env.PROVIDER_MINUTE_LIMIT = '100';
