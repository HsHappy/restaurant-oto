import { db, IDbClient } from '../../infrastructure/database/db.js';
import { Order, OrderItem, Product, DiningTable } from '../../core/domain/entities/index.js';
import {
  OrderStatus,
  OrderItemStatus,
  OrderType,
  TableStatus,
} from '../../core/domain/enums/index.js';
import {
  OrderNotFoundError,
  OrderAlreadySettledError,
  ItemNotFoundError,
  InvalidManagerPinError,
  InvalidSplitError,
} from '../../core/domain/errors/DomainError.js';
import { eventBus } from '../../infrastructure/bus/LocalEventBus.js';
import { auditService } from '../audit/AuditService.js';
import { SplitBillEngine, EqualSplitResult } from './SplitBillEngine.js';
import { randomUUID } from 'node:crypto';

export interface AddItemInput {
  productId: string;
  quantity: number;
  modifiers?: { name: string; extra_price: number }[];
}

export class OrderService {
  /**
   * Retrieves order with all line items and payments
   */
  public async getOrderById(orderId: string, client: IDbClient = db): Promise<Order> {
    const orderRes = await client.query<Order>(
      `SELECT o.*, t.table_number 
       FROM orders o 
       LEFT JOIN dining_tables t ON o.table_id = t.id 
       WHERE o.id = $1`,
      [orderId]
    );

    if (orderRes.rows.length === 0) {
      throw new OrderNotFoundError(orderId);
    }

    const order = orderRes.rows[0];

    // Fetch items with product details
    const itemsRes = await client.query<OrderItem>(
      `SELECT oi.*, p.name as product_name, p.preparation_station
       FROM order_items oi
       JOIN products p ON oi.product_id = p.id
       WHERE oi.order_id = $1
       ORDER BY oi.created_at ASC`,
      [orderId]
    );
    order.items = itemsRes.rows;

    // Fetch payments
    const paymentsRes = await client.query(
      `SELECT * FROM payments WHERE order_id = $1 ORDER BY paid_at ASC`,
      [orderId]
    );
    order.payments = paymentsRes.rows;

    return order;
  }


  /**
   * Creates a new standalone order (takeaway or dine-in)
   */
  public async createOrder(
    branchId: string,
    waiterId: string,
    tableId?: string,
    orderType: OrderType = OrderType.DINE_IN
  ): Promise<Order> {
    const id = randomUUID();
    const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const randPart = Math.floor(1000 + Math.random() * 9000);
    const orderNumber = `ORD-${datePart}-${randPart}`;

    await db.query(
      `INSERT INTO orders (
        id, branch_id, table_id, waiter_id, order_number, order_type,
        status, subtotal, discount_total, tax_total, grand_total, opened_at, version
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 0.00, 0.00, 0.00, 0.00, NOW(), 1)`,
      [id, branchId, tableId || null, waiterId, orderNumber, orderType, OrderStatus.OPEN]
    );

    return await this.getOrderById(id);
  }

