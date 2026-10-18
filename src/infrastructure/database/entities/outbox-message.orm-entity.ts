import { Entity, PrimaryKey, Property, Index } from "@mikro-orm/decorators/legacy";
import { OutboxMessage } from "../../../domain/models/outbox-message.entity";

@Entity({ tableName: "outbox_messages" })
@Index({ properties: ["publishedAt", "nextAttemptAt"] })
export class OutboxMessageOrmEntity {
  @PrimaryKey({ type: "uuid" })
  id!: string;

  @Property({ type: "varchar", length: 128 })
  @Index()
  aggregateId!: string;

  @Property({ type: "varchar", length: 128 })
  @Index()
  eventType!: string;

  @Property({ type: "jsonb" })
  payload!: Record<string, unknown>;

  @Property({ type: "timestamptz" })
  occurredAt!: Date;

  @Property({ type: "integer", default: 0 })
  attempts!: number;

  @Property({ type: "timestamptz", nullable: true })
  @Index()
  nextAttemptAt?: Date;

  @Property({ type: "timestamptz", nullable: true })
  @Index()
  publishedAt?: Date;

  public static fromDomain(outbox: OutboxMessage): OutboxMessageOrmEntity {
    const entity = new OutboxMessageOrmEntity();
    entity.id = outbox.id;
    entity.aggregateId = outbox.aggregateId;
    entity.eventType = outbox.eventType;
    entity.payload = outbox.payload as Record<string, unknown>;
    entity.occurredAt = outbox.occurredAt;
    entity.attempts = outbox.attempts;
    entity.nextAttemptAt = outbox.nextAttemptAt;
    entity.publishedAt = outbox.publishedAt;
    return entity;
  }

  public toDomain(): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: this.id,
      aggregateId: this.aggregateId,
      eventType: this.eventType,
      payload: this.payload,
      occurredAt: this.occurredAt,
      attempts: this.attempts,
      nextAttemptAt: this.nextAttemptAt,
      publishedAt: this.publishedAt,
    });
  }
}
