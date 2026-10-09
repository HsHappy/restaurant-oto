export enum TableStatus {
  AVAILABLE = 'AVAILABLE',
  OCCUPIED = 'OCCUPIED',
  RESERVED = 'RESERVED',
  BILL_REQUESTED = 'BILL_REQUESTED',
  DIRTY = 'DIRTY',
}

export enum OrderStatus {
  OPEN = 'OPEN',
  SETTLED = 'SETTLED',
  CANCELLED = 'CANCELLED',
  MERGED = 'MERGED',
}

export enum OrderItemStatus {
  HOLD = 'HOLD',
  QUEUED = 'QUEUED',
  PREPARING = 'PREPARING',
  READY = 'READY',
  SERVED = 'SERVED',
  CANCELLED = 'CANCELLED',
}

export enum PaymentMethod {
  CASH = 'CASH',
  CREDIT_CARD = 'CREDIT_CARD',
  MEAL_VOUCHER = 'MEAL_VOUCHER',
  GIFT_CARD = 'GIFT_CARD',
}

export enum OrderType {
  DINE_IN = 'DINE_IN',
  TAKEAWAY = 'TAKEAWAY',
  AGGREGATOR = 'AGGREGATOR',
}

export enum PreparationStation {
  GRILL = 'GRILL',
  BAR = 'BAR',
  OVEN = 'OVEN',
  COLD = 'COLD',
  EXPEDITOR = 'EXPEDITOR',
}

export enum KdsAction {
  HOLD = 'HOLD',
  FIRE = 'FIRE',
  PREPARING = 'PREPARING',
  BUMP = 'BUMP',
  RECALL = 'RECALL',
}

