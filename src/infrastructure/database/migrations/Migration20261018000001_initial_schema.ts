import { Migration } from "@mikro-orm/migrations";

export class Migration20261018000001_initial_schema extends Migration {
  async up(): Promise<void> {
    // 1. Wallets table
    this.addSql(`
      CREATE TABLE IF NOT EXISTS wallets (
        id UUID PRIMARY KEY,
        player_id VARCHAR(64) NOT NULL,
        currency VARCHAR(3) NOT NULL,
        balance NUMERIC(18, 2) NOT NULL DEFAULT 0.00,
        version INT NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency),
        CONSTRAINT chk_wallet_balance_non_negative CHECK (balance >= 0.00)
      );
    `);
    this.addSql(`CREATE INDEX IF NOT EXISTS idx_wallets_player_id ON wallets (player_id);`);

    // 2. Wager Transactions table
    this.addSql(`
      CREATE TABLE IF NOT EXISTS wager_transactions (
        id UUID PRIMARY KEY,
        provider_id VARCHAR(64) NOT NULL,
        external_transaction_id VARCHAR(128) NOT NULL,
        idempotency_key VARCHAR(255) NOT NULL,
        payload_hash CHAR(64) NOT NULL,
        wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
        player_id VARCHAR(64) NOT NULL,
        round_id VARCHAR(128) NOT NULL,
        game_id VARCHAR(128) NOT NULL,
        kind VARCHAR(20) NOT NULL,
        amount NUMERIC(18, 2) NOT NULL,
        currency VARCHAR(3) NOT NULL,
        reference_external_transaction_id VARCHAR(128) NULL,
        status VARCHAR(30) NOT NULL,
        reference_transaction_id UUID NULL,
        failure_code VARCHAR(64) NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        processed_at TIMESTAMPTZ NULL,
        CONSTRAINT uq_wager_tx_provider_external_id UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT uq_wager_tx_idempotency_key UNIQUE (idempotency_key)
      );
    `);
    this.addSql(`CREATE INDEX IF NOT EXISTS idx_wager_tx_wallet_id ON wager_transactions (wallet_id);`);
    this.addSql(`CREATE INDEX IF NOT EXISTS idx_wager_tx_player_id ON wager_transactions (player_id);`);
    this.addSql(`CREATE INDEX IF NOT EXISTS idx_wager_tx_round_id ON wager_transactions (round_id);`);
    this.addSql(`CREATE INDEX IF NOT EXISTS idx_wager_tx_status ON wager_transactions (status);`);
    this.addSql(`CREATE INDEX IF NOT EXISTS idx_wager_tx_pending_ref ON wager_transactions (status) WHERE status = 'PENDING_REFERENCE';`);
    this.addSql(`CREATE INDEX IF NOT EXISTS idx_wager_tx_ref_lookup ON wager_transactions (provider_id, reference_external_transaction_id);`);

    // 3. Wallet Ledger Entries table (append-only)
    this.addSql(`
      CREATE TABLE IF NOT EXISTS wallet_ledger_entries (
        id UUID PRIMARY KEY,
        wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
        transaction_id UUID NOT NULL,
        direction VARCHAR(10) NOT NULL,
        amount NUMERIC(18, 2) NOT NULL,
        currency VARCHAR(3) NOT NULL,
        balance_before NUMERIC(18, 2) NOT NULL,
        balance_after NUMERIC(18, 2) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT chk_ledger_amount_positive CHECK (amount > 0.00),
        CONSTRAINT chk_ledger_balance_before_non_negative CHECK (balance_before >= 0.00),
        CONSTRAINT chk_ledger_balance_after_non_negative CHECK (balance_after >= 0.00)
      );
    `);
    this.addSql(`CREATE INDEX IF NOT EXISTS idx_ledger_wallet_pagination ON wallet_ledger_entries (wallet_id, created_at DESC, id DESC);`);
    this.addSql(`CREATE INDEX IF NOT EXISTS idx_ledger_transaction_id ON wallet_ledger_entries (transaction_id);`);

    // Trigger to guarantee immutability (prohibit UPDATE or DELETE on ledger entries)
    this.addSql(`
      CREATE OR REPLACE FUNCTION prevent_ledger_modification()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'Ledger entries are strictly immutable. UPDATE and DELETE operations are prohibited.';
      END;
      $$ LANGUAGE plpgsql;
    `);
    this.addSql(`
      DROP TRIGGER IF EXISTS trg_prevent_ledger_update_or_delete ON wallet_ledger_entries;
      CREATE TRIGGER trg_prevent_ledger_update_or_delete
      BEFORE UPDATE OR DELETE ON wallet_ledger_entries
      FOR EACH ROW EXECUTE FUNCTION prevent_ledger_modification();
    `);

    // 4. Inbox Messages table
    this.addSql(`
      CREATE TABLE IF NOT EXISTS inbox_messages (
        consumer_name VARCHAR(64) NOT NULL,
        message_id VARCHAR(128) NOT NULL,
        payload_hash CHAR(64) NOT NULL,
        received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        processed_at TIMESTAMPTZ NULL,
        PRIMARY KEY (consumer_name, message_id)
      );
    `);

    // 5. Outbox Messages table
    this.addSql(`
      CREATE TABLE IF NOT EXISTS outbox_messages (
        id UUID PRIMARY KEY,
        aggregate_id VARCHAR(128) NOT NULL,
        event_type VARCHAR(128) NOT NULL,
        payload JSONB NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        attempts INT NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ NULL,
        published_at TIMESTAMPTZ NULL
      );
    `);
    this.addSql(`CREATE INDEX IF NOT EXISTS idx_outbox_pending_publish ON outbox_messages (published_at, next_attempt_at) WHERE published_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS idx_outbox_aggregate_id ON outbox_messages (aggregate_id);`);
  }

  async down(): Promise<void> {
    this.addSql(`DROP TRIGGER IF EXISTS trg_prevent_ledger_update_or_delete ON wallet_ledger_entries;`);
    this.addSql(`DROP FUNCTION IF EXISTS prevent_ledger_modification();`);
    this.addSql(`DROP TABLE IF EXISTS outbox_messages;`);
    this.addSql(`DROP TABLE IF EXISTS inbox_messages;`);
    this.addSql(`DROP TABLE IF EXISTS wallet_ledger_entries;`);
    this.addSql(`DROP TABLE IF EXISTS wager_transactions;`);
    this.addSql(`DROP TABLE IF EXISTS wallets;`);
  }
}
