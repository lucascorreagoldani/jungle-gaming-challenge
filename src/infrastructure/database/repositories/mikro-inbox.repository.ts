import { EntityManager } from "@mikro-orm/postgresql";
import { IInboxRepository } from "../../../domain/repositories/repository.ports";
import { InboxMessage } from "../../../domain/models/inbox-message.entity";
import { InboxMessageOrmEntity } from "../entities/inbox-message.orm-entity";

export class MikroInboxRepository implements IInboxRepository {
  constructor(private readonly em: EntityManager) { }

  async findByMessageId(consumerName: string, messageId: string): Promise<InboxMessage | null> {
    const entity = await this.em.findOne(InboxMessageOrmEntity, { consumerName, messageId });
    return entity ? entity.toDomain() : null;
  }

  async save(message: InboxMessage): Promise<void> {
    const existing = await this.em.findOne(InboxMessageOrmEntity, {
      consumerName: message.consumerName,
      messageId: message.messageId,
    });

    if (existing) {
      existing.processedAt = message.processedAt;
      this.em.persist(existing);
    } else {
      const entity = InboxMessageOrmEntity.fromDomain(message);
      this.em.persist(entity);
    }
    if (typeof (this.em as any).flush === "function") {
      await this.em.flush();
    }
  }
}
