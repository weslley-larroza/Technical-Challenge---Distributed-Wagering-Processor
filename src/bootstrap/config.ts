import type { LogLevel } from '../infrastructure/observability/json-logger';
import { DEFAULT_DATABASE_URL } from '../infrastructure/persistence/mikro-orm.config';

export interface AppConfig {
  instanceId: string;
  port: number;
  databaseUrl: string;
  dbPoolMax: number;
  lockTimeoutMs: number;
  logLevel: LogLevel;
  auth: { mode: 'none' };
}

function int(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}

/** All configuration comes from the environment (12-factor). Fails fast on invalid values. */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  return {
    instanceId: env.INSTANCE_ID ?? `instance-${process.pid}`,
    port: int(env, 'PORT', 3000),
    databaseUrl: env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    dbPoolMax: int(env, 'DB_POOL_MAX', 10),
    lockTimeoutMs: int(env, 'DB_LOCK_TIMEOUT_MS', 5_000),
    logLevel: (env.LOG_LEVEL as LogLevel | undefined) ?? 'info',
    auth: { mode: 'none' },
  };
}
