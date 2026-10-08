export interface DomainEvent<T = any> {
  eventId: string;
  eventType: string;
  occurredAt: Date;
  aggregateId: string;
  payload: T;
}

export type EventHandler<T = any> = (event: DomainEvent<T>) => void | Promise<void>;

export interface IEventBus {
  publish<T>(eventType: string, aggregateId: string, payload: T): Promise<void>;
  subscribe<T>(eventType: string, handler: EventHandler<T>): void;
}
