import { InvalidSplitError } from '../../core/domain/errors/DomainError.js';
import { Order, OrderItem } from '../../core/domain/entities/index.js';

export interface EqualSplitResult {
  parts: number;
  totalRemaining: number;
  shares: { partNumber: number; amount: number }[];
}

export interface ByItemSplitInput {
  itemSplits: { itemId: string; quantity: number }[];
  targetWaiterId: string;
}

export class SplitBillEngine {
  /**
   * Calculates exact equal division of grand total into N parts, distributing rounding cents cleanly.
   */
  public static calculateEqualSplit(grandTotal: number, totalPaid: number, parts: number): EqualSplitResult {
    if (parts <= 1) {
      throw new InvalidSplitError('Equal split must be divided into at least 2 parts');
    }

    const remaining = Math.max(0, Number((grandTotal - totalPaid).toFixed(2)));
    if (remaining <= 0) {
      throw new InvalidSplitError('Order is already fully paid');
    }

    const baseAmount = Math.floor((remaining / parts) * 100) / 100;
    const remainderCents = Math.round((remaining - baseAmount * parts) * 100);

    const shares: { partNumber: number; amount: number }[] = [];
    for (let i = 0; i < parts; i++) {
      // Add 1 cent to earlier shares until remainder is exhausted
      const extraCent = i < remainderCents ? 0.01 : 0.0;
      const shareAmount = Number((baseAmount + extraCent).toFixed(2));
      shares.push({
        partNumber: i + 1,
        amount: shareAmount,
      });
    }

    return {
      parts,
      totalRemaining: remaining,
      shares,
    };
  }

  /**
   * Validates custom amount against remaining balance
   */
  public static validateCustomAmount(grandTotal: number, totalPaid: number, requestedAmount: number): number {
    const remaining = Math.max(0, Number((grandTotal - totalPaid).toFixed(2)));
    if (requestedAmount <= 0) {
      throw new InvalidSplitError('Payment amount must be greater than 0');
    }
    if (requestedAmount > remaining + 0.001) {
      throw new InvalidSplitError(`Amount ${requestedAmount.toFixed(2)} TL exceeds remaining balance of ${remaining.toFixed(2)} TL`);
    }
    return requestedAmount;
  }

  /**
   * Validates item-level split request against current order items
   */
  public static validateItemSplit(items: OrderItem[], itemSplits: { itemId: string; quantity: number }[]): void {
    if (!itemSplits || itemSplits.length === 0) {
      throw new InvalidSplitError('Must select at least one item to split');
    }

    for (const split of itemSplits) {
      const existing = items.find((it) => it.id === split.itemId);
      if (!existing) {
        throw new InvalidSplitError(`Item ID ${split.itemId} not found in this order`);
      }
      if (split.quantity <= 0 || split.quantity > existing.quantity) {
        throw new InvalidSplitError(
          `Invalid quantity ${split.quantity} for item '${existing.product_name || existing.id}'. Current quantity: ${existing.quantity}`
        );
      }
    }
  }
}
