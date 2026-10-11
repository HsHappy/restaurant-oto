import { db } from '../../infrastructure/database/db.js';
import { eventBus } from '../../infrastructure/bus/LocalEventBus.js';
import { orderService } from '../orders/OrderService.js';
import { tableService } from '../tables/TableService.js';
import { auditService } from '../audit/AuditService.js';
import { holdAndFireEngine } from '../kds/HoldAndFireEngine.js';
import { TableStatus, OrderItemStatus } from '../../core/domain/enums/index.js';
import {
  TableNotFoundError,
  OrderNotFoundError,
  InvalidTableStateTransitionError,
} from '../../core/domain/errors/DomainError.js';

export interface QuickOrderItemInput {
  productId: string;
  quantity: number;
  modifiers?: { name: string; extra_price: number }[];
  customerNotes?: string;
}

export interface QuickOrderInput {
  tableId: string;
  waiterId: string;
  items: QuickOrderItemInput[];
  enablePacing?: boolean;
}

export interface WaiterTableOverview {
  id: string;
  table_number: string;
  section: string;
  capacity: number;
  current_status: TableStatus;
  active_order_id?: string | null;
  order_number?: string | null;
  grand_total: number;
  item_count: number;
  ready_items_count: number;
  elapsed_minutes: number;
  locked_by?: string | null;
}

export class WaiterService {
  /**
   * Retrieves enriched overview of all tables for handheld terminal UX
   */
  public async getTablesOverview(branchId: string): Promise<WaiterTableOverview[]> {
    const tables = await tableService.getTables(branchId);
    const now = new Date();

    const overviewList: WaiterTableOverview[] = [];

    for (const table of tables) {
      let grandTotal = 0;
      let itemCount = 0;
      let readyItemsCount = 0;
      let elapsedMinutes = 0;
      let orderNumber: string | null = null;

      if (table.active_order_id) {
        const orderRes = await db.query(
          `SELECT o.order_number, o.grand_total, o.opened_at,
                  (SELECT COUNT(*) FROM order_items WHERE order_id = o.id AND status != 'CANCELLED') as item_count,
                  (SELECT COUNT(*) FROM order_items WHERE order_id = o.id AND status = 'READY') as ready_count
           FROM orders o
           WHERE o.id = $1`,
          [table.active_order_id]
        );

        if (orderRes.rows.length > 0) {
          const ord = orderRes.rows[0];
          orderNumber = ord.order_number;
          grandTotal = Number(ord.grand_total) || 0;
          itemCount = parseInt(ord.item_count || '0', 10);
          readyItemsCount = parseInt(ord.ready_count || '0', 10);
          const openedAt = new Date(ord.opened_at);
          elapsedMinutes = Math.max(0, Math.floor((now.getTime() - openedAt.getTime()) / (60 * 1000)));
        }
      }

      overviewList.push({
        id: table.id,
        table_number: table.table_number,
        section: table.section,
        capacity: table.capacity,
        current_status: table.current_status,
        active_order_id: table.active_order_id,
        order_number: orderNumber,
        grand_total: grandTotal,
        item_count: itemCount,
        ready_items_count: readyItemsCount,
        elapsed_minutes: elapsedMinutes,
        locked_by: table.locked_by,
      });
    }

    return overviewList;
  }

  /**
   * High-speed optimized quick order entry from handheld terminal with Cook Time Pacing
   */
  public async quickOrder(input: QuickOrderInput) {
    const table = await tableService.getTableById(input.tableId);
    let orderId = table.active_order_id;

    // If table is available, automatically open it
    if (!orderId || table.current_status === TableStatus.AVAILABLE) {
      const openResult = await tableService.openTable(table.id, input.waiterId);
      orderId = openResult.orderId;
    }

    // Fetch product details for pacing calculation
    const productIds = input.items.map((i) => i.productId);
    const prodRes = await db.query(
      `SELECT id, preparation_station, standard_prep_time_minutes FROM products WHERE id = ANY($1)`,
      [productIds]
    );
    const prodMap = new Map(prodRes.rows.map((p) => [p.id, p]));

    const itemsForPacing = input.items.map((i) => {
      const p = prodMap.get(i.productId);
      return {
        productId: i.productId,
        prepTimeMinutes: p?.standard_prep_time_minutes || 5,
        station: p?.preparation_station || 'GRILL',
      };
    });

    const enablePacing = input.enablePacing !== false;
    const pacingPlans = enablePacing
      ? holdAndFireEngine.calculatePacing(itemsForPacing)
      : [];

    const addedItems = [];

    // Add items one by one
    for (let index = 0; index < input.items.length; index++) {
      const itemInput = input.items[index];
      const plan = pacingPlans[index];

      const initialStatus = plan ? plan.status : OrderItemStatus.QUEUED;
      const fireAt = plan ? plan.fireAt : null;

      const addRes = await orderService.addItemToOrder(
        orderId,
        {
          productId: itemInput.productId,
          quantity: itemInput.quantity,
          modifiers: itemInput.modifiers,
          customerNotes: itemInput.customerNotes,
          status: initialStatus,
          fireAt,
        },
        input.waiterId
      );

      addedItems.push(addRes.newItem);
    }

    const updatedOrder = await orderService.getOrderById(orderId);

    // Notify KDS screens of new ticket/items
    await eventBus.publish('KDS:NEW_TICKET', orderId, {
      orderId,
      orderNumber: updatedOrder.order_number,
      tableId: table.id,
      tableNumber: table.table_number,
      items: addedItems,
      openedAt: updatedOrder.opened_at,
    });

    return {
      order: updatedOrder,
      addedItems,
      tableNumber: table.table_number,
    };
  }

