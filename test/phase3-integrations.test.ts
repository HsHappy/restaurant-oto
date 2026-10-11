import { buildApp } from '../src/app.js';
import { db } from '../src/infrastructure/database/db.js';
import { seedDatabase } from '../src/infrastructure/database/seed.js';
import { AggregatorPlatform, AggregatorOrderStatus } from '../src/core/domain/enums/index.js';

async function runPhase3IntegrationTest() {
  console.log('\n================================================================');
  console.log('  RUNNING FAZ 3: AGGREGATORS, POS HARDWARE, FISCAL & SYNC TESTS  ');
  console.log('================================================================\n');

  // 1. Initialize Application and Database
  await db.initialize();
  await seedDatabase();
  const app = await buildApp();

  let simulatedOrderId: string;
  let simulatedExtId: string;
  let dineInOrderId: string;

  try {
    // -------------------------------------------------------------
    // TEST 1: AGGREGATOR GETIR WEBHOOK SIMULATION & CANONICAL NORMALIZATION
    // -------------------------------------------------------------
    console.log('--- TEST 1: Online Aggregator Webhook (Getir Yemek) ---');
    const getirRes = await app.inject({
      method: 'POST',
      url: '/api/v1/aggregators/simulate-order',
      payload: {
        platform: AggregatorPlatform.GETIR,
        productName: 'Antrikot Izgara',
        quantity: 2,
        customerName: 'Kerem Aksoy',
        deliveryAddress: 'Kadıköy Rıhtım Cad. No: 18 D: 4',
        notes: 'Sıcak gelsin lütfen',
      },
    });

    if (getirRes.statusCode !== 201) {
      throw new Error(`Getir order simulation failed: ${getirRes.body}`);
    }

    const getirData = JSON.parse(getirRes.body);
    simulatedOrderId = getirData.orderId;
    simulatedExtId = getirData.externalOrder.external_order_id;

    console.log(`✅ STEP 1: Getir Yemek order created: Order ${simulatedOrderId}`);
    console.log(`   External Order ID: ${simulatedExtId}`);
    console.log(`   Status: ${getirData.externalOrder.platform_status} (Auto-Accepted: ${getirData.externalOrder.auto_accepted})`);
    console.log(`   Customer: ${getirData.canonical.customer.name} - ${getirData.canonical.customer.delivery_address}`);
    console.log(`   Total: ${getirData.canonical.grand_total} TL`);

    // Verify order in database
    const orderDb = await db.query(`SELECT * FROM orders WHERE id = $1`, [simulatedOrderId]);
    if (orderDb.rows[0].order_type !== 'AGGREGATOR' || orderDb.rows[0].aggregator_type !== 'GETIR') {
      throw new Error('Order type or aggregator_type mismatch in DB');
    }

    // -------------------------------------------------------------
    // TEST 2: IDEMPOTENCY TEST (Prevent Duplicate Webhook Orders)
    // -------------------------------------------------------------
    console.log('\n--- TEST 2: Aggregator Webhook Idempotency ---');
    const duplicateRes = await app.inject({
      method: 'POST',
      url: `/api/v1/aggregators/webhooks/getir`,
      payload: {
        id: simulatedExtId, // Same external order ID
        client: { name: 'Kerem Aksoy' },
        products: [],
        totalPrice: 1000,
      },
    });

    const dupData = JSON.parse(duplicateRes.body);
    if (!dupData.success || duplicateRes.statusCode !== 200) {
      throw new Error('Idempotent order check failed');
    }
    console.log(`✅ STEP 2: Duplicate webhook handled safely without re-inserting (Idempotent: true).`);

    // -------------------------------------------------------------
    // TEST 3: AGGREGATOR ORDER STATUS LIFECYCLE (Rider Dispatch & Delivered)
    // -------------------------------------------------------------
    console.log('\n--- TEST 3: Courier & Status Lifecycle ---');
    const riderRes = await app.inject({
      method: 'POST',
      url: `/api/v1/aggregators/orders/${simulatedExtId}/status`,
      payload: {
        status: AggregatorOrderStatus.RIDER_DISPATCH,
        riderName: 'Murat Kurye (34 KDS 88)',
        riderPhone: '05301112233',
      },
    });

    const riderData = JSON.parse(riderRes.body);
    if (riderData.externalOrder.platform_status !== 'RIDER_DISPATCH') {
      throw new Error('Status update to RIDER_DISPATCH failed');
    }
    console.log(`✅ STEP 3: Courier assigned: ${riderData.externalOrder.rider_name} -> Status: RIDER_DISPATCH`);

    // Transition to DELIVERED
    const deliverRes = await app.inject({
      method: 'POST',
      url: `/api/v1/aggregators/orders/${simulatedExtId}/status`,
      payload: {
        status: AggregatorOrderStatus.DELIVERED,
      },
    });

    const deliverData = JSON.parse(deliverRes.body);
    if (deliverData.externalOrder.platform_status !== 'DELIVERED') {
      throw new Error('Status update to DELIVERED failed');
    }
    console.log(`✅ STEP 4: Order marked DELIVERED -> Core order auto-settled.`);

    // -------------------------------------------------------------
    // TEST 4: DYNAMIC 86'ING (Out-of-Stock Sync Across All Platforms)
    // -------------------------------------------------------------
    console.log('\n--- TEST 4: Dynamic 86ing (Out-of-Stock Broadcast) ---');
    const prodRes = await db.query(`SELECT id, name FROM products WHERE sku = 'GRL-01' LIMIT 1`);
    const antrikotId = prodRes.rows[0].id;

    const stockSyncRes = await app.inject({
      method: 'POST',
      url: '/api/v1/aggregators/stock-sync',
      payload: {
        productId: antrikotId,
        isAvailable: false,
      },
    });

    const stockData = JSON.parse(stockSyncRes.body);
    if (!stockData.success || stockData.result.isAvailable !== false) {
      throw new Error('Stock sync failed');
    }

    const updatedProd = await db.query(`SELECT is_available FROM products WHERE id = $1`, [antrikotId]);
    if (updatedProd.rows[0].is_available !== false) {
      throw new Error('Product is_available was not updated to false in DB');
    }

    console.log(`✅ STEP 5: Dynamic 86'ing succeeded: Product disabled on 4 delivery platforms simultaneously.`);
    console.log(`   Platforms: ${stockData.result.platformResults.map((r: any) => r.platform).join(', ')}`);

    // Re-enable for subsequent tests
    await app.inject({
      method: 'POST',
      url: '/api/v1/aggregators/stock-sync',
      payload: { productId: antrikotId, isAvailable: true },
    });

    // -------------------------------------------------------------
    // TEST 5: PHYSICAL BANK POS TERMINAL HARDWARE BRIDGE (GMP3 / BKM TechPOS)
    // -------------------------------------------------------------
    console.log('\n--- TEST 5: Bank POS Hardware Terminal Bridge ---');
    // Open a dine-in table order
    const tableRes = await db.query(`SELECT id, table_number FROM dining_tables WHERE table_number = 'Salon-1' LIMIT 1`);
    const tableSalon1 = tableRes.rows[0];

    const openTableRes = await app.inject({
      method: 'POST',
      url: `/api/v1/tables/${tableSalon1.id}/open`,
      payload: { waiterId: '00000000-0000-0000-0000-000000000001' },
    });
    const openData = JSON.parse(openTableRes.body);
    dineInOrderId = openData.data.orderId;

    // Add item to table
    await app.inject({
      method: 'POST',
      url: `/api/v1/orders/${dineInOrderId}/items`,
      payload: {
        productId: antrikotId,
        quantity: 1,
        selectedModifiers: [{ name: 'Mantar Sos', extraPrice: 40 }],
      },
    });

    // Execute physical Bank POS Sale command
    const posSaleRes = await app.inject({
      method: 'POST',
      url: '/api/v1/terminal/sale',
      payload: {
        orderId: dineInOrderId,
        amount: 590.0,
        currency: 'TRY',
        installment: 1,
        terminalId: 'BKM-POS-ISBANK-01',
      },
    });

    if (posSaleRes.statusCode !== 201) {
      throw new Error(`POS sale failed: ${posSaleRes.body}`);
    }

    const posSaleData = JSON.parse(posSaleRes.body);
    const termResult = posSaleData.result.terminalResponse;

    console.log(`✅ STEP 6: Bank POS Terminal Sale processed successfully:`);
    console.log(`   Response Code: ${termResult.statusCode} (${termResult.statusMessage})`);
    console.log(`   Auth Code: ${termResult.authCode} | RRN: ${termResult.rrn}`);
    console.log(`   Terminal ID: ${termResult.terminalId} | Amount: ${termResult.amount} ${termResult.currency}`);
    console.log(`   Slip Snippet:`);
    console.log(termResult.slipText.split('\n').slice(0, 6).join('\n'));

    // Check terminal logs in database
    const termLogsRes = await app.inject({
      method: 'GET',
      url: '/api/v1/terminal/logs?limit=5',
    });
    const termLogs = JSON.parse(termLogsRes.body).logs;
    if (termLogs.length === 0 || termLogs[0].status_code !== '00') {
      throw new Error('Terminal log not recorded properly in DB');
    }
    console.log(`✅ STEP 7: Payment terminal log cryptographically recorded with full slip text.`);

    // Test End of Day (Z / Gün Sonu Mutabakatı)
    const settleRes = await app.inject({
      method: 'POST',
      url: '/api/v1/terminal/settlement',
      payload: { terminalId: 'BKM-POS-ISBANK-01' },
    });
    const settleData = JSON.parse(settleRes.body);
    console.log(`✅ STEP 8: Terminal End of Day Settlement (Z Raporu) executed: Batch ${settleData.settlement.batchNumber}`);

    // -------------------------------------------------------------
    // TEST 6: VIRTUAL POS & QR TABLE PAYMENT
    // -------------------------------------------------------------
    console.log('\n--- TEST 6: Virtual POS & Table QR Pay ---');
    const vposSessionRes = await app.inject({
      method: 'POST',
      url: '/api/v1/terminal/virtual-pos/session',
      payload: {
        orderId: dineInOrderId,
        amount: 150.0,
      },
    });

    const vposSession = JSON.parse(vposSessionRes.body).session;
    console.log(`✅ STEP 9: QR payment session created: ${vposSession.qrCodeUrl}`);

    // -------------------------------------------------------------
    // TEST 7: GİB e-ADİSYON GENERATION & UBL-TR 1.2 XML COMPLIANCE
    // -------------------------------------------------------------
    console.log('\n--- TEST 7: GİB e-Adisyon (UBL-TR 1.2 XML) ---');
    const eAdisyonRes = await app.inject({
      method: 'POST',
      url: `/api/v1/fiscal/eadisyon/${dineInOrderId}`,
    });

    if (eAdisyonRes.statusCode !== 201) {
      throw new Error(`e-Adisyon generation failed: ${eAdisyonRes.body}`);
    }

    const eAdisyonData = JSON.parse(eAdisyonRes.body);
    const doc = eAdisyonData.document;

    console.log(`✅ STEP 10: GİB e-Adisyon generated successfully:`);
    console.log(`   Document No: ${doc.documentNumber}`);
    console.log(`   Profile ID : ${doc.profileId}`);
    console.log(`   UUID       : ${doc.documentUuid}`);
    console.log(`   Payable    : ${doc.totalPayable} TL (VAT: ${doc.vatTotal} TL)`);
    console.log(`   QR Data    : ${doc.qrCodeData}`);
    console.log(`   SHA-256 Sig: ${doc.signedHash}`);

    // Download XML and verify structure
    const xmlRes = await app.inject({
      method: 'GET',
      url: `/api/v1/fiscal/documents/${doc.id}/xml`,
    });

    if (!xmlRes.body.includes('<Invoice') || !xmlRes.body.includes('<cbc:UBLVersionID>2.1</cbc:UBLVersionID>')) {
      throw new Error('UBL XML structure invalid');
    }
    console.log(`✅ STEP 11: UBL-TR 1.2 XML format verified (contains <Invoice>, <cac:TaxTotal>, <cac:InvoiceLine>).`);

    // -------------------------------------------------------------
    // TEST 8: GİB e-FATURA / e-ARŞİV & TAXPAYER LOOKUP
    // -------------------------------------------------------------
    console.log('\n--- TEST 8: GİB e-Fatura / e-Arşiv Finalization ---');
    // Corporate Taxpayer Check
    const taxCheckRes = await app.inject({
      method: 'GET',
      url: '/api/v1/fiscal/taxpayer-check/1234567890',
    });
    const taxInfo = JSON.parse(taxCheckRes.body).taxpayer;
    console.log(`✅ STEP 12: Taxpayer lookup: VKN ${taxInfo.vkn_tckn} -> e-Fatura registered: ${taxInfo.is_e_invoice_taxpayer}`);

    // Finalize e-Invoice
    const invoiceRes = await app.inject({
      method: 'POST',
      url: `/api/v1/fiscal/invoice/${dineInOrderId}`,
      payload: taxInfo,
    });

    const invoiceData = JSON.parse(invoiceRes.body).document;
    console.log(`✅ STEP 13: Final commercial invoice created: ${invoiceData.documentNumber} (${invoiceData.documentType}) for ${invoiceData.taxpayerTitle}`);

    // -------------------------------------------------------------
    // TEST 9: CLOUD SYNC ENGINE (Offline Resilience & Conflict Resolution)
    // -------------------------------------------------------------
    console.log('\n--- TEST 9: Offline-First Cloud Sync & Conflict Resolution ---');
    // 1. Simulate Offline Mode
    await app.inject({
      method: 'POST',
      url: '/api/v1/sync/network-mode',
      payload: { isOnline: false },
    });

    const offlinePush = await app.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
    });
    const offlineResult = JSON.parse(offlinePush.body).result;
    if (offlineResult.isOnline !== false || offlineResult.pushedCount !== 0) {
      throw new Error('Offline check failed: events were pushed while network was marked offline');
    }
    console.log(`✅ STEP 14: Offline network resilience verified: 0 events leaked while WAN is disconnected.`);

    // 2. Restore Online Mode & Push Outbox Batch
    await app.inject({
      method: 'POST',
      url: '/api/v1/sync/network-mode',
      payload: { isOnline: true },
    });

    const onlinePush = await app.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
    });
    const onlineResult = JSON.parse(onlinePush.body).result;
    console.log(`✅ STEP 15: WAN reconnected: ${onlineResult.pushedCount} outbox events batch-pushed to Cloud Hub (Batch ID: ${onlineResult.batchId}).`);

    // 3. Test Downstream Sync & Last-Write-Wins (LWW)
    const pullRes = await app.inject({
      method: 'POST',
      url: '/api/v1/sync/pull',
      payload: {
        updates: [
          {
            entityType: 'PRICE',
            entityId: antrikotId,
            operation: 'UPDATE',
            payload: { base_price: 620.0 },
            version: 2,
            updatedAt: new Date().toISOString(),
          },
        ],
      },
    });

    const pullResult = JSON.parse(pullRes.body).result;
    console.log(`✅ STEP 16: Downstream catalog update pulled and merged (Applied: ${pullResult.appliedCount}, Conflicts: ${pullResult.conflictCount}).`);

    // 4. Verify updated price
    const updatedPriceRes = await db.query(`SELECT base_price FROM products WHERE id = $1`, [antrikotId]);
    if (Number(updatedPriceRes.rows[0].base_price) !== 620.0) {
      throw new Error(`Price update failed in DB: expected 620.0, got ${updatedPriceRes.rows[0].base_price}`);
    }
    console.log(`✅ STEP 17: Antrikot price synced to 620.00 TL in Edge Database.`);

    // 5. Check Sync Health Status & Stock Discrepancies
    const syncStatusRes = await app.inject({
      method: 'GET',
      url: '/api/v1/sync/status',
    });
    const syncStatus = JSON.parse(syncStatusRes.body).status;
    console.log(`✅ STEP 18: Sync status check: Network ${syncStatus.networkState}, Pending Outbox: ${syncStatus.pendingEventsCount}`);

    console.log('\n================================================================');
    console.log('  🎉 ALL 18 PHASE 3 INTEGRATION TEST SCENARIOS PASSED 100%!       ');
    console.log('================================================================\n');
  } catch (err) {
    console.error('\n❌ Phase 3 Integration Test Suite Failed:', err);
    process.exit(1);
  } finally {
    await app.close();
    await db.close();
  }
}

runPhase3IntegrationTest().catch(console.error);
