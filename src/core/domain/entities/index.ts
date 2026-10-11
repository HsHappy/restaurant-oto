import {
  TableStatus,
  OrderStatus,
  OrderItemStatus,
  PaymentMethod,
  OrderType,
  PreparationStation,
  AggregatorPlatform,
  AggregatorOrderStatus,
  FiscalDocumentType,
  GibDocumentStatus,
  TerminalCommandType,
  TerminalConnectionType,
  SyncDirection,
  SyncStatus,
  SyncType,
} from '../enums/index.js';

export interface Branch {
  id: string;
  name: string;
  tax_number: string;
  tax_office?: string | null;
  is_active: boolean;
  created_at: Date;
}

export interface DiningTable {
  id: string;
  branch_id: string;
  table_number: string;
  section: string;
  capacity: number;
  current_status: TableStatus;
  active_order_id?: string | null;
  pos_x?: number;
  pos_y?: number;
  locked_by?: string | null;
  locked_at?: Date | null;
  created_at: Date;
}

export interface Category {
  id: string;
  name: string;
  sort_order: number;
  is_active: boolean;
  created_at: Date;
}

export interface Product {
  id: string;
  category_id?: string | null;
  sku: string;
  barcode?: string | null;
  name: string;
  base_price: number;
  tax_rate: number;
  preparation_station: PreparationStation | string;
  standard_prep_time_minutes: number;
  is_available: boolean;
  created_at: Date;
}

export interface ModifierItem {
  name: string;
  extra_price: number;
}

export interface OrderItem {
  id: string;
  order_id: string;
  product_id: string;
  product_name?: string;
  preparation_station?: PreparationStation | string;
  standard_prep_time_minutes?: number;
  quantity: number;
  unit_price: number;
  total_price: number;
  status: OrderItemStatus;
  is_complimentary: boolean;
  cancel_reason?: string | null;
  selected_modifiers: ModifierItem[];
  fire_at?: Date | null;
  prep_started_at?: Date | null;
  ready_at?: Date | null;
  bumped_by?: string | null;
  customer_notes?: string | null;
  created_at: Date;
  bumped_at?: Date | null;
}

export interface KdsStationLog {
  id: string;
  order_id: string;
  order_item_id: string;
  station: string;
  action: string;
  actor_id?: string | null;
  previous_status?: string | null;
  new_status?: string | null;
  created_at: Date;
}

export interface KdsTicketItem extends OrderItem {
  is_held: boolean;
  time_remaining_seconds: number;
}

export interface KdsTicket {
  order_id: string;
  order_number: string;
  table_id?: string | null;
  table_number: string;
  waiter_id: string;
  opened_at: Date;
  elapsed_seconds: number;
  max_prep_time_minutes: number;
  sla_status: 'NORMAL' | 'WARNING' | 'CRITICAL';
  station: string;
  items: KdsTicketItem[];
  all_items_ready: boolean;
}


export interface Order {
  id: string;
  branch_id: string;
  table_id?: string | null;
  table_number?: string;
  waiter_id: string;
  order_number: string;
  order_type: OrderType;
  aggregator_type?: string | null;
  status: OrderStatus;
  subtotal: number;
  discount_total: number;
  tax_total: number;
  grand_total: number;
  opened_at: Date;
  closed_at?: Date | null;
  version: number;
  items?: OrderItem[];
  payments?: Payment[];
}

export interface InventoryItem {
  id: string;
  branch_id: string;
  sku: string;
  name: string;
  unit_of_measure: string;
  current_stock: number;
  safety_threshold: number;
  unit_cost: number;
  updated_at: Date;
}

export interface Recipe {
  id: string;
  product_id: string;
  yield_quantity: number;
  instructions?: string | null;
  created_at: Date;
  ingredients?: RecipeIngredient[];
}

export interface RecipeIngredient {
  id: string;
  recipe_id: string;
  inventory_item_id: string;
  inventory_item_name?: string;
  quantity_needed: number;
  waste_percentage: number;
}

export interface Payment {
  id: string;
  order_id: string;
  payment_method: PaymentMethod;
  amount: number;
  currency: string;
  transaction_reference?: string | null;
  status: 'COMPLETED' | 'REFUNDED';
  paid_at: Date;
}

