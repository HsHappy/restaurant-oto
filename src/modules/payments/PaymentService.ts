import { db } from '../../infrastructure/database/db.js';
import { Payment, Order, DiningTable } from '../../core/domain/entities/index.js';
import { PaymentMethod, OrderStatus, TableStatus } from '../../core/domain/enums/index.js';
import {
  OrderNotFoundError,
  OrderAlreadySettledError,
  InsufficientPaymentError,
} from '../../core/domain/errors/DomainError.js';
import { eventBus } from '../../infrastructure/bus/LocalEventBus.js';
import { auditService } from '../audit/AuditService.js';
import { orderService } from '../orders/OrderService.js';
import { randomUUID } from 'node:crypto';

export interface ProcessPaymentInput {
  orderId: string;
  method: PaymentMethod;
  amount: number;
  actorId: string;
  transactionReference?: string;
}

export interface PaymentResult {
  payment: Payment;
  order: Order;
  totalPaid: number;
  remainingBalance: number;
  isFullySettled: boolean;
}

export class PaymentService {
  /**
   * Processes cash or credit card partial/full payment, closes order if settled
   */
  public async processPayment(input: ProcessPaymentInput): Promise<PaymentResult> {
    const paymentAmount = Number(input.amount);
    if (isNaN(paymentAmount) || paymentAmount <= 0) {
      throw new InsufficientPaymentError(0);
    }

    return await db.transaction(async (tx) => {
      // 1. Lock and check order
      const orderRes = await tx.query<Order>(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [input.orderId]);
      if (orderRes.rows.length === 0) {
        throw new OrderNotFoundError(input.orderId);
      }
      const order = orderRes.rows[0];
      if (order.status === OrderStatus.SETTLED) {
        throw new OrderAlreadySettledError(input.orderId);
      }

      // 2. Fetch existing payments
      const existingPayRes = await tx.query<{ total: number }>(
        `SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE order_id = $1 AND status = 'COMPLETED'`,
        [input.orderId]
      );
      const priorPaid = Number(existingPayRes.rows[0]?.total || 0);
      const grandTotal = Number(order.grand_total);
      const remainingBefore = Math.max(0, Number((grandTotal - priorPaid).toFixed(2)));

      if (paymentAmount > remainingBefore + 0.01) {
        throw new InsufficientPaymentError(remainingBefore);
      }

      // 3. Insert payment
      const paymentId = randomUUID();
      const now = new Date();
      await tx.query(
        `INSERT INTO payments (
          id, order_id, payment_method, amount, currency, transaction_reference, status, paid_at
        ) VALUES ($1, $2, $3, $4, 'TRY', $5, 'COMPLETED', $6)`,
        [paymentId, input.orderId, input.method, paymentAmount, input.transactionReference || null, now]
      );

      const newTotalPaid = Number((priorPaid + paymentAmount).toFixed(2));
      const remainingAfter = Math.max(0, Number((grandTotal - newTotalPaid).toFixed(2)));
      const isFullySettled = remainingAfter <= 0.009;

      // 4. If fully settled, close order and transition table
      if (isFullySettled) {
        await tx.query(
          `UPDATE orders SET status = $1, closed_at = $2, version = version + 1 WHERE id = $3`,
          [OrderStatus.SETTLED, now, input.orderId]
        );
        order.status = OrderStatus.SETTLED;
        order.closed_at = now;

        // Transition table to DIRTY
        if (order.table_id) {
          await tx.query(
            `UPDATE dining_tables 
             SET current_status = $1, active_order_id = NULL, locked_by = NULL, locked_at = NULL 
             WHERE id = $2`,
            [TableStatus.DIRTY, order.table_id]
          );

          await auditService.log(
            {
              branchId: order.branch_id,
              actorId: input.actorId,
              entityName: 'DINING_TABLE',
              entityId: order.table_id,
              actionType: 'TABLE_STATUS_DIRTY',
              reason: 'Order fully settled. Table marked dirty for cleaning.',
            },
            tx
          );

          await eventBus.publish('TABLE_STATE_CHANGED', order.table_id, {
            tableId: order.table_id,
            previousStatus: TableStatus.OCCUPIED,
            newStatus: TableStatus.DIRTY,
            activeOrderId: null,
          });
        }

        // Full settlement audit
        await auditService.log(
          {
            branchId: order.branch_id,
            actorId: input.actorId,
            entityName: 'ORDER',
            entityId: input.orderId,
            actionType: 'SETTLE_ORDER',
            afterState: { grandTotal, totalPaid: newTotalPaid, closedAt: now.toISOString() },
            reason: 'Order paid in full and settled',
          },
          tx
        );

        await eventBus.publish('ORDER_SETTLED', input.orderId, {
          orderId: input.orderId,
          tableId: order.table_id,
          grandTotal,
          totalPaid: newTotalPaid,
        });
      } else {
        // Partial payment audit
        await auditService.log(
          {
            branchId: order.branch_id,
            actorId: input.actorId,
            entityName: 'PAYMENT',
            entityId: paymentId,
            actionType: 'PARTIAL_PAYMENT',
            afterState: { paymentAmount, method: input.method, remainingAfter },
          },
          tx
        );
      }

      await eventBus.publish('PAYMENT_PROCESSED', paymentId, {
        paymentId,
        orderId: input.orderId,
        amount: paymentAmount,
        method: input.method,
        remainingBalance: remainingAfter,
        isFullySettled,
      });

      const payment: Payment = {
        id: paymentId,
        order_id: input.orderId,
        payment_method: input.method,
        amount: paymentAmount,
        currency: 'TRY',
        transaction_reference: input.transactionReference,
        status: 'COMPLETED',
        paid_at: now,
      };

      const fullOrder = await orderService.getOrderById(input.orderId, tx);

      return {
        payment,
        order: fullOrder,
        totalPaid: newTotalPaid,
        remainingBalance: remainingAfter,
        isFullySettled,
      };
    });
  }

  /**
   * Retrieves all payments for an order
   */
  public async getPaymentsForOrder(orderId: string): Promise<Payment[]> {
    const res = await db.query<Payment>(
      `SELECT * FROM payments WHERE order_id = $1 ORDER BY paid_at ASC`,
      [orderId]
    );
    return res.rows;
  }
}

export const paymentService = new PaymentService();
