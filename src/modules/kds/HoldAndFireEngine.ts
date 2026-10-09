import { db } from '../../infrastructure/database/db.js';
import { eventBus } from '../../infrastructure/bus/LocalEventBus.js';
import { OrderItemStatus, PreparationStation } from '../../core/domain/enums/index.js';

export interface PacedItemPlan {
  productId: string;
  prepTimeMinutes: number;
  station: string;
  status: OrderItemStatus;
  fireAt: Date;
  delaySeconds: number;
}

export class HoldAndFireEngine {
  private static instance: HoldAndFireEngine;
  private intervalTimer: NodeJS.Timeout | null = null;
  private isProcessing = false;

  public static getInstance(): HoldAndFireEngine {
    if (!HoldAndFireEngine.instance) {
      HoldAndFireEngine.instance = new HoldAndFireEngine();
    }
    return HoldAndFireEngine.instance;
  }

  /**
   * Calculates Cook Time Pacing for a batch of items ordered together.
   * Finds max preparation time in ticket, delays shorter items so all finish simultaneously.
   */
  public calculatePacing(
    items: { productId: string; prepTimeMinutes: number; station: string }[],
    baseTime: Date = new Date()
  ): PacedItemPlan[] {
    if (!items || items.length === 0) return [];

    // 1. Find max prep time among all items in batch
    const maxPrepMinutes = Math.max(...items.map((i) => i.prepTimeMinutes || 1));
    const targetReadyTimeMs = baseTime.getTime() + maxPrepMinutes * 60 * 1000;

    // 2. For each item, fire time = targetReadyTime - prepTime
    return items.map((item) => {
      const itemPrepMinutes = item.prepTimeMinutes || 1;
      const fireTimeMs = targetReadyTimeMs - itemPrepMinutes * 60 * 1000;
      const delaySeconds = Math.max(0, Math.round((fireTimeMs - baseTime.getTime()) / 1000));

      const isDelayed = delaySeconds > 0;
      const status = isDelayed ? OrderItemStatus.HOLD : OrderItemStatus.QUEUED;
      const fireAt = new Date(fireTimeMs);

      return {
        productId: item.productId,
        prepTimeMinutes: itemPrepMinutes,
        station: item.station,
        status,
        fireAt,
        delaySeconds,
      };
    });
  }

  /**
   * Starts periodic background Hold & Fire scheduler
   */
  public start(intervalMs: number = 3000): void {
    if (this.intervalTimer) return;

    this.intervalTimer = setInterval(() => {
      this.checkAndFireHeldItems().catch((err) => {
        console.error('[HoldAndFireEngine] Scheduler error:', err);
      });
    }, intervalMs);

    this.intervalTimer.unref();
    console.log(`[HoldAndFireEngine] Cook time pacing scheduler active (interval: ${intervalMs}ms).`);
  }

  /**
   * Stops scheduler
   */
  public stop(): void {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
  }

  /**
   * Checks database for items on HOLD whose fire_at has arrived, and fires them to QUEUED.
   */
  public async checkAndFireHeldItems(): Promise<number> {
    if (this.isProcessing) return 0;
    this.isProcessing = true;

    try {
      const now = new Date();
      // Find held items ready to fire
      const res = await db.query(
        `SELECT oi.id, oi.order_id, oi.product_id, oi.status, oi.customer_notes,
                p.name as product_name, p.preparation_station,
                o.order_number, o.table_id, t.table_number
         FROM order_items oi
         JOIN products p ON oi.product_id = p.id
         JOIN orders o ON oi.order_id = o.id
         LEFT JOIN dining_tables t ON o.table_id = t.id
         WHERE oi.status = $1 AND oi.fire_at <= $2`,
        [OrderItemStatus.HOLD, now]
      );

      if (res.rows.length === 0) return 0;

      for (const item of res.rows) {
        // Update item status to QUEUED and mark prep_started_at
        await db.query(
          `UPDATE order_items 
           SET status = $1, prep_started_at = $2 
           WHERE id = $3`,
          [OrderItemStatus.QUEUED, now, item.id]
        );

        // Record log
        await db.query(
          `INSERT INTO kds_station_logs (order_id, order_item_id, station, action, previous_status, new_status, created_at)
           VALUES ($1, $2, $3, 'FIRE', $4, $5, $6)`,
          [item.order_id, item.id, item.preparation_station, OrderItemStatus.HOLD, OrderItemStatus.QUEUED, now]
        );

        console.log(
          `[HoldAndFireEngine] 🔥 FIRED ITEM: ${item.product_name} on Table ${item.table_number || 'Takeaway'} for station ${item.preparation_station}`
        );

        // Publish events
        await eventBus.publish('KDS:ITEM_FIRED', item.id, {
          orderId: item.order_id,
          orderItemId: item.id,
          productName: item.product_name,
          station: item.preparation_station,
          tableNumber: item.table_number || 'Paket',
          orderNumber: item.order_number,
          firedAt: now.toISOString(),
        });

        await eventBus.publish('KDS:ITEM_STATUS_CHANGED', item.id, {
          orderId: item.order_id,
          orderItemId: item.id,
          previousStatus: OrderItemStatus.HOLD,
          newStatus: OrderItemStatus.QUEUED,
          station: item.preparation_station,
        });
      }

      return res.rows.length;
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Manually forces an item from HOLD to QUEUED immediately
   */
  public async forceFire(orderItemId: string, actorId: string = '00000000-0000-0000-0000-000000000001'): Promise<void> {
    const now = new Date();
    const itemRes = await db.query(
      `SELECT oi.id, oi.order_id, p.name as product_name, p.preparation_station,
              o.order_number, t.table_number
       FROM order_items oi
       JOIN products p ON oi.product_id = p.id
       JOIN orders o ON oi.order_id = o.id
       LEFT JOIN dining_tables t ON o.table_id = t.id
       WHERE oi.id = $1`,
      [orderItemId]
    );

    if (itemRes.rows.length === 0) return;
    const item = itemRes.rows[0];

    await db.query(
      `UPDATE order_items 
       SET status = $1, fire_at = $2, prep_started_at = $2 
       WHERE id = $3`,
      [OrderItemStatus.QUEUED, now, orderItemId]
    );

    await db.query(
      `INSERT INTO kds_station_logs (order_id, order_item_id, station, action, actor_id, previous_status, new_status, created_at)
       VALUES ($1, $2, $3, 'FIRE', $4, $5, $6, $7)`,
      [item.order_id, item.id, item.preparation_station, actorId, OrderItemStatus.HOLD, OrderItemStatus.QUEUED, now]
    );

    await eventBus.publish('KDS:ITEM_FIRED', item.id, {
      orderId: item.order_id,
      orderItemId: item.id,
      productName: item.product_name,
      station: item.preparation_station,
      tableNumber: item.table_number || 'Paket',
      orderNumber: item.order_number,
      firedAt: now.toISOString(),
      forced: true,
    });

    await eventBus.publish('KDS:ITEM_STATUS_CHANGED', item.id, {
      orderId: item.order_id,
      orderItemId: item.id,
      previousStatus: OrderItemStatus.HOLD,
      newStatus: OrderItemStatus.QUEUED,
      station: item.preparation_station,
    });
  }
}

export const holdAndFireEngine = HoldAndFireEngine.getInstance();
