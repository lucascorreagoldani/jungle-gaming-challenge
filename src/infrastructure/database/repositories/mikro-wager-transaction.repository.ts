import { EntityManager } from "@mikro-orm/postgresql";
import { IWagerTransactionRepository } from "../../../domain/repositories/repository.ports";
import { WagerTransaction, WagerTransactionStatus } from "../../../domain/models/wager-transaction.entity";
import { WagerTransactionOrmEntity } from "../entities/wager-transaction.orm-entity";

export class MikrowagerTransactionRepository implements IWagerTransactionRepository {
  constructor(private readonly em: EntityManager) { }

  async findById(id: string): Promise<WagerTransaction | null> {
    const entity = await this.em.findOne(WagerTransactionOrmEntity, { id });
    return entity ? entity.toDomain() : null;
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null> {
    const entity = await this.em.findOne(WagerTransactionOrmEntity, {
      providerId,
      externalTransactionId,
    });
    return entity ? entity.toDomain() : null;
  }

  async findByIdempotencyKey(key: string): Promise<WagerTransaction | null> {
    const entity = await this.em.findOne(WagerTransactionOrmEntity, { idempotencyKey: key });
    return entity ? entity.toDomain() : null;
  }

  async findPendingReferences(limit: number): Promise<WagerTransaction[]> {
    const entities = await this.em.find(
      WagerTransactionOrmEntity,
      { status: WagerTransactionStatus.PendingReference },
      { limit, orderBy: { createdAt: "ASC" } },
    );
    return entities.map((e) => e.toDomain());
  }

  async save(transaction: WagerTransaction): Promise<void> {
    const existing = await this.em.findOne(WagerTransactionOrmEntity, { id: transaction.id });
    if (existing) {
      existing.status = transaction.status;
      existing.referenceTransactionId = transaction.referenceTransactionId;
      existing.failureCode = transaction.failureCode;
      existing.processedAt = transaction.processedAt;
      this.em.persist(existing);
    } else {
      const entity = WagerTransactionOrmEntity.fromDomain(transaction);
      this.em.persist(entity);
    }
  }
}
