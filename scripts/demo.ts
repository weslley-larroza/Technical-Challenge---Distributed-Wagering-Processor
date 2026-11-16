/**
 * Guided, narrated walkthrough against a RUNNING instance — `bun run demo`.
 *
 *   bun run infra:up && bun run migration:up && bun run start     (other terminal)
 *   bun run demo                                                   (BASE_URL=http://localhost:3000)
 *
 * Every step prints the request, the response and ✔/✘ against the expected outcome.
 * Exit code 1 if any expectation fails.
 */
import { randomUUID } from 'node:crypto';
import { GetQueueAttributesCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { loadConfig } from '../src/bootstrap/config';
import { createSqsClient, QueueUrlResolver } from '../src/infrastructure/messaging/sqs';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const TOKEN = process.env.DEMO_TOKEN; // optional bearer token when AUTH_MODE=oidc
let failures = 0;
let step = 0;

const c = { dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', cyan: '\x1b[36m', reset: '\x1b[0m' };
const title = (t: string) => console.log(`\n${c.bold}${c.cyan}── ${t}${c.reset}`);
const say = (t: string) => console.log(`${c.dim}   ${t}${c.reset}`);

function check(ok: boolean, label: string): void {
  if (!ok) failures += 1;
  console.log(`   ${ok ? `${c.green}✔` : `${c.red}✘`} ${label}${c.reset}`);
}

async function http(method: string, path: string, body?: unknown, key?: string): Promise<{ status: number; body: any }> {
  step += 1;
  const shown = body ? ` ${JSON.stringify(body)}` : '';
  console.log(`${c.bold}▶ ${step}. ${method} ${path}${key ? `  [Idempotency-Key: ${key}]` : ''}${c.reset}${c.dim}${shown.length > 160 ? `${shown.slice(0, 157)}...` : shown}${c.reset}`);
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(key ? { 'idempotency-key': key } : {}),
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const parsed = text.startsWith('{') ? JSON.parse(text) : text;
  console.log(`   ← ${res.status} ${typeof parsed === 'string' ? '' : JSON.stringify(parsed)}`);
  return { status: res.status, body: parsed };
}

async function wallet(amount: string) {
  const r = await http('POST', '/wallets', { playerId: randomUUID(), initialBalance: { amount, currency: 'BRL' } });
  check(r.status === 201 && r.body.version === 1, `201, version 1, balance ${amount}`);
  return r.body as { id: string; playerId: string };
}

function tx(w: { id: string; playerId: string }, kind: string, amount: string, extra: Record<string, unknown> = {}) {
  const externalTransactionId = (extra.externalTransactionId as string) ?? `demo-${randomUUID().slice(0, 8)}`;
  return {
    key: `provider-a:${externalTransactionId}`,
    body: {
      providerId: 'provider-a',
      externalTransactionId,
      playerId: w.playerId,
      walletId: w.id,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind,
      money: { amount, currency: 'BRL' },
      ...extra,
    },
  };
}

const submit = (t: ReturnType<typeof tx>) => http('POST', '/wagering/transactions', t.body, t.key);

async function main() {
  title('0. Health');
  const ready = await http('GET', '/health/ready');
  check(ready.status === 200, 'PostgreSQL e SQS alcançáveis');
  if (ready.status !== 200) {
    console.log(`${c.red}   A aplicação não está pronta em ${BASE}. Rode: bun run infra:up && bun run migration:up && bun run start${c.reset}`);
    process.exit(1);
  }

  title('1. Wallet com saldo inicial → OPENING + lançamento CREDIT na mesma transação SQL');
  const w = await wallet('100.00');
  const ledger0 = await http('GET', `/wallets/${w.id}/ledger`);
  check(ledger0.body.entries?.length === 1 && ledger0.body.entries[0].direction === 'CREDIT', 'ledger: 1 CREDIT 0.00 → 100.00');
  const dup = await http('POST', '/wallets', { playerId: w.playerId, initialBalance: { amount: '1.00', currency: 'BRL' } });
  check(dup.status === 409 && dup.body.error.code === 'WALLET_ALREADY_EXISTS', '409: uma wallet por player + moeda');

  title('2. Idempotência');
  const bet1 = tx(w, 'BET', '25.00');
  const r1 = await submit(bet1);
  check(r1.status === 200 && r1.body.balance.amount === '75.00' && r1.body.idempotentReplay === false, '200 PROCESSED, saldo 75.00');
  await submit(tx(w, 'BET', '10.00'));
  say('o saldo agora é 65.00 — reenviando a PRIMEIRA aposta:');
  const replay = await submit(bet1);
  check(
    replay.status === 200 && replay.body.idempotentReplay === true && replay.body.transactionId === r1.body.transactionId && replay.body.balance.amount === '75.00',
    'replay: mesmo transactionId, idempotentReplay=true, saldo OBSERVADO NA ÉPOCA (75.00)',
  );
  const conflict = await http('POST', '/wagering/transactions', { ...bet1.body, money: { amount: '26.00', currency: 'BRL' } }, bet1.key);
  check(conflict.status === 409 && conflict.body.error.code === 'IDEMPOTENCY_KEY_REUSED', '409: mesma key com payload diferente é conflito, não replay');
  const noKey = await http('POST', '/wagering/transactions', tx(w, 'BET', '1.00').body);
  check(noKey.status === 400, '400: Idempotency-Key obrigatório');

  title('3. Validação e regras de negócio');
  const asNumber = await submit({ ...tx(w, 'BET', '1.00'), body: { ...tx(w, 'BET', '1.00').body, money: { amount: 1 as unknown as string, currency: 'BRL' } } });
  check(asNumber.status === 400, '400: dinheiro como número JSON é recusado');
  const opening = await submit(tx(w, 'OPENING', '1.00'));
  check(opening.status === 400, '400: OPENING é interno');
  const broke = await submit(tx(w, 'BET', '1000.00'));
  check(broke.status === 422 && broke.body.failureCode === 'INSUFFICIENT_FUNDS', '422 INSUFFICIENT_FUNDS (persistido, auditável, replayable)');
  const usd = await submit(tx(w, 'BET', '1.00', { money: { amount: '1.00', currency: 'USD' } }));
  check(usd.status === 422 && usd.body.failureCode === 'CURRENCY_MISMATCH', '422 CURRENCY_MISMATCH');
  const loss = await submit(tx(w, 'LOSS', '5.00'));
  check(loss.status === 200 && loss.body.balance.amount === '65.00', 'LOSS: PROCESSED sem mexer no saldo');

  title('4. Cenário obrigatório da seção 8 — 100.00 e duas apostas de 80.00 SIMULTÂNEAS');
  const w8 = await wallet('100.00');
  const [a, b] = await Promise.all([submit(tx(w8, 'BET', '80.00')), submit(tx(w8, 'BET', '80.00'))]);
  check([a.status, b.status].sort().join(',') === '200,422', 'exatamente uma 200 e uma 422');
  const w8after = await http('GET', `/wallets/${w8.id}`);
  check(w8after.body.balance.amount === '20.00', 'saldo final 20.00');
  const l8 = await http('GET', `/wallets/${w8.id}/ledger`);
  check(l8.body.entries.filter((e: { direction: string }) => e.direction === 'DEBIT').length === 1, 'exatamente UM débito no ledger');

  title('5. Referência fora de ordem — ROLLBACK chega ANTES da BET');
  const wo = await wallet('100.00');
  const lateBet = tx(wo, 'BET', '30.00');
  const rollback = tx(wo, 'ROLLBACK', '30.00', { referenceExternalTransactionId: lateBet.body.externalTransactionId });
  const pending = await submit(rollback);
  check(pending.status === 202 && pending.body.status === 'PENDING_REFERENCE', '202 PENDING_REFERENCE');
  const betNow = await submit(lateBet);
  check(betNow.status === 200 && betNow.body.balance.amount === '70.00', 'a BET chega e é processada (70.00)');
  const resolved = await http('GET', `/wagering/transactions/${pending.body.transactionId}`);
  check(resolved.body.status === 'PROCESSED' && resolved.body.balanceAfter.amount === '100.00', 'o ROLLBACK foi liquidado NO MESMO COMMIT da BET (cascata) → 100.00');
  const refund = await submit(tx(wo, 'REFUND', '30.00', { referenceExternalTransactionId: lateBet.body.externalTransactionId }));
  check(refund.status === 422 && refund.body.failureCode === 'ALREADY_REVERSED', '422 ALREADY_REVERSED: uma reversão por transação');

  title('6. Mesma operação pela FILA (mesmo use case) + redelivery');
  const config = loadConfig();
  const sqs = createSqsClient(config.sqs);
  try {
    const queueUrl = await new QueueUrlResolver(sqs, config.sqs.wagerQueue).get();
    const q = tx(w, 'BET', '5.00');
    const messageId = `msg-${randomUUID()}`;
    const body = JSON.stringify({ messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data: { ...q.body, idempotencyKey: q.key } });
    for (const dedup of ['a', 'b']) {
      // two deliveries of the SAME message (broker dedup bypassed on purpose)
      await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: body, MessageGroupId: w.id, MessageDeduplicationId: `${messageId}-${dedup}` }));
    }
    say(`2 entregas da mensagem ${messageId} enviadas para ${config.sqs.wagerQueue}; aguardando o consumidor...`);
    let viaQueue: { status: number; body: any } | undefined;
    for (let i = 0; i < 40; i++) {
      const res = await fetch(`${BASE}/providers/provider-a/wagering/transactions/${q.body.externalTransactionId}`, { headers: TOKEN ? { authorization: `Bearer ${TOKEN}` } : {} });
      if (res.status === 200) {
        viaQueue = { status: 200, body: await res.json() };
        break;
      }
      await Bun.sleep(250);
    }
    check(viaQueue?.body.status === 'PROCESSED', 'processada pelo consumidor SQS');
    await Bun.sleep(1_500);
    const wq = await http('GET', `/wallets/${w.id}`);
    check(wq.body.balance.amount === '60.00', 'redelivery deduplicado pela inbox: debitou UMA vez (65.00 → 60.00)');
    const depth = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] }));
    say(`fila: visíveis=${depth.Attributes?.ApproximateNumberOfMessages} em voo=${depth.Attributes?.ApproximateNumberOfMessagesNotVisible} (ack só após commit)`);
  } finally {
    sqs.destroy();
  }

  title('7. Ledger paginado, reconciliação e métricas');
  const page = await http('GET', `/wallets/${w.id}/ledger?limit=2`);
  check(page.body.entries.length === 2 && typeof page.body.nextCursor === 'string', 'página com cursor opaco');
  const next = await http('GET', `/wallets/${w.id}/ledger?limit=2&cursor=${page.body.nextCursor}`);
  check(next.status === 200 && next.body.entries[0].balanceBefore.amount === page.body.entries[1].balanceAfter.amount, 'próxima página encadeia (balanceBefore = balanceAfter anterior)');
  const rec = await http('POST', `/wallets/${w.id}/reconciliation`);
  check(rec.body.consistent === true && rec.body.difference.amount === '0.00', 'saldo materializado == saldo reconstruído pelo ledger');
  const metrics = await (await fetch(`${BASE}/metrics`)).text();
  for (const name of ['wager_transactions_total', 'idempotent_replays_total', 'idempotency_conflicts_total', 'outbox_pending_messages']) {
    const line = metrics.split('\n').find((l) => l.startsWith(name));
    say(line ?? `${name} (ausente)`);
  }

  console.log(`\n${failures === 0 ? `${c.green}${c.bold}✔ todas as verificações passaram` : `${c.red}${c.bold}✘ ${failures} verificação(ões) falharam`}${c.reset}`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
