# Enterprise Restaurant Management System (RMS) - Edge Core POS & Hardware Service

Bu servis; `docs/spec.md` teknik şartnamesine uygun olarak, şube yerel ağında (LAN) internet bağlantısı kesilse dahi **sıfır kesintiyle (<15ms gecikme)** çalışan **FAZ 1: Core POS & Edge Node** çekirdek backend platformudur.

---

## 🏛 Mimari ve Katmanlar (Clean Architecture)

Proje katmanları:

```
src/
├── core/
│   ├── domain/
│   │   ├── entities/       # Branch, Table, Order, OrderItem, Product, Recipe, Inventory, Payment, Audit
│   │   ├── enums/          # TableStatus, OrderStatus, OrderItemStatus, PaymentMethod, PreparationStation
│   │   └── errors/         # DomainError (TableLockedError, InvalidManagerPinError, etc.)
│   └── events/             # DomainEvent ve IEventBus arayüzleri
├── infrastructure/
│   ├── database/
│   │   ├── db.ts           # PostgreSQL 16 Pool + Embedded PGlite (WASM PG16) çift modlu bağlantı yöneticisi
│   │   ├── migrator.ts     # Otomatik DDL migration çalıştırıcısı
│   │   ├── seed.ts         # Şube, 10 Masa, 4 Kategori, 8 Ürün, Reçete (BOM) ve Stok tohumlayıcı
│   │   └── migrations/     # 001_initial_schema.sql (Şartname 4.2 tam DDL şeması)
│   ├── bus/
│   │   └── LocalEventBus.ts# Şube içi Event-driven pub/sub mesaj dağıtıcısı
│   └── websocket/
│       └── WebSocketGateway.ts # POS ve El Terminalleri için anlık LAN WebSocket yayıncısı
├── hardware/
│   └── printer/
│       ├── EscPosBuilder.ts # Saf binary ESC/POS komut formatlayıcı (Müşteri adisyonu, Mutfak fişi, Çekmece)
│       ├── NetworkPrinter.ts# Raw TCP Socket (Port 9100) sürücüsü + Çevrimdışı hata kuyruğu (offline buffer)
│       └── PrinterService.ts# Yüksek seviyeli fiş ve istasyon bileşeni
├── modules/
│   ├── tables/             # TableService (State Machine & Concurrency Lock) + TableController
│   ├── orders/             # OrderService + SplitBillEngine (3 Algoritma) + OrderController
│   ├── payments/           # PaymentService (Parçalı ödeme & otomatik masa kapatma) + PaymentController
│   ├── hardware/           # PrinterController (Fiş, mutfak ve para çekmecesi endpoint'leri)
│   └── audit/              # AuditService (Kriptografik SHA-256 zincirli denetim izi) + AuditController
├── app.ts                  # Fastify sunucu montajı, CORS, WebSockets ve hata yakalayıcı
└── server.ts               # Sunucu başlatıcı (Graceful shutdown ile)
```

---

## 🚀 Kurulum ve Çalıştırma

### 1. Docker ile Başlatma (PostgreSQL 16 + Redis + App)
```bash
docker-compose up -d
```

### 2. Yerel Ortamda Çalıştırma (Node.js LTS)
Sistem, yerel PostgreSQL kurulu olmadığında bile sıfır konfigürasyonla in-process **Embedded PostgreSQL 16 (PGlite WASM)** motoruna otomatik geçerek kesintisiz çalışır.

```bash
# Bağımlılıkları yükle
npm install

# Veritabanını tohumla (Şube, masalar, menü ve reçeteler)
npm run seed

# Geliştirme modunda başlat
npm run dev

# TypeScript derle
npm run build

# Tüm 18 adımlı uçtan uca entegrasyon testini çalıştır
npm test
```

---

## 🧪 Entegrasyon Test Senaryoları (`npm test`)

`test/integration-test.ts` dosyası aşağıdaki tüm aşamaları sırasıyla ve doğrulanmış assertion'lar ile test eder:

1. **Sistem Durumu:** `/health` kontrolü (Database Mode: PostgreSQL/PGlite, WebSocket bağlı istemci sayısı).
2. **Masa Listesi:** 10 adet masanın (Salon-1'den 6'ya, Teras-1'den 4'e) listelenmesi.
3. **Optimistik Çift Kilit Koruması (Concurrency Lock):** 1. garson masayı kilitlediğinde 2. garsonun `409 TableLockedError` ile engellenmesi.
4. **Masa Açma & Adisyon Başlatma:** Masanın `AVAILABLE` durumundan `OCCUPIED` durumuna geçirilmesi ve sipariş oluşturulması.
5. **Menü & Ürün Ekleme:** Ek malzeme (modifier: "Ekstra Cheddar") içeren burgerler, patates ve içeceklerin adisyona eklenmesi.
6. **4-Eye Principle (Çift Onay Kuralı):** 
   - Yanlış müdür PIN kodu girildiğinde `403 Forbidden (InvalidManagerPinError)` fırlatılması.
   - Doğru müdür PIN kodu ile %10 indirim uygulanması veya ürünün ikram (`is_complimentary = true`, tutar = 0) yapılması.
