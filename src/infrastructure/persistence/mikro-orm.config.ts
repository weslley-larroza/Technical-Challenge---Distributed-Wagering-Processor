import { Migrator } from '@mikro-orm/migrations';
import { defineConfig, type Options } from '@mikro-orm/postgresql';
import { ENTITY_SCHEMAS } from './entities';
import { migrationsList } from './migrations';

export const DEFAULT_DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/wagering_db';

export interface OrmConfigOptions {
  clientUrl?: string;
  poolMax?: number;
  debug?: boolean;
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
