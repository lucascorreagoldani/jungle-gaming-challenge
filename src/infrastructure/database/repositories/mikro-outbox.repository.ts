import { EntityManager, LockMode } from "@mikro-orm/postgresql";
import { IOutboxRepository } from "../../../domain/repositories/repository.ports";
import { OutboxMessage } from "../../../domain/models/outbox-message.entity";
import { OutboxMessageOrmEntity } from "../entities/outbox-message.orm-entity";

export class MikroOutboxRepository implements IOutboxRepository {
  constructor(private readonly em: EntityManager) { }

  async save(message: OutboxMessage): Promise<void> {
    const entity = OutboxMessageOrmEntity.fromDomain(message);
    this.em.persist(entity);
  }

  async findPendingToPublish(limit: number, now: Date = new Date()): Promise<OutboxMessage[]> {
    // Busca mensagens pendentes com lock pessimista SKIP LOCKED para publicação concorrente segura
    const entities = await this.em.find(
      OutboxMessageOrmEntity,
      {
        publishedAt: null,
        $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
      },
      {
        limit,
        orderBy: { occurredAt: "ASC" },
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE, // FOR UPDATE SKIP LOCKED
      },
    );

    return entities.map((e) => e.toDomain());
  }

  async update(message: OutboxMessage): Promise<void> {
    const entity = await this.em.findOne(OutboxMessageOrmEntity, { id: message.id });
    if (entity) {
      entity.attempts = message.attempts;
      entity.nextAttemptAt = message.nextAttemptAt;
      entity.publishedAt = message.publishedAt;
      this.em.persist(entity);
    }
  }
}
