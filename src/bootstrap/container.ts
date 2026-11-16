import { MikroORM } from '@mikro-orm/postgresql';
import { PublishOutbox } from '../application/messaging/publish-outbox';
import type { EventPublisher } from '../application/ports/messaging';
import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import type { Metrics } from '../application/ports/system';
import { PrometheusMetrics } from '../infrastructure/observability/prometheus-metrics';
import { WalletQueries } from '../application/queries';
import { ResolvePendingReferences } from '../application/wagering/resolve-pending-references';
import { SubmitWagerTransaction } from '../application/wagering/submit-wager-transaction';
import { WagerProcessor } from '../application/wagering/wager-processor';
import { CreateWallet } from '../application/wallets/create-wallet';
import { ReconcileWallet } from '../application/wallets/reconcile-wallet';
import { createSqsClient, QueueUrlResolver, SqsEventPublisher } from '../infrastructure/messaging/sqs';
import { JsonLogger } from '../infrastructure/observability/json-logger';
import { createOrmConfig } from '../infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../infrastructure/persistence/mikro-orm-unit-of-work';
import { systemClock, uuidV7Generator } from '../infrastructure/system/system';
import { PollingLoop } from '../infrastructure/workers/polling-loop';
import { AllowAllAuthenticator, type RequestAuthenticator } from '../interfaces/http/auth/authenticator';
import { SqsWagerConsumer, type SqsWagerConsumerOptions } from '../interfaces/messaging/sqs-wager-consumer';
import type { AppConfig } from './config';

export interface HealthIndicator {
  readonly name: string;
  /** Resolves when the dependency is reachable; rejects otherwise. */
  check(): Promise<void>;
}

export interface ContainerOverrides {
  metrics?: Metrics;
  authenticator?: RequestAuthenticator;
  /** Test seam: wrap / replace the broker publisher (e.g. fault injection). */
  eventPublisher?: (real: EventPublisher) => EventPublisher;
  consumerHooks?: Pick<SqsWagerConsumerOptions, 'beforeAck'>;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    }),
  ]);
}

/**
 * Composition root: the only place that knows concrete adapters. Shared by the HTTP
 * process, the workers and the tests, so they all run the exact same application graph.
 * Nothing here connects eagerly: the process boots even when PostgreSQL / SQS are down.
 */
