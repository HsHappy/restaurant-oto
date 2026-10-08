import { db } from '../../infrastructure/database/db.js';
import { DiningTable } from '../../core/domain/entities/index.js';
import { TableStatus, OrderStatus, OrderType } from '../../core/domain/enums/index.js';
import {
  TableNotFoundError,
  TableLockedError,
  InvalidTableStateTransitionError,
} from '../../core/domain/errors/DomainError.js';
import { eventBus } from '../../infrastructure/bus/LocalEventBus.js';
import { auditService } from '../audit/AuditService.js';
import { randomUUID } from 'node:crypto';

export class TableService {
  // Allowed state machine transitions
  private static readonly ALLOWED_TRANSITIONS: Record<TableStatus, TableStatus[]> = {
    [TableStatus.AVAILABLE]: [TableStatus.OCCUPIED, TableStatus.RESERVED],
    [TableStatus.OCCUPIED]: [TableStatus.BILL_REQUESTED, TableStatus.DIRTY],
    [TableStatus.BILL_REQUESTED]: [TableStatus.OCCUPIED, TableStatus.DIRTY],
    [TableStatus.DIRTY]: [TableStatus.AVAILABLE],
    [TableStatus.RESERVED]: [TableStatus.AVAILABLE, TableStatus.OCCUPIED],
  };

  /**
   * Lists all tables for a branch
   */
  public async getTables(branchId: string): Promise<DiningTable[]> {
    const res = await db.query<DiningTable>(
      `SELECT * FROM dining_tables WHERE branch_id = $1 ORDER BY section, table_number`,
      [branchId]
    );
    return res.rows;
  }

  /**
   * Retrieves a table by ID
   */
  public async getTableById(tableId: string): Promise<DiningTable> {
    const res = await db.query<DiningTable>(`SELECT * FROM dining_tables WHERE id = $1`, [tableId]);
    if (res.rows.length === 0) {
      throw new TableNotFoundError(tableId);
    }
    return res.rows[0];
  }

  /**
   * Acquires a lock on a table for optimistic concurrency control
   */
  public async acquireLock(tableId: string, lockedBy: string): Promise<DiningTable> {
    const table = await this.getTableById(tableId);
    const lockExpiryMs = 2 * 60 * 1000; // 2 minutes auto-lock timeout

    if (table.locked_by && table.locked_by !== lockedBy && table.locked_at) {
      const lockAge = Date.now() - new Date(table.locked_at).getTime();
      if (lockAge < lockExpiryMs) {
        throw new TableLockedError(table.table_number, table.locked_by);
      }
    }

    const now = new Date();
    await db.query(
      `UPDATE dining_tables SET locked_by = $1, locked_at = $2 WHERE id = $3`,
      [lockedBy, now, tableId]
    );

    table.locked_by = lockedBy;
    table.locked_at = now;
    return table;
  }

  /**
   * Releases lock on a table
   */
  public async releaseLock(tableId: string, lockedBy?: string): Promise<void> {
    if (lockedBy) {
      await db.query(`UPDATE dining_tables SET locked_by = NULL, locked_at = NULL WHERE id = $1 AND locked_by = $2`, [
        tableId,
        lockedBy,
      ]);
    } else {
      await db.query(`UPDATE dining_tables SET locked_by = NULL, locked_at = NULL WHERE id = $1`, [tableId]);
    }
  }

  /**
   * Transitions table state following the state machine rules
   */
  public async updateStatus(tableId: string, newStatus: TableStatus, actorId: string): Promise<DiningTable> {
    const table = await this.getTableById(tableId);
    const currentStatus = table.current_status as TableStatus;

    if (currentStatus === newStatus) {
      return table;
    }

    const allowed = TableService.ALLOWED_TRANSITIONS[currentStatus] || [];
    if (!allowed.includes(newStatus)) {
      throw new InvalidTableStateTransitionError(currentStatus, newStatus);
    }

    const beforeState = { ...table };

    // Clear active_order_id if moving to AVAILABLE
    const activeOrderId = newStatus === TableStatus.AVAILABLE ? null : table.active_order_id;

    await db.query(
      `UPDATE dining_tables SET current_status = $1, active_order_id = $2 WHERE id = $3`,
      [newStatus, activeOrderId, tableId]
    );

    table.current_status = newStatus;
    table.active_order_id = activeOrderId;

    // Cryptographic audit log
    await auditService.log({
      branchId: table.branch_id,
      actorId,
      entityName: 'DINING_TABLE',
      entityId: tableId,
      actionType: 'UPDATE_STATUS',
      beforeState: { status: currentStatus },
      afterState: { status: newStatus },
      reason: `Status transition from ${currentStatus} to ${newStatus}`,
    });

    // Publish event
    await eventBus.publish('TABLE_STATE_CHANGED', tableId, {
      tableId,
      tableNumber: table.table_number,
      section: table.section,
      previousStatus: currentStatus,
      newStatus,
      activeOrderId,
    });

    return table;
  }

  /**
   * Opens an available table and attaches a new active order atomically
   */
  public async openTable(
    tableId: string,
    waiterId: string,
    orderNumberPrefix: string = 'ORD'
  ): Promise<{ table: DiningTable; orderId: string; orderNumber: string }> {
    return await db.transaction(async (tx) => {
      const res = await tx.query<DiningTable>(
        `SELECT * FROM dining_tables WHERE id = $1 FOR UPDATE`,
        [tableId]
      );

      if (res.rows.length === 0) {
        throw new TableNotFoundError(tableId);
      }

      const table = res.rows[0];
      if (table.current_status !== TableStatus.AVAILABLE && table.current_status !== TableStatus.RESERVED) {
        throw new InvalidTableStateTransitionError(table.current_status, TableStatus.OCCUPIED);
      }

      const orderId = randomUUID();
      const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const randPart = Math.floor(1000 + Math.random() * 9000);
      const orderNumber = `${orderNumberPrefix}-${datePart}-${randPart}`;

      // Insert new Order
      await tx.query(
        `INSERT INTO orders (
          id, branch_id, table_id, waiter_id, order_number, order_type,
          status, subtotal, discount_total, tax_total, grand_total, opened_at, version
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 0.00, 0.00, 0.00, 0.00, NOW(), 1)`,
        [orderId, table.branch_id, tableId, waiterId, orderNumber, OrderType.DINE_IN, OrderStatus.OPEN]
      );

      // Update table to OCCUPIED
      await tx.query(
        `UPDATE dining_tables SET current_status = $1, active_order_id = $2, locked_by = NULL, locked_at = NULL WHERE id = $3`,
        [TableStatus.OCCUPIED, orderId, tableId]
      );

      // Audit log inside transaction
      await auditService.log(
        {
          branchId: table.branch_id,
          actorId: waiterId,
          entityName: 'DINING_TABLE',
          entityId: tableId,
          actionType: 'OPEN_TABLE',
          beforeState: { status: table.current_status },
          afterState: { status: TableStatus.OCCUPIED, active_order_id: orderId, orderNumber },
        },
        tx
      );

      table.current_status = TableStatus.OCCUPIED;
      table.active_order_id = orderId;

      // Publish event
      await eventBus.publish('TABLE_STATE_CHANGED', tableId, {
        tableId,
        tableNumber: table.table_number,
        previousStatus: TableStatus.AVAILABLE,
        newStatus: TableStatus.OCCUPIED,
        activeOrderId: orderId,
      });

      return { table, orderId, orderNumber };
    });
  }
}

export const tableService = new TableService();
