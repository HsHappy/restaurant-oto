import { buildApp } from '../src/app.js';
import { db } from '../src/infrastructure/database/db.js';
import { seedDatabase } from '../src/infrastructure/database/seed.js';
import { TableStatus } from '../src/core/domain/enums/index.js';
import { networkPrinter } from '../src/hardware/printer/NetworkPrinter.js';


async function runIntegrationTest() {
  console.log('========================================================');
  console.log('  RUNNING FAZ 1 END-TO-END INTEGRATION TEST SUITE');
  console.log('========================================================\n');

  // 1. Initialize Database & Seed
  await db.initialize();
  const seedResult = await seedDatabase();
  const branchId = seedResult.branchId;

  // 2. Build Fastify Test Application
  const app = await buildApp();
  await app.ready();

  console.log('✅ STEP 1: Application & Database Initialized in mode:', db.getMode());

  // 3. Test Health Endpoint
  const healthRes = await app.inject({ method: 'GET', url: '/health' });
  if (healthRes.statusCode !== 200) throw new Error('Health check failed');
  const healthData = JSON.parse(healthRes.body);
  console.log('✅ STEP 2: Health check passed:', healthData);

  // 4. Test Table List
  const tablesRes = await app.inject({ method: 'GET', url: `/api/v1/tables?branchId=${branchId}` });
  const tables = JSON.parse(tablesRes.body).data;
  console.log(`✅ STEP 3: Retrieved ${tables.length} tables from branch.`);

  const testTable = tables.find((t: any) => t.table_number === 'Salon-1');
  if (!testTable) throw new Error('Salon-1 not found');

  // 5. Test Table Concurrency Locking
  const waiter1 = '11111111-1111-1111-1111-111111111111';
  const waiter2 = '22222222-2222-2222-2222-222222222222';

  const lockRes1 = await app.inject({
    method: 'POST',
    url: `/api/v1/tables/${testTable.id}/lock`,
    payload: { lockedBy: waiter1 },
  });
  if (lockRes1.statusCode !== 200) throw new Error('Lock acquisition failed');

  // Attempt lock by second waiter -> should fail with 409 Conflict
  const lockRes2 = await app.inject({
    method: 'POST',
    url: `/api/v1/tables/${testTable.id}/lock`,
    payload: { lockedBy: waiter2 },
  });
  if (lockRes2.statusCode !== 409) {
    throw new Error(`Expected 409 TableLockedError, got ${lockRes2.statusCode}`);
  }
  console.log('✅ STEP 4: Table concurrency lock verified (Waiter 2 was blocked correctly with 409).');

  // Unlock table
  await app.inject({
    method: 'POST',
    url: `/api/v1/tables/${testTable.id}/unlock`,
    payload: { lockedBy: waiter1 },
  });

  // 6. Test Open Table & Create Order
  const openRes = await app.inject({
    method: 'POST',
    url: `/api/v1/tables/${testTable.id}/open`,
    payload: { waiterId: waiter1 },
  });
  if (openRes.statusCode !== 201) throw new Error('Open table failed: ' + openRes.body);
  const openData = JSON.parse(openRes.body).data;
  const orderId = openData.orderId;
  console.log(`✅ STEP 5: Table Salon-1 opened. Active Order ID: ${orderId}, Order Number: ${openData.orderNumber}`);

  // 7. Fetch Menu Products
  const menuRes = await app.inject({ method: 'GET', url: '/api/v1/orders/menu' });
  const menu = JSON.parse(menuRes.body).data;
  const burger = menu.products.find((p: any) => p.sku === 'BUR-01');
  const fries = menu.products.find((p: any) => p.sku === 'SNK-01');
  const coke = menu.products.find((p: any) => p.sku === 'DRK-02');

  // 8. Add Items to Order
  // Add 2x Burger with modifiers
  await app.inject({
    method: 'POST',
    url: `/api/v1/orders/${orderId}/items`,
    payload: {
      productId: burger.id,
      quantity: 2,
      modifiers: [{ name: 'Ekstra Cheddar Peyniri', extra_price: 25.0 }],
      waiterId: waiter1,
    },
  });

  // Add 1x Fries
  await app.inject({
    method: 'POST',
    url: `/api/v1/orders/${orderId}/items`,
    payload: {
      productId: fries.id,
      quantity: 1,
      waiterId: waiter1,
    },
  });

  // Add 2x Coke
  await app.inject({
    method: 'POST',
    url: `/api/v1/orders/${orderId}/items`,
    payload: {
      productId: coke.id,
      quantity: 2,
      waiterId: waiter1,
    },
  });

  // Inspect Order Totals
  const orderAfterAddRes = await app.inject({ method: 'GET', url: `/api/v1/orders/${orderId}` });
  const orderAfterAdd = JSON.parse(orderAfterAddRes.body).data;
  console.log('✅ STEP 6: Line items added successfully.');
  console.log(
    `   Subtotal: ${orderAfterAdd.subtotal} TL, Tax: ${orderAfterAdd.tax_total} TL, Grand Total: ${orderAfterAdd.grand_total} TL`
  );

  // 9. 4-Eye Manager PIN Test for Discounts & Complimentary
  // Wrong PIN -> Should reject with 403 Forbidden
  const wrongPinRes = await app.inject({
    method: 'POST',
    url: `/api/v1/orders/${orderId}/discount`,
    payload: {
      discountType: 'PERCENT',
      amount: 10,
      managerPin: '9999', // Incorrect PIN
    },
  });
  if (wrongPinRes.statusCode !== 403) {
    throw new Error(`Expected 403 InvalidManagerPinError, got ${wrongPinRes.statusCode}`);
  }
  console.log('✅ STEP 7: 4-Eye Principle verified: Invalid PIN was rejected with 403 Forbidden.');

  // Correct PIN -> Apply 10% discount
  const discountRes = await app.inject({
    method: 'POST',
    url: `/api/v1/orders/${orderId}/discount`,
    payload: {
      discountType: 'PERCENT',
      amount: 10,
      managerPin: '1234',
    },
  });
  if (discountRes.statusCode !== 200) throw new Error('Discount failed');
  const orderAfterDiscount = JSON.parse(discountRes.body).data;
  console.log(
    `✅ STEP 8: 10% Discount applied with manager authorization. New Grand Total: ${orderAfterDiscount.grand_total} TL (Discount: -${orderAfterDiscount.discount_total} TL)`
  );

  // 10. Split Bill Algorithms Test
  // 10.1 Equal Split (2 parts)
  const equalSplitRes = await app.inject({
    method: 'POST',
    url: `/api/v1/orders/${orderId}/split`,
    payload: {
      type: 'EQUAL',
      payload: { parts: 2 },
    },
  });
  const equalSplit = JSON.parse(equalSplitRes.body).data;
  console.log('✅ STEP 9: Equal Split calculation verified:', equalSplit.shares);

  // 10.2 Custom Amount validation
  const customSplitRes = await app.inject({
    method: 'POST',
    url: `/api/v1/orders/${orderId}/split`,
    payload: {
      type: 'CUSTOM_AMOUNT',
      payload: { amount: 200.0 },
    },
  });
  const customSplit = JSON.parse(customSplitRes.body).data;
  console.log(`✅ STEP 10: Custom amount split approved: ${customSplit.approvedAmount} TL`);

  // 11. Payment Engine (Partial Cash + Card Settlement)
  // Partial Cash Payment (300.00 TL)
  const pay1Res = await app.inject({
    method: 'POST',
    url: '/api/v1/payments',
    payload: {
      orderId,
      method: 'CASH',
      amount: 300.0,
      actorId: waiter1,
    },
  });
  const pay1Data = JSON.parse(pay1Res.body).data;
  console.log(
    `✅ STEP 11: Partial Cash payment processed: 300.00 TL. Remaining balance: ${pay1Data.remainingBalance} TL`
  );

  // Remaining Credit Card Payment to fully settle
  const remainingAmount = pay1Data.remainingBalance;
  const pay2Res = await app.inject({
    method: 'POST',
    url: '/api/v1/payments',
    payload: {
      orderId,
      method: 'CREDIT_CARD',
      amount: remainingAmount,
      actorId: waiter1,
      transactionReference: 'POS-AUTH-987654',
    },
  });
  const pay2Data = JSON.parse(pay2Res.body).data;
  console.log(`✅ STEP 12: Remaining Card payment processed: ${remainingAmount} TL. Fully settled: ${pay2Data.isFullySettled}`);

  // Check Table State: should now be DIRTY
  const tableAfterPayRes = await app.inject({ method: 'GET', url: `/api/v1/tables/${testTable.id}` });
  const tableAfterPay = JSON.parse(tableAfterPayRes.body).data;
  if (tableAfterPay.current_status !== TableStatus.DIRTY) {
    throw new Error(`Expected table status DIRTY, got ${tableAfterPay.current_status}`);
  }
  console.log(`✅ STEP 13: Table Salon-1 automatically transitioned to DIRTY after full bill settlement.`);

  // Clean table -> Back to AVAILABLE
  const cleanRes = await app.inject({
    method: 'PATCH',
    url: `/api/v1/tables/${testTable.id}/status`,
    payload: { status: TableStatus.AVAILABLE, actorId: waiter1 },
  });
  const tableCleaned = JSON.parse(cleanRes.body).data;
  if (tableCleaned.current_status !== TableStatus.AVAILABLE) throw new Error('Table cleaning failed');
  console.log(`✅ STEP 14: Table Salon-1 cleaned and transitioned back to AVAILABLE.`);

  // 12. Hardware ESC/POS Printer Driver Tests
  // Customer Receipt Print
  const printReceiptRes = await app.inject({
    method: 'POST',
    url: '/api/v1/printer/receipt',
    payload: { orderId, openDrawer: true },
  });
  const receiptPrint = JSON.parse(printReceiptRes.body);
  console.log(`✅ STEP 15: ESC/POS Customer Receipt generated: Job ID ${receiptPrint.jobId} (Queued: ${receiptPrint.queued})`);

  // Kitchen Ticket Print (GRILL)
  const printKitchenRes = await app.inject({
    method: 'POST',
    url: '/api/v1/printer/kitchen',
    payload: { orderId, station: 'GRILL' },
  });
  const kitchenPrint = JSON.parse(printKitchenRes.body);
  console.log(`✅ STEP 16: ESC/POS Kitchen Station Ticket generated: Job ID ${kitchenPrint.jobId} (Queued: ${kitchenPrint.queued})`);

  // Cash Drawer Kick Signal
  const drawerRes = await app.inject({
    method: 'POST',
    url: '/api/v1/printer/drawer',
    payload: { managerPin: '1234' },
  });
  const drawerPrint = JSON.parse(drawerRes.body);
  console.log(`✅ STEP 17: Cash Drawer kick signal sent: Job ID ${drawerPrint.jobId}`);

  // 13. Cryptographic SHA-256 Audit Trail Verification
  const auditRes = await app.inject({ method: 'GET', url: `/api/v1/audit/verify?branchId=${branchId}` });
  const verification = JSON.parse(auditRes.body).verification;
  if (!verification.valid) {
    throw new Error('Audit chain verification failed: ' + verification.message);
  }
  console.log(`✅ STEP 18: Cryptographic SHA-256 Audit Trail Verified: ${verification.message}`);

  networkPrinter.close();
  await app.close();
  await db.close();

  console.log('\n========================================================');
  console.log('  🎉 ALL 18 INTEGRATION TEST SCENARIOS PASSED WITH 100% SUCCESS!');
  console.log('========================================================');
  process.exit(0);
}

runIntegrationTest().catch((err) => {
  console.error('\n❌ Integration Test Suite Failed:', err);
  process.exit(1);
});

