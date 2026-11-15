import { MikroORM } from '@mikro-orm/postgresql';
import { noopMetrics, type Metrics } from '../application/ports/system';
import { WalletQueries } from '../application/queries';
import { ResolvePendingReferences } from '../application/wagering/resolve-pending-references';
import { SubmitWagerTransaction } from '../application/wagering/submit-wager-transaction';
import { WagerProcessor } from '../application/wagering/wager-processor';
import { CreateWallet } from '../application/wallets/create-wallet';
import { ReconcileWallet } from '../application/wallets/reconcile-wallet';
import { JsonLogger } from '../infrastructure/observability/json-logger';
import { createOrmConfig } from '../infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../infrastructure/persistence/mikro-orm-unit-of-work';
import { systemClock, uuidV7Generator } from '../infrastructure/system/system';
import { AllowAllAuthenticator, type RequestAuthenticator } from '../interfaces/http/auth/authenticator';
import type { AppConfig } from './config';

export interface HealthIndicator {
  readonly name: string;
  /** Resolves when the dependency is reachable; rejects otherwise. */
  check(): Promise<void>;
}

export interface ContainerOverrides {
  metrics?: Metrics;
  authenticator?: RequestAuthenticator;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)),
  ]);
}

/**
 * Composition root: the only place that knows concrete adapters. Shared by the HTTP
 * process, the workers and the tests, so they all run the exact same application graph.
 */
export async function createContainer(config: AppConfig, overrides: ContainerOverrides = {}) {
  const orm = await MikroORM.init(
    createOrmConfig({ clientUrl: config.databaseUrl, poolMax: config.dbPoolMax, connect: false, ensureDatabase: false }),
  );
  const logger = new JsonLogger(config.logLevel, { service: 'wagering-processor', instanceId: config.instanceId });
  const metrics = overrides.metrics ?? noopMetrics;
  const clock = systemClock;
  const ids = uuidV7Generator;
  const uow = new MikroOrmUnitOfWork(orm, { lockTimeoutMs: config.lockTimeoutMs });
  const processor = new WagerProcessor(ids, clock, metrics);

  const healthIndicators: HealthIndicator[] = [
    {
      name: 'postgres',
      check: async () => {
        await withTimeout(orm.em.fork().execute('select 1'), 2_000, 'postgres');
      },
    },
  ];

  return {
    config,
    orm,
    logger,
    metrics,
    authenticator: overrides.authenticator ?? new AllowAllAuthenticator(),
    healthIndicators,
    submitWagerTransaction: new SubmitWagerTransaction(uow, processor, ids, clock, metrics, logger),
    resolvePendingReferences: new ResolvePendingReferences(uow, processor, clock, metrics, logger),
    createWallet: new CreateWallet(uow, ids, clock, metrics, logger),
    reconcileWallet: new ReconcileWallet(uow, metrics, logger),
    queries: new WalletQueries(uow),
    async close(): Promise<void> {
      await orm.close(true);
    },
  };
}

export type Container = Awaited<ReturnType<typeof createContainer>>;
