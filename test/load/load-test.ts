/**
 * Load test — `bun run test:load`  (needs `bun run infra:up`).
 *
 * Spawns N real instances of src/main.ts (default 3) on an isolated database
 * (`wagering_load`) and isolated queues, drives them with a closed-loop HTTP load
 * generator and a bulk SQS enqueue, scrapes their /metrics, verifies the global ledger
 * invariant at the end and writes docs/load-test-report.md.
 *
 * Tunables (env): LOAD_INSTANCES=3 LOAD_CONCURRENCY=64 LOAD_WALLETS=200
 *                 LOAD_MIXED_SEC=30 LOAD_HOT_SEC=15 LOAD_HOT_CONCURRENCY=32 LOAD_SQS_MESSAGES=3000
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../../src/bootstrap/config';
import { createSqsClient, ensureQueues, QueueUrlResolver } from '../../src/infrastructure/messaging/sqs';
import { createOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { expectGlobalInvariant, type Instance, killHard, spawnInstance } from '../support/cluster';

const num = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
const P = {
  instances: num('LOAD_INSTANCES', 3),
  concurrency: num('LOAD_CONCURRENCY', 64),
  wallets: num('LOAD_WALLETS', 200),
  mixedSec: num('LOAD_MIXED_SEC', 30),
  hotSec: num('LOAD_HOT_SEC', 15),
  hotConcurrency: num('LOAD_HOT_CONCURRENCY', 32),
  sqsMessages: num('LOAD_SQS_MESSAGES', 3000),
};

const DATABASE_URL = process.env.LOAD_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/wagering_load';
const suffix = randomUUID().slice(0, 8);
const ENV: Record<string, string> = {
  DATABASE_URL,
  LOG_LEVEL: 'warn', // info logs every request; keep the generator measuring the service, not stdout
  SQS_WAGER_QUEUE: `load-wager-${suffix}.fifo`,
  SQS_WAGER_DLQ: `load-wager-dlq-${suffix}.fifo`,
  SQS_EVENTS_QUEUE: `load-events-${suffix}.fifo`,
  SQS_WAIT_TIME_SEC: '1',
};

// ------------------------------------------------------------------ helpers
const log = (msg: string) => console.log(`[load] ${msg}`);

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

interface RunStats {
  name: string;
  durationSec: number;
  concurrency: number;
  latencies: number[];
  statuses: Map<string, number>;
  networkErrors: number;
  replaysVerified: number;
  replayMismatches: number;
}

function newStats(name: string, concurrency: number): RunStats {
  return { name, durationSec: 0, concurrency, latencies: [], statuses: new Map(), networkErrors: 0, replaysVerified: 0, replayMismatches: 0 };
}

function summarize(s: RunStats) {
  const sorted = [...s.latencies].sort((a, b) => a - b);
  const total = s.latencies.length + s.networkErrors;
  const count = (pred: (code: number) => boolean) =>
    [...s.statuses].filter(([k]) => pred(Number(k))).reduce((a, [, v]) => a + v, 0);
  const errors = count((c) => c >= 500) + s.networkErrors;
  return {
    requests: total,
    throughput: total / s.durationSec,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.at(-1) ?? Number.NaN,
    errorRate: total ? errors / total : 0,
    errors,
    business422: count((c) => c === 422),
    conflicts409: count((c) => c === 409),
    statuses: Object.fromEntries([...s.statuses].sort()),
  };
}

// Prometheus text parsing (summed over every instance and label set)
type Sample = { name: string; labels: Record<string, string>; value: number };
function parseMetrics(text: string): Sample[] {
  const out: Sample[] = [];
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const m = /^([a-zA-Z_:][\w:]*)(?:\{(.*)\})? ([-+\d.eE]+|NaN|\+Inf)$/.exec(line);
    if (!m) continue;
    const labels: Record<string, string> = {};
    for (const pair of (m[2] ?? '').matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) labels[pair[1]!] = pair[2]!;
    out.push({ name: m[1]!, labels, value: Number(m[3]) });
  }
  return out;
}

async function scrape(cluster: Instance[]): Promise<Sample[]> {
  const texts = await Promise.all(cluster.map((i) => fetch(`${i.base}/metrics`).then((r) => r.text()).catch(() => '')));
  return texts.flatMap(parseMetrics);
}

const sum = (samples: Sample[], name: string, filter: (l: Record<string, string>) => boolean = () => true) =>
  samples.filter((s) => s.name === name && filter(s.labels)).reduce((a, s) => a + s.value, 0);

/** Percentile from a Prometheus cumulative histogram (linear interpolation inside the bucket). */
function histogramPercentile(samples: Sample[], name: string, p: number): number {
  const byLe = new Map<number, number>();
  for (const s of samples.filter((x) => x.name === `${name}_bucket`)) {
    const le = s.labels.le === '+Inf' ? Number.POSITIVE_INFINITY : Number(s.labels.le);
    byLe.set(le, (byLe.get(le) ?? 0) + s.value);
  }
  const buckets = [...byLe].sort((a, b) => a[0] - b[0]);
  const total = buckets.at(-1)?.[1] ?? 0;
  if (!total) return Number.NaN;
  const rank = (p / 100) * total;
  let prevLe = 0;
  let prevCount = 0;
  for (const [le, count] of buckets) {
    if (count >= rank) {
      if (!Number.isFinite(le)) return prevLe; // beyond the last finite bucket: report its bound
      return prevLe + ((le - prevLe) * (rank - prevCount)) / Math.max(1, count - prevCount);
    }
    prevLe = le;
    prevCount = count;
  }
  return prevLe;
}

