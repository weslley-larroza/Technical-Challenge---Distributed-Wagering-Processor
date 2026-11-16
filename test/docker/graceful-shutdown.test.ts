/**
 * Opt-in (needs Docker): `bun run test:docker`.
 * Real SIGTERM on Linux containers (tini as PID 1, `docker compose stop`), mid-stream,
 * against the compose cluster (app1..app3 + postgres + localstack).
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../../src/bootstrap/config';
import { createSqsClient, QueueUrlResolver } from '../../src/infrastructure/messaging/sqs';
import { createOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { expectGlobalInvariant } from '../support/cluster';
import { queueDepth, sendWager, waitFor, wagerData } from '../support/messaging';

const enabled = process.env.RUN_DOCKER_TESTS === '1';
setDefaultTimeout(240_000);

const SERVICES = ['app1', 'app2', 'app3'];
let orm: MikroORM;
let sqs: SQSClient;
let wagerUrl: string;

async function sh(...args: string[]): Promise<string> {
  const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if ((await proc.exited) !== 0) throw new Error(`${args.join(' ')} failed: ${err}`);
  return out.trim();
}

const compose = (...args: string[]) => sh('docker', 'compose', '--profile', 'app', ...args);

describe.skipIf(!enabled)('graceful shutdown on Linux (docker compose)', () => {
  beforeAll(async () => {
    await compose('up', '-d', '--build', '--wait');
    orm = await MikroORM.init(createOrmConfig({ clientUrl: 'postgres://postgres:postgres@localhost:5432/wagering_db' }));
    const config = loadConfig({});
    sqs = createSqsClient(config.sqs);
    wagerUrl = await new QueueUrlResolver(sqs, config.sqs.wagerQueue).get();
  });

  afterAll(async () => {
    sqs?.destroy();
    await orm?.close(true);
  });

  test('SIGTERM to all 3 instances mid-stream: clean exit, nothing stranded, exactly-once after restart', async () => {
    const wallets = await Promise.all(
      Array.from({ length: 10 }, async () => {
        const res = await fetch('http://localhost:3001/wallets', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ playerId: randomUUID(), initialBalance: { amount: '1000.00', currency: 'BRL' } }),
        });
        expect(res.status).toBe(201);
        return (await res.json()) as { id: string; playerId: string };
      }),
    );
    const sent = wallets.flatMap((w) => Array.from({ length: 20 }, () => wagerData(w, { money: { amount: '1.00', currency: 'BRL' } })));
    await Promise.all(sent.map((d) => sendWager(sqs, wagerUrl, d)));

    const ids = sent.map((d) => d.externalTransactionId);
    const applied = async () =>
      (await orm.em.fork().execute<{ n: number }[]>(
        'select count(*)::int as n from wager_transactions where external_transaction_id in (?)',
        [ids],
      ))[0]?.n ?? 0;

    await waitFor(async () => (await applied()) >= 10, { what: 'processing started' });
    await compose('stop', '-t', '30', ...SERVICES); // SIGTERM, waits for exit

    const atStop = await applied();
    expect(atStop).toBeLessThan(sent.length); // really mid-stream
    for (const service of SERVICES) {
      const id = await compose('ps', '-aq', service);
      expect(await sh('docker', 'inspect', '-f', '{{.State.ExitCode}}', id)).toBe('0');
      const logs = await compose('logs', '--no-color', '--tail', '50', service);
      expect(logs).toContain('"msg":"shutdown requested","service":"wagering-processor"');
      expect(logs).toContain('"msg":"shutdown complete"');
    }
    // drained: in-flight messages were acked, unstarted ones released → nothing invisible
    const depth = await queueDepth(sqs, wagerUrl);
    expect(depth.inFlight).toBe(0);
    expect(depth.visible).toBe(sent.length - atStop);

    await compose('start', ...SERVICES);
    await waitFor(async () => (await applied()) === sent.length, { timeoutMs: 90_000, what: 'all applied after restart' });
    for (const w of wallets) {
      const res = await fetch(`http://localhost:3002/wallets/${w.id}`);
      expect(((await res.json()) as { balance: { amount: string } }).balance.amount).toBe('980.00');
    }
    await expectGlobalInvariant(orm);
  });
});
