import { Entity, PrimaryKey, Property, Unique, Index } from "@mikro-orm/decorators/legacy";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../../domain/models/wager-transaction.entity";
import { Money } from "../../../domain/value-objects/money.vo";
import { FailureCode } from "../../../domain/errors/domain.error";

@Entity({ tableName: "wager_transactions" })
@Unique({ properties: ["providerId", "externalTransactionId"] })
@Unique({ properties: ["idempotencyKey"] })
@Index({ properties: ["providerId", "referenceExternalTransactionId"] })
export class WagerTransactionOrmEntity {
  @PrimaryKey({ type: "uuid" })
  id!: string;

  @Property({ type: "varchar", length: 64 })
  @Index()
  providerId!: string;

  @Property({ type: "varchar", length: 128 })
  externalTransactionId!: string;

  @Property({ type: "varchar", length: 255 })
  idempotencyKey!: string;

  @Property({ type: "char", length: 64 })
  payloadHash!: string;

  @Property({ type: "uuid" })
  @Index()
  walletId!: string;

  @Property({ type: "varchar", length: 64 })
  @Index()
  playerId!: string;

  @Property({ type: "varchar", length: 128 })
  @Index()
  roundId!: string;

  @Property({ type: "varchar", length: 128 })
  gameId!: string;

  @Property({ type: "varchar", length: 20 })
  kind!: WagerTransactionKind;

  @Property({ type: "decimal", precision: 18, scale: 2 })
  amount!: string;

  @Property({ type: "varchar", length: 3 })
  currency!: string;

  @Property({ type: "varchar", length: 128, nullable: true })
  referenceExternalTransactionId?: string;

  @Property({ type: "varchar", length: 30 })
  @Index()
  status!: WagerTransactionStatus;

  @Property({ type: "uuid", nullable: true })
  referenceTransactionId?: string;

  @Property({ type: "varchar", length: 64, nullable: true })
  failureCode?: FailureCode;

  @Property({ type: "timestamptz" })
  createdAt!: Date;

  @Property({ type: "timestamptz", nullable: true })
  processedAt?: Date;

  public static fromDomain(tx: WagerTransaction): WagerTransactionOrmEntity {
    const entity = new WagerTransactionOrmEntity();
    entity.id = tx.id;
    entity.providerId = tx.providerId;
    entity.externalTransactionId = tx.externalTransactionId;
    entity.idempotencyKey = tx.idempotencyKey;
    entity.payloadHash = tx.payloadHash;
    entity.walletId = tx.walletId;
    entity.playerId = tx.playerId;
    entity.roundId = tx.roundId;
    entity.gameId = tx.gameId;
    entity.kind = tx.kind;
    entity.amount = tx.money.toString();
    entity.currency = tx.money.currency;
    entity.referenceExternalTransactionId = tx.referenceExternalTransactionId;
    entity.status = tx.status;
    entity.referenceTransactionId = tx.referenceTransactionId;
    entity.failureCode = tx.failureCode;
    entity.createdAt = tx.createdAt;
    entity.processedAt = tx.processedAt;
    return entity;
  }

  public toDomain(): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: this.id,
      providerId: this.providerId,
      externalTransactionId: this.externalTransactionId,
      idempotencyKey: this.idempotencyKey,
      payloadHash: this.payloadHash,
      walletId: this.walletId,
      playerId: this.playerId,
      roundId: this.roundId,
      gameId: this.gameId,
      kind: this.kind,
      money: Money.rehydrate(this.amount, this.currency),
      referenceExternalTransactionId: this.referenceExternalTransactionId,
      status: this.status,
      referenceTransactionId: this.referenceTransactionId,
      failureCode: this.failureCode,
      createdAt: this.createdAt,
      processedAt: this.processedAt,
    });
  }
}
