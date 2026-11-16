import { Migration } from '@mikro-orm/migrations';

/**
 * Double-entry journal (see src/domain/ledger/double-entry.ts).
 *
 * Guarantees enforced HERE, at COMMIT (deferred constraint triggers):
 *   - every journal transaction is balanced: Σ debits = Σ credits, ≥ 2 legs, one currency
 *   - every wallet ledger entry has a journal whose PLAYER_WALLET leg mirrors it exactly
 *     (same wallet, direction and amount), and no journal exists without one
 *   ⇒ the sum over all accounts is always zero, and each player account equals its wallet.
 * Postings and accounts are append-only.
 *
 * Existing data is backfilled with the same deterministic ids the application derives
 * (md5('account:' || code)::uuid), so the migration is safe on a populated database.
 */
export class Migration20261116000004DoubleEntryJournal extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table ledger_accounts (
        id          uuid          primary key,
        code        varchar(200)  not null,
        kind        varchar(20)   not null,
        currency    char(3)       not null,
        wallet_id   uuid,
        created_at  timestamptz   not null,
        constraint ledger_accounts_code_uq unique (code),
        constraint ledger_accounts_wallet_uq unique (wallet_id),
        constraint ledger_accounts_id_currency_uq unique (id, currency),
        constraint ledger_accounts_kind_chk check (kind in ('PLAYER_WALLET','PROVIDER_GAMING','FUNDING')),
        constraint ledger_accounts_wallet_kind_chk check ((kind = 'PLAYER_WALLET') = (wallet_id is not null)),
        constraint ledger_accounts_wallet_fk foreign key (wallet_id, currency)
          references wallets (id, currency) deferrable initially deferred
      )`);

    this.addSql(`
      create table journal_postings (
        id              uuid           primary key,
        seq             bigint         generated always as identity,
        transaction_id  uuid           not null,
        account_id      uuid           not null,
        direction       varchar(6)     not null,
        amount          numeric(20,2)  not null,
        currency        char(3)        not null,
        created_at      timestamptz    not null,
        constraint journal_postings_seq_uq unique (seq),
        constraint journal_postings_tx_fk foreign key (transaction_id)
          references wager_transactions (id) deferrable initially deferred,
        -- a leg can only be booked in its account's currency
        constraint journal_postings_account_fk foreign key (account_id, currency)
          references ledger_accounts (id, currency) deferrable initially deferred,
        constraint journal_postings_one_leg_per_account_uq unique (transaction_id, account_id),
        constraint journal_postings_direction_chk check (direction in ('DEBIT','CREDIT')),
        constraint journal_postings_amount_positive_chk check (amount > 0)
      )`);
    this.addSql('create index journal_postings_account_seq_idx on journal_postings (account_id, seq)');

    this.addSql(`
      create trigger journal_postings_append_only
        before update or delete on journal_postings
        for each row execute function forbid_mutation()`);
    this.addSql(`
      create trigger journal_postings_no_truncate
        before truncate on journal_postings
        for each statement execute function forbid_mutation()`);
    this.addSql(`
      create trigger ledger_accounts_immutable
        before update or delete on ledger_accounts
        for each row execute function forbid_mutation()`);

    this.addSql(`
      create function journal_assert_balanced() returns trigger language plpgsql as $fn$
      declare
        tid          uuid := (to_jsonb(new) ->> tg_argv[0])::uuid;
        debits       numeric(30,2);
        credits      numeric(30,2);
        legs         int;
        currencies   int;
        player_legs  int;
        entry        record;
      begin
        select coalesce(sum(amount) filter (where direction = 'DEBIT'), 0),
               coalesce(sum(amount) filter (where direction = 'CREDIT'), 0),
               count(*), count(distinct currency)
          into debits, credits, legs, currencies
          from journal_postings where transaction_id = tid;

        select wallet_id, direction, amount into entry
          from wallet_ledger_entries where transaction_id = tid;

        if legs = 0 then
          if found then
            raise exception 'transaction % moved a wallet without a double-entry journal', tid
              using errcode = 'integrity_constraint_violation';
          end if;
          return null;
        end if;

        if legs < 2 or currencies <> 1 or debits <> credits then
          raise exception 'journal of transaction % is not balanced (debits %, credits %, legs %)', tid, debits, credits, legs
            using errcode = 'integrity_constraint_violation';
        end if;

        if not found then
          raise exception 'journal of transaction % has no wallet ledger entry', tid
            using errcode = 'integrity_constraint_violation';
        end if;

        select count(*) into player_legs
          from journal_postings p join ledger_accounts a on a.id = p.account_id
         where p.transaction_id = tid and a.kind = 'PLAYER_WALLET';
        if player_legs <> 1 or not exists (
             select 1 from journal_postings p join ledger_accounts a on a.id = p.account_id
              where p.transaction_id = tid and a.wallet_id = entry.wallet_id
                and p.direction = entry.direction and p.amount = entry.amount) then
          raise exception 'journal of transaction % does not mirror its wallet ledger entry', tid
            using errcode = 'integrity_constraint_violation';
        end if;
        return null;
      end
      $fn$`);
    this.addSql(`
      create constraint trigger journal_postings_balanced
        after insert on journal_postings
        deferrable initially deferred
        for each row execute function journal_assert_balanced('transaction_id')`);
    this.addSql(`
      create constraint trigger wallet_ledger_entry_has_journal
        after insert on wallet_ledger_entries
        deferrable initially deferred
        for each row execute function journal_assert_balanced('transaction_id')`);

    // ---------------------------------------------------------------- backfill
    this.addSql(`
      insert into ledger_accounts (id, code, kind, currency, wallet_id, created_at)
      select md5('account:wallet:' || w.id)::uuid, 'wallet:' || w.id, 'PLAYER_WALLET', w.currency, w.id, w.created_at
        from wallets w`);
    this.addSql(`
      insert into ledger_accounts (id, code, kind, currency, wallet_id, created_at)
      select distinct on (t.provider_id, t.currency)
             md5('account:provider:' || t.provider_id || ':' || t.currency)::uuid,
             'provider:' || t.provider_id || ':' || t.currency, 'PROVIDER_GAMING', t.currency, null, now()
        from wager_transactions t
        join wallet_ledger_entries l on l.transaction_id = t.id
       where t.kind <> 'OPENING'`);
    this.addSql(`
      insert into ledger_accounts (id, code, kind, currency, wallet_id, created_at)
      select distinct on (t.currency)
             md5('account:funding:' || t.currency)::uuid, 'funding:' || t.currency, 'FUNDING', t.currency, null, now()
        from wager_transactions t
       where t.kind = 'OPENING'`);
    this.addSql(`
      insert into journal_postings (id, transaction_id, account_id, direction, amount, currency, created_at)
      select md5('posting:player:' || l.id)::uuid, l.transaction_id, md5('account:wallet:' || l.wallet_id)::uuid,
             l.direction, l.amount, l.currency, l.created_at
        from wallet_ledger_entries l
       order by l.seq`);
    this.addSql(`
      insert into journal_postings (id, transaction_id, account_id, direction, amount, currency, created_at)
      select md5('posting:counterparty:' || l.id)::uuid, l.transaction_id,
             case when t.kind = 'OPENING' then md5('account:funding:' || l.currency)::uuid
                  else md5('account:provider:' || t.provider_id || ':' || l.currency)::uuid end,
             case l.direction when 'DEBIT' then 'CREDIT' else 'DEBIT' end,
             l.amount, l.currency, l.created_at
        from wallet_ledger_entries l
        join wager_transactions t on t.id = l.transaction_id
       order by l.seq`);
  }

  override async down(): Promise<void> {
    this.addSql('drop trigger if exists wallet_ledger_entry_has_journal on wallet_ledger_entries');
    this.addSql('drop table if exists journal_postings');
    this.addSql('drop table if exists ledger_accounts');
    this.addSql('drop function if exists journal_assert_balanced()');
  }
}
