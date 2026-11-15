/** `bun run sqs:setup` — idempotently creates the FIFO queues (same as the LocalStack init script). */
import { loadConfig } from '../../bootstrap/config';
import { createSqsClient, ensureQueues } from './sqs';

const config = loadConfig();
const client = createSqsClient(config.sqs);
await ensureQueues(
  client,
  { wager: config.sqs.wagerQueue, wagerDlq: config.sqs.wagerDlq, events: config.sqs.eventsQueue },
  config.sqs.maxAttempts,
);
console.log(`queues ready: ${config.sqs.wagerQueue}, ${config.sqs.wagerDlq}, ${config.sqs.eventsQueue}`);
client.destroy();
