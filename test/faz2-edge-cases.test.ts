import { buildApp } from '../src/app.js';
import { db } from '../src/infrastructure/database/db.js';
import { seedDatabase } from '../src/infrastructure/database/seed.js';
import { holdAndFireEngine } from '../src/modules/kds/HoldAndFireEngine.js';
import { OrderItemStatus } from '../src/core/domain/enums/index.js';
import { networkPrinter } from '../src/hardware/printer/NetworkPrinter.js';

async function runEdgeCasesSuite() {
  console.log('================================================================');
  console.log('  RUNNING FAZ 2 EDGE-CASES, ISOLATION & VALIDATION TEST SUITE');
  console.log('================================================================\n');

  // Setup DB and Fastify
  await db.initialize();
  await seedDatabase();

  const app = await buildApp();
  await app.ready();

  console.log('✅ STEP 1: Fastify app & database initialized.');

  // =================================================================
  // SECTION 1: HoldAndFireEngine Cook Time Pacing Unit Math
  // =================================================================
  console.log('\n--- SECTION 1: Pacing Engine Unit Calculations ---');

  // Case 1.1: Empty array
  const emptyPlan = holdAndFireEngine.calculatePacing([]);
  if (emptyPlan.length !== 0) throw new Error('Expected empty pacing plan for empty array');
  console.log('✅ Pacing 1.1: Empty input returns empty plan.');

  // Case 1.2: Single item -> Immediate fire
  const baseTime = new Date('2026-10-09T12:00:00.000Z');
  const singlePlan = holdAndFireEngine.calculatePacing(
    [{ productId: 'p1', prepTimeMinutes: 10, station: 'GRILL' }],
    baseTime
  );
  if (singlePlan[0].status !== OrderItemStatus.QUEUED || singlePlan[0].delaySeconds !== 0) {
    throw new Error('Single item should be QUEUED with 0 delay');
  }
  console.log('✅ Pacing 1.2: Single item queued immediately with 0 delay.');

  // Case 1.3: Equal prep times -> All immediate fire
  const equalPlan = holdAndFireEngine.calculatePacing(
    [
      { productId: 'p1', prepTimeMinutes: 15, station: 'GRILL' },
      { productId: 'p2', prepTimeMinutes: 15, station: 'OVEN' },
    ],
    baseTime
  );
  if (
    equalPlan[0].status !== OrderItemStatus.QUEUED ||
    equalPlan[1].status !== OrderItemStatus.QUEUED ||
    equalPlan[0].delaySeconds !== 0 ||
    equalPlan[1].delaySeconds !== 0
  ) {
    throw new Error('Equal prep time items should both be QUEUED with 0 delay');
  }
  console.log('✅ Pacing 1.3: Items with equal prep times fire together immediately.');

  // Case 1.4: Complex multi-item pacing
  // Max is Steak (20 min). Salad (5 min) should delay 15 min (900s). Drink (3 min) should delay 17 min (1020s).
  const multiPlan = holdAndFireEngine.calculatePacing(
    [
      { productId: 'steak', prepTimeMinutes: 20, station: 'GRILL' },
      { productId: 'pizza', prepTimeMinutes: 8, station: 'OVEN' },
      { productId: 'salad', prepTimeMinutes: 5, station: 'COLD' },
      { productId: 'drink', prepTimeMinutes: 3, station: 'BAR' },
    ],
    baseTime
  );

  const [steakP, pizzaP, saladP, drinkP] = multiPlan;
  if (steakP.status !== OrderItemStatus.QUEUED || steakP.delaySeconds !== 0) {
    throw new Error('Steak should be QUEUED immediately');
  }
  if (pizzaP.status !== OrderItemStatus.HOLD || pizzaP.delaySeconds !== 12 * 60) {
    throw new Error(`Pizza delay mismatch: expected ${12 * 60}, got ${pizzaP.delaySeconds}`);
  }
  if (saladP.status !== OrderItemStatus.HOLD || saladP.delaySeconds !== 15 * 60) {
    throw new Error(`Salad delay mismatch: expected ${15 * 60}, got ${saladP.delaySeconds}`);
  }
  if (drinkP.status !== OrderItemStatus.HOLD || drinkP.delaySeconds !== 17 * 60) {
    throw new Error(`Drink delay mismatch: expected ${17 * 60}, got ${drinkP.delaySeconds}`);
  }
  console.log('✅ Pacing 1.4: Multi-item staggered pacing offsets calculated with second-level precision.');

  // =================================================================
  // SECTION 2: Automatic Background Firing Scheduler Logic
  // =================================================================
  console.log('\n--- SECTION 2: Automatic Background Firing Engine ---');

  // Insert a dummy order and an item with fire_at in the past
  const branchRes = await db.query(`SELECT id FROM branches LIMIT 1`);
  const branchId = branchRes.rows[0].id;

  const waiterId = '33333333-3333-3333-3333-333333333333';

  const pastOrderRes = await db.query(
    `INSERT INTO orders (id, order_number, branch_id, waiter_id, order_type, status, subtotal, tax_total, grand_total, opened_at)
     VALUES ('11111111-1111-1111-1111-111111111111', 'ORD-SCHED-01', $1, $2, 'DINE_IN', 'OPEN', 140, 14, 154, NOW())
     RETURNING id`,
    [branchId, waiterId]
  );
  const prodRes = await db.query(`SELECT id FROM products WHERE sku = 'CLD-01' LIMIT 1`);
  const saladProdId = prodRes.rows[0].id;

  const pastItemId = '22222222-2222-2222-2222-222222222222';
  const pastFireDate = new Date(Date.now() - 10000); // 10 seconds ago
  await db.query(
    `INSERT INTO order_items (id, order_id, product_id, quantity, unit_price, total_price, status, is_complimentary, fire_at, created_at)
     VALUES ($1, $2, $3, 1, 140, 140, 'HOLD', FALSE, $4, NOW())`,
    [pastItemId, pastOrderRes.rows[0].id, saladProdId, pastFireDate]
  );

  const firedCount = await holdAndFireEngine.checkAndFireHeldItems();
  if (firedCount === 0) throw new Error('Expected at least 1 held item fired');

  const checkItemRes = await db.query(`SELECT status, prep_started_at FROM order_items WHERE id = $1`, [pastItemId]);
  if (checkItemRes.rows[0].status !== OrderItemStatus.QUEUED || !checkItemRes.rows[0].prep_started_at) {
    throw new Error('Item should be updated to QUEUED with prep_started_at timestamp');
  }
  console.log(`✅ Firing 2.1: Scheduler fired ${firedCount} overdue held item(s) to QUEUED automatically.`);

  // =================================================================
  // SECTION 3: Multi-Station KDS Isolation & Expeditor View
  // =================================================================
  console.log('\n--- SECTION 3: Station Isolation & Expeditor Filtering ---');

  const tablesRes = await app.inject({ method: 'GET', url: '/api/v1/waiter/tables' });
  const tables = JSON.parse(tablesRes.body).data;
  const table1 = tables.find((t: any) => t.table_number === 'Salon-1');

  const menuRes = await app.inject({ method: 'GET', url: '/api/v1/orders/menu' });
  const menu = JSON.parse(menuRes.body).data;
  const prodGrill = menu.products.find((p: any) => p.preparation_station === 'GRILL');
  const prodOven = menu.products.find((p: any) => p.preparation_station === 'OVEN');
  const prodCold = menu.products.find((p: any) => p.preparation_station === 'COLD');
  const prodBar = menu.products.find((p: any) => p.preparation_station === 'BAR');

  // Place quick order containing all 4 stations
  const multiStationOrderRes = await app.inject({
    method: 'POST',
    url: '/api/v1/waiter/quick-order',
    payload: {
      tableId: table1.id,
      enablePacing: false, // all QUEUED for station isolation testing
      items: [
        { productId: prodGrill.id, quantity: 1 },
        { productId: prodOven.id, quantity: 1 },
        { productId: prodCold.id, quantity: 1 },
        { productId: prodBar.id, quantity: 1 },
      ],
    },
  });
  if (multiStationOrderRes.statusCode !== 201) throw new Error('Multi-station order placement failed');
  const multiOrderId = JSON.parse(multiStationOrderRes.body).data.order.id;

  // Station isolation check: GRILL
  const grillRes = await app.inject({ method: 'GET', url: '/api/v1/kds/tickets?station=GRILL' });
  const grillTicket = JSON.parse(grillRes.body).data.find((t: any) => t.order_id === multiOrderId);
  if (!grillTicket || grillTicket.items.some((i: any) => i.preparation_station !== 'GRILL')) {
    throw new Error('GRILL KDS screen leaked non-GRILL items');
  }

  // Station isolation check: OVEN
  const ovenRes = await app.inject({ method: 'GET', url: '/api/v1/kds/tickets?station=OVEN' });
  const ovenTicket = JSON.parse(ovenRes.body).data.find((t: any) => t.order_id === multiOrderId);
  if (!ovenTicket || ovenTicket.items.some((i: any) => i.preparation_station !== 'OVEN')) {
    throw new Error('OVEN KDS screen leaked non-OVEN items');
  }

  // Station isolation check: COLD
  const coldRes = await app.inject({ method: 'GET', url: '/api/v1/kds/tickets?station=COLD' });
  const coldTicket = JSON.parse(coldRes.body).data.find((t: any) => t.order_id === multiOrderId);
  if (!coldTicket || coldTicket.items.some((i: any) => i.preparation_station !== 'COLD')) {
    throw new Error('COLD KDS screen leaked non-COLD items');
  }

  // Station isolation check: BAR
  const barRes = await app.inject({ method: 'GET', url: '/api/v1/kds/tickets?station=BAR' });
  const barTicket = JSON.parse(barRes.body).data.find((t: any) => t.order_id === multiOrderId);
  if (!barTicket || barTicket.items.some((i: any) => i.preparation_station !== 'BAR')) {
    throw new Error('BAR KDS screen leaked non-BAR items');
  }

  // Expeditor view: must see all 4 items
  const expoRes = await app.inject({ method: 'GET', url: '/api/v1/kds/tickets?station=EXPEDITOR' });
  const expoTicket = JSON.parse(expoRes.body).data.find((t: any) => t.order_id === multiOrderId);
  if (!expoTicket || expoTicket.items.length !== 4) {
    throw new Error(`EXPEDITOR must show all 4 station items, got ${expoTicket?.items?.length}`);
  }
  console.log('✅ Isolation 3.1: Complete station isolation verified. Stations only see their items; Expeditor sees all.');

  // Station Ticket Bump isolation: Bump on OVEN station only
  const bumpOvenRes = await app.inject({
    method: 'POST',
    url: `/api/v1/kds/tickets/${multiOrderId}/bump`,
    payload: { station: 'OVEN' },
  });
  if (bumpOvenRes.statusCode !== 200) throw new Error('Station bump failed');

  // Verify OVEN item is now READY, while GRILL item remains QUEUED
  const expoAfterBumpRes = await app.inject({ method: 'GET', url: '/api/v1/kds/tickets?station=EXPEDITOR' });
  const expoAfterBump = JSON.parse(expoAfterBumpRes.body).data.find((t: any) => t.order_id === multiOrderId);
  const ovenItemStatus = expoAfterBump.items.find((i: any) => i.preparation_station === 'OVEN').status;
  const grillItemStatus = expoAfterBump.items.find((i: any) => i.preparation_station === 'GRILL').status;

  if (ovenItemStatus !== OrderItemStatus.READY) throw new Error('OVEN item should be READY');
  if (grillItemStatus !== OrderItemStatus.QUEUED) throw new Error('GRILL item should still be QUEUED');
  console.log('✅ Isolation 3.2: Station-specific ticket bump only bumped OVEN items, GRILL unaffected.');

  // =================================================================
  // SECTION 4: Bump Bar Multi-Step LIFO Recall Stack
  // =================================================================
  console.log('\n--- SECTION 4: Bump Bar LIFO Recall Stack ---');

  // Find two items to bump individually
  const grillItemId = expoAfterBump.items.find((i: any) => i.preparation_station === 'GRILL').id;
  const coldItemId = expoAfterBump.items.find((i: any) => i.preparation_station === 'COLD').id;

  // 1. Bump GRILL item
  await app.inject({ method: 'POST', url: `/api/v1/kds/items/${grillItemId}/bump` });
  // Wait 10ms to ensure distinct timestamp
  await new Promise((r) => setTimeout(r, 10));
  // 2. Bump COLD item
  await app.inject({ method: 'POST', url: `/api/v1/kds/items/${coldItemId}/bump` });

  // 3. First recall on EXPEDITOR -> should recall COLD item (LIFO)
  const recall1 = await app.inject({ method: 'POST', url: '/api/v1/kds/recall', payload: { station: 'EXPEDITOR' } });
  const recall1Data = JSON.parse(recall1.body);
  if (!recall1Data.success || recall1Data.data.itemId !== coldItemId) {
    throw new Error(`Expected COLD item (${coldItemId}) to be recalled first, got ${recall1Data.data.itemId}`);
  }

  // 4. Second recall on EXPEDITOR -> should recall GRILL item (LIFO)
  const recall2 = await app.inject({ method: 'POST', url: '/api/v1/kds/recall', payload: { station: 'EXPEDITOR' } });
  const recall2Data = JSON.parse(recall2.body);
  if (!recall2Data.success || recall2Data.data.itemId !== grillItemId) {
    throw new Error(`Expected GRILL item (${grillItemId}) to be recalled second, got ${recall2Data.data.itemId}`);
  }

  console.log('✅ BumpBar 4.1: Bump Bar LIFO stack verified. Items successfully recalled in reverse order.');

  // Recall on station with empty bump buffer
  const emptyRecallRes = await app.inject({
    method: 'POST',
    url: '/api/v1/kds/recall',
    payload: { station: 'BAR' },
  });
  const emptyRecall = JSON.parse(emptyRecallRes.body);
  if (emptyRecall.success !== false || emptyRecall.data.recalled !== false) {
    throw new Error('Expected recall on empty station to return false');
  }
  console.log('✅ BumpBar 4.2: Recall gracefully handles empty log buffer (success: false).');

  // =================================================================
  // SECTION 5: Domain Validation & Error Handling Edge Cases
  // =================================================================
  console.log('\n--- SECTION 5: Error Handling & Invalid State Transitions ---');

  const nonExistentId = '99999999-9999-9999-9999-999999999999';

  // 5.1 KDS Item actions on non-existent ID
  const fakeBump = await app.inject({ method: 'POST', url: `/api/v1/kds/items/${nonExistentId}/bump` });
  if (fakeBump.statusCode !== 404) throw new Error(`Expected 404 for non-existent item bump, got ${fakeBump.statusCode}`);

  const fakeHold = await app.inject({ method: 'POST', url: `/api/v1/kds/items/${nonExistentId}/hold` });
  if (fakeHold.statusCode !== 404) throw new Error(`Expected 404 for non-existent item hold, got ${fakeHold.statusCode}`);

  const fakeServe = await app.inject({ method: 'POST', url: `/api/v1/kds/items/${nonExistentId}/serve` });
  if (fakeServe.statusCode !== 404) throw new Error(`Expected 404 for non-existent item serve, got ${fakeServe.statusCode}`);
  console.log('✅ Validation 5.1: Non-existent item operations correctly rejected with 404 ItemNotFoundError.');

  // 5.2 Waiter quick-order on non-existent table
  const fakeQuickOrder = await app.inject({
    method: 'POST',
    url: '/api/v1/waiter/quick-order',
    payload: { tableId: nonExistentId, items: [{ productId: prodGrill.id, quantity: 1 }] },
  });
  if (fakeQuickOrder.statusCode !== 404) {
    throw new Error(`Expected 404 for quick-order on non-existent table, got ${fakeQuickOrder.statusCode}`);
  }
  console.log('✅ Validation 5.2: Quick order on non-existent table rejected with 404 TableNotFoundError.');

  // 5.3 Waiter request-bill on AVAILABLE table (must be OCCUPIED)
  const table2 = tables.find((t: any) => t.table_number === 'Salon-2');
  const invalidBill = await app.inject({
    method: 'POST',
    url: '/api/v1/waiter/request-bill',
    payload: { tableId: table2.id },
  });
  if (invalidBill.statusCode !== 422) {
    throw new Error(`Expected 422 InvalidTableStateTransitionError for request-bill on AVAILABLE table, got ${invalidBill.statusCode}`);
  }
  console.log('✅ Validation 5.3: Request bill on AVAILABLE table rejected with 422 InvalidTableStateTransitionError.');

  // 5.4 Waiter transfer-table edge cases
  // Target table non-existent
  const fakeTransferTgt = await app.inject({
    method: 'POST',
    url: '/api/v1/waiter/transfer-table',
    payload: { sourceTableId: table1.id, targetTableId: nonExistentId },
  });
  if (fakeTransferTgt.statusCode !== 404) {
    throw new Error(`Expected 404 for transfer with non-existent target, got ${fakeTransferTgt.statusCode}`);
  }

  // Source table with NO active order (table2 is AVAILABLE)
  const tableTeras1 = tables.find((t: any) => t.table_number === 'Teras-1');
  const noOrderTransfer = await app.inject({
    method: 'POST',
    url: '/api/v1/waiter/transfer-table',
    payload: { sourceTableId: table2.id, targetTableId: tableTeras1.id },
  });
  if (noOrderTransfer.statusCode !== 404) {
    throw new Error(`Expected 404 OrderNotFoundError for table with no active order, got ${noOrderTransfer.statusCode}`);
  }

  // Target table is already OCCUPIED (table1 is OCCUPIED)
  // Let's create an active order on table2 first
  await app.inject({
    method: 'POST',
    url: '/api/v1/waiter/quick-order',
    payload: { tableId: table2.id, items: [{ productId: prodBar.id, quantity: 1 }] },
  });
  // Now try transferring table2 to table1 (which is already OCCUPIED)
  const occupiedTransfer = await app.inject({
    method: 'POST',
    url: '/api/v1/waiter/transfer-table',
    payload: { sourceTableId: table2.id, targetTableId: table1.id },
  });
  if (occupiedTransfer.statusCode !== 422) {
    throw new Error(`Expected 422 InvalidTableStateTransitionError when transferring to OCCUPIED target, got ${occupiedTransfer.statusCode}`);
  }
  console.log('✅ Validation 5.4: Table transfer edge cases (missing tables, no active order, target occupied) strictly enforced.');

  // Cleanup
  holdAndFireEngine.stop();
  networkPrinter.close();
  await app.close();
  await db.close();

  console.log('\n================================================================');
  console.log('  🎉 ALL FAZ 2 EDGE-CASE & VALIDATION SCENARIOS PASSED (100%)');
  console.log('================================================================');
  process.exit(0);
}

runEdgeCasesSuite().catch((err) => {
  console.error('\n❌ Edge Cases Suite Failed:', err);
  process.exit(1);
});
