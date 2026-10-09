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

## 🍳 FAZ 2: KDS (Kitchen Display System) & Garson Mobil Terminali

Faz 2 kapsamında mutfak operasyonlarını ve salon garson yönetimini sıfır gecikmeyle koordine eden gerçek zamanlı KDS ve mobil el terminali altyapısı inşa edilmiştir:

### 1. Akıllı Pişirme Zamanlaması (Cook Time Pacing / Hold & Fire Motoru)
- **Farklı Pişirme Süresi Optimizasyonu:** Aynı masada sipariş edilen farklı hazırlık süreli ürünlerin (örn: 20 dk Antrikot ile 5 dk Salata) eş zamanlı sıcak servis edilmesini garanti eder.
- **Formül:** $T_{\text{hedef}} = T_{\text{siparis}} + \max(T_{\text{prep}})$; $T_{\text{fire}} = T_{\text{hedef}} - T_{\text{ürün\_prep}}$
- **Hold & Fire:** Kısa süren ürünler `HOLD` statüsünde bekletilir; süresi geldiğinde arka plan zamanlayıcısı tarafından otomatik olarak `QUEUED` statüsüne `FIRE` edilir. Gerektiğinde şef tarafından anında zorunlu pişirmeye (`forceFire`) alınabilir.

### 2. KDS Kiosk Web İstemcisi (`/kds`)
- **İstasyon Rotalaması:** `GRILL`, `BAR`, `OVEN`, `COLD` veya tüm mutfağı yöneten `EXPEDITOR` (Toplayıcı/Şef) ekran filtreleri.
- **Endüstriyel Bump Bar Klavye Desteği:**
  - `ENTER`: Seçili veya ilk aktfi bileti tamamla (Bump).
  - `F1` veya `Z`: Yanlışlıkla tamamlanan bileti LIFO kuyruğundan geri al (Recall).
  - `F2` veya `H`: Kalemi beklemede (`HOLD`) durumuna al.
  - `SPACE`: Beklemedeki ürünü anında pişirmeye zorla (`FIRE`).
- **Dinamik SLA & Web Audio API Ses Sentezi:**
  - Süre < %50: Canlı Yeşil
  - Süre %50 - %100: Uyarı Sarısı + Tekil bip sesi
  - Süre > %100: Yanıp sönen Acil Kırmızı + Alarm sesi
- **Canlı WebSocket:** Sipariş eklendiğinde veya ateşlendiğinde sıfır sayfa yenileme ile bilet akışı.

### 3. Garson Mobil Terminali (`/waiter`)
- **Masa Krokisi & Canlı Plan:** Masaların anlık renk kodlu durumları (`AVAILABLE`, `OCCUPIED`, `BILL_REQUESTED`, `DIRTY`).
- **Hızlı Sipariş Girişi (UX Optimized):** Kategori filtreleri, arama, varyasyon ve pişme derecesi seçimi, dinamik ek malzemeler (modifiers) ve özel müşteri notları ("Tuzsuz", "Sos ayrı").
- **Masa Operasyonları:** Masadan tek tuşla hesap isteme (`BILL_REQUESTED`) ve masalar arası aktif sipariş taşıma (`transfer-table`).
- **Mutfak Hazır Bildirimleri (KDS Ready Alerts):** Mutfakta bir ürün `READY` olduğunda garson el terminalinde görsel banner, sesli sinyal ve titreşim (Web Vibration API - 200ms haptic feedback) ile anlık servis çağrısı.

---

## 📡 REST API & WebSocket Endpoint'leri

| Modül | Metod | Endpoint | Açıklama |
| :--- | :--- | :--- | :--- |
| **Sistem & UI** | `GET` | `/health` | Sistem ve donanım sağlık durumu |
| | `GET` | `/kds` | KDS Mutfak Ekranı Web Kiosk Arayüzü |
| | `GET` | `/waiter` | Garson Mobil El Terminali Web / PWA Arayüzü |
| **WebSockets**| `WS` | `/ws` | LAN anlık olay yayını (`KDS:*`, `WAITER:*`, `TABLE_*`) |
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
| **KDS (Mutfak)**| `GET` | `/api/v1/kds/tickets` | İstasyon bazlı mutfak biletlerini listele (`?station=GRILL`) |
| | `POST` | `/api/v1/kds/items/:id/bump` | Kalemi mutfakta hazır olarak tamamla (Bump) |
| | `POST` | `/api/v1/kds/tickets/:orderId/bump` | Biletteki tüm istasyon kalemlerini tamamla |
| | `POST` | `/api/v1/kds/recall` | Son bump yapılan bileti/kalemi geri al (LIFO Recall) |
| | `POST` | `/api/v1/kds/items/:id/fire` | Beklemedeki (`HOLD`) kalemi zorla pişirmeye ver (`FIRE`) |
| | `POST` | `/api/v1/kds/items/:id/hold` | Kalemi beklemeye (`HOLD`) al |
| | `POST` | `/api/v1/kds/items/:id/serve`| Garson servis onayını kaydet (`SERVED`) |
| **Garson (Mobil)**| `GET` | `/api/v1/waiter/tables` | Masalar, aktif tutarlar ve hazır ürün sayaçları |
| | `POST` | `/api/v1/waiter/quick-order` | Cook Time Pacing optimizasyonlu hızlı sipariş girişi |
| | `POST` | `/api/v1/waiter/request-bill`| Masadan hesap isteme aksiyonu |
| | `POST` | `/api/v1/waiter/transfer-table`| Masayı ve aktif siparişi başka masaya taşıma |
| **Ödemeler** | `POST` | `/api/v1/payments` | Nakit / Kredi Kartı tahsilatı yap |
| | `GET` | `/api/v1/payments/order/:orderId` | Siparişe ait ödeme hareketleri |
| **Yazıcı** | `POST` | `/api/v1/printer/receipt` | Müşteri adisyonu fişi bas (ESC/POS Raw 9100) |
| | `POST` | `/api/v1/printer/kitchen` | Mutfak istasyon fişi bas |
| | `POST` | `/api/v1/printer/drawer` | Para çekmecesini tetikle (`DLE DC4` / `ESC p`) |
| | `GET` | `/api/v1/printer/queue` | Çevrimdışı yazıcı kuyruğunu incele |
| **Denetim** | `GET` | `/api/v1/audit/logs` | Kriptografik audit log kayıtlarını listele |
| | `GET` | `/api/v1/audit/verify` | SHA-256 hash zincirinin bozulmadığını doğrula |