// ------------------------------------------------------------------ workload
interface Wallet {
  id: string;
  playerId: string;
}

function txRequest(w: Wallet, kind: string, amount: string) {
  const externalTransactionId = `ld-${randomUUID()}`;
  return {
    key: `provider-a:${externalTransactionId}`,
    body: {
      providerId: 'provider-a',
      externalTransactionId,
      playerId: w.playerId,
      walletId: w.id,
      roundId: `round-${Math.floor(Math.random() * 1e6)}`,
      gameId: 'fortune-chimp',
      kind,
      money: { amount, currency: 'BRL' },
    },
  };
}

type Req = ReturnType<typeof txRequest>;

async function send(instance: Instance, req: Req, stats: RunStats): Promise<{ status: number; body: any } | undefined> {
  const t0 = performance.now();
  try {
    const res = await fetch(`${instance.base}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': req.key },
      body: JSON.stringify(req.body),
    });
    const body = await res.json();
    stats.latencies.push(performance.now() - t0);
    stats.statuses.set(String(res.status), (stats.statuses.get(String(res.status)) ?? 0) + 1);
    return { status: res.status, body };
  } catch {
    stats.networkErrors += 1;
    return undefined;
  }
}

/** Closed loop: each worker sends, waits for the answer, sends again — until the deadline. */
async function closedLoop(
  stats: RunStats,
  cluster: Instance[],
  seconds: number,
  next: (worker: number) => { req: Req; expect?: unknown },
): Promise<void> {
  const deadline = performance.now() + seconds * 1_000;
  const started = performance.now();
  let rr = 0;
  await Promise.all(
    Array.from({ length: stats.concurrency }, async (_, worker) => {
      while (performance.now() < deadline) {
        const { req, expect } = next(worker);
        const res = await send(cluster[rr++ % cluster.length]!, req, stats);
        if (expect && res) {
          const same = res.body?.idempotentReplay === true && res.body?.transactionId === (expect as { transactionId: string }).transactionId;
          if (same) stats.replaysVerified += 1;
          else stats.replayMismatches += 1;
        }
      }
    }),
  );
  stats.durationSec = (performance.now() - started) / 1_000;
}

// ------------------------------------------------------------------ main
async function main() {
  log(`params ${JSON.stringify(P)}`);

  // isolated database, migrated from scratch
  const orm = await MikroORM.init(createOrmConfig({ clientUrl: DATABASE_URL, poolMax: 5 }));
  await orm.em.fork().execute('drop schema if exists public cascade; create schema public;');
  await orm.getMigrator().up();
  const pgVersion = (await orm.em.fork().execute<{ v: string }[]>('select version() as v'))[0]?.v ?? '?';

  const config = loadConfig(ENV);
  const sqs = createSqsClient(config.sqs);
  await ensureQueues(sqs, { wager: config.sqs.wagerQueue, wagerDlq: config.sqs.wagerDlq, events: config.sqs.eventsQueue }, 5);
  const wagerUrl = await new QueueUrlResolver(sqs, config.sqs.wagerQueue).get();
  const localstack = (await fetch('http://localhost:4566/_localstack/health').then((r) => r.json()).catch(() => ({}))) as { version?: string };

  log(`spawning ${P.instances} instances`);
  const cluster = await Promise.all(Array.from({ length: P.instances }, (_, i) => spawnInstance(`load-${i + 1}`, ENV)));

  // Background sampler: outbox backlog / age while load runs, queried DIRECTLY from the
  // database (the /metrics gauge has a short timeout and keeps its last value under load,
  // which would under-report exactly when it matters).
  let maxPending = 0;
  let maxOldestAge = 0;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const [row] = await orm.em
        .fork()
        .execute<{ pending: number; age_ms: number | null }[]>(
          `select count(*)::int as pending,
                  (extract(epoch from (now() - min(occurred_at))) * 1000)::float8 as age_ms
             from outbox_messages where published_at is null`,
        )
        .catch(() => [{ pending: 0, age_ms: 0 }]);
      maxPending = Math.max(maxPending, row?.pending ?? 0);
      maxOldestAge = Math.max(maxOldestAge, row?.age_ms ?? 0);
      await Bun.sleep(1_000);
    }
  })();

  try {
    // ---------------- setup wallets
    log(`creating ${P.wallets} wallets + 1 hot wallet`);
    const create = async (i: number) => {
      const res = await fetch(`${cluster[i % cluster.length]!.base}/wallets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ playerId: randomUUID(), initialBalance: { amount: '1000000.00', currency: 'BRL' } }),
      });
      return (await res.json()) as Wallet;
    };
    const wallets: Wallet[] = [];
    for (let i = 0; i < P.wallets; i += 50) {
      wallets.push(...(await Promise.all(Array.from({ length: Math.min(50, P.wallets - i) }, (_, j) => create(i + j)))));
    }
    const hot = await create(0);

    // ---------------- scenario 1: mixed workload over many wallets
    log(`scenario 1: mixed, ${P.concurrency} workers, ${P.mixedSec}s`);
    const mixed = newStats('mixed', P.concurrency);
    const history: Array<{ req: Req; transactionId?: string }> = [];
    await closedLoop(mixed, cluster, P.mixedSec, () => {
      const r = Math.random();
      const w = wallets[Math.floor(Math.random() * wallets.length)]!;
      const kind = r < 0.65 ? 'BET' : r < 0.9 ? 'WIN' : 'LOSS';
      const req = txRequest(w, kind, `${1 + Math.floor(Math.random() * 50)}.${String(Math.floor(Math.random() * 100)).padStart(2, '0')}`);
      history.push({ req });
      if (history.length > 5_000) history.shift();
      return { req };
    });
    // replays are checked against the ORIGINAL transaction ids, resolved from the DB
    {
      const ids = await orm.em.fork().execute<{ external_transaction_id: string; id: string }[]>(
        `select external_transaction_id, id from wager_transactions where provider_id = 'provider-a' and external_transaction_id like 'ld-%'`,
      );
      const map = new Map(ids.map((r) => [r.external_transaction_id, r.id]));
      for (const h of history) h.transactionId = map.get(h.req.body.externalTransactionId);
    }
    const replay = newStats('replay', Math.max(8, P.concurrency / 4));
    await closedLoop(replay, cluster, 5, () => {
      const prev = history[Math.floor(Math.random() * history.length)]!;
      return { req: prev.req, expect: { transactionId: prev.transactionId } };
    });

    // ---------------- scenario 2: hot wallet
    log(`scenario 2: hot wallet, ${P.hotConcurrency} workers, ${P.hotSec}s`);
    const before = await scrape(cluster);
    const hotStats = newStats('hot-wallet', P.hotConcurrency);
    await closedLoop(hotStats, cluster, P.hotSec, () => ({ req: txRequest(hot, Math.random() < 0.7 ? 'BET' : 'WIN', '1.00') }));
    const afterHot = await scrape(cluster);

    // ---------------- scenario 3: SQS drain
    log(`scenario 3: enqueue ${P.sqsMessages} messages, measure drain`);
    const sqsIds: string[] = [];
    const t0 = performance.now();
    const batches: Array<Promise<unknown>> = [];
    for (let i = 0; i < P.sqsMessages; i += 10) {
      const entries = Array.from({ length: Math.min(10, P.sqsMessages - i) }, () => {
        const w = wallets[Math.floor(Math.random() * wallets.length)]!;
        const { body, key } = txRequest(w, 'BET', '1.00');
        sqsIds.push(body.externalTransactionId);
        const messageId = `msg-${randomUUID()}`;
        return {
          Id: messageId.replace(/[^\w-]/g, '').slice(0, 80),
          MessageBody: JSON.stringify({ messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data: { ...body, idempotencyKey: key } }),
          MessageGroupId: w.id,
          MessageDeduplicationId: messageId,
        };
      });
      batches.push(sqs.send(new SendMessageBatchCommand({ QueueUrl: wagerUrl, Entries: entries })));
      if (batches.length >= 20) await Promise.all(batches.splice(0));
    }
    await Promise.all(batches);
    const enqueueSec = (performance.now() - t0) / 1_000;
    const countSqs = async () =>
      (await orm.em.fork().execute<{ n: number }[]>(
        'select count(*)::int as n from wager_transactions where external_transaction_id in (?)',
        [sqsIds],
      ))[0]?.n ?? 0;
    while ((await countSqs()) < sqsIds.length) {
      if (performance.now() - t0 > 300_000) throw new Error('SQS drain timed out');
      await Bun.sleep(250);
    }
    const drainSec = (performance.now() - t0) / 1_000;

    // ---------------- outbox drain + consistency
    const tOutbox = performance.now();
    for (;;) {
      const [{ n } = { n: 0 }] = await orm.em.fork().execute<{ n: number }[]>('select count(*)::int as n from outbox_messages where published_at is null');
      if (n === 0) break;
      if (performance.now() - tOutbox > 120_000) throw new Error('outbox drain timed out');
      await Bun.sleep(250);
    }
    const outboxDrainSec = (performance.now() - tOutbox) / 1_000;
    sampling = false;
    await sampler;
    const final = await scrape(cluster);

    let invariant = 'OK';
    try {
      await expectGlobalInvariant(orm);
    } catch (e) {
      invariant = `FAILED: ${(e as Error).message}`;
    }
    const totals = (await orm.em.fork().execute<{ tx: number; entries: number; events: number }[]>(
      `select (select count(*)::int from wager_transactions) as tx,
              (select count(*)::int from wallet_ledger_entries) as entries,
              (select count(*)::int from outbox_messages) as events`,
    ))[0]!;

    // ---------------- report
    const s1 = summarize(mixed);
    const sR = summarize(replay);
    const s2 = summarize(hotStats);
    const lock = (samples: Sample[]) => sum(samples, 'lock_conflicts_total');
    const retries = (samples: Sample[], reason?: string) =>
      sum(samples, 'persistence_retries_total', (l) => (reason ? l.reason === reason : true));
    const fmt = (n: number, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : 'n/a');
    const cpus = os.cpus();

    const report = `# Relatório de teste de carga

> Gerado por \`bun run test:load\` em ${new Date().toISOString()}. Os números abaixo são **desta execução**; a análise está no fim.

## Ambiente

| Item | Valor |
|---|---|
| Máquina | ${os.type()} ${os.release()} · ${cpus[0]?.model?.trim() ?? '?'} · ${cpus.length} threads · ${(os.totalmem() / 2 ** 30).toFixed(1)} GiB RAM |
| Runtime | Bun ${Bun.version} |
| PostgreSQL | ${pgVersion.split(',')[0]} (Docker Desktop) |
| SQS | LocalStack ${localstack.version ?? '?'} (Docker Desktop) |
| Instâncias da app | ${P.instances} processos \`src/main.ts\` (HTTP + consumidor + outbox + worker), pool de ${config.dbPoolMax} conexões cada, \`LOG_LEVEL=warn\` |
| Gerador de carga | mesmo host, processo único, *closed loop* |

**Tudo roda na mesma máquina:** gerador, 3 instâncias, PostgreSQL e LocalStack competem pela mesma CPU (e o Docker roda sobre uma VM no Windows). Os números são um **limite inferior** e servem para comparar cenários entre si, não para dimensionar produção.

## Metodologia

- **Banco e filas isolados:** banco \`wagering_load\` recriado e migrado do zero; filas com nome único.
- **Wallets:** ${P.wallets} wallets com 1.000.000,00 BRL (saldo alto para que rejeições por saldo não dominem o cenário misto), mais 1 *hot wallet*.
- **Gerador *closed loop*:** cada worker envia, espera a resposta e envia de novo; as requisições são distribuídas *round-robin* entre as instâncias. A latência é medida no cliente (envio → corpo recebido) e inclui a fila do pool de conexões.
- **Erro** = HTTP 5xx ou falha de rede. **422 (rejeição de negócio) e 409 (conflito) não são erros**: são respostas corretas e aparecem separadas.
- **Métricas do servidor:** scrape do \`/metrics\` das ${P.instances} instâncias (somadas). O backlog e a idade da outbox foram amostrados a cada 1s durante toda a execução.
- **Consistência:** ao final, o invariante global foi verificado no banco inteiro (saldo = ledger em todas as wallets; um lançamento por transação processada).

| Cenário | Descrição |
|---|---|
| 1. Misto | ${P.concurrency} workers por ${P.mixedSec}s; BET 65% · WIN 25% · LOSS 10%, valores aleatórios, wallet aleatória entre ${P.wallets} |
| 1b. Replay | ${replay.concurrency} workers por 5s reenviando requisições já processadas (mesma key + payload); valida que a resposta é o replay da transação original |
| 2. Hot wallet | ${P.hotConcurrency} workers por ${P.hotSec}s **na mesma wallet** (BET/WIN de 1,00) — pior caso do lock por wallet |
| 3. SQS | ${P.sqsMessages} mensagens \`WagerTransactionRequested\` enfileiradas em lote em ${P.wallets} grupos FIFO; tempo até todas serem aplicadas |

## Resultados — HTTP

| Cenário | Requisições | Throughput (req/s) | p50 (ms) | p95 (ms) | p99 (ms) | máx (ms) | Taxa de erro | 422 | 409 |
|---|---|---|---|---|---|---|---|---|---|
| 1. Misto | ${s1.requests} | ${fmt(s1.throughput)} | ${fmt(s1.p50)} | ${fmt(s1.p95)} | ${fmt(s1.p99)} | ${fmt(s1.max)} | ${(s1.errorRate * 100).toFixed(2)}% (${s1.errors}) | ${s1.business422} | ${s1.conflicts409} |
| 1b. Replay | ${sR.requests} | ${fmt(sR.throughput)} | ${fmt(sR.p50)} | ${fmt(sR.p95)} | ${fmt(sR.p99)} | ${fmt(sR.max)} | ${(sR.errorRate * 100).toFixed(2)}% (${sR.errors}) | ${sR.business422} | ${sR.conflicts409} |
| 2. Hot wallet | ${s2.requests} | ${fmt(s2.throughput)} | ${fmt(s2.p50)} | ${fmt(s2.p95)} | ${fmt(s2.p99)} | ${fmt(s2.max)} | ${(s2.errorRate * 100).toFixed(2)}% (${s2.errors}) | ${s2.business422} | ${s2.conflicts409} |

- Status por cenário: misto \`${JSON.stringify(s1.statuses)}\` · replay \`${JSON.stringify(sR.statuses)}\` · hot \`${JSON.stringify(s2.statuses)}\`
- Replays verificados (mesmo \`transactionId\`, \`idempotentReplay: true\`): **${replay.replaysVerified}**; divergências: **${replay.replayMismatches}**

## Resultados — SQS

| Métrica | Valor |
|---|---|
| Mensagens | ${P.sqsMessages} |
| Tempo de enfileiramento (cliente) | ${fmt(enqueueSec, 2)} s |
| Tempo até todas aplicadas (desde o primeiro envio) | ${fmt(drainSec, 2)} s |
| Throughput de consumo (${P.instances} consumidores) | **${fmt(P.sqsMessages / drainSec)} msg/s** |
| DLQ | ${sum(final, 'sqs_dlq_total')} |
| Retries de mensagem | ${sum(final, 'sqs_retries_total')} |

## Concorrência e outbox

| Métrica | Hot wallet (só o cenário 2) | Execução inteira |
|---|---|---|
| Conflitos de lock (deadlock + lock timeout) | ${lock(afterHot) - lock(before)} | ${lock(final)} |
| Retries da unidade de trabalho (todas as razões) | ${retries(afterHot) - retries(before)} | ${retries(final)} |
| …dos quais corrida de chave única | ${retries(afterHot, 'unique-race') - retries(before, 'unique-race')} | ${retries(final, 'unique-race')} |

| Outbox | Valor |
|---|---|
| Eventos gerados | ${totals.events} |
| Lag commit → broker p50 / p95 / p99 (histograma) | ${fmt(histogramPercentile(final, 'outbox_lag_ms', 50), 0)} / ${fmt(histogramPercentile(final, 'outbox_lag_ms', 95), 0)} / ${fmt(histogramPercentile(final, 'outbox_lag_ms', 99), 0)} ms |
| Backlog máximo observado (amostrado no banco a cada 1s) | ${maxPending} eventos |
| Idade máxima do evento pendente mais antigo (idem) | ${fmt(maxOldestAge / 1000, 2)} s |
| Tempo para zerar o backlog após o fim da carga | ${fmt(outboxDrainSec, 2)} s |

## Consistência final

- Transações: ${totals.tx} · lançamentos no ledger: ${totals.entries} · eventos: ${totals.events}
- Invariante global (saldo = ledger em todas as wallets; 1 lançamento por transação processada): **${invariant}**

## Análise

${ANALYSIS_PLACEHOLDER}
`;
    mkdirSync('docs', { recursive: true });
    writeFileSync('docs/load-test-report.md', report);
    writeFileSync(
      'docs/load-test-results.json',
      JSON.stringify({ params: P, mixed: s1, replay: sR, hot: s2, sqs: { messages: P.sqsMessages, enqueueSec, drainSec }, lockConflicts: lock(final), retries: retries(final), outbox: { events: totals.events, maxPending, maxOldestAgeMs: maxOldestAge, drainSec: outboxDrainSec, p50: histogramPercentile(final, 'outbox_lag_ms', 50), p95: histogramPercentile(final, 'outbox_lag_ms', 95), p99: histogramPercentile(final, 'outbox_lag_ms', 99) }, invariant }, null, 2),
    );
    log('report written to docs/load-test-report.md');
    log(JSON.stringify({ mixed: { rps: s1.throughput, p50: s1.p50, p95: s1.p95, p99: s1.p99, err: s1.errorRate }, hot: { rps: s2.throughput, p50: s2.p50, p95: s2.p95, p99: s2.p99, err: s2.errorRate }, sqsMsgPerSec: P.sqsMessages / drainSec, invariant }));
    if (invariant !== 'OK') process.exitCode = 1;
  } finally {
    sampling = false;
    await Promise.all(cluster.map((i) => killHard(i).catch(() => undefined)));
    sqs.destroy();
    await orm.close(true);
  }
}

const ANALYSIS_PLACEHOLDER =
  'A análise comentada da execução de referência (com o antes e depois da otimização da outbox) está em [load-test-reference.md](load-test-reference.md). Compare os números desta execução com aqueles: a variação entre execuções na mesma máquina foi de cerca de ±10%.';
await main();
