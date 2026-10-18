import { Entity, PrimaryKey, Property } from "@mikro-orm/decorators/legacy";
import { InboxMessage } from "../../../domain/models/inbox-message.entity";

@Entity({ tableName: "inbox_messages" })
export class InboxMessageOrmEntity {
  @PrimaryKey({ type: "varchar", length: 64 })
  consumerName!: string;

  @PrimaryKey({ type: "varchar", length: 128 })
  messageId!: string;

  @Property({ type: "char", length: 64 })
  payloadHash!: string;

  @Property({ type: "timestamptz" })
  receivedAt!: Date;

  @Property({ type: "timestamptz", nullable: true })
  processedAt?: Date;

  public static fromDomain(inbox: InboxMessage): InboxMessageOrmEntity {
    const entity = new InboxMessageOrmEntity();
    entity.consumerName = inbox.consumerName;
    entity.messageId = inbox.messageId;
    entity.payloadHash = inbox.payloadHash;
    entity.receivedAt = inbox.receivedAt;
    entity.processedAt = inbox.processedAt;
    return entity;
  }

  public toDomain(): InboxMessage {
    return InboxMessage.rehydrate({
      consumerName: this.consumerName,
      messageId: this.messageId,
      payloadHash: this.payloadHash,
      receivedAt: this.receivedAt,
      processedAt: this.processedAt,
    });
  }
}
