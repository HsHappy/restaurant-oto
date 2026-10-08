-- ====================================================================
-- ENTERPRISE RMS - EDGE NODE MIGRATION 001
-- PostgreSQL 16 DDL for Local Offline-First Edge Node
-- ====================================================================

-- Native gen_random_uuid() is built into PostgreSQL 13+
-- Extensions can be enabled if available
DO $$ 
BEGIN 
  CREATE EXTENSION IF NOT EXISTS "pgcrypto";
EXCEPTION WHEN OTHERS THEN 
  NULL;
END $$;


-- Şubeler Tablosu
CREATE TABLE IF NOT EXISTS branches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(150) NOT NULL,
    tax_number VARCHAR(20) NOT NULL,
    tax_office VARCHAR(100),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Masalar Tablosu
CREATE TABLE IF NOT EXISTS dining_tables (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    table_number VARCHAR(20) NOT NULL,
    section VARCHAR(50) NOT NULL DEFAULT 'Ana Salon',
    capacity INT NOT NULL DEFAULT 4,
    current_status VARCHAR(30) NOT NULL DEFAULT 'AVAILABLE',
    -- 'AVAILABLE', 'OCCUPIED', 'RESERVED', 'BILL_REQUESTED', 'DIRTY'
    active_order_id UUID,
    pos_x INT DEFAULT 0,
    pos_y INT DEFAULT 0,
    locked_by VARCHAR(100),
    locked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_branch_table UNIQUE (branch_id, table_number)
);

CREATE INDEX IF NOT EXISTS idx_tables_status ON dining_tables (branch_id, current_status);

-- Kategoriler Tablosu
CREATE TABLE IF NOT EXISTS categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    sort_order INT NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Ürünler Tablosu
CREATE TABLE IF NOT EXISTS products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
    sku VARCHAR(50) UNIQUE NOT NULL,
    barcode VARCHAR(50),
    name VARCHAR(150) NOT NULL,
    base_price NUMERIC(12, 2) NOT NULL,
    tax_rate NUMERIC(5, 2) NOT NULL DEFAULT 10.00,
    preparation_station VARCHAR(50) NOT NULL DEFAULT 'GRILL', -- 'GRILL', 'BAR', 'OVEN', 'COLD'
    standard_prep_time_minutes INT NOT NULL DEFAULT 15,
    is_available BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_products_category ON products (category_id);
CREATE INDEX IF NOT EXISTS idx_products_station ON products (preparation_station);

-- Siparişler (Adisyonlar) Tablosu
CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    branch_id UUID NOT NULL REFERENCES branches(id),
    table_id UUID REFERENCES dining_tables(id),
    waiter_id UUID NOT NULL,
    order_number VARCHAR(50) NOT NULL, -- ör: B1-20261008-0042
    order_type VARCHAR(30) NOT NULL DEFAULT 'DINE_IN', -- 'DINE_IN', 'TAKEAWAY', 'AGGREGATOR'
    aggregator_type VARCHAR(50), -- 'YEMEKSEPETI', 'GETIR', 'TRENDYOL'
    status VARCHAR(30) NOT NULL DEFAULT 'OPEN', -- 'OPEN', 'SETTLED', 'CANCELLED', 'MERGED'
    subtotal NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    discount_total NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    tax_total NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    grand_total NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at TIMESTAMPTZ,
    version INT NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_orders_open ON orders (branch_id, status) WHERE status = 'OPEN';
CREATE INDEX IF NOT EXISTS idx_orders_opened_at ON orders (branch_id, opened_at);
CREATE INDEX IF NOT EXISTS idx_orders_table ON orders (table_id);

-- Sipariş Kalemleri Tablosu
CREATE TABLE IF NOT EXISTS order_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id),
    quantity INT NOT NULL CHECK (quantity > 0),
    unit_price NUMERIC(12, 2) NOT NULL,
    total_price NUMERIC(12, 2) NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'QUEUED', 
    -- 'QUEUED', 'PREPARING', 'READY', 'SERVED', 'CANCELLED'
    is_complimentary BOOLEAN NOT NULL DEFAULT FALSE,
    cancel_reason VARCHAR(255),
    selected_modifiers JSONB DEFAULT '[]'::jsonb, -- [{"name": "Ekstra Peynir", "extra_price": 25.00}]
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    bumped_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_order_items_kds ON order_items (order_id, status);

-- Hammadde ve Envanter Tablosu
CREATE TABLE IF NOT EXISTS inventory_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    branch_id UUID NOT NULL REFERENCES branches(id),
    sku VARCHAR(50) NOT NULL,
    name VARCHAR(150) NOT NULL,
    unit_of_measure VARCHAR(20) NOT NULL, -- 'GR', 'ML', 'ADET', 'KG'
    current_stock NUMERIC(14, 4) NOT NULL DEFAULT 0.0000,
    safety_threshold NUMERIC(14, 4) NOT NULL DEFAULT 10.0000,
    unit_cost NUMERIC(12, 4) NOT NULL DEFAULT 0.0000,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_branch_inventory_sku UNIQUE (branch_id, sku)
);

-- Reçeteler Tablosu (BOM)
CREATE TABLE IF NOT EXISTS recipes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID UNIQUE NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    yield_quantity NUMERIC(8, 2) NOT NULL DEFAULT 1.00,
    instructions TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Reçete Kalemleri
CREATE TABLE IF NOT EXISTS recipe_ingredients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipe_id UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    inventory_item_id UUID NOT NULL REFERENCES inventory_items(id),
    quantity_needed NUMERIC(12, 4) NOT NULL,
    waste_percentage NUMERIC(5, 2) NOT NULL DEFAULT 0.00
);

-- Ödemeler Tablosu
CREATE TABLE IF NOT EXISTS payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id),
    payment_method VARCHAR(30) NOT NULL, -- 'CASH', 'CREDIT_CARD', 'MEAL_VOUCHER', 'GIFT_CARD'
    amount NUMERIC(12, 2) NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'TRY',
    transaction_reference VARCHAR(100),
    status VARCHAR(20) NOT NULL DEFAULT 'COMPLETED', -- 'COMPLETED', 'REFUNDED'
    paid_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_order ON payments (order_id);

-- Değiştirilemez Denetim İzi (Audit Log - Cryptographically chained with SHA-256)
CREATE TABLE IF NOT EXISTS audit_logs (
    sequence_num BIGSERIAL,
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    branch_id UUID NOT NULL REFERENCES branches(id),
    actor_id UUID NOT NULL,
    entity_name VARCHAR(50) NOT NULL, -- 'ORDER', 'ORDER_ITEM', 'PAYMENT', 'TABLE'
    entity_id UUID NOT NULL,
    action_type VARCHAR(50) NOT NULL, -- 'CANCEL_ITEM', 'APPLY_DISCOUNT', 'VOID_ORDER', 'SETTLE_BILL'
    before_state JSONB,
    after_state JSONB,
    reason VARCHAR(255),
    ip_address VARCHAR(45),
    previous_hash VARCHAR(64),
    current_hash VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_branch_date ON audit_logs (branch_id, created_at);

-- Transactional Outbox Events (Offline-first event store for cloud synchronization)
CREATE TABLE IF NOT EXISTS outbox_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    aggregate_type VARCHAR(50) NOT NULL,
    aggregate_id UUID NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING', -- 'PENDING', 'PROCESSED', 'FAILED'
    retry_count INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox_events (status, created_at) WHERE status = 'PENDING';
