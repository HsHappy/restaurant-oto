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

export enum AggregatorPlatform {
  YEMEKSEPETI = 'YEMEKSEPETI',
  GETIR = 'GETIR',
  TRENDYOL = 'TRENDYOL',
  MIGROS_YEMEK = 'MIGROS_YEMEK',
}

export enum AggregatorOrderStatus {
  NEW = 'NEW',
  ACCEPTED = 'ACCEPTED',
  PREPARING = 'PREPARING',
  RIDER_DISPATCH = 'RIDER_DISPATCH',
  PICKED_UP = 'PICKED_UP',
  DELIVERED = 'DELIVERED',
  CANCELLED = 'CANCELLED',
}

export enum FiscalDocumentType {
  E_ADISYON = 'E_ADISYON',
  E_FATURA = 'E_FATURA',
  E_ARSIV = 'E_ARSIV',
}

export enum GibDocumentStatus {
  DRAFT = 'DRAFT',
  QUEUED = 'QUEUED',
  PROCESSING = 'PROCESSING',
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
}

export enum TerminalCommandType {
  SALE = 'SALE',
  VOID = 'VOID',
  REFUND = 'REFUND',
  SETTLEMENT = 'SETTLEMENT',
}

export enum TerminalConnectionType {
  TCP = 'TCP',
  SERIAL = 'SERIAL',
  VIRTUAL_POS = 'VIRTUAL_POS',
}

export enum SyncDirection {
  UPSTREAM = 'UPSTREAM',
  DOWNSTREAM = 'DOWNSTREAM',
}

export enum SyncStatus {
  PENDING = 'PENDING',
  SYNCED = 'SYNCED',
  CONFLICT = 'CONFLICT',
  FAILED = 'FAILED',
}

export enum SyncType {
  UPSTREAM_EVENTS = 'UPSTREAM_EVENTS',
  DOWNSTREAM_CATALOG = 'DOWNSTREAM_CATALOG',
  DOWNSTREAM_PRICING = 'DOWNSTREAM_PRICING',
}

