import { Migrator } from '@mikro-orm/migrations';
import { defineConfig, type Options } from '@mikro-orm/postgresql';
import { ENTITY_SCHEMAS } from './entities';
import { migrationsList } from './migrations';

export const DEFAULT_DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/wagering_db';

export interface OrmConfigOptions {
  clientUrl?: string;
  poolMax?: number;
  debug?: boolean;
  /**
   * Runtime uses `false`: the process boots even if PostgreSQL is down (readiness reports
   * it, requests get 503) and the pool reconnects on its own. Tests/CLI keep the default.
   */
  connect?: boolean;
  /** Create the database if missing (tests / CLI only; the app never creates databases). */
  ensureDatabase?: boolean;
}

export function createOrmConfig(opts: OrmConfigOptions = {}): Options {
  return defineConfig({
    clientUrl: opts.clientUrl ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    entities: ENTITY_SCHEMAS,
    extensions: [Migrator],
    // Every unit of work must be explicit (em.fork() / em.transactional()).
    allowGlobalContext: false,
    forceUtcTimezone: true,
    debug: opts.debug ?? false,
    connect: opts.connect ?? true,
    ensureDatabase: opts.ensureDatabase ?? true,
    pool: { min: 0, max: opts.poolMax ?? 10 },
    migrations: {
      migrationsList,
      tableName: 'mikro_orm_migrations',
      transactional: true,
      allOrNothing: true,
      // MikroORM defaults to `session_replication_role = replica` during migrations,
      // which silently disables triggers and FKs. Our guarantees ARE triggers/FKs.
      disableForeignKeys: false,
      snapshot: false,
    },
  });
}
