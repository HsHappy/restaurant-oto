-- ====================================================================
-- ENTERPRISE RMS - EDGE NODE MIGRATION 002
-- KDS (Kitchen Display System), Hold & Fire Cook Pacing, Station Logs
-- ====================================================================

-- 1. Order Items tablosuna KDS Hold & Fire alanları ekle
ALTER TABLE order_items 
ADD COLUMN IF NOT EXISTS fire_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS prep_started_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS ready_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS bumped_by VARCHAR(100),
ADD COLUMN IF NOT EXISTS customer_notes VARCHAR(255);

-- 2. KDS performans indeksleri
CREATE INDEX IF NOT EXISTS idx_order_items_kds_station_status 
ON order_items (status, fire_at);

CREATE INDEX IF NOT EXISTS idx_order_items_prep_started 
ON order_items (prep_started_at);

-- 3. Mutfak İstasyonu Eylem ve Geri Alma (Recall LIFO) Günlüğü
CREATE TABLE IF NOT EXISTS kds_station_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    order_item_id UUID REFERENCES order_items(id) ON DELETE CASCADE,
    station VARCHAR(50) NOT NULL,
    action VARCHAR(30) NOT NULL, -- 'HOLD', 'FIRE', 'PREPARING', 'BUMP', 'RECALL'
    actor_id VARCHAR(100),
    previous_status VARCHAR(30),
    new_status VARCHAR(30),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


CREATE INDEX IF NOT EXISTS idx_kds_logs_station_created 
ON kds_station_logs (station, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_kds_logs_order 
ON kds_station_logs (order_id, created_at DESC);
