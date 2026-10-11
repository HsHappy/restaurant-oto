import { randomUUID } from 'node:crypto';
import { db } from '../../infrastructure/database/db.js';
import { eventBus } from '../../infrastructure/bus/LocalEventBus.js';
import { OutboxEvent, SyncCheckpoint, SyncQueueItem } from '../../core/domain/entities/index.js';
import { SyncDirection, SyncStatus, SyncType } from '../../core/domain/enums/index.js';

export interface SyncPushResult {
  pushedCount: number;
  batchId: string;
  isOnline: boolean;
  events: OutboxEvent[];
  lastSequence: number;
}

export interface CloudCatalogUpdate {
  entityType: 'PRODUCT' | 'CATEGORY' | 'PRICE';
  entityId: string;
  operation: 'INSERT' | 'UPDATE' | 'DELETE';
  payload: any;
  version: number;
  updatedAt: string;
}

export interface SyncPullResult {
  appliedCount: number;
  conflictCount: number;
  conflicts: { entityId: string; strategy: string; resolution: string }[];
}

export class NetworkMonitor {
  private online: boolean = true;

  public isOnline(): boolean {
    return this.online;
  }

  public setOnline(state: boolean): void {
    const prev = this.online;
    this.online = state;
    if (prev !== state) {
      console.log(`[NetworkMonitor] 🌐 Edge Network State changed: ${state ? 'ONLINE' : 'OFFLINE (Disconnected)'}`);
      eventBus.publish('SYNC:NETWORK_STATE_CHANGED', 'SYSTEM', { isOnline: state });
    }
  }
}

export class SyncEngine {
  private static instance: SyncEngine;
  public networkMonitor = new NetworkMonitor();
  private isSyncing = false;
  private syncTimer: NodeJS.Timeout | null = null;

  public static getInstance(): SyncEngine {
    if (!SyncEngine.instance) {
      SyncEngine.instance = new SyncEngine();
    }
    return SyncEngine.instance;
  }

  /**
   * Pushes pending outbox events from local edge database to cloud endpoint (Upstream)
   */
  public async pushLocalEvents(batchSize: number = 50): Promise<SyncPushResult> {
    if (!this.networkMonitor.isOnline()) {
      return {
        pushedCount: 0,
        batchId: 'OFFLINE',
        isOnline: false,
        events: [],
        lastSequence: 0,
      };
    }

    const eventsRes = await db.query(
      `SELECT * FROM outbox_events 
       WHERE status = 'PENDING' 
       ORDER BY created_at ASC 
       LIMIT $1`,
      [batchSize]
    );

    if (eventsRes.rows.length === 0) {
      return {
        pushedCount: 0,
        batchId: randomUUID(),
        isOnline: true,
        events: [],
        lastSequence: 0,
      };
    }

    const events: OutboxEvent[] = eventsRes.rows;
    const batchId = randomUUID();

    // 1. Transmit batch to Cloud Hub (Simulated HTTPS mTLS / JWT Batch Request)
    console.log(`[SyncEngine] ☁️ Pushing ${events.length} pending events to Cloud Hub (Batch: ${batchId})...`);

    // 2. Mark events as PROCESSED in local database
    const eventIds = events.map((e) => e.id);
    await db.query(
      `UPDATE outbox_events 
       SET status = 'PROCESSED', processed_at = NOW() 
       WHERE id = ANY($1::uuid[])`,
      [eventIds]
    );

    // 3. Update Sync Checkpoints
    const branchRes = await db.query(`SELECT id FROM branches LIMIT 1`);
    const branchId = branchRes.rows[0]?.id || 'b53136a9-e892-4a06-93dd-d13039230bfd';

    await db.query(
      `INSERT INTO sync_checkpoints (branch_id, sync_type, last_synced_sequence, last_synced_at, status)
       VALUES ($1, $2, $3, NOW(), 'SUCCESS')
       ON CONFLICT (branch_id, sync_type)
       DO UPDATE SET last_synced_sequence = sync_checkpoints.last_synced_sequence + $3, last_synced_at = NOW()`,
      [branchId, SyncType.UPSTREAM_EVENTS, events.length]
    );

    await eventBus.publish('SYNC:BATCH_PUSHED', batchId, {
      batchId,
      pushedCount: events.length,
      timestamp: new Date().toISOString(),
    });

    return {
      pushedCount: events.length,
      batchId,
      isOnline: true,
      events,
      lastSequence: events.length,
    };
  }

