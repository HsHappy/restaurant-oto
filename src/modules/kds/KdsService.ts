import { db } from '../../infrastructure/database/db.js';
import { eventBus } from '../../infrastructure/bus/LocalEventBus.js';
import { KdsTicket, KdsTicketItem } from '../../core/domain/entities/index.js';
import { OrderItemStatus, PreparationStation } from '../../core/domain/enums/index.js';
import { ItemNotFoundError } from '../../core/domain/errors/DomainError.js';
import { randomUUID } from 'node:crypto';

export class KdsService {
  /**
   * Retrieves active KDS tickets filtered by preparation station or all (EXPEDITOR).
   * Calculates elapsed times, remaining countdowns, and dynamic SLA alert status.
   */
  public async getStationTickets(station: PreparationStation | 'EXPEDITOR'): Promise<KdsTicket[]> {
    const now = new Date();

    // Query all orders that have non-served, non-cancelled items
    const ordersRes = await db.query(
      `SELECT o.id as order_id, o.order_number, o.table_id, o.waiter_id, o.opened_at,
              COALESCE(t.table_number, 'Paket') as table_number
       FROM orders o
       LEFT JOIN dining_tables t ON o.table_id = t.id
       WHERE o.status = 'OPEN'
       ORDER BY o.opened_at ASC`
    );

    if (ordersRes.rows.length === 0) {
      return [];
    }

    const tickets: KdsTicket[] = [];

    for (const orderRow of ordersRes.rows) {
      // Fetch active kitchen items for this order
      const itemsRes = await db.query(
        `SELECT oi.*, p.name as product_name, p.preparation_station, p.standard_prep_time_minutes
         FROM order_items oi
         JOIN products p ON oi.product_id = p.id
         WHERE oi.order_id = $1 AND oi.status IN ('HOLD', 'QUEUED', 'PREPARING', 'READY')
         ORDER BY oi.created_at ASC`,
        [orderRow.order_id]
      );

      if (itemsRes.rows.length === 0) {
        continue;
      }

      // Filter by station if not EXPEDITOR
      const relevantRows =
        station === 'EXPEDITOR'
          ? itemsRes.rows
          : itemsRes.rows.filter((it) => it.preparation_station === station);

      if (relevantRows.length === 0) {
        continue;
      }

      const openedAt = new Date(orderRow.opened_at);
      const elapsedSeconds = Math.max(0, Math.floor((now.getTime() - openedAt.getTime()) / 1000));

      const maxPrepMinutes = Math.max(
        ...relevantRows.map((it) => Number(it.standard_prep_time_minutes) || 1)
      );
      const targetDurationSeconds = maxPrepMinutes * 60;

      // SLA Status: <50% Normal (Green), 50-100% Warning (Yellow), >100% Critical (Red)
      const ratio = elapsedSeconds / targetDurationSeconds;
      let slaStatus: 'NORMAL' | 'WARNING' | 'CRITICAL' = 'NORMAL';
      if (ratio > 1.0) {
        slaStatus = 'CRITICAL';
      } else if (ratio >= 0.5) {
        slaStatus = 'WARNING';
      }

      const ticketItems: KdsTicketItem[] = relevantRows.map((it) => {
        const isHeld = it.status === OrderItemStatus.HOLD;
        let timeRemainingSeconds = 0;
        if (it.fire_at) {
          const fireMs = new Date(it.fire_at).getTime();
          timeRemainingSeconds = Math.max(0, Math.floor((fireMs - now.getTime()) / 1000));
        }

        return {
          id: it.id,
          order_id: it.order_id,
          product_id: it.product_id,
          product_name: it.product_name,
          preparation_station: it.preparation_station,
          standard_prep_time_minutes: it.standard_prep_time_minutes,
          quantity: it.quantity,
          unit_price: Number(it.unit_price),
          total_price: Number(it.total_price),
          status: it.status as OrderItemStatus,
          is_complimentary: it.is_complimentary,
          cancel_reason: it.cancel_reason,
          selected_modifiers: it.selected_modifiers || [],
          fire_at: it.fire_at ? new Date(it.fire_at) : null,
          prep_started_at: it.prep_started_at ? new Date(it.prep_started_at) : null,
          ready_at: it.ready_at ? new Date(it.ready_at) : null,
          bumped_by: it.bumped_by,
          customer_notes: it.customer_notes,
          created_at: new Date(it.created_at),
          bumped_at: it.bumped_at ? new Date(it.bumped_at) : null,
          is_held: isHeld,
          time_remaining_seconds: timeRemainingSeconds,
        };
      });

      const allItemsReady = ticketItems.every((it) => it.status === OrderItemStatus.READY);

      tickets.push({
        order_id: orderRow.order_id,
        order_number: orderRow.order_number,
        table_id: orderRow.table_id,
        table_number: orderRow.table_number,
        waiter_id: orderRow.waiter_id,
        opened_at: openedAt,
        elapsed_seconds: elapsedSeconds,
        max_prep_time_minutes: maxPrepMinutes,
        sla_status: slaStatus,
        station: String(station),
        items: ticketItems,
        all_items_ready: allItemsReady,
      });
    }

    return tickets;
  }

