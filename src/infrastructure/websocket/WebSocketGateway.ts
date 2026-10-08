import { WebSocket } from 'ws';
import { eventBus } from '../bus/LocalEventBus.js';

export class WebSocketGateway {
  private static instance: WebSocketGateway;
  private clients = new Set<WebSocket>();

  private constructor() {
    this.registerEventBusListeners();
  }

  public static getInstance(): WebSocketGateway {
    if (!WebSocketGateway.instance) {
      WebSocketGateway.instance = new WebSocketGateway();
    }
    return WebSocketGateway.instance;
  }

  public registerClient(socket: WebSocket): void {
    this.clients.add(socket);

    socket.on('close', () => {
      this.clients.delete(socket);
    });

    socket.on('error', (err) => {
      console.warn('[WebSocketGateway] Client socket error:', err.message);
      this.clients.delete(socket);
    });

    // Send connection greeting
    socket.send(
      JSON.stringify({
        event: 'CONNECTED',
        message: 'Connected to Enterprise RMS Edge Node Real-Time Bus',
        timestamp: new Date().toISOString(),
      })
    );
  }

  public broadcast(event: string, payload: any): void {
    const message = JSON.stringify({
      event,
      payload,
      timestamp: new Date().toISOString(),
    });

    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(message);
        } catch (err: any) {
          console.warn('[WebSocketGateway] Failed to send message to client:', err.message);
        }
      }
    }
  }

  public getConnectedClientsCount(): number {
    return this.clients.size;
  }

  private registerEventBusListeners(): void {
    // Listen to domain events and rebroadcast to LAN clients
    eventBus.subscribe('TABLE_STATE_CHANGED', (event) => {
      this.broadcast('TABLE_STATE_CHANGED', event.payload);
    });

    eventBus.subscribe('ORDER_UPDATED', (event) => {
      this.broadcast('ORDER_UPDATED', event.payload);
    });

    eventBus.subscribe('ORDER_SETTLED', (event) => {
      this.broadcast('ORDER_SETTLED', event.payload);
    });

    eventBus.subscribe('PAYMENT_PROCESSED', (event) => {
      this.broadcast('PAYMENT_PROCESSED', event.payload);
    });

    eventBus.subscribe('PRINTER.COMPLETED', (event) => {
      this.broadcast('PRINTER_STATUS', { status: 'COMPLETED', ...(event.payload as object) });
    });

    eventBus.subscribe('PRINTER.OFFLINE_QUEUED', (event) => {
      this.broadcast('PRINTER_STATUS', { status: 'OFFLINE_QUEUED', ...(event.payload as object) });
    });
  }
}


export const wsGateway = WebSocketGateway.getInstance();
