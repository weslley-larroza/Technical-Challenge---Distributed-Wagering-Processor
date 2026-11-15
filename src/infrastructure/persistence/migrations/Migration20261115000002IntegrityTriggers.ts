import { Migration } from '@mikro-orm/migrations';

/**
 * Database-enforced behavioural invariants (they hold even if application code is wrong):
 *
 *  1. Ledger is append-only (no UPDATE / DELETE / TRUNCATE).
 *  2. Ledger chain: each entry's balance_before equals the previous entry's balance_after
 *     for that wallet (first entry starts at 0). Appends are serialised per wallet.
 *  3. At COMMIT, wallet.balance == balance_after of its latest ledger entry (0 if none).
 *     With (2) this proves by induction: wallet.balance == Σ ledger.
 *  4. Wallet: identity columns immutable, never deleted; version +1 iff balance changes
 *     (a stale "read → calculate → update" fails here — lost-update guard).
 *  5. Wager transactions: never deleted, business columns immutable, terminal states frozen.
 *  6. Outbox: payload immutable, publication irreversible. Inbox: processed is final.
 *
 * All raise SQLSTATE 23000 (integrity_constraint_violation).
 */
export class Migration20261115000002IntegrityTriggers extends Migration {
  override async up(): Promise<void> {
    // ---------------------------------------------------------------- generic
    this.addSql(`
      create function forbid_mutation() returns trigger language plpgsql as $fn$
      begin
        raise exception '% on % is forbidden', tg_op, tg_table_name
          using errcode = 'integrity_constraint_violation';
      end
      $fn$`);

    // ---------------------------------------------------------------- 1. ledger append-only
    this.addSql(`
      create trigger ledger_append_only
        before update or delete on wallet_ledger_entries
        for each row execute function forbid_mutation()`);
    this.addSql(`
      create trigger ledger_no_truncate
        before truncate on wallet_ledger_entries
        for each statement execute function forbid_mutation()`);

    // ---------------------------------------------------------------- 2. ledger chain
    this.addSql(`
      create function ledger_assert_chain() returns trigger language plpgsql as $fn$
      declare
        prev_after numeric(20,2);
      begin
        -- serialise appends per wallet even if a caller forgot to lock the wallet row
        perform 1 from wallets where id = new.wallet_id for update;

        select balance_after into prev_after
          from wallet_ledger_entries
         where wallet_id = new.wallet_id
         order by seq desc
         limit 1;

        if new.balance_before is distinct from coalesce(prev_after, 0) then
          raise exception 'ledger chain broken for wallet %: balance_before % <> previous balance_after %',
            new.wallet_id, new.balance_before, coalesce(prev_after, 0)
            using errcode = 'integrity_constraint_violation';
        end if;
        return new;
      end
      $fn$`);
    this.addSql(`
      create trigger ledger_chain
        before insert on wallet_ledger_entries
        for each row execute function ledger_assert_chain()`);

    // ---------------------------------------------------------------- 3. wallet == ledger at commit
    this.addSql(`
      create function wallet_assert_ledger_consistency() returns trigger language plpgsql as $fn$
      declare
        wid        uuid := (to_jsonb(new) ->> tg_argv[0])::uuid;
        w_balance  numeric(20,2);
        last_after numeric(20,2);
      begin
        select balance into w_balance from wallets where id = wid;
        if not found then
          return null; -- the ledger FK reports a missing wallet
        end if;

        select balance_after into last_after
          from wallet_ledger_entries
         where wallet_id = wid
         order by seq desc
         limit 1;

        if w_balance is distinct from coalesce(last_after, 0) then
          raise exception 'wallet % balance % does not match ledger balance %',
            wid, w_balance, coalesce(last_after, 0)
            using errcode = 'integrity_constraint_violation';
        end if;
        return null;
      end
      $fn$`);
    this.addSql(`
      create constraint trigger wallet_balance_matches_ledger
        after insert or update on wallets
        deferrable initially deferred
        for each row execute function wallet_assert_ledger_consistency('id')`);
    this.addSql(`
      create constraint trigger ledger_matches_wallet_balance
        after insert on wallet_ledger_entries
        deferrable initially deferred
        for each row execute function wallet_assert_ledger_consistency('wallet_id')`);

    // ---------------------------------------------------------------- 4. wallet guard
    this.addSql(`
      create function wallet_guard_update() returns trigger language plpgsql as $fn$
      begin
        if new.id <> old.id or new.player_id <> old.player_id
           or new.currency <> old.currency or new.created_at <> old.created_at then
          raise exception 'wallet % identity columns are immutable', old.id
            using errcode = 'integrity_constraint_violation';
        end if;
        if new.balance <> old.balance and new.version <> old.version + 1 then
          raise exception 'wallet % version must be % when balance changes (got %)',
            old.id, old.version + 1, new.version
            using errcode = 'integrity_constraint_violation';
        end if;
        if new.balance = old.balance and new.version <> old.version then
          raise exception 'wallet % version may only change with balance', old.id
            using errcode = 'integrity_constraint_violation';
        end if;
        return new;
      end
      $fn$`);
    this.addSql(`
      create trigger wallet_guard_update
        before update on wallets
        for each row execute function wallet_guard_update()`);
    this.addSql(`
      create trigger wallet_no_delete
        before delete on wallets
        for each row execute function forbid_mutation()`);

    // ---------------------------------------------------------------- 5. wager transaction guard
    this.addSql(`
      create function wager_tx_guard_update() returns trigger language plpgsql as $fn$
      begin
        if old.status in ('PROCESSED','REJECTED','FAILED') then
          raise exception 'wager transaction % is terminal (%)', old.id, old.status
            using errcode = 'integrity_constraint_violation';
        end if;
        if old.status = 'PENDING_REFERENCE' and new.status = 'PENDING' then
          raise exception 'wager transaction % cannot go back to PENDING', old.id
            using errcode = 'integrity_constraint_violation';
        end if;
        if (new.id, new.provider_id, new.external_transaction_id, new.idempotency_key, new.payload_hash,
            new.wallet_id, new.player_id, new.round_id, new.game_id, new.kind, new.amount, new.currency,
            new.reference_external_transaction_id, new.created_at)
           is distinct from
           (old.id, old.provider_id, old.external_transaction_id, old.idempotency_key, old.payload_hash,
            old.wallet_id, old.player_id, old.round_id, old.game_id, old.kind, old.amount, old.currency,
            old.reference_external_transaction_id, old.created_at) then
          raise exception 'wager transaction % business columns are immutable', old.id
            using errcode = 'integrity_constraint_violation';
        end if;
        return new;
      end
      $fn$`);
    this.addSql(`
      create trigger wager_tx_guard_update
        before update on wager_transactions
        for each row execute function wager_tx_guard_update()`);
    this.addSql(`
      create trigger wager_tx_no_delete
        before delete on wager_transactions
        for each row execute function forbid_mutation()`);

    // ---------------------------------------------------------------- 6. outbox / inbox
    this.addSql(`
      create function outbox_guard_update() returns trigger language plpgsql as $fn$
      begin
        if (new.id, new.aggregate_id, new.event_type, new.payload, new.occurred_at)
           is distinct from (old.id, old.aggregate_id, old.event_type, old.payload, old.occurred_at) then
          raise exception 'outbox message % content is immutable', old.id
            using errcode = 'integrity_constraint_violation';
        end if;
        if old.published_at is not null then
          raise exception 'outbox message % is already published', old.id
            using errcode = 'integrity_constraint_violation';
        end if;
        return new;
      end
      $fn$`);
    this.addSql(`
      create trigger outbox_guard_update
        before update on outbox_messages
        for each row execute function outbox_guard_update()`);

    this.addSql(`
      create function inbox_guard_update() returns trigger language plpgsql as $fn$
      begin
        if new.payload_hash <> old.payload_hash or old.processed_at is not null then
          raise exception 'inbox message %/% is immutable once processed', old.consumer_name, old.message_id
            using errcode = 'integrity_constraint_violation';
        end if;
        return new;
      end
      $fn$`);
    this.addSql(`
      create trigger inbox_guard_update
        before update on inbox_messages
        for each row execute function inbox_guard_update()`);
  }