export async function createContainer(config: AppConfig, overrides: ContainerOverrides = {}) {
  const orm = await MikroORM.init(
    createOrmConfig({ clientUrl: config.databaseUrl, poolMax: config.dbPoolMax, connect: false, ensureDatabase: false }),
  );
  const logger = new JsonLogger(config.logLevel, { service: 'wagering-processor', instanceId: config.instanceId });
  // Tests may inject a recording spy; otherwise Prometheus (exposed on GET /metrics).
  const prometheus = overrides.metrics ? undefined : new PrometheusMetrics({ service: 'wagering-processor' });
  const metrics: Metrics = overrides.metrics ?? prometheus!;
  const clock = systemClock;
  const ids = uuidV7Generator;
  const uow = new MikroOrmUnitOfWork(orm, { lockTimeoutMs: config.lockTimeoutMs });
  const processor = new WagerProcessor(ids, clock, metrics);

  const sqs = createSqsClient(config.sqs);
  const queues = {
    wager: new QueueUrlResolver(sqs, config.sqs.wagerQueue),
    wagerDlq: new QueueUrlResolver(sqs, config.sqs.wagerDlq),
    events: new QueueUrlResolver(sqs, config.sqs.eventsQueue),
  };
  const realPublisher = new SqsEventPublisher(sqs, queues.events);
  const eventPublisher = overrides.eventPublisher ? overrides.eventPublisher(realPublisher) : realPublisher;

  const submitWagerTransaction = new SubmitWagerTransaction(uow, processor, ids, clock, metrics, logger);
  const resolvePendingReferences = new ResolvePendingReferences(uow, processor, clock, metrics, logger);
  const publishOutbox = new PublishOutbox(uow, eventPublisher, clock, metrics, logger);

  const consumer = new SqsWagerConsumer(
    sqs,
    queues.wager,
    queues.wagerDlq,
    submitWagerTransaction,
    {
      consumerName: 'wager-transactions-consumer',
      maxAttempts: config.sqs.maxAttempts,
      visibilityTimeoutSec: config.sqs.visibilityTimeoutSec,
      waitTimeSec: config.sqs.waitTimeSec,
      batchSize: config.sqs.batchSize,
      retryBaseSec: config.sqs.retryBaseSec,
      retryMaxSec: config.sqs.retryMaxSec,
      shutdownGraceMs: config.shutdownGraceMs,
      ...overrides.consumerHooks,
    },
    metrics,
    logger.child({ component: 'sqs-consumer' }),
  );

  const outboxLoop = new PollingLoop(
    'outbox-publisher',
    async () => (await publishOutbox.runOnce(config.outbox.batchSize)).claimed,
    { idleDelayMs: config.outbox.idleDelayMs, errorDelayMs: 2_000 },
    logger.child({ component: 'outbox-publisher' }),
  );

  const pendingReferenceLoop = new PollingLoop(
    'pending-reference-worker',
    async () => {
      const report = await resolvePendingReferences.runOnce(config.scheduler.batchSize);
      return report.scanned === config.scheduler.batchSize ? report.scanned : 0; // full batch → keep going
    },
    { idleDelayMs: config.scheduler.intervalMs, errorDelayMs: 5_000 },
    logger.child({ component: 'pending-reference-worker' }),
  );

  if (prometheus) {
    // Outbox lag that keeps growing while publishing is stuck (the histogram only sees successes).
    const outboxStats = () => withTimeout(uow.run((r) => r.outbox.stats(clock.now())), 1_000, 'outbox stats');
    prometheus.registerGauge('outbox_pending_messages', 'Unpublished outbox events', [], async () => [
      { value: (await outboxStats()).pending },
    ]);
    prometheus.registerGauge('outbox_oldest_pending_age_ms', 'Age of the oldest unpublished outbox event', [], async () => [
      { value: (await outboxStats()).oldestAgeMs },
    ]);
    // Includes the DLQ depth: "mensagens em DLQ" as a level, not only as a rate.
    prometheus.registerGauge('sqs_queue_messages', 'Approximate SQS queue depth', ['queue', 'state'], async () => {
      const samples = await Promise.all(
        [queues.wager, queues.wagerDlq].map(async (q) => {
          const r = await withTimeout(
            sqs.send(
              new GetQueueAttributesCommand({
                QueueUrl: await q.get(),
                AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
              }),
            ),
            1_000,
            'sqs depth',
          );
          return [
            { labels: { queue: q.queueName, state: 'visible' }, value: Number(r.Attributes?.ApproximateNumberOfMessages ?? 0) },
            { labels: { queue: q.queueName, state: 'in_flight' }, value: Number(r.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0) },
          ];
        }),
      );
      return samples.flat();
    });
  }

  const healthIndicators: HealthIndicator[] = [
    { name: 'postgres', check: () => withTimeout(orm.em.fork().execute('select 1').then(() => undefined), 2_000, 'postgres') },
    { name: 'sqs', check: () => withTimeout(queues.wager.ping(), 2_000, 'sqs') },
  ];

  return {
    config,
    orm,
    sqs,
    queues,
    logger,
    metrics,
    prometheus,
    authenticator: overrides.authenticator ?? new AllowAllAuthenticator(),
    healthIndicators,
    submitWagerTransaction,
    resolvePendingReferences,
    publishOutbox,
    createWallet: new CreateWallet(uow, ids, clock, metrics, logger),
    reconcileWallet: new ReconcileWallet(uow, metrics, logger),
    queries: new WalletQueries(uow),
    workers: { consumer, outboxLoop, pendingReferenceLoop },
    async close(): Promise<void> {
      sqs.destroy();
      await orm.close(true);
    },
  };
}

export type Container = Awaited<ReturnType<typeof createContainer>>;
