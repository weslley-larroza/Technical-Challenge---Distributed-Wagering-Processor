/**
 * Migration CLI.
 *   bun run migration:up        apply pending migrations
 *   bun run migration:down      revert the last migration
 *   bun run migration:status    list executed / pending
 */
import { MikroORM } from '@mikro-orm/postgresql';
import { createOrmConfig } from './mikro-orm.config';

const command = process.argv[2] ?? 'up';
const orm = await MikroORM.init(createOrmConfig());
const migrator = orm.getMigrator();

try {
  switch (command) {
    case 'up': {
      const applied = await migrator.up();
      console.log(applied.length ? `applied: ${applied.map((m) => m.name).join(', ')}` : 'nothing to apply');
      break;
    }
    case 'down': {
      const reverted = await migrator.down();
      console.log(reverted.length ? `reverted: ${reverted.map((m) => m.name).join(', ')}` : 'nothing to revert');
      break;
    }
    case 'status': {
      const executed = await migrator.getExecutedMigrations();
      const pending = await migrator.getPendingMigrations();
      console.log('executed:', executed.map((m) => m.name));
      console.log('pending: ', pending.map((m) => m.name));
      break;
    }
    default:
      console.error(`unknown command "${command}" (use up | down | status)`);
      process.exitCode = 1;
  }
} finally {
  await orm.close(true);
}
