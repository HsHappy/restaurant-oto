import { buildApp } from '../src/app.js';
import { db } from '../src/infrastructure/database/db.js';
import { seedDatabase } from '../src/infrastructure/database/seed.js';
import { holdAndFireEngine } from '../src/modules/kds/HoldAndFireEngine.js';
import { TableStatus, OrderItemStatus } from '../src/core/domain/enums/index.js';
import { networkPrinter } from '../src/hardware/printer/NetworkPrinter.js';

async function runFaz2IntegrationTest() {
  console.log('================================================================');
  console.log('  RUNNING FAZ 2 KDS & WAITER MOBILE INTEGRATION TEST SUITE');
  console.log('================================================================\n');

  // 1. Initialize DB & Migrations & Seed
  await db.initialize();
  await seedDatabase();

  const app = await buildApp();
  await app.ready();

  console.log('✅ STEP 1: Fastify Application & DB Engine ready.');

  // 2. Fetch tables and products
  const tablesRes = await app.inject({ method: 'GET', url: '/api/v1/waiter/tables' });
  const tables = JSON.parse(tablesRes.body).data;
  const table3 = tables.find((t: any) => t.table_number === 'Salon-3');
  if (!table3) throw new Error('Table Salon-3 not found');

  const menuRes = await app.inject({ method: 'GET', url: '/api/v1/orders/menu' });
  const menu = JSON.parse(menuRes.body).data;
  const antrikot = menu.products.find((p: any) => p.sku === 'GRL-01');
  const salata = menu.products.find((p: any) => p.sku === 'CLD-01');

  if (!antrikot || !salata) {
    throw new Error('Antrikot or Salata product not found in seeded menu');
  }

  console.log(`✅ STEP 2: Products verified: Antrikot (GRILL, ${antrikot.standard_prep_time_minutes} min), Salata (COLD, ${salata.standard_prep_time_minutes} min).`);

  // 3. Waiter Quick Order with Hold & Fire Pacing
  const waiterId = '33333333-3333-3333-3333-333333333333';
  const quickOrderRes = await app.inject({
    method: 'POST',
    url: '/api/v1/waiter/quick-order',
    payload: {
      tableId: table3.id,
      waiterId,
      enablePacing: true,
      items: [
        {
          productId: antrikot.id,
          quantity: 1,
          customerNotes: 'Orta Pişmiş',
          modifiers: [{ name: 'Karamelize Soğan', extra_price: 15.0 }],
        },
        {
          productId: salata.id,
          quantity: 1,
          customerNotes: 'Sos ayrı',
        },
      ],
    },
  });

  if (quickOrderRes.statusCode !== 201) {
    throw new Error('Quick order failed: ' + quickOrderRes.body);
  }

  const orderData = JSON.parse(quickOrderRes.body).data;
  const orderId = orderData.order.id;
  const items = orderData.order.items;

  console.log(`✅ STEP 3: Quick Order placed on Table Salon-3 (Order: ${orderData.order.order_number}).`);

  // Verify pacing: Antrikot (20 min) should be QUEUED, Salata (5 min) should be HOLD
  const antrikotItem = items.find((i: any) => i.product_id === antrikot.id);
  const salataItem = items.find((i: any) => i.product_id === salata.id);

  if (!antrikotItem || antrikotItem.status !== OrderItemStatus.QUEUED) {
    throw new Error(`Expected Antrikot status QUEUED, got ${antrikotItem?.status}`);
  }
  if (!salataItem || salataItem.status !== OrderItemStatus.HOLD) {
    throw new Error(`Expected Salata status HOLD, got ${salataItem?.status}`);
  }

  console.log(`✅ STEP 4: Cook Time Pacing Verified:`);
  console.log(`   🥩 Antrikot (20 min): QUEUED (Immediate fire on GRILL station)`);
  console.log(`   🥗 Salata (5 min): HOLD (Scheduled fire_at: ${salataItem.fire_at})`);

  // 4. KDS Station Ticket Filtering Test
  // Check GRILL KDS screen
  const grillTicketsRes = await app.inject({ method: 'GET', url: '/api/v1/kds/tickets?station=GRILL' });
  const grillTickets = JSON.parse(grillTicketsRes.body).data;
  const grillTicket = grillTickets.find((t: any) => t.order_id === orderId);
  if (!grillTicket) throw new Error('Order ticket not found on GRILL KDS screen');
  if (grillTicket.items.length !== 1 || grillTicket.items[0].product_id !== antrikot.id) {
    throw new Error('GRILL ticket should only contain Antrikot');
  }
  console.log('✅ STEP 5: GRILL KDS screen correctly displays only Antrikot ticket.');

  // Check COLD KDS screen
  const coldTicketsRes = await app.inject({ method: 'GET', url: '/api/v1/kds/tickets?station=COLD' });
  const coldTickets = JSON.parse(coldTicketsRes.body).data;
  const coldTicket = coldTickets.find((t: any) => t.order_id === orderId);
  if (!coldTicket) throw new Error('Order ticket not found on COLD KDS screen');
  if (coldTicket.items[0].status !== 'HOLD') {
    throw new Error('Salata item should have HOLD status on COLD KDS');
  }
  console.log('✅ STEP 6: COLD KDS screen correctly displays Salata with HOLD badge.');

  // 5. Hold & Fire Trigger Test
  // Manually fire the Salata
  const fireRes = await app.inject({
    method: 'POST',
    url: `/api/v1/kds/items/${salataItem.id}/fire`,
  });
  if (fireRes.statusCode !== 200) throw new Error('Fire item failed: ' + fireRes.body);

  // Re-check COLD ticket: Salata should now be QUEUED
  const coldTicketsAfterFire = await app.inject({ method: 'GET', url: '/api/v1/kds/tickets?station=COLD' });
  const coldTicketAfterFire = JSON.parse(coldTicketsAfterFire.body).data.find((t: any) => t.order_id === orderId);
  if (coldTicketAfterFire.items[0].status !== OrderItemStatus.QUEUED) {
    throw new Error(`Expected Salata status QUEUED after fire, got ${coldTicketAfterFire.items[0].status}`);
  }
  console.log('✅ STEP 7: Hold & Fire engine successfully transitioned Salata from HOLD to QUEUED.');

  // 6. Kitchen Bump Action
  const bumpRes = await app.inject({
    method: 'POST',
    url: `/api/v1/kds/items/${antrikotItem.id}/bump`,
    payload: { actorId: 'chef-grill-01' },
  });
  if (bumpRes.statusCode !== 200) throw new Error('Bump item failed');

  // Verify item is now READY
  const grillAfterBump = await app.inject({ method: 'GET', url: '/api/v1/kds/tickets?station=GRILL' });
  const grillTicketAfterBump = JSON.parse(grillAfterBump.body).data.find((t: any) => t.order_id === orderId);
  if (grillTicketAfterBump.items[0].status !== OrderItemStatus.READY) {
    throw new Error('Antrikot should be marked as READY');
  }
  console.log('✅ STEP 8: GRILL chef bumped Antrikot -> Status updated to READY.');

  // Check Waiter Overview: Salon-3 should report 1 ready item
  const waiterOverviewRes = await app.inject({ method: 'GET', url: '/api/v1/waiter/tables' });
  const table3Overview = JSON.parse(waiterOverviewRes.body).data.find((t: any) => t.id === table3.id);
  if (table3Overview.ready_items_count !== 1) {
    throw new Error(`Expected ready_items_count 1 on waiter screen, got ${table3Overview.ready_items_count}`);
  }
  console.log('✅ STEP 9: Waiter handheld terminal received READY alert for Salon-3 (ready_items_count = 1).');

  // 7. Bump Bar Recall (LIFO Geri Alma) Test
  const recallRes = await app.inject({
    method: 'POST',
    url: '/api/v1/kds/recall',
    payload: { station: 'GRILL' },
  });
  const recallData = JSON.parse(recallRes.body);
  if (!recallData.success || recallData.data.itemId !== antrikotItem.id) {
    throw new Error('Recall failed or recalled wrong item: ' + recallRes.body);
  }

  // Verify Antrikot reverted to QUEUED
  const grillAfterRecall = await app.inject({ method: 'GET', url: '/api/v1/kds/tickets?station=GRILL' });
  const grillTicketAfterRecall = JSON.parse(grillAfterRecall.body).data.find((t: any) => t.order_id === orderId);
  if (grillTicketAfterRecall.items[0].status !== OrderItemStatus.QUEUED) {
    throw new Error(`Expected Antrikot reverted to QUEUED, got ${grillTicketAfterRecall.items[0].status}`);
  }
  console.log('✅ STEP 10: Bump Bar Recall (F1 / Z) verified: Antrikot restored back to QUEUED on KDS.');

  // 8. Re-bump and Waiter Serve Confirmation
  await app.inject({
    method: 'POST',
    url: `/api/v1/kds/items/${antrikotItem.id}/bump`,
  });

  const serveRes = await app.inject({
    method: 'POST',
    url: `/api/v1/kds/items/${antrikotItem.id}/serve`,
    payload: { waiterId },
  });
  if (serveRes.statusCode !== 200) throw new Error('Serve item failed');
  console.log('✅ STEP 11: Waiter confirmed delivery to table -> Antrikot marked as SERVED.');

  // 9. Table Transfer Test (Masa Taşıma: Salon-3 -> Salon-4)
  const table4 = tables.find((t: any) => t.table_number === 'Salon-4');
  if (!table4) throw new Error('Salon-4 not found');

  const transferRes = await app.inject({
    method: 'POST',
    url: '/api/v1/waiter/transfer-table',
    payload: {
      sourceTableId: table3.id,
      targetTableId: table4.id,
      waiterId,
    },
  });
  if (transferRes.statusCode !== 200) throw new Error('Transfer table failed: ' + transferRes.body);

  // Verify source table is now AVAILABLE and target is OCCUPIED
  const tablesAfterTransfer = await app.inject({ method: 'GET', url: '/api/v1/waiter/tables' });
  const overviewList = JSON.parse(tablesAfterTransfer.body).data;
  const src = overviewList.find((t: any) => t.id === table3.id);
  const tgt = overviewList.find((t: any) => t.id === table4.id);

  if (src.current_status !== TableStatus.AVAILABLE || src.active_order_id !== null) {
    throw new Error(`Source table should be AVAILABLE, got ${src.current_status}`);
  }
  if (tgt.current_status !== TableStatus.OCCUPIED || tgt.active_order_id !== orderId) {
    throw new Error(`Target table should be OCCUPIED with order ${orderId}`);
  }
  console.log('✅ STEP 12: Table Transfer verified: Active order moved from Salon-3 to Salon-4.');

  // 10. Request Bill from Table (Hesap İste)
  const billRes = await app.inject({
    method: 'POST',
    url: '/api/v1/waiter/request-bill',
    payload: { tableId: table4.id, actorId: waiterId },
  });
  if (billRes.statusCode !== 200) throw new Error('Request bill failed: ' + billRes.body);

  const table4AfterBill = JSON.parse(billRes.body).data;
  if (table4AfterBill.current_status !== TableStatus.BILL_REQUESTED) {
    throw new Error(`Expected BILL_REQUESTED, got ${table4AfterBill.current_status}`);
  }
  console.log('✅ STEP 13: Request Bill action verified: Salon-4 transitioned to BILL_REQUESTED.');

  // 11. Cleanup
  holdAndFireEngine.stop();
  networkPrinter.close();
  await app.close();
  await db.close();

  console.log('\n================================================================');
  console.log('  🎉 ALL 13 FAZ 2 KDS & WAITER TEST SCENARIOS PASSED WITH 100% SUCCESS!');
  console.log('================================================================');
  process.exit(0);
}

runFaz2IntegrationTest().catch((err) => {
  console.error('\n❌ Faz 2 Integration Test Suite Failed:', err);
  process.exit(1);
});
