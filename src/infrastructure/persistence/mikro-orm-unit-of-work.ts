import { IsolationLevel } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import {
  type Repositories,
  TransientPersistenceError,
  type TransientReason,
  UniqueViolationError,
  type UnitOfWork,
  type UnitOfWorkOptions,
} from '../../application/ports/persistence';
import { withChildSpan } from '../observability/tracing';
import { createRepositories } from './mikro-orm-repositories';

export interface MikroOrmUnitOfWorkOptions {
  /** Max wait for a row lock before giving up (→ transient, retried). */
  lockTimeoutMs?: number;
  /** Hard cap for any statement inside a unit of work. */
  statementTimeoutMs?: number;
}

/**
 * One `run` = one forked EntityManager (fresh Identity Map) inside `em.transactional()`:
 * BEGIN … work … flush … COMMIT, or ROLLBACK on any error. PostgreSQL errors are
 * translated into the application's persistence error vocabulary here, so no
 * MikroORM / pg type leaks upward.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  private readonly lockTimeoutMs: number;
  private readonly statementTimeoutMs: number;

  constructor(
    private readonly orm: MikroORM,
    options: MikroOrmUnitOfWorkOptions = {},
  ) {
    this.lockTimeoutMs = Math.trunc(options.lockTimeoutMs ?? 5_000);
    this.statementTimeoutMs = Math.trunc(options.statementTimeoutMs ?? 15_000);
  }

  run<T>(work: (repositories: Repositories) => Promise<T>, options: UnitOfWorkOptions = {}): Promise<T> {
    // one span per SQL transaction (retries of a use case show up as sibling spans)
    return withChildSpan(
      'db.transaction',
      { attributes: { 'db.system': 'postgresql', 'db.transaction.isolation': options.isolation ?? 'read-committed' } },
      () => this.runInTransaction(work, options),
    );
  }

  private async runInTransaction<T>(work: (repositories: Repositories) => Promise<T>, options: UnitOfWorkOptions): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(
        async (em) => {
          // integers validated above; SET LOCAL does not accept bind parameters
          await em.execute(
            `set local lock_timeout = ${this.lockTimeoutMs}; set local statement_timeout = ${this.statementTimeoutMs}`,
          );
          return work(createRepositories(em));
        },
        {
          isolationLevel:
            options.isolation === 'repeatable-read' ? IsolationLevel.REPEATABLE_READ : IsolationLevel.READ_COMMITTED,
        },
      );
    } catch (error) {
      throw translatePersistenceError(error);
    }
  }
}

const TRANSIENT_SQLSTATE: Readonly<Record<string, TransientReason>> = {
  '40P01': 'deadlock',
  '40001': 'serialization',
  '55P03': 'lock-timeout',
  '57014': 'lock-timeout', // statement_timeout
  '57P01': 'connection', // admin_shutdown
  '57P03': 'connection', // cannot_connect_now
  '53300': 'connection', // too_many_connections
};

const TRANSIENT_NODE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN']);

/** Exported for tests. Leaves non-database errors (domain / application) untouched. */
export function translatePersistenceError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const e = error as Error & { code?: string; sqlState?: string; constraint?: string };
  const code = e.code ?? e.sqlState;

  if (code === '23505') {
    const constraint = e.constraint ?? /unique constraint "([^"]+)"/.exec(e.message)?.[1];
    return new UniqueViolationError(constraint, { cause: error });
  }
  if (code && TRANSIENT_SQLSTATE[code]) {
    return new TransientPersistenceError(TRANSIENT_SQLSTATE[code]!, { cause: error });
  }
  if ((code && (code.startsWith('08') || TRANSIENT_NODE_CODES.has(code))) || /Timeout acquiring a connection/i.test(e.message)) {
    return new TransientPersistenceError('connection', { cause: error });
  }
  return error;
}