7. **Adisyon Bölme (Split Bill) Algoritmaları:**
   - **EQUAL (Eşit Bölme):** Kuruş yuvarlamaları dengeli dağıtılarak N kişiye eşit bölüştürme.
   - **CUSTOM_AMOUNT (Özel Tutar):** Kalan bakiyeye göre serbest tutar onaylama.
   - **BY_ITEM (Kalem Bazlı Bölme):** Belirli ürünlerin yeni adisyona aktarılması.
8. **Ödeme & Otomatik Kapanış (Payment Engine):**
   - Parçalı Nakit ödeme alınması (300.00 TL).
   - Kalan bakiyenin Kredi Kartı ile tahsil edilip siparişin `SETTLED` durumuna gelmesi.
   - Masanın otomatik olarak `DIRTY` statüsüne geçmesi.
   - Masanın temizlenerek `AVAILABLE` durumuna dönmesi.
9. **Donanım ESC/POS Ağ Yazıcısı:**
   - Müşteri adisyonu binary ESC/POS çıktısı üretilmesi (`DLE DC4` çekmece ve `GS V A` kağıt kesme ile).
   - Mutfak (GRILL) istasyon fişi üretilmesi.
   - Ağ yazıcısı kapalı/çevrimdışı olduğunda job'ların `offline buffer` kuyruğuna alınması ve POS'un kilitlenmemesi.
10. **Kriptografik SHA-256 Denetim İzi (Audit Trail):**
   - Tüm işlemlerin SHA-256 hash zinciriyle `audit_logs` tablosuna yazılması.
   - Zincir bütünlüğünün doğrulanması (`verifyAuditChain()` -> `%100 Valid`).

---

## 📡 REST API & WebSocket Endpoint'leri

| Modül | Metod | Endpoint | Açıklama |
| :--- | :--- | :--- | :--- |
| **Sistem** | `GET` | `/health` | Sistem ve donanım sağlık durumu |
| **WebSockets**| `WS` | `/ws` | LAN anlık olay yayını (`TABLE_STATE_CHANGED`, vb.) |
| **Masalar** | `GET` | `/api/v1/tables` | Şubedeki masaları listele |
| | `GET` | `/api/v1/tables/:id` | Masa detayını ve aktif adisyonu getir |
| | `POST` | `/api/v1/tables/:id/open` | Masa aç ve aktif sipariş bağla |
| | `PATCH` | `/api/v1/tables/:id/status` | Masa durumunu güncelle (`AVAILABLE`, `DIRTY`, vb.) |
| | `POST` | `/api/v1/tables/:id/lock` | Masayı işlem için kilitle (concurrency lock) |
| | `POST` | `/api/v1/tables/:id/unlock` | Masa kilidini kaldır |
| **Siparişler** | `GET` | `/api/v1/orders/menu` | Menü kategorilerini ve ürünleri getir |
| | `POST` | `/api/v1/orders` | Yeni bağımsız sipariş oluştur |
| | `GET` | `/api/v1/orders/:id` | Sipariş detayını, kalemleri ve ödemeleri getir |
| | `POST` | `/api/v1/orders/:id/items` | Siparişe ek malzemeli ürün ekle |
| | `DELETE`| `/api/v1/orders/:id/items/:itemId` | Ürün iptal et (Müdür PIN ve zayi kaydı ile) |
| | `POST` | `/api/v1/orders/:id/discount` | İndirim / İkram uygula (Müdür PIN doğrulaması ile) |
| | `POST` | `/api/v1/orders/:id/split` | Adisyonu böl (`EQUAL`, `BY_ITEM`, `CUSTOM_AMOUNT`) |
| **Ödemeler** | `POST` | `/api/v1/payments` | Nakit / Kredi Kartı tahsilatı yap |
| | `GET` | `/api/v1/payments/order/:orderId` | Siparişe ait ödeme hareketleri |
| **Yazıcı** | `POST` | `/api/v1/printer/receipt` | Müşteri adisyonu fişi bas (ESC/POS Raw 9100) |
| | `POST` | `/api/v1/printer/kitchen` | Mutfak istasyon fişi bas |
| | `POST` | `/api/v1/printer/drawer` | Para çekmecesini tetikle (`DLE DC4` / `ESC p`) |
| | `GET` | `/api/v1/printer/queue` | Çevrimdışı yazıcı kuyruğunu incele |
| **Denetim** | `GET` | `/api/v1/audit/logs` | Kriptografik audit log kayıtlarını listele |
| | `GET` | `/api/v1/audit/verify` | SHA-256 hash zincirinin bozulmadığını doğrula |