  /**
   * Bumps (completes) an individual item on the KDS screen
   */
  public async bumpItem(orderItemId: string, actorId: string): Promise<void> {
    const now = new Date();
    const itemRes = await db.query(
      `SELECT oi.*, p.name as product_name, p.preparation_station,
              o.order_number, o.table_id, COALESCE(t.table_number, 'Paket') as table_number
       FROM order_items oi
       JOIN products p ON oi.product_id = p.id
       JOIN orders o ON oi.order_id = o.id
       LEFT JOIN dining_tables t ON o.table_id = t.id
       WHERE oi.id = $1`,
      [orderItemId]
    );

    if (itemRes.rows.length === 0) {
      throw new ItemNotFoundError(orderItemId);
    }

    const item = itemRes.rows[0];
    const prevStatus = item.status;

    // Mark READY
    await db.query(
      `UPDATE order_items 
       SET status = $1, ready_at = $2, bumped_by = $3, bumped_at = $2 
       WHERE id = $4`,
      [OrderItemStatus.READY, now, actorId, orderItemId]
    );

    // Record action log for recall
    await db.query(
      `INSERT INTO kds_station_logs (
        id, order_id, order_item_id, station, action, actor_id, previous_status, new_status, created_at
      ) VALUES ($1, $2, $3, $4, 'BUMP', $5, $6, $7, $8)`,
      [
        randomUUID(),
        item.order_id,
        orderItemId,
        item.preparation_station,
        actorId,
        prevStatus,
        OrderItemStatus.READY,
        now,
      ]
    );

    // Publish status changed
    await eventBus.publish('KDS:ITEM_STATUS_CHANGED', orderItemId, {
      orderId: item.order_id,
      orderItemId,
      previousStatus: prevStatus,
      newStatus: OrderItemStatus.READY,
      station: item.preparation_station,
    });

    // Alert Waiters that this item is ready
    await eventBus.publish('WAITER:ITEM_READY', orderItemId, {
      orderId: item.order_id,
      orderNumber: item.order_number,
      tableNumber: item.table_number,
      productName: item.product_name,
      quantity: item.quantity,
      station: item.preparation_station,
      readyAt: now.toISOString(),
    });

    // Check if entire ticket is now ready
    const remainingRes = await db.query(
      `SELECT COUNT(*) as count 
       FROM order_items 
       WHERE order_id = $1 AND status IN ('HOLD', 'QUEUED', 'PREPARING')`,
      [item.order_id]
    );

    if (parseInt(remainingRes.rows[0]?.count || '0', 10) === 0) {
      await eventBus.publish('KDS:TICKET_READY', item.order_id, {
        orderId: item.order_id,
        orderNumber: item.order_number,
        tableNumber: item.table_number,
        readyAt: now.toISOString(),
      });
    }
  }

  /**
   * Bumps all items for a given order and station
   */
  public async bumpTicket(
    orderId: string,
    station: PreparationStation | 'EXPEDITOR',
    actorId: string
  ): Promise<void> {
    const condition =
      station === 'EXPEDITOR'
        ? `oi.order_id = $1 AND oi.status IN ('HOLD', 'QUEUED', 'PREPARING')`
        : `oi.order_id = $1 AND oi.status IN ('HOLD', 'QUEUED', 'PREPARING') AND p.preparation_station = '${station}'`;

    const itemsRes = await db.query(
      `SELECT oi.id 
       FROM order_items oi
       JOIN products p ON oi.product_id = p.id
       WHERE ${condition}`,
      [orderId]
    );

    for (const row of itemsRes.rows) {
      await this.bumpItem(row.id, actorId);
    }
  }

