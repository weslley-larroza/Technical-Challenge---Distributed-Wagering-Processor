import 'reflect-metadata';
import { loadConfig } from './bootstrap/config';
import { createContainer } from './bootstrap/container';
import { createHttpApp } from './interfaces/http/http-app';

const config = loadConfig();
const container = await createContainer(config);
const app = await createHttpApp(container);
await app.listen(config.port);
container.logger.info('http server listening', { port: config.port });

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  container.logger.info('shutdown requested', { signal });
  // Stop accepting connections and let in-flight requests finish, then release the pool.
  await app.close();
  await container.close();
  container.logger.info('shutdown complete');
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
