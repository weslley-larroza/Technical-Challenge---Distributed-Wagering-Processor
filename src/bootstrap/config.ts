import type { LogLevel } from '../infrastructure/observability/json-logger';
import type { OidcSettings } from '../interfaces/http/auth/oidc-jwt-authenticator';
import { DEFAULT_DATABASE_URL } from '../infrastructure/persistence/mikro-orm.config';

export interface AppConfig {
  instanceId: string;
  port: number;
  databaseUrl: string;
  dbPoolMax: number;
  lockTimeoutMs: number;
  logLevel: LogLevel;
  shutdownGraceMs: number;
  /** 'none' = documented open mode (default for local dev); 'oidc' = Keycloak / any OIDC IdP. */
  auth: { mode: 'none' } | { mode: 'oidc'; oidc: OidcSettings };
  /** Which components this process runs. Every instance may run all of them safely. */
  roles: { http: boolean; consumer: boolean; outbox: boolean; scheduler: boolean };
  sqs: {
    endpoint?: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    wagerQueue: string;
    wagerDlq: string;
    eventsQueue: string;
    maxAttempts: number;
    visibilityTimeoutSec: number;
    waitTimeSec: number;
    batchSize: number;
    retryBaseSec: number;
    retryMaxSec: number;
  };
  outbox: { batchSize: number; idleDelayMs: number };
  scheduler: { intervalMs: number; batchSize: number };
}

type Env = Record<string, string | undefined>;

function int(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}

function bool(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name]?.toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  if (['1', 'true', 'yes'].includes(raw)) return true;
  if (['0', 'false', 'no'].includes(raw)) return false;
  throw new Error(`${name} must be a boolean`);
}

function loadAuth(env: Env): AppConfig['auth'] {
  const mode = env.AUTH_MODE ?? 'none';
  if (mode === 'none') return { mode: 'none' };
  if (mode !== 'oidc') throw new Error('AUTH_MODE must be "none" or "oidc"');
  const issuer = env.OIDC_ISSUER;
  if (!issuer) throw new Error('OIDC_ISSUER is required when AUTH_MODE=oidc');
  return {
    mode: 'oidc',
    oidc: {
      issuer,
      jwksUri: env.OIDC_JWKS_URI ?? `${issuer}/protocol/openid-connect/certs`,
      audience: env.OIDC_AUDIENCE ?? 'wagering-api',
      providerClaim: env.OIDC_PROVIDER_CLAIM ?? 'provider_id',
      backofficeRole: env.OIDC_BACKOFFICE_ROLE ?? 'wagering-backoffice',
    },
  };
}

/** All configuration comes from the environment (12-factor). Fails fast on invalid values. */
export function loadConfig(env: Env = process.env): AppConfig {
  return {
    instanceId: env.INSTANCE_ID ?? `instance-${process.pid}`,
    port: int(env, 'PORT', 3000),
    databaseUrl: env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    dbPoolMax: int(env, 'DB_POOL_MAX', 10),
    lockTimeoutMs: int(env, 'DB_LOCK_TIMEOUT_MS', 5_000),
    logLevel: (env.LOG_LEVEL as LogLevel | undefined) ?? 'info',
    shutdownGraceMs: int(env, 'SHUTDOWN_GRACE_MS', 20_000),
    auth: loadAuth(env),
    roles: {
      http: bool(env, 'ENABLE_HTTP', true),
      consumer: bool(env, 'ENABLE_CONSUMER', true),
      outbox: bool(env, 'ENABLE_OUTBOX_PUBLISHER', true),
      scheduler: bool(env, 'ENABLE_PENDING_REFERENCE_WORKER', true),
    },
    sqs: {
      endpoint: env.SQS_ENDPOINT ?? 'http://localhost:4566',
      region: env.AWS_REGION ?? 'us-east-1',
      accessKeyId: env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? 'test',
      wagerQueue: env.SQS_WAGER_QUEUE ?? 'wager-transactions.fifo',
      wagerDlq: env.SQS_WAGER_DLQ ?? 'wager-transactions-dlq.fifo',
      eventsQueue: env.SQS_EVENTS_QUEUE ?? 'wagering-events.fifo',
      maxAttempts: int(env, 'SQS_MAX_ATTEMPTS', 5),
      visibilityTimeoutSec: int(env, 'SQS_VISIBILITY_TIMEOUT_SEC', 30),
      waitTimeSec: int(env, 'SQS_WAIT_TIME_SEC', 10),
      batchSize: Math.min(10, Math.max(1, int(env, 'SQS_BATCH_SIZE', 10))),
      retryBaseSec: int(env, 'SQS_RETRY_BASE_SEC', 2),
      retryMaxSec: int(env, 'SQS_RETRY_MAX_SEC', 300),
    },
    outbox: { batchSize: int(env, 'OUTBOX_BATCH_SIZE', 50), idleDelayMs: int(env, 'OUTBOX_IDLE_DELAY_MS', 250) },
    scheduler: {
      intervalMs: int(env, 'PENDING_REFERENCE_INTERVAL_MS', 1_000),
      batchSize: int(env, 'PENDING_REFERENCE_BATCH_SIZE', 100),
    },
  };
}
