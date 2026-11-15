import type { Logger } from '../../application/ports/system';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/**
 * Keys that must never reach the logs: credentials and full financial payloads.
 * Identifiers (walletId, transactionId, …) are allowed — they are what makes logs useful.
 */
const REDACTED_KEYS = new Set([
  'authorization',
  'password',
  'token',
  'accesstoken',
  'payload',
  'body',
  'money',
  'balance',
  'amount',
  'initialbalance',
]);

function redact(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    out[k] = REDACTED_KEYS.has(k.toLowerCase()) ? '[redacted]' : v instanceof Error ? serializeError(v) : v;
  }
  return out;
}

function serializeError(e: Error): Record<string, unknown> {
  const code = (e as { code?: unknown }).code;
  return { type: e.name, message: e.message, ...(code ? { code } : {}) };
}

/** One JSON object per line on stdout (12-factor); base fields are merged into every line. */
export class JsonLogger implements Logger {
  constructor(
    private readonly level: LogLevel = 'info',
    private readonly base: Record<string, unknown> = {},
    private readonly write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  ) {}

  child(fields: Record<string, unknown>): JsonLogger {
    return new JsonLogger(this.level, { ...this.base, ...fields }, this.write);
  }

  debug(message: string, fields: Record<string, unknown> = {}): void {
    this.log('debug', message, fields);
  }
  info(message: string, fields: Record<string, unknown> = {}): void {
    this.log('info', message, fields);
  }
  warn(message: string, fields: Record<string, unknown> = {}): void {
    this.log('warn', message, fields);
  }
  error(message: string, fields: Record<string, unknown> = {}): void {
    this.log('error', message, fields);
  }

  private log(level: Exclude<LogLevel, 'silent'>, message: string, fields: Record<string, unknown>): void {
    if (ORDER[level] < ORDER[this.level]) return;
    this.write(
      JSON.stringify({ ts: new Date().toISOString(), level, msg: message, ...this.base, ...redact(fields) }),
    );
  }
}
