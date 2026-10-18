import { Entity, PrimaryKey, Property, Index } from "@mikro-orm/decorators/legacy";
import { LedgerDirection, WalletLedgerEntry } from "../../../domain/models/wallet-ledger-entry.entity";
import { Money } from "../../../domain/value-objects/money.vo";

@Entity({ tableName: "wallet_ledger_entries" })
@Index({ properties: ["walletId", "createdAt", "id"] })
export class WalletLedgerEntryOrmEntity {
  @PrimaryKey({ type: "uuid" })
  id!: string;

  @Property({ type: "uuid" })
  @Index()
  walletId!: string;

  @Property({ type: "uuid" })
  @Index()
  transactionId!: string;

  @Property({ type: "varchar", length: 10 })
  direction!: LedgerDirection;

  @Property({ type: "decimal", precision: 18, scale: 2 })
  amount!: string;

  @Property({ type: "varchar", length: 3 })
  currency!: string;

  @Property({ type: "decimal", precision: 18, scale: 2 })
  balanceBefore!: string;

  @Property({ type: "decimal", precision: 18, scale: 2 })
  balanceAfter!: string;

  @Property({ type: "timestamptz" })
  @Index()
  createdAt!: Date;

  public static fromDomain(entry: WalletLedgerEntry): WalletLedgerEntryOrmEntity {
    const entity = new WalletLedgerEntryOrmEntity();
    entity.id = entry.id;
    entity.walletId = entry.walletId;
    entity.transactionId = entry.transactionId;
    entity.direction = entry.direction;
    entity.amount = entry.money.toString();
    entity.currency = entry.money.currency;
    entity.balanceBefore = entry.balanceBefore.toString();
    entity.balanceAfter = entry.balanceAfter.toString();
    entity.createdAt = entry.createdAt;
    return entity;
  }

  public toDomain(): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({
      id: this.id,
      walletId: this.walletId,
      transactionId: this.transactionId,
      direction: this.direction,
      money: Money.rehydrate(this.amount, this.currency),
      balanceBefore: Money.rehydrate(this.balanceBefore, this.currency),
      balanceAfter: Money.rehydrate(this.balanceAfter, this.currency),
      createdAt: this.createdAt,
    });
  }
}
