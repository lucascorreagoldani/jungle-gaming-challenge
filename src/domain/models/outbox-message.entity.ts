import { v4 as uuidv4 } from "uuid";
import { IntegrationEvent } from "../events/integration-event.base";

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) { }

  public static enqueue(event: IntegrationEvent<unknown>, id: string = uuidv4()): OutboxMessage {
    return new OutboxMessage(
      id,
      event.aggregateId,
      event.eventType,
      event.toJSON(),
      event.occurredAt,
      0,
      undefined,
      undefined,
    );
  }

  public static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  public get attempts(): number {
    return this._attempts;
  }

  public get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  public get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  public isPending(): boolean {
    return this._publishedAt === undefined;
  }

  public isDue(now: Date = new Date()): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt <= now);
  }

  public markPublished(at: Date = new Date()): void {
    this._publishedAt = at;
  }

  /**
   * Incrementa attempts e calcula o próximo nextAttemptAt com backoff exponencial.
   */
  public scheduleRetry(now: Date = new Date()): void {
    this._attempts += 1;
    // Backoff exponencial: 1s, 2s, 4s, 8s, 16s... com teto de 60s
    const delaySeconds = Math.min(Math.pow(2, this._attempts - 1), 60);
    this._nextAttemptAt = new Date(now.getTime() + delaySeconds * 1000);
  }
}
