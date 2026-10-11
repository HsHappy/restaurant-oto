import { randomUUID } from 'node:crypto';
import { db } from '../../infrastructure/database/db.js';
import { eventBus } from '../../infrastructure/bus/LocalEventBus.js';
import { posTerminalDriver } from './PosTerminalDriver.js';
import { tableService } from '../tables/TableService.js';
import {
  TerminalSaleRequest,
  TerminalSaleResponse,
  TerminalSettlementResponse,
  PaymentTerminalLog,
} from '../../core/domain/entities/index.js';
import {
  PaymentMethod,
  OrderStatus,
  TableStatus,
  TerminalCommandType,
  TerminalConnectionType,
} from '../../core/domain/enums/index.js';

export interface TerminalChargeResult {
  paymentId: string;
  orderId: string;
  terminalResponse: TerminalSaleResponse;
  remainingBalance: number;
  isFullySettled: boolean;
}

export class PosTerminalService {
  private static instance: PosTerminalService;

  public static getInstance(): PosTerminalService {
    if (!PosTerminalService.instance) {
      PosTerminalService.instance = new PosTerminalService();
    }
    return PosTerminalService.instance;
  }

  /**
   * Processes card charge via physical Bank POS terminal and settles order balance
   */
  public async chargeOrderViaTerminal(
    request: TerminalSaleRequest
  ): Promise<TerminalChargeResult> {
    const { orderId, amount } = request;

    if (!orderId) {
      throw new Error('Missing orderId for terminal sale transaction.');
    }

    // 1. Verify order exists and is OPEN
    const orderRes = await db.query(
      `SELECT o.*, t.id as table_id, t.table_number 
       FROM orders o 
       LEFT JOIN dining_tables t ON o.table_id = t.id 
       WHERE o.id = $1`,
      [orderId]
    );

    if (orderRes.rows.length === 0) {
      throw new Error(`Order ${orderId} not found.`);
    }

    const order = orderRes.rows[0];
    if (order.status !== OrderStatus.OPEN) {
      throw new Error(`Cannot charge payment for order in status ${order.status}`);
    }

    // 2. Trigger physical/virtual Bank POS hardware transaction
    const terminalResponse = await posTerminalDriver.executeSale(request);

    if (!terminalResponse.success || terminalResponse.statusCode !== '00') {
      // Record failed log
      await db.query(
        `INSERT INTO payment_terminal_logs (
          id, order_id, terminal_id, connection_type, command_type,
          amount, currency, status_code, status_message, slip_text, raw_response, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())`,
        [
          randomUUID(),
          orderId,
          terminalResponse.terminalId,
          request.connectionType || TerminalConnectionType.TCP,
          TerminalCommandType.SALE,
          amount,
          terminalResponse.currency,
          terminalResponse.statusCode,
          terminalResponse.statusMessage,
          terminalResponse.slipText,
          terminalResponse.rawResponse,
        ]
      );
      throw new Error(`POS Terminal declined transaction: ${terminalResponse.statusMessage}`);
    }

    const paymentId = randomUUID();

    // 3. Record Payment & Terminal Log inside transaction
    const { remainingBalance, isFullySettled } = await db.transaction(async (tx) => {
      // Insert Payment
      await tx.query(
        `INSERT INTO payments (
          id, order_id, payment_method, amount, currency, transaction_reference, status, paid_at
        ) VALUES ($1, $2, $3, $4, $5, $6, 'COMPLETED', NOW())`,
        [
          paymentId,
          orderId,
          PaymentMethod.CREDIT_CARD,
          amount,
          terminalResponse.currency,
          terminalResponse.rrn,
        ]
      );

      // Insert Terminal Log
      await tx.query(
        `INSERT INTO payment_terminal_logs (
          id, order_id, payment_id, terminal_id, connection_type, command_type,
          amount, currency, status_code, status_message, auth_code, rrn, slip_text, raw_response, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())`,
        [
          randomUUID(),
          orderId,
          paymentId,
          terminalResponse.terminalId,
          request.connectionType || TerminalConnectionType.TCP,
          TerminalCommandType.SALE,
          amount,
          terminalResponse.currency,
          terminalResponse.statusCode,
          terminalResponse.statusMessage,
          terminalResponse.authCode,
          terminalResponse.rrn,
          terminalResponse.slipText,
          terminalResponse.rawResponse,
        ]
      );

      // Check remaining balance
      const paidRes = await tx.query(
        `SELECT COALESCE(SUM(amount), 0) as total_paid FROM payments WHERE order_id = $1 AND status = 'COMPLETED'`,
        [orderId]
      );

      const totalPaid = Number(paidRes.rows[0]?.total_paid || 0);
      const grandTotal = Number(order.grand_total);
      const remaining = Math.max(0, Number((grandTotal - totalPaid).toFixed(2)));
      const fullySettled = remaining <= 0.01;

      if (fullySettled) {
        await tx.query(`UPDATE orders SET status = $1, closed_at = NOW() WHERE id = $2`, [
          OrderStatus.SETTLED,
          orderId,
        ]);

        if (order.table_id) {
          await tx.query(
            `UPDATE dining_tables SET current_status = $1, active_order_id = NULL WHERE id = $2`,
            [TableStatus.DIRTY, order.table_id]
          );
        }
      }

      return { remainingBalance: remaining, isFullySettled: fullySettled };
    });

    // 4. Publish Real-time events
    await eventBus.publish('PAYMENT_COMPLETED', paymentId, {
      paymentId,
      orderId,
      amount,
      method: PaymentMethod.CREDIT_CARD,
      rrn: terminalResponse.rrn,
      isFullySettled,
    });

    if (isFullySettled && order.table_id) {
      await eventBus.publish('TABLE_STATE_CHANGED', order.table_id, {
        tableId: order.table_id,
        tableNumber: order.table_number,
        previousStatus: TableStatus.OCCUPIED,
        newStatus: TableStatus.DIRTY,
      });
    }

    return {
      paymentId,
      orderId,
      terminalResponse,
      remainingBalance,
      isFullySettled,
    };
  }

  /**
   * Executes End of Day (Z / Gün Sonu) Settlement on physical terminal
   */
  public async executeSettlement(terminalId: string = 'BKM-POS-01'): Promise<TerminalSettlementResponse> {
    const result = await posTerminalDriver.executeSettlement(terminalId);

    // Record settlement in terminal logs
    await db.query(
      `INSERT INTO payment_terminal_logs (
        id, terminal_id, connection_type, command_type, amount, currency,
        status_code, status_message, slip_text, created_at
      ) VALUES ($1, $2, $3, $4, $5, 'TRY', '00', 'SETTLEMENT COMPLETED', $6, NOW())`,
      [
        randomUUID(),
        terminalId,
        TerminalConnectionType.TCP,
        TerminalCommandType.SETTLEMENT,
        result.totalSaleAmount,
        result.slipText,
      ]
    );

    return result;
  }

  /**
   * Retrieves terminal audit logs
   */
  public async getTerminalLogs(limit: number = 50): Promise<PaymentTerminalLog[]> {
    const res = await db.query(
      `SELECT * FROM payment_terminal_logs ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    return res.rows;
  }
}

export const posTerminalService = PosTerminalService.getInstance();
