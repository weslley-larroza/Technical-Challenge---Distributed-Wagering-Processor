import { Migration } from '@mikro-orm/migrations';

/**
 * W3C `traceparent` of the request that produced each outbox event, captured at insert
 * time. The publisher runs later, in another process maybe: it links its span to this
 * context and forwards it as an SQS message attribute, so the trace crosses the async hop.
 * Transport metadata only — not part of the immutable event content checked by the guard.
 */
export class Migration20261116000005OutboxTraceParent extends Migration {
  override async up(): Promise<void> {
    this.addSql('alter table outbox_messages add column trace_parent varchar(64)');
  }

  override async down(): Promise<void> {
    this.addSql('alter table outbox_messages drop column if exists trace_parent');
  }
}
