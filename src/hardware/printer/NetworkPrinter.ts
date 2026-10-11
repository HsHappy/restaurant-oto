import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { eventBus } from '../../infrastructure/bus/LocalEventBus.js';

export interface PrintJob {
  id: string;
  type: 'RECEIPT' | 'KITCHEN' | 'DRAWER_PULSE' | 'DELIVERY_TICKET';
  targetHost: string;
  targetPort: number;
  data: Buffer;
  attempts: number;
  maxAttempts: number;
  createdAt: Date;
}

export class NetworkPrinter {
  private queue: PrintJob[] = [];
  private isProcessingQueue = false;
  private retryIntervalTimer: NodeJS.Timeout | null = null;

  constructor() {
    // Start periodic background queue worker (every 10 seconds)
    this.retryIntervalTimer = setInterval(() => {
      this.processQueue().catch((err) => console.error('[NetworkPrinter] Queue process error:', err));
    }, 10000);
    this.retryIntervalTimer.unref();

  }

  /**
   * Sends raw binary buffer to network thermal printer via TCP socket.
   * If socket fails or times out, job is buffered into offline queue.
   */
  public async sendRaw(
    host: string,
    port: number,
    data: Buffer,
    type: 'RECEIPT' | 'KITCHEN' | 'DRAWER_PULSE' | 'DELIVERY_TICKET' = 'RECEIPT'
  ): Promise<{ success: boolean; jobId: string; queued: boolean; message?: string }> {
    const jobId = randomUUID();

    try {
      await this.connectAndWrite(host, port, data);
      await eventBus.publish('PRINTER.COMPLETED', jobId, { host, port, type });
      return { success: true, jobId, queued: false, message: 'Print job dispatched successfully' };
    } catch (err: any) {
      console.warn(`[NetworkPrinter] Failed to reach printer at ${host}:${port} (${err.message}). Buffering in offline queue.`);
      
      const job: PrintJob = {
        id: jobId,
        type,
        targetHost: host,
        targetPort: port,
        data,
        attempts: 1,
        maxAttempts: 5,
        createdAt: new Date(),
      };
      this.queue.push(job);

      await eventBus.publish('PRINTER.OFFLINE_QUEUED', jobId, {
        host,
        port,
        type,
        error: err.message,
        queueLength: this.queue.length,
      });

      return {
        success: false,
        jobId,
        queued: true,
        message: `Printer offline. Job queued for retry (${this.queue.length} in queue). Error: ${err.message}`,
      };
    }
  }

  private connectAndWrite(host: string, port: number, data: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      let isResolved = false;

      socket.setTimeout(1000);

      socket.connect(port, host, () => {
        socket.write(data, () => {
          socket.end();
          isResolved = true;
          resolve();
        });
      });

      socket.on('timeout', () => {
        socket.destroy();
        if (!isResolved) {
          isResolved = true;
          reject(new Error(`Connection to ${host}:${port} timed out`));
        }
      });

      socket.on('error', (err) => {
        socket.destroy();
        if (!isResolved) {
          isResolved = true;
          reject(err);
        }
      });
    });
  }


  /**
   * Background retry processor for offline queue
   */
  public async processQueue(): Promise<void> {
    if (this.isProcessingQueue || this.queue.length === 0) return;
    this.isProcessingQueue = true;

    try {
      const pendingJobs = [...this.queue];
      for (const job of pendingJobs) {
        try {
          await this.connectAndWrite(job.targetHost, job.targetPort, job.data);
          console.log(`[NetworkPrinter] Offline job ${job.id} dispatched successfully on retry.`);
          this.queue = this.queue.filter((j) => j.id !== job.id);
          await eventBus.publish('PRINTER.COMPLETED', job.id, {
            host: job.targetHost,
            port: job.targetPort,
            type: job.type,
          });
        } catch (err: any) {
          job.attempts++;
          if (job.attempts >= job.maxAttempts) {
            console.error(`[NetworkPrinter] Job ${job.id} dropped after ${job.maxAttempts} attempts.`);
            this.queue = this.queue.filter((j) => j.id !== job.id);
            await eventBus.publish('PRINTER.JOB_DROPPED', job.id, {
              host: job.targetHost,
              port: job.targetPort,
              error: err.message,
            });
          }
        }
      }
    } finally {
      this.isProcessingQueue = false;
    }
  }

  public getQueueLength(): number {
    return this.queue.length;
  }

  public getQueue(): PrintJob[] {
    return [...this.queue];
  }

  public close(): void {
    if (this.retryIntervalTimer) {
      clearInterval(this.retryIntervalTimer);
      this.retryIntervalTimer = null;
    }
  }
}

export const networkPrinter = new NetworkPrinter();