  override async down(): Promise<void> {
    this.addSql('drop trigger if exists inbox_guard_update on inbox_messages');
    this.addSql('drop function if exists inbox_guard_update()');
    this.addSql('drop trigger if exists outbox_guard_update on outbox_messages');
    this.addSql('drop function if exists outbox_guard_update()');
    this.addSql('drop trigger if exists wager_tx_no_delete on wager_transactions');
    this.addSql('drop trigger if exists wager_tx_guard_update on wager_transactions');
    this.addSql('drop function if exists wager_tx_guard_update()');
    this.addSql('drop trigger if exists wallet_no_delete on wallets');
    this.addSql('drop trigger if exists wallet_guard_update on wallets');
    this.addSql('drop function if exists wallet_guard_update()');
    this.addSql('drop trigger if exists ledger_matches_wallet_balance on wallet_ledger_entries');
    this.addSql('drop trigger if exists wallet_balance_matches_ledger on wallets');
    this.addSql('drop function if exists wallet_assert_ledger_consistency()');
    this.addSql('drop trigger if exists ledger_chain on wallet_ledger_entries');
    this.addSql('drop function if exists ledger_assert_chain()');
    this.addSql('drop trigger if exists ledger_no_truncate on wallet_ledger_entries');
    this.addSql('drop trigger if exists ledger_append_only on wallet_ledger_entries');
    this.addSql('drop function if exists forbid_mutation()');
  }
}
