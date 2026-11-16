import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { loadConfig } from './bootstrap/config';
import { createContainer } from './bootstrap/container';
import { initTracing } from './infrastructure/observability/tracing';
import { createHttpApp } from './interfaces/http/http-app';

const config = loadConfig();
// Tracing first, so every span created later is recorded. Off unless an OTLP endpoint is set.
const tracing = initTracing({
  serviceName: process.env.OTEL_SERVICE_NAME ?? 'wagering-processor',
  instanceId: config.instanceId,
  otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || undefined,
});
const container = await createContainer(config);
const { logger, workers } = container;

let http: INestApplication | undefined;
if (config.roles.http) {
  http = await createHttpApp(container);
  await http.listen(config.port);
  logger.info('http server listening', { port: config.port });
}
if (config.roles.consumer) workers.consumer.start();
if (config.roles.outbox) workers.outboxLoop.start();
if (config.roles.scheduler) workers.pendingReferenceLoop.start();
logger.info('instance started', { roles: config.roles, auth: config.auth.mode, tracing: Boolean(tracing) });
if (config.auth.mode === 'none') {
  logger.warn('AUTH_MODE=none: HTTP API is unauthenticated (local development only)');
}

let shuttingDown = false;
/**
 * SIGTERM order:
 *   1. stop intake: HTTP stops accepting (in-flight requests finish), consumer stops
 *      receiving and drains (in-flight messages commit + ack, unstarted ones are released)
 *   2. background loops finish their current batch (an outbox batch is committed, not lost)
 *   3. release connections
 * A hard kill at any point is still safe: un-acked messages are redelivered and
 * deduplicated, uncommitted outbox claims are retaken by another publisher.
 */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutdown requested', { signal });
  const hardStop = setTimeout(() => {
    logger.error('shutdown grace exceeded, exiting');
    process.exit(1);
  }, config.shutdownGraceMs + 5_000);

  await Promise.allSettled([http?.close(), workers.consumer.stop()]);
  await Promise.allSettled([workers.outboxLoop.stop(), workers.pendingReferenceLoop.stop()]);
  await container.close();
  await tracing?.shutdown(); // flush buffered spans
  clearTimeout(hardStop);
  logger.info('shutdown complete', { signal });
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
