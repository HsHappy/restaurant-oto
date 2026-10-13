import { test, expect } from '@playwright/test';

test.describe('Faz 3: Delivery Aggregators, KDS Routing & Real-Time Loop E2E Suite', () => {

  test('Aggregator Online Order Flow -> Real-Time KDS Ticket Display & Chef Bump', async ({ page, request }) => {
    // 1. Simulate an incoming online aggregator order (Getir Yemek) via REST API
    const simRes = await request.post('/api/v1/aggregators/simulate-order', {
      data: {
        platform: 'GETIR',
        productName: 'Antrikot Izgara',
        quantity: 1,
        customerName: 'Kerem Aksoy',
        deliveryAddress: 'Kadıköy Rıhtım Cad. No: 18',
        notes: 'Sıcak ve iyi pişmiş lütfen',
      },
    });

    expect(simRes.status()).toBe(201);
    const simData = await simRes.json();
    expect(simData.success).toBe(true);

    // 2. Open KDS screen in browser
    await page.goto('/kds');
    await expect(page.locator('h1')).toContainText('KDS MUTFAK EKRANI');
    await expect(page.locator('#wsStatusText')).toContainText('CANLI');

    // 3. Switch to GRILL station (since Antrikot Izgara is a GRILL item)
    const grillBtn = page.locator('.station-btn[data-station="GRILL"]');
    await grillBtn.click();
    await expect(grillBtn).toHaveClass(/active/);

    // 4. Verify the aggregator order ticket appears in the KDS ticket grid
    const packageTicket = page.locator('.ticket-card', { hasText: 'Antrikot Izgara' }).first();
    await expect(packageTicket).toBeVisible({ timeout: 5000 });

    // Verify it is flagged as a package order and shows product
    await expect(packageTicket.locator('.ticket-table')).toContainText('Paket');
    await expect(packageTicket.locator('.item-title')).toContainText('Antrikot Izgara');

    // 5. Chef interacts with ticket: Bump single item
    const itemRow = packageTicket.locator('.item-row', { hasText: 'Antrikot Izgara' }).first();
    await itemRow.click();
    await expect(itemRow).toHaveClass(/item-ready/, { timeout: 5000 });

    // 6. Test recall button to undo bump
    const recallBtn = page.locator('#recallBtn');
    await recallBtn.click();
    await expect(itemRow).not.toHaveClass(/item-ready/, { timeout: 5000 });

    // 7. Chef bumps entire ticket
    const bumpEntireBtn = packageTicket.locator('.bump-ticket-btn');
    await bumpEntireBtn.click();
    await expect(itemRow).toHaveClass(/item-ready/, { timeout: 5000 });
  });

  test('Multi-Platform Aggregator Routing: Trendyol order displayed on Expeditor station', async ({ page, request }) => {
    // 1. Simulate Trendyol order
    const tyRes = await request.post('/api/v1/aggregators/simulate-order', {
      data: {
        platform: 'TRENDYOL',
        productName: 'Mevsim Yeşillikleri Salata',
        quantity: 2,
        customerName: 'Zeynep Kaya',
        deliveryAddress: 'Fenerbahçe Mah. No: 12',
      },
    });

    expect(tyRes.status()).toBe(201);

    // 2. Open KDS screen on EXPEDITOR station
    await page.goto('/kds');
    await page.locator('.station-btn[data-station="EXPEDITOR"]').click();

    // 3. Verify ticket appears with Salata
    const salataTicket = page.locator('.ticket-card', { hasText: 'Mevsim Yeşillikleri Salata' }).first();
    await expect(salataTicket).toBeVisible({ timeout: 5000 });
    await expect(salataTicket.locator('.item-title')).toContainText('2x');

    // 4. Bump ticket via bump button or click
    const bumpBtn = salataTicket.locator('.bump-ticket-btn');
    await bumpBtn.click();
    await expect(salataTicket.locator('.item-row').first()).toHaveClass(/item-ready/, { timeout: 5000 });
  });

  test('Waiter Handheld Terminal: Offline/Online resilience and WebSocket reconnect', async ({ page, request }) => {
    // 1. Open Waiter terminal
    await page.goto('/waiter');
    await expect(page.locator('.header-title')).toContainText('GARSON EL TERMİNALİ');
    await expect(page.locator('#wsBadge')).toBeVisible();

    // 2. Set network offline via sync API
    await request.post('/api/v1/sync/network-mode', {
      data: { isOnline: false },
    });

    // Verify edge sync status indicates offline
    const statusRes = await request.get('/api/v1/sync/status');
    const statusData = await statusRes.json();
    expect(statusData.status.networkState).toBe('OFFLINE');

    // 3. Re-enable network online
    await request.post('/api/v1/sync/network-mode', {
      data: { isOnline: true },
    });

    const onlineRes = await request.get('/api/v1/sync/status');
    const onlineData = await onlineRes.json();
    expect(onlineData.status.networkState).toBe('ONLINE');

    // 4. Verify Waiter screen remains fully functional and interactive
    const terasBtn = page.locator('.section-tabs .tab-btn', { hasText: 'Teras' });
    await terasBtn.click();
    await expect(page.locator('.table-card', { hasText: 'Teras' }).first()).toBeVisible();
  });
});
