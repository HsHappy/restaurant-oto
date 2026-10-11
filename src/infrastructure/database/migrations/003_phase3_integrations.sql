-- ====================================================================
-- ENTERPRISE RMS - EDGE NODE MIGRATION 003
-- Phase 3: Aggregators, Payment Terminals, Fiscal e-Transformation & Cloud Sync
-- ====================================================================

-- 1. Dış Siparişler (Pazar Yeri / Aggregator Siparişleri)
CREATE TABLE IF NOT EXISTS external_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    platform VARCHAR(50) NOT NULL, -- 'YEMEKSEPETI', 'GETIR', 'TRENDYOL', 'MIGROS_YEMEK'
    external_order_id VARCHAR(100) NOT NULL,
    external_order_number VARCHAR(100),
    platform_status VARCHAR(50) NOT NULL DEFAULT 'NEW', 
    -- 'NEW', 'ACCEPTED', 'PREPARING', 'RIDER_DISPATCH', 'PICKED_UP', 'DELIVERED', 'CANCELLED'
    auto_accepted BOOLEAN NOT NULL DEFAULT FALSE,
    rider_name VARCHAR(100),
    rider_phone VARCHAR(50),
    customer_delivery_address TEXT,
    customer_notes TEXT,
    package_pin VARCHAR(20),
    raw_payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_platform_external_order UNIQUE (platform, external_order_id)
);

CREATE INDEX IF NOT EXISTS idx_ext_orders_platform_status 
ON external_orders (platform, platform_status);

CREATE INDEX IF NOT EXISTS idx_ext_orders_order_id 
ON external_orders (order_id);

-- 2. Banka POS & Ödeme Terminali Logları (Fiziksel / Sanal POS Cihaz Kayıtları)
CREATE TABLE IF NOT EXISTS payment_terminal_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
    payment_id UUID REFERENCES payments(id) ON DELETE SET NULL,
    terminal_id VARCHAR(50) NOT NULL,
    connection_type VARCHAR(20) NOT NULL DEFAULT 'TCP', -- 'TCP', 'SERIAL', 'VIRTUAL_POS'
    command_type VARCHAR(30) NOT NULL, -- 'SALE', 'VOID', 'REFUND', 'SETTLEMENT'
    amount NUMERIC(12, 2) NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'TRY',
    status_code VARCHAR(10) NOT NULL, -- '00' for Success
    status_message VARCHAR(255),
    auth_code VARCHAR(50),
    rrn VARCHAR(50), -- Retrieval Reference Number
    slip_text TEXT,
    raw_response TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_terminal_logs_order 
ON payment_terminal_logs (order_id);

CREATE INDEX IF NOT EXISTS idx_terminal_logs_created 
ON payment_terminal_logs (created_at DESC);

-- 3. Mali Belgeler (GİB e-Adisyon, e-Fatura, e-Arşiv UBL-TR XML Kayıtları)
CREATE TABLE IF NOT EXISTS fiscal_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    document_type VARCHAR(50) NOT NULL, -- 'E_ADISYON', 'E_FATURA', 'E_ARSIV'
    document_uuid UUID NOT NULL DEFAULT gen_random_uuid(),
    document_number VARCHAR(100) NOT NULL, -- ör: EAD2026000000001
    profile_id VARCHAR(50) NOT NULL DEFAULT 'EADISYON', -- 'EADISYON', 'EARSIVFATURA', 'TICARIFATURA'
    taxpayer_vkn_tckn VARCHAR(20),
    taxpayer_title VARCHAR(255),
    total_payable_amount NUMERIC(12, 2) NOT NULL,
    tax_exclusive_amount NUMERIC(12, 2) NOT NULL,
    tax_total_amount NUMERIC(12, 2) NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'TRY',
    ubl_xml TEXT NOT NULL,
    qr_code_data TEXT NOT NULL,
    gib_status_code VARCHAR(50) NOT NULL DEFAULT 'DRAFT', -- 'DRAFT', 'QUEUED', 'SUCCESS', 'FAILED'
    signed_hash VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sent_to_gib_at TIMESTAMPTZ,
    CONSTRAINT uq_fiscal_doc_number UNIQUE (document_number)
);

CREATE INDEX IF NOT EXISTS idx_fiscal_order 
ON fiscal_documents (order_id);

CREATE INDEX IF NOT EXISTS idx_fiscal_doc_uuid 
ON fiscal_documents (document_uuid);

-- 4. Bulut Senkronizasyon Kontrol Noktaları (Sync Checkpoints)
CREATE TABLE IF NOT EXISTS sync_checkpoints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    sync_type VARCHAR(50) NOT NULL, -- 'UPSTREAM_EVENTS', 'DOWNSTREAM_CATALOG', 'DOWNSTREAM_PRICING'
    last_synced_sequence BIGINT NOT NULL DEFAULT 0,
    last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status VARCHAR(30) NOT NULL DEFAULT 'SUCCESS',
    error_message TEXT,
    CONSTRAINT uq_branch_sync_type UNIQUE (branch_id, sync_type)
);

-- 5. Bulut Senkronizasyon Kuyruğu & Çakışma Yönetimi (Sync Queue & CRDT Resolution)
CREATE TABLE IF NOT EXISTS sync_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    direction VARCHAR(20) NOT NULL DEFAULT 'UPSTREAM', -- 'UPSTREAM', 'DOWNSTREAM'
    entity_type VARCHAR(50) NOT NULL, -- 'ORDER', 'ITEM', 'PAYMENT', 'PRODUCT', 'STOCK'
    entity_id VARCHAR(100) NOT NULL,
    operation VARCHAR(20) NOT NULL, -- 'INSERT', 'UPDATE', 'DELETE'
    payload JSONB NOT NULL,
    version INT NOT NULL DEFAULT 1,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING', -- 'PENDING', 'SYNCED', 'CONFLICT', 'FAILED'
    retry_count INT NOT NULL DEFAULT 0,
    conflict_resolution VARCHAR(50), -- 'LWW', 'GROW_ONLY_SET', 'MANUAL'
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    synced_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sync_queue_pending 
ON sync_queue (direction, status, created_at) 
WHERE status = 'PENDING';
