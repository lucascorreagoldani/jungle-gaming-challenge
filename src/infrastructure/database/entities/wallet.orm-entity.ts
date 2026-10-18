import { Entity, PrimaryKey, Property, Unique, Check, Index } from "@mikro-orm/decorators/legacy";
import { Wallet } from "../../../domain/models/wallet.entity";
import { Money } from "../../../domain/value-objects/money.vo";

@Entity({ tableName: "wallets" })
@Unique({ properties: ["playerId", "currency"] })
@Check({ expression: "balance >= 0" })
export class WalletOrmEntity {
  @PrimaryKey({ type: "uuid" })
  id!: string;

  @Property({ type: "varchar", length: 64 })
  @Index()
  playerId!: string;

  @Property({ type: "varchar", length: 3 })
  currency!: string;

  @Property({ type: "decimal", precision: 18, scale: 2 })
  balance!: string;

  @Property({ type: "integer", default: 1 })
  version!: number;

  @Property({ type: "timestamptz" })
  createdAt!: Date;

  @Property({ type: "timestamptz" })
  updatedAt!: Date;

  public static fromDomain(wallet: Wallet): WalletOrmEntity {
    const entity = new WalletOrmEntity();
    entity.id = wallet.id;
    entity.playerId = wallet.playerId;
    entity.currency = wallet.currency;
    entity.balance = wallet.balance.toString();
    entity.version = wallet.version;
    entity.createdAt = wallet.createdAt;
    entity.updatedAt = wallet.updatedAt;
    return entity;
  }

  public toDomain(): Wallet {
    return Wallet.rehydrate({
      id: this.id,
      playerId: this.playerId,
      currency: this.currency,
      balance: Money.rehydrate(this.balance, this.currency),
      version: this.version,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    });
  }
}