  /**
   * Recalls the last bumped item for a station (LIFO buffer)
   */
  public async recallLastBump(station: PreparationStation | 'EXPEDITOR'): Promise<{ recalled: boolean; itemId?: string }> {
    const stationFilter = station === 'EXPEDITOR' ? '' : `AND station = '${station}'`;

    const logRes = await db.query(
      `SELECT * FROM kds_station_logs 
       WHERE action = 'BUMP' ${stationFilter}
       ORDER BY created_at DESC 
       LIMIT 1`
    );

    if (logRes.rows.length === 0) {
      return { recalled: false };
    }

    const lastLog = logRes.rows[0];
    const itemId = lastLog.order_item_id;
    const restoreStatus = lastLog.previous_status || OrderItemStatus.QUEUED;

    // Restore item status
    await db.query(
      `UPDATE order_items 
       SET status = $1, ready_at = NULL, bumped_at = NULL 
       WHERE id = $2`,
      [restoreStatus, itemId]
    );

    // Record recall log
    await db.query(
      `INSERT INTO kds_station_logs (
        id, order_id, order_item_id, station, action, actor_id, previous_status, new_status, created_at
      ) VALUES ($1, $2, $3, $4, 'RECALL', $5, $6, $7, NOW())`,
      [
        randomUUID(),
        lastLog.order_id,
        itemId,
        lastLog.station,
        lastLog.actor_id,
        OrderItemStatus.READY,
        restoreStatus,
      ]
    );

    // Re-publish status change to put item back on KDS screen
    await eventBus.publish('KDS:ITEM_STATUS_CHANGED', itemId, {
      orderId: lastLog.order_id,
      orderItemId: itemId,
      previousStatus: OrderItemStatus.READY,
      newStatus: restoreStatus,
      station: lastLog.station,
      recalled: true,
    });

    console.log(`[KdsService] 🔄 RECALLED ITEM ${itemId} back to ${restoreStatus} for station ${lastLog.station}`);
    return { recalled: true, itemId };
  }

  /**
   * Puts an item on manual HOLD
   */
  public async holdItem(orderItemId: string, actorId: string): Promise<void> {
    const itemRes = await db.query(
      `SELECT oi.*, p.preparation_station FROM order_items oi JOIN products p ON oi.product_id = p.id WHERE oi.id = $1`,
      [orderItemId]
    );
    if (itemRes.rows.length === 0) throw new ItemNotFoundError(orderItemId);
    const item = itemRes.rows[0];

    await db.query(`UPDATE order_items SET status = $1 WHERE id = $2`, [OrderItemStatus.HOLD, orderItemId]);

    await db.query(
      `INSERT INTO kds_station_logs (id, order_id, order_item_id, station, action, actor_id, previous_status, new_status, created_at)
       VALUES ($1, $2, $3, $4, 'HOLD', $5, $6, $7, NOW())`,
      [randomUUID(), item.order_id, orderItemId, item.preparation_station, actorId, item.status, OrderItemStatus.HOLD]
    );

    await eventBus.publish('KDS:ITEM_STATUS_CHANGED', orderItemId, {
      orderId: item.order_id,
      orderItemId,
      previousStatus: item.status,
      newStatus: OrderItemStatus.HOLD,
      station: item.preparation_station,
    });
  }

  /**
   * Marks item as SERVED by waiter
   */
  public async serveItem(orderItemId: string, waiterId: string): Promise<void> {
    const itemRes = await db.query(
      `SELECT oi.*, p.name as product_name, p.preparation_station, o.table_id, t.table_number
       FROM order_items oi
       JOIN products p ON oi.product_id = p.id
       JOIN orders o ON oi.order_id = o.id
       LEFT JOIN dining_tables t ON o.table_id = t.id
       WHERE oi.id = $1`,
      [orderItemId]
    );
    if (itemRes.rows.length === 0) throw new ItemNotFoundError(orderItemId);
    const item = itemRes.rows[0];

    await db.query(`UPDATE order_items SET status = $1 WHERE id = $2`, [OrderItemStatus.SERVED, orderItemId]);

    await eventBus.publish('KDS:ITEM_STATUS_CHANGED', orderItemId, {
      orderId: item.order_id,
      orderItemId,
      previousStatus: item.status,
      newStatus: OrderItemStatus.SERVED,
      station: item.preparation_station,
    });

    await eventBus.publish('WAITER:ITEM_SERVED', orderItemId, {
      orderId: item.order_id,
      orderItemId,
      productName: item.product_name,
      tableNumber: item.table_number,
      waiterId,
      servedAt: new Date().toISOString(),
    });
  }
}

export const kdsService = new KdsService();