  /**
   * Pulls downstream catalog/pricing updates from Cloud and resolves conflicts locally
   */
  public async pullCloudUpdates(updates: CloudCatalogUpdate[]): Promise<SyncPullResult> {
    let appliedCount = 0;
    let conflictCount = 0;
    const conflicts: { entityId: string; strategy: string; resolution: string }[] = [];

    for (const update of updates) {
      if (update.entityType === 'PRODUCT') {
        const prod = update.payload;

        // Check if existing product exists
        const existingRes = await db.query(`SELECT * FROM products WHERE id = $1 OR sku = $2`, [
          update.entityId,
          prod.sku || '',
        ]);

        if (existingRes.rows.length === 0) {
          // INSERT new product
          await db.query(
            `INSERT INTO products (id, sku, name, base_price, tax_rate, preparation_station, is_available)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              update.entityId,
              prod.sku,
              prod.name,
              prod.base_price,
              prod.tax_rate || 10,
              prod.preparation_station || 'GRILL',
              prod.is_available ?? true,
            ]
          );
          appliedCount++;
        } else {
          // CONFLICT RESOLUTION: Last-Write-Wins (LWW)
          const current = existingRes.rows[0];
          const localUpdated = new Date(current.created_at).getTime();
          const cloudUpdated = new Date(update.updatedAt || Date.now()).getTime();

          if (cloudUpdated >= localUpdated) {
            // Apply Cloud update
            await db.query(
              `UPDATE products 
               SET name = $1, base_price = $2, is_available = $3 
               WHERE id = $4`,
              [prod.name || current.name, prod.base_price || current.base_price, prod.is_available ?? current.is_available, current.id]
            );
            appliedCount++;
          } else {
            // Local wins
            conflictCount++;
            conflicts.push({
              entityId: update.entityId,
              strategy: 'LWW (Last-Write-Wins)',
              resolution: 'Local version was newer than cloud version; local state preserved',
            });
          }
        }
      } else if (update.entityType === 'PRICE') {
        // Direct Price update
        await db.query(`UPDATE products SET base_price = $1 WHERE id = $2`, [
          update.payload.base_price,
          update.entityId,
        ]);
        appliedCount++;
      }
    }

    return {
      appliedCount,
      conflictCount,
      conflicts,
    };
  }

  /**
   * Evaluates Stock Discrepancy & Negative Stock Tolerances
   */
  public async checkStockDiscrepancies(): Promise<{ alerts: any[] }> {
    const res = await db.query(
      `SELECT * FROM inventory_items WHERE current_stock < 0 OR current_stock <= safety_threshold`
    );

    const alerts = res.rows.map((item) => ({
      itemId: item.id,
      name: item.name,
      currentStock: item.current_stock,
      safetyThreshold: item.safety_threshold,
      type: Number(item.current_stock) < 0 ? 'NEGATIVE_STOCK_TOLERANCE' : 'LOW_STOCK_WARNING',
    }));

    return { alerts };
  }

  /**
   * Gets overall sync health status
   */
  public async getSyncStatus(): Promise<any> {
    const isOnline = this.networkMonitor.isOnline();
    const pendingEventsRes = await db.query(
      `SELECT COUNT(*) as count FROM outbox_events WHERE status = 'PENDING'`
    );
    const processedEventsRes = await db.query(
      `SELECT COUNT(*) as count FROM outbox_events WHERE status = 'PROCESSED'`
    );
    const checkpointsRes = await db.query(`SELECT * FROM sync_checkpoints`);

    return {
      networkState: isOnline ? 'ONLINE' : 'OFFLINE',
      isOnline,
      pendingEventsCount: parseInt(pendingEventsRes.rows[0]?.count || '0', 10),
      processedEventsCount: parseInt(processedEventsRes.rows[0]?.count || '0', 10),
      checkpoints: checkpointsRes.rows,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Periodic scheduler to automatically push events when online
   */
  public startPeriodicSync(intervalMs: number = 5000): void {
    if (this.syncTimer) return;

    this.syncTimer = setInterval(async () => {
      if (this.isSyncing || !this.networkMonitor.isOnline()) return;
      this.isSyncing = true;
      try {
        await this.pushLocalEvents(20);
      } catch (err) {
        console.error('[SyncEngine] Automatic sync error:', err);
      } finally {
        this.isSyncing = false;
      }
    }, intervalMs);

    this.syncTimer.unref();
  }

  public stopPeriodicSync(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }
}

export const syncEngine = SyncEngine.getInstance();