  /**
   * Adds product item to order and recalculates totals
   */
  public async addItemToOrder(
    orderId: string,
    input: AddItemInput,
    waiterId: string
  ): Promise<{ order: Order; newItem: OrderItem }> {
    return await db.transaction(async (tx) => {
      const orderRes = await tx.query<Order>(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
      if (orderRes.rows.length === 0) {
        throw new OrderNotFoundError(orderId);
      }
      const order = orderRes.rows[0];
      if (order.status !== OrderStatus.OPEN) {
        throw new OrderAlreadySettledError(orderId);
      }

      // Fetch product
      const prodRes = await tx.query<Product>(`SELECT * FROM products WHERE id = $1`, [input.productId]);
      if (prodRes.rows.length === 0) {
        throw new ItemNotFoundError(`Product ${input.productId}`);
      }
      const product = prodRes.rows[0];

      // Calculate unit price including modifiers
      const basePrice = Number(product.base_price);
      const modifiers = input.modifiers || [];
      const modifiersExtra = modifiers.reduce((acc, m) => acc + Number(m.extra_price || 0), 0);
      const unitPrice = Number((basePrice + modifiersExtra).toFixed(2));
      const totalPrice = Number((unitPrice * input.quantity).toFixed(2));

      const itemId = randomUUID();
      await tx.query(
        `INSERT INTO order_items (
          id, order_id, product_id, quantity, unit_price, total_price,
          status, is_complimentary, selected_modifiers, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, $8, NOW())`,
        [
          itemId,
          orderId,
          product.id,
          input.quantity,
          unitPrice,
          totalPrice,
          OrderItemStatus.QUEUED,
          JSON.stringify(modifiers),
        ]
      );

      // Recalculate totals
      await this.recalculateOrderTotals(orderId, tx);

      // Audit log
      await auditService.log(
        {
          branchId: order.branch_id,
          actorId: waiterId,
          entityName: 'ORDER_ITEM',
          entityId: itemId,
          actionType: 'ADD_ITEM',
          afterState: { productId: product.id, name: product.name, quantity: input.quantity, totalPrice },
        },
        tx
      );

      const updatedOrder = await this.getOrderByIdInternal(orderId, tx);
      const newItem = updatedOrder.items?.find((i) => i.id === itemId)!;

      // Event notification
      await eventBus.publish('ORDER_UPDATED', orderId, {
        orderId,
        action: 'ADD_ITEM',
        newItem,
        grandTotal: updatedOrder.grand_total,
      });

      return { order: updatedOrder, newItem };
    });
  }

  /**
   * Applies Discount or Complimentary (İkram / İskonto) with 4-Eye Manager PIN check
   */
  public async applyDiscountOrComp(
    orderId: string,
    discountType: 'PERCENT' | 'FIXED' | 'COMPLIMENTARY',
    amount: number,
    managerPin: string,
    actorId: string,
    itemId?: string
  ): Promise<Order> {
    const requiredPin = process.env.MANAGER_PIN || '1234';
    if (!managerPin || managerPin !== requiredPin) {
      throw new InvalidManagerPinError();
    }

    return await db.transaction(async (tx) => {
      const orderRes = await tx.query<Order>(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
      if (orderRes.rows.length === 0) {
        throw new OrderNotFoundError(orderId);
      }
      const order = orderRes.rows[0];
      if (order.status !== OrderStatus.OPEN) {
        throw new OrderAlreadySettledError(orderId);
      }

      if (discountType === 'COMPLIMENTARY') {
        if (!itemId) {
          throw new InvalidSplitError('Complimentary (İkram) requires a specific item ID');
        }
        const itemRes = await tx.query<OrderItem>(`SELECT * FROM order_items WHERE id = $1 AND order_id = $2`, [
          itemId,
          orderId,
        ]);
        if (itemRes.rows.length === 0) {
          throw new ItemNotFoundError(`Order item ${itemId}`);
        }

        // Set is_complimentary to true and total_price to 0.00
        await tx.query(
          `UPDATE order_items SET is_complimentary = TRUE, total_price = 0.00 WHERE id = $1`,
          [itemId]
        );

        await auditService.log(
          {
            branchId: order.branch_id,
            actorId,
            entityName: 'ORDER_ITEM',
            entityId: itemId,
            actionType: 'APPLY_COMPLIMENTARY',
            reason: `Item marked as complimentary by manager approval`,
          },
          tx
        );
      } else if (discountType === 'PERCENT') {
        if (amount <= 0 || amount > 100) {
          throw new InvalidSplitError('Percentage discount must be between 1 and 100');
        }
        const subtotal = Number(order.subtotal);
        const discountAmount = Number(((subtotal * amount) / 100).toFixed(2));
        await tx.query(`UPDATE orders SET discount_total = $1 WHERE id = $2`, [discountAmount, orderId]);

        await auditService.log(
          {
            branchId: order.branch_id,
            actorId,
            entityName: 'ORDER',
            entityId: orderId,
            actionType: 'APPLY_PERCENT_DISCOUNT',
            afterState: { percentage: amount, discountAmount },
          },
          tx
        );
      } else if (discountType === 'FIXED') {
        if (amount <= 0 || amount > Number(order.subtotal)) {
          throw new InvalidSplitError('Fixed discount cannot exceed order subtotal');
        }
        await tx.query(`UPDATE orders SET discount_total = $1 WHERE id = $2`, [amount, orderId]);

        await auditService.log(
          {
            branchId: order.branch_id,
            actorId,
            entityName: 'ORDER',
            entityId: orderId,
            actionType: 'APPLY_FIXED_DISCOUNT',
            afterState: { discountAmount: amount },
          },
          tx
        );
      }

      await this.recalculateOrderTotals(orderId, tx);
      const updated = await this.getOrderByIdInternal(orderId, tx);

      await eventBus.publish('ORDER_UPDATED', orderId, {
        orderId,
        action: 'DISCOUNT_APPLIED',
        discountType,
        grandTotal: updated.grand_total,
      });

      return updated;
    });
  }

  /**
   * Cancels an order item with reason and manager authorization
   */
  public async cancelItem(
    orderId: string,
    itemId: string,
    reason: string,
    wasteRecorded: boolean,
    managerPin: string,
    actorId: string
  ): Promise<Order> {
    const requiredPin = process.env.MANAGER_PIN || '1234';
    if (!managerPin || managerPin !== requiredPin) {
      throw new InvalidManagerPinError();
    }

    return await db.transaction(async (tx) => {
      const orderRes = await tx.query<Order>(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
      if (orderRes.rows.length === 0) throw new OrderNotFoundError(orderId);
      const order = orderRes.rows[0];

      const itemRes = await tx.query<OrderItem>(`SELECT * FROM order_items WHERE id = $1 AND order_id = $2`, [
        itemId,
        orderId,
      ]);
      if (itemRes.rows.length === 0) throw new ItemNotFoundError(itemId);
      const item = itemRes.rows[0];

      await tx.query(
        `UPDATE order_items SET status = $1, cancel_reason = $2, total_price = 0.00 WHERE id = $3`,
        [OrderItemStatus.CANCELLED, reason, itemId]
      );

      await this.recalculateOrderTotals(orderId, tx);

      await auditService.log(
        {
          branchId: order.branch_id,
          actorId,
          entityName: 'ORDER_ITEM',
          entityId: itemId,
          actionType: 'CANCEL_ITEM',
          beforeState: item,
          afterState: { status: OrderItemStatus.CANCELLED, wasteRecorded, reason },
          reason,
        },
        tx
      );

      return await this.getOrderByIdInternal(orderId, tx);
    });
  }

  /**
   * Splits an order using BY_ITEM, EQUAL, or CUSTOM_AMOUNT
   */
  public async splitOrder(
    orderId: string,
    type: 'BY_ITEM' | 'EQUAL' | 'CUSTOM_AMOUNT',
    payload: any,
    actorId: string
  ): Promise<any> {
    const order = await this.getOrderById(orderId);
    if (order.status !== OrderStatus.OPEN) {
      throw new OrderAlreadySettledError(orderId);
    }

    const totalPaid = (order.payments || []).reduce((acc, p) => acc + Number(p.amount), 0);

    if (type === 'EQUAL') {
      const parts = Number(payload.parts || 2);
      return SplitBillEngine.calculateEqualSplit(order.grand_total, totalPaid, parts);
    }

    if (type === 'CUSTOM_AMOUNT') {
      const requested = Number(payload.amount);
      const validAmount = SplitBillEngine.validateCustomAmount(order.grand_total, totalPaid, requested);
      return {
        orderId,
        grandTotal: order.grand_total,
        totalPaid,
        remainingBefore: order.grand_total - totalPaid,
        approvedAmount: validAmount,
      };
    }

    if (type === 'BY_ITEM') {
      const itemSplits: { itemId: string; quantity: number }[] = payload.itemSplits;
      SplitBillEngine.validateItemSplit(order.items || [], itemSplits);

      return await db.transaction(async (tx) => {
        // 1. Create new split order
        const newOrderId = randomUUID();
        const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const randPart = Math.floor(1000 + Math.random() * 9000);
        const newOrderNumber = `${order.order_number}-SPLIT-${randPart}`;

        await tx.query(
          `INSERT INTO orders (
            id, branch_id, table_id, waiter_id, order_number, order_type,
            status, subtotal, discount_total, tax_total, grand_total, opened_at, version
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, 0.00, 0.00, 0.00, 0.00, NOW(), 1)`,
          [newOrderId, order.branch_id, order.table_id, actorId, newOrderNumber, order.order_type, OrderStatus.OPEN]
        );

        // 2. Transfer items
        for (const split of itemSplits) {
          const original = order.items!.find((i) => i.id === split.itemId)!;
          if (split.quantity === original.quantity) {
            // Move whole item to new order
            await tx.query(`UPDATE order_items SET order_id = $1 WHERE id = $2`, [newOrderId, original.id]);
          } else {
            // Split item quantity
            const remainingQty = original.quantity - split.quantity;
            const remainingTotal = Number((Number(original.unit_price) * remainingQty).toFixed(2));
            await tx.query(
              `UPDATE order_items SET quantity = $1, total_price = $2 WHERE id = $3`,
              [remainingQty, remainingTotal, original.id]
            );

            // Create new item in target order
            const newTotal = Number((Number(original.unit_price) * split.quantity).toFixed(2));
            await tx.query(
              `INSERT INTO order_items (
                id, order_id, product_id, quantity, unit_price, total_price,
                status, is_complimentary, selected_modifiers, created_at
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
              [
                randomUUID(),
                newOrderId,
                original.product_id,
                split.quantity,
                original.unit_price,
                newTotal,
                original.status,
                original.is_complimentary,
                JSON.stringify(original.selected_modifiers),
              ]
            );
          }
        }

        // Recalculate totals for both orders
        await this.recalculateOrderTotals(orderId, tx);
        await this.recalculateOrderTotals(newOrderId, tx);

        // Audit log
        await auditService.log(
          {
            branchId: order.branch_id,
            actorId,
            entityName: 'ORDER',
            entityId: orderId,
            actionType: 'SPLIT_ORDER_BY_ITEM',
            afterState: { newOrderId, newOrderNumber, itemSplits },
          },
          tx
        );

        const originalUpdated = await this.getOrderByIdInternal(orderId, tx);
        const splitOrder = await this.getOrderByIdInternal(newOrderId, tx);

        return {
          originalOrder: originalUpdated,
          splitOrder,
        };
      });
    }

    throw new InvalidSplitError(`Unsupported split type: ${type}`);
  }

  /**
   * Internal order fetcher inside a transaction
   */
  private async getOrderByIdInternal(orderId: string, client: IDbClient): Promise<Order> {
    const orderRes = await client.query<Order>(
      `SELECT o.*, t.table_number 
       FROM orders o 
       LEFT JOIN dining_tables t ON o.table_id = t.id 
       WHERE o.id = $1`,
      [orderId]
    );
    const order = orderRes.rows[0];
    const itemsRes = await client.query<OrderItem>(
      `SELECT oi.*, p.name as product_name, p.preparation_station
       FROM order_items oi
       JOIN products p ON oi.product_id = p.id
       WHERE oi.order_id = $1
       ORDER BY oi.created_at ASC`,
      [orderId]
    );
    order.items = itemsRes.rows;
    const paymentsRes = await client.query(
      `SELECT * FROM payments WHERE order_id = $1 ORDER BY paid_at ASC`,
      [orderId]
    );
    order.payments = paymentsRes.rows;
    return order;
  }

  /**
   * Recalculates subtotal, tax_total, grand_total for an order
   */
  public async recalculateOrderTotals(orderId: string, client: IDbClient = db): Promise<void> {
    const itemsRes = await client.query<{ total_price: number; tax_rate: number; is_complimentary: boolean }>(
      `SELECT oi.total_price, oi.is_complimentary, p.tax_rate
       FROM order_items oi
       JOIN products p ON oi.product_id = p.id
       WHERE oi.order_id = $1 AND oi.status != $2`,
      [orderId, OrderItemStatus.CANCELLED]
    );

    let subtotal = 0;
    let taxTotal = 0;

    for (const item of itemsRes.rows) {
      if (!item.is_complimentary) {
        const itemPrice = Number(item.total_price);
        subtotal += itemPrice;
        const rate = Number(item.tax_rate || 10.0);
        // Tax included or added calculation
        taxTotal += (itemPrice * rate) / (100 + rate);
      }
    }

    subtotal = Number(subtotal.toFixed(2));
    taxTotal = Number(taxTotal.toFixed(2));

    const orderRes = await client.query<{ discount_total: number }>(
      `SELECT discount_total FROM orders WHERE id = $1`,
      [orderId]
    );
    const discount = Number(orderRes.rows[0]?.discount_total || 0);

    const grandTotal = Math.max(0, Number((subtotal - discount).toFixed(2)));

    await client.query(
      `UPDATE orders 
       SET subtotal = $1, tax_total = $2, grand_total = $3, version = version + 1 
       WHERE id = $4`,
      [subtotal, taxTotal, grandTotal, orderId]
    );
  }
}

export const orderService = new OrderService();
