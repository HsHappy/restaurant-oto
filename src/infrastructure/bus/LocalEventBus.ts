import { randomUUID } from 'node:crypto';
import { DomainEvent, EventHandler, IEventBus } from '../../core/events/DomainEvent.js';

export class LocalEventBus implements IEventBus {
  private static instance: LocalEventBus;
  private handlers = new Map<string, Set<EventHandler>>();

  public static getInstance(): LocalEventBus {
    if (!LocalEventBus.instance) {
      LocalEventBus.instance = new LocalEventBus();
    }
    return LocalEventBus.instance;
  }

  public subscribe<T>(eventType: string, handler: EventHandler<T>): void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set());
    }
    this.handlers.get(eventType)!.add(handler as EventHandler);
  }

  public unsubscribe<T>(eventType: string, handler: EventHandler<T>): void {
    const set = this.handlers.get(eventType);
    if (set) {
      set.delete(handler as EventHandler);
    }
  }

  public async publish<T>(eventType: string, aggregateId: string, payload: T): Promise<void> {
    const event: DomainEvent<T> = {
      eventId: randomUUID(),
      eventType,
      occurredAt: new Date(),
      aggregateId,
      payload,
    };

    const specificHandlers = this.handlers.get(eventType);
    const wildcardHandlers = this.handlers.get('*');

    const promises: Promise<void>[] = [];

    if (specificHandlers) {
      for (const handler of specificHandlers) {
        promises.push(
          Promise.resolve().then(() => handler(event)).catch((err) => {
            console.error(`[LocalEventBus] Error in handler for ${eventType}:`, err);
          })
        );
      }
    }

    if (wildcardHandlers) {
      for (const handler of wildcardHandlers) {
        promises.push(
          Promise.resolve().then(() => handler(event)).catch((err) => {
            console.error(`[LocalEventBus] Error in wildcard handler:`, err);
          })
        );
      }
    }

    await Promise.all(promises);
  }
}

export const eventBus = LocalEventBus.getInstance();