  /**
   * Request bill from table (Garson 'Hesap İste' aksiyonu)
   */
  public async requestBill(tableId: string, actorId: string) {
    const table = await tableService.getTableById(tableId);
    if (table.current_status !== TableStatus.OCCUPIED) {
      throw new InvalidTableStateTransitionError(table.current_status, TableStatus.BILL_REQUESTED);
    }

    const updatedTable = await tableService.updateStatus(tableId, TableStatus.BILL_REQUESTED, actorId);

    await eventBus.publish('WAITER:CALL_NOTIFICATION', tableId, {
      tableId,
      tableNumber: table.table_number,
      type: 'BILL_REQUESTED',
      requestedAt: new Date().toISOString(),
      actorId,
    });

    return updatedTable;
  }

  /**
   * Transfers active order from one table to another (Masa Taşıma)
   */
  public async transferTable(sourceTableId: string, targetTableId: string, waiterId: string) {
    return await db.transaction(async (tx) => {
      const srcRes = await tx.query(`SELECT * FROM dining_tables WHERE id = $1 FOR UPDATE`, [sourceTableId]);
      const tgtRes = await tx.query(`SELECT * FROM dining_tables WHERE id = $1 FOR UPDATE`, [targetTableId]);

      if (srcRes.rows.length === 0) throw new TableNotFoundError(sourceTableId);
      if (tgtRes.rows.length === 0) throw new TableNotFoundError(targetTableId);

      const source = srcRes.rows[0];
      const target = tgtRes.rows[0];

      if (!source.active_order_id) {
        throw new OrderNotFoundError(`No active order on table ${source.table_number}`);
      }
      if (target.current_status !== TableStatus.AVAILABLE) {
        throw new InvalidTableStateTransitionError(target.current_status, TableStatus.OCCUPIED);
      }

      const orderId = source.active_order_id;

      // Update order table reference
      await tx.query(`UPDATE orders SET table_id = $1 WHERE id = $2`, [targetTableId, orderId]);

      // Update tables
      await tx.query(
        `UPDATE dining_tables SET current_status = 'AVAILABLE', active_order_id = NULL WHERE id = $1`,
        [sourceTableId]
      );
      await tx.query(
        `UPDATE dining_tables SET current_status = 'OCCUPIED', active_order_id = $1 WHERE id = $2`,
        [orderId, targetTableId]
      );

      // Cryptographic Audit log
      await auditService.log(
        {
          branchId: source.branch_id,
          actorId: waiterId,
          entityName: 'DINING_TABLE',
          entityId: sourceTableId,
          actionType: 'TRANSFER_TABLE',
          beforeState: { sourceTable: source.table_number, status: source.current_status },
          afterState: { targetTable: target.table_number, orderId },
          reason: `Table transferred from ${source.table_number} to ${target.table_number}`,
        },
        tx
      );

      // Publish table events
      await eventBus.publish('TABLE_STATE_CHANGED', sourceTableId, {
        tableId: sourceTableId,
        tableNumber: source.table_number,
        previousStatus: source.current_status,
        newStatus: TableStatus.AVAILABLE,
        activeOrderId: null,
      });

      await eventBus.publish('TABLE_STATE_CHANGED', targetTableId, {
        tableId: targetTableId,
        tableNumber: target.table_number,
        previousStatus: TableStatus.AVAILABLE,
        newStatus: TableStatus.OCCUPIED,
        activeOrderId: orderId,
      });

      return {
        sourceTable: source.table_number,
        targetTable: target.table_number,
        orderId,
      };
    });
  }
}

export const waiterService = new WaiterService();
