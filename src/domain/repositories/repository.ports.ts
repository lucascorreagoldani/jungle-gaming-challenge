import { Wallet } from "../models/wallet.entity";
import { WagerTransaction } from "../models/wager-transaction.entity";
import { WalletLedgerEntry } from "../models/wallet-ledger-entry.entity";
import { InboxMessage } from "../models/inbox-message.entity";
import { OutboxMessage } from "../models/outbox-message.entity";
import { Money } from "../value-objects/money.vo";

export interface IWalletRepository {
  findById(id: string, lock?: "pessimistic_write"): Promise<Wallet | null>;
  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null>;
  save(wallet: Wallet): Promise<void>;
}

export interface IWagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | null>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;
  findByIdempotencyKey(key: string): Promise<WagerTransaction | null>;
  findPendingReferences(limit: number): Promise<WagerTransaction[]>;
  save(transaction: WagerTransaction): Promise<void>;
}

export interface ILedgerPaginationResult {
  entries: WalletLedgerEntry[];
  nextCursor?: string;
  hasMore: boolean;
}

export interface ILedgerSumResult {
  totalCredits: Money;
  totalDebits: Money;
  count: number;
}

export interface IWalletLedgerRepository {
  save(entry: WalletLedgerEntry): Promise<void>;
  findByWalletId(walletId: string, cursor?: string, limit?: number): Promise<ILedgerPaginationResult>;
  sumByWalletId(walletId: string, currency: string): Promise<ILedgerSumResult>;
}

export interface IInboxRepository {
  findByMessageId(consumerName: string, messageId: string): Promise<InboxMessage | null>;
  save(message: InboxMessage): Promise<void>;
}

export interface IOutboxRepository {
  save(message: OutboxMessage): Promise<void>;
  findPendingToPublish(limit: number, now?: Date): Promise<OutboxMessage[]>;
  update(message: OutboxMessage): Promise<void>;
}
