import { Migration } from '@mikro-orm/migrations';

/**
 * Tables, CHECK / UNIQUE / FK constraints and indexes.
 * Behavioural guarantees that cannot be expressed declaratively (append-only ledger,
 * ledger chain, wallet == ledger at commit, terminal states) live in the next migration.
 *
 * FKs are DEFERRABLE INITIALLY DEFERRED: integrity is checked at COMMIT, so the ORM's
 * insert order inside one unit of work does not matter.
 *
 * NOTE: no "?" characters in SQL here — knex would treat them as bindings.
 */
export class Migration20261115000001InitialSchema extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table wallets (
        id          uuid           primary key,
        player_id   uuid           not null,
        currency    char(3)        not null,
        balance     numeric(20,2)  not null,
        version     integer        not null,
        created_at  timestamptz    not null,
        updated_at  timestamptz    not null,
        constraint wallets_currency_format_chk     check (currency ~ '^[A-Z]{3}$'),
        constraint wallets_balance_non_negative_chk check (balance >= 0),
        constraint wallets_version_positive_chk    check (version >= 1),
        constraint wallets_player_currency_uq      unique (player_id, currency),
        -- target of the ledger composite FK: a ledger line can only use its wallet's currency
        constraint wallets_id_currency_uq          unique (id, currency)
      )`);

    this.addSql(`
      create table wager_transactions (
        id                                 uuid           primary key,
        provider_id                        varchar(128)   not null,
        external_transaction_id            varchar(128)   not null,
        idempotency_key                    varchar(256)   not null,
        payload_hash                       varchar(80)    not null,
        wallet_id                          uuid           not null,
        player_id                          uuid           not null,
        round_id                           varchar(128)   not null,
        game_id                            varchar(128)   not null,
        kind                               varchar(16)    not null,
        amount                             numeric(20,2)  not null,
        currency                           char(3)        not null,
        reference_external_transaction_id  varchar(128),
        reference_transaction_id           uuid,
        status                             varchar(20)    not null,
        failure_code                       varchar(64),
        balance_after_amount               numeric(20,2),
        balance_after_currency             char(3),
        reference_attempts                 integer        not null default 0,
        next_reference_check_at            timestamptz,
        processed_at                       timestamptz,
        created_at                         timestamptz    not null,
        updated_at                         timestamptz    not null,

        constraint wager_tx_wallet_fk foreign key (wallet_id)
          references wallets (id) deferrable initially deferred,
        constraint wager_tx_reference_fk foreign key (reference_transaction_id)
          references wager_transactions (id) deferrable initially deferred,

        -- idempotency: one row per provider operation and per provider idempotency key
        constraint wager_tx_provider_external_uq        unique (provider_id, external_transaction_id),
        constraint wager_tx_provider_idempotency_key_uq unique (provider_id, idempotency_key),
        -- target of the ledger composite FK (ledger line must match its transaction exactly)
        constraint wager_tx_ledger_target_uq            unique (id, wallet_id, currency, amount),

        constraint wager_tx_kind_chk check (kind in ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        constraint wager_tx_status_chk check (status in ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        constraint wager_tx_amount_positive_chk check (amount > 0),
        constraint wager_tx_currency_format_chk check (currency ~ '^[A-Z]{3}$'),
        constraint wager_tx_reference_attempts_chk check (reference_attempts >= 0),
        constraint wager_tx_balance_after_chk check (
          (balance_after_amount is null and balance_after_currency is null)
          or (balance_after_amount >= 0 and balance_after_currency is not null)),
        -- OPENING is internal-only, and the internal provider only emits OPENING
        constraint wager_tx_opening_internal_chk check ((kind = 'OPENING') = (provider_id = 'internal')),
        constraint wager_tx_reversal_requires_reference_chk check (
          kind not in ('REFUND','ROLLBACK') or reference_external_transaction_id is not null),
        constraint wager_tx_failure_code_chk check ((status in ('REJECTED','FAILED')) = (failure_code is not null)),
        constraint wager_tx_terminal_processed_at_chk check (
          (status in ('PROCESSED','REJECTED','FAILED')) = (processed_at is not null)),
        constraint wager_tx_pending_reference_chk check (
          (status = 'PENDING_REFERENCE') = (next_reference_check_at is not null)),
        -- a resolved reference exists only on PROCESSED rows, and every PROCESSED row with an
        -- external reference has it resolved
        constraint wager_tx_reference_resolved_chk check (
          reference_transaction_id is null or status = 'PROCESSED'),
        constraint wager_tx_processed_reference_chk check (
          status <> 'PROCESSED'
          or (reference_external_transaction_id is null) = (reference_transaction_id is null))
      )`);

    // A transaction can be reversed (REFUND or ROLLBACK) at most once — enforced by the DB,
    // so two concurrent reversals cannot both commit.
    this.addSql(`
      create unique index wager_tx_single_reversal_uq
        on wager_transactions (reference_transaction_id)
        where status = 'PROCESSED' and kind in ('REFUND','ROLLBACK')`);
    // Scheduled worker: "which pending references are due?"
    this.addSql(`
      create index wager_tx_pending_reference_due_idx
        on wager_transactions (next_reference_check_at)
        where status = 'PENDING_REFERENCE'`);
    // Reference resolution happens by (provider_id, external_transaction_id) — covered by the unique.
    this.addSql(`create index wager_tx_wallet_created_idx on wager_transactions (wallet_id, created_at)`);

    this.addSql(`
      create table wallet_ledger_entries (
        id              uuid           primary key,
        -- monotonic append order: stable cursor for pagination and chain checks
        seq             bigint         generated always as identity,
        wallet_id       uuid           not null,
        transaction_id  uuid           not null,
        direction       varchar(6)     not null,
        amount          numeric(20,2)  not null,
        currency        char(3)        not null,
        balance_before  numeric(20,2)  not null,
        balance_after   numeric(20,2)  not null,
        created_at      timestamptz    not null,

        constraint ledger_seq_uq unique (seq),
        constraint ledger_wallet_fk foreign key (wallet_id, currency)
          references wallets (id, currency) deferrable initially deferred,
        constraint ledger_transaction_fk foreign key (transaction_id, wallet_id, currency, amount)
          references wager_transactions (id, wallet_id, currency, amount) deferrable initially deferred,
        constraint ledger_one_entry_per_transaction_wallet_uq unique (transaction_id, wallet_id),
        constraint ledger_direction_chk check (direction in ('DEBIT','CREDIT')),
        constraint ledger_amount_positive_chk check (amount > 0),
        constraint ledger_balances_non_negative_chk check (balance_before >= 0 and balance_after >= 0),
        constraint ledger_arithmetic_chk check (
          balance_after = case direction when 'CREDIT' then balance_before + amount
                                         else balance_before - amount end)
      )`);
    this.addSql(`create index ledger_wallet_seq_idx on wallet_ledger_entries (wallet_id, seq)`);

    this.addSql(`
      create table inbox_messages (
        consumer_name  varchar(128)  not null,
        message_id     varchar(256)  not null,
        payload_hash   varchar(80)   not null,
        received_at    timestamptz   not null,
        processed_at   timestamptz,
        constraint inbox_messages_pk primary key (consumer_name, message_id)
      )`);

    this.addSql(`
      create table outbox_messages (
        id               uuid          primary key,
        aggregate_id     varchar(128)  not null,
        event_type       varchar(64)   not null,
        payload          jsonb         not null,
        occurred_at      timestamptz   not null,
        attempts         integer       not null default 0,
        next_attempt_at  timestamptz,
        published_at     timestamptz,
        last_error       text,
        constraint outbox_attempts_chk check (attempts >= 0),
        constraint outbox_schedule_chk check ((published_at is null) = (next_attempt_at is not null))
      )`);
    // Publishers claim due rows with FOR UPDATE SKIP LOCKED ordered by next_attempt_at.
    this.addSql(`
      create index outbox_due_idx on outbox_messages (next_attempt_at)
        where published_at is null`);
  }

  override async down(): Promise<void> {
    this.addSql('drop table if exists outbox_messages');
    this.addSql('drop table if exists inbox_messages');
    this.addSql('drop table if exists wallet_ledger_entries');
    this.addSql('drop table if exists wager_transactions');
    this.addSql('drop table if exists wallets');
  }
}
