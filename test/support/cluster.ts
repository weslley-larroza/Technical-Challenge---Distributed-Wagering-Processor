import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Subprocess } from 'bun';
import type { MikroORM } from '@mikro-orm/postgresql';

/**
 * A REAL application instance: a separate OS process running src/main.ts (HTTP +
 * SQS consumer + outbox publisher + pending-reference worker), exactly as in production.
 */
export interface Instance {
  id: string;
  base: string;
  logPath: string;
  process: Subprocess;
}

let portSeed = 41_000 + Math.floor(Math.random() * 2_000);

export async function spawnInstance(id: string, env: Record<string, string>): Promise<Instance> {
  const port = portSeed++;
  const logPath = join(tmpdir(), `wagering-${id}-${Date.now()}.log`);
  const proc = Bun.spawn([process.execPath, 'src/main.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, ...env, PORT: String(port), INSTANCE_ID: id },
    stdout: Bun.file(logPath),
    stderr: Bun.file(`${logPath}.err`),
  });
  const instance = { id, base: `http://127.0.0.1:${port}`, logPath, process: proc };
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${instance.base}/health/ready`)).ok) return instance;
    } catch {
      // not listening yet
    }
    if (proc.exitCode !== null) throw new Error(`${id} exited early (${proc.exitCode}); see ${logPath}.err`);
    if (Date.now() > deadline) throw new Error(`${id} not ready in time; see ${logPath}`);
    await Bun.sleep(100);
  }
}

/** SIGKILL: no shutdown hook runs — simulates a crash / OOM kill. */
export async function killHard(instance: Instance): Promise<void> {
  instance.process.kill(9);
  await instance.process.exited;
}

export async function countLogLines(instance: Instance, message: string): Promise<number> {
  const text = await Bun.file(instance.logPath).text().catch(() => '');
  return text.split('\n').filter((l) => l.includes(`"msg":"${message}"`)).length;
}

/**
 * The final invariant of the challenge, checked over the WHOLE database:
 *  1. every wallet balance == balance rebuilt from its ledger
 *  2. every PROCESSED balance-affecting transaction has exactly one ledger entry,
 *     every other transaction has none
 */
export async function expectGlobalInvariant(orm: MikroORM): Promise<void> {
  const em = orm.em.fork();
  const drift = await em.execute(`
    select w.id, w.balance,
           coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0) as ledger
      from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
     group by w.id, w.balance
    having w.balance <> coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0)`);
  if (drift.length) throw new Error(`balance != ledger for ${JSON.stringify(drift)}`);

  const orphan = await em.execute(`
    select t.id, t.status, t.kind, count(l.id)::int as entries
      from wager_transactions t left join wallet_ledger_entries l on l.transaction_id = t.id
     group by t.id, t.status, t.kind
    having (t.status = 'PROCESSED' and t.kind <> 'LOSS') <> (count(l.id) = 1)`);
  if (orphan.length) throw new Error(`transaction/ledger mismatch for ${JSON.stringify(orphan.slice(0, 5))}`);
}