export interface AuditLog {
  id: string;
  branch_id: string;
  actor_id: string;
  entity_name: string;
  entity_id: string;
  action_type: string;
  before_state?: any;
  after_state?: any;
  reason?: string | null;
  ip_address?: string | null;
  previous_hash?: string | null;
  current_hash: string;
  created_at: Date;
}

export interface OutboxEvent {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: any;
  status: 'PENDING' | 'PROCESSED' | 'FAILED';
  retry_count: number;
  created_at: Date;
  processed_at?: Date | null;
}

// ================= Phase 3 Interfaces =================

export interface CanonicalCustomer {
  name: string;
  phone?: string;
  delivery_address?: string;
  notes?: string;
}

export interface CanonicalOrderItem {
  sku?: string;
  product_id?: string;
  product_name: string;
  quantity: number;
  unit_price: number;
  total_price: number;
  selected_modifiers?: { name: string; extra_price: number }[];
  customer_notes?: string;
}

export interface CanonicalOrder {
  platform: AggregatorPlatform;
  external_order_id: string;
  external_order_number?: string;
  customer: CanonicalCustomer;
  items: CanonicalOrderItem[];
  subtotal: number;
  discount_total: number;
  grand_total: number;
  payment_method: string;
  package_pin?: string;
  requested_delivery_time?: string;
  raw_payload: any;
}

export interface ExternalOrder {
  id: string;
  order_id: string;
  platform: AggregatorPlatform;
  external_order_id: string;
  external_order_number?: string | null;
  platform_status: AggregatorOrderStatus;
  auto_accepted: boolean;
  rider_name?: string | null;
  rider_phone?: string | null;
  customer_delivery_address?: string | null;
  customer_notes?: string | null;
  package_pin?: string | null;
  raw_payload: any;
  created_at: Date;
  updated_at: Date;
}

export interface TerminalSaleRequest {
  orderId?: string;
  amount: number;
  currency?: string;
  installment?: number;
  terminalId?: string;
  connectionType?: TerminalConnectionType;
}

export interface TerminalSaleResponse {
  success: boolean;
  statusCode: string;
  statusMessage: string;
  terminalId: string;
  amount: number;
  currency: string;
  authCode: string;
  rrn: string;
  slipText: string;
  rawResponse?: string;
  timestamp: string;
}

export interface TerminalSettlementResponse {
  success: boolean;
  terminalId: string;
  batchNumber: string;
  totalTxCount: number;
  totalSaleAmount: number;
  slipText: string;
  timestamp: string;
}

export interface PaymentTerminalLog {
  id: string;
  order_id?: string | null;
  payment_id?: string | null;
  terminal_id: string;
  connection_type: TerminalConnectionType;
  command_type: TerminalCommandType;
  amount: number;
  currency: string;
  status_code: string;
  status_message?: string | null;
  auth_code?: string | null;
  rrn?: string | null;
  slip_text?: string | null;
  raw_response?: string | null;
  created_at: Date;
}

export interface TaxpayerInfo {
  vkn_tckn: string;
  title: string;
  tax_office?: string;
  address?: string;
  is_e_invoice_taxpayer?: boolean;
}

export interface FiscalDocument {
  id: string;
  order_id: string;
  document_type: FiscalDocumentType;
  document_uuid: string;
  document_number: string;
  profile_id: string;
  taxpayer_vkn_tckn?: string | null;
  taxpayer_title?: string | null;
  total_payable_amount: number;
  tax_exclusive_amount: number;
  tax_total_amount: number;
  currency: string;
  ubl_xml: string;
  qr_code_data: string;
  gib_status_code: GibDocumentStatus;
  signed_hash?: string | null;
  created_at: Date;
  sent_to_gib_at?: Date | null;
}

export interface SyncCheckpoint {
  id: string;
  branch_id: string;
  sync_type: SyncType;
  last_synced_sequence: number;
  last_synced_at: Date;
  status: string;
  error_message?: string | null;
}

export interface SyncQueueItem {
  id: string;
  direction: SyncDirection;
  entity_type: string;
  entity_id: string;
  operation: 'INSERT' | 'UPDATE' | 'DELETE';
  payload: any;
  version: number;
  status: SyncStatus;
  retry_count: number;
  conflict_resolution?: string | null;
  created_at: Date;
  synced_at?: Date | null;
}
