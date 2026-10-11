import { test, expect } from '@playwright/test';

test.describe('Faz 2: KDS & Waiter Handheld Terminal E2E Suite', () => {

  test('Waiter Terminal: section filtering, table selection, and quick-order modal flow', async ({ page }) => {
    // 1. Open Waiter Terminal
    await page.goto('/waiter');
    await expect(page.locator('.header-title')).toContainText('GARSON EL TERMİNALİ');
    await expect(page.locator('#wsBadge')).toContainText('ÇEVRİMİÇİ');

    // 2. Section filtering
    const terasTab = page.locator('.section-tabs .tab-btn', { hasText: 'Teras' });
    await terasTab.click();
    await expect(page.locator('.table-card', { hasText: 'Teras' }).first()).toBeVisible();

    const anaSalonTab = page.locator('.section-tabs .tab-btn', { hasText: 'Ana Salon' });
    await anaSalonTab.click();
    await expect(page.locator('.table-card', { hasText: 'Salon' }).first()).toBeVisible();

    // 3. Table click -> opens Menu View
    const tableCard = page.locator('.table-card', { hasText: 'Salon-2' }).first();
    await tableCard.click();
    await expect(page.locator('#viewMenu')).toHaveClass(/active/);
    await expect(page.locator('#currentTableLabel')).toContainText('Salon-2');

    // 4. Category navigation & product selection
    await expect(page.locator('.product-card').first()).toBeVisible();
    const burgerProduct = page.locator('.product-card', { hasText: 'Klasik Gurme Burger' });
    await burgerProduct.click();

    // 5. Modifier & Notes Modal
    const modalBackdrop = page.locator('#modalBackdrop');
    await expect(modalBackdrop).toBeVisible();
    await expect(page.locator('#modalProdTitle')).toContainText('Klasik Gurme Burger');

    // Check modifier if available
    const cheddarCb = page.locator('#modalModifiersList input[data-name="Ekstra Cheddar Peyniri"]');
    if (await cheddarCb.count() > 0) {
      await cheddarCb.check();
    }

    // Type kitchen customer note
    await page.locator('#modalCustomerNote').fill('Sos ayrı olsun, iyi pişmiş');

    // Confirm add to cart
    await page.locator('button', { hasText: 'Sepete Ekle' }).click();
    await expect(modalBackdrop).toBeHidden();

    // 6. Cart verification
    const cartSection = page.locator('#cartSection');
    await expect(cartSection).toBeVisible();
    await expect(page.locator('#cartItemsList')).toContainText('Klasik Gurme Burger');
    await expect(page.locator('#cartTotalLabel')).not.toContainText('0.00 TL');

    // 7. Submit Quick Order to KDS
    page.once('dialog', async (dialog) => {
      expect(dialog.message()).toContain('KDS mutfağına iletildi');
      await dialog.accept();
    });

    const submitBtn = page.locator('button', { hasText: 'MUTFAĞA İLET' });
    await submitBtn.click();

    // After order submission, returns to Tables view
    await expect(page.locator('#viewTables')).toHaveClass(/active/);
  });

  test('KDS Kiosk: station filtering, ticket bump, keyboard bump-bar and recall', async ({ page }) => {
    // Handle any alert dialogs gracefully
    page.on('dialog', async (dialog) => {
      await dialog.accept();
    });

    // 1. Open KDS screen
    await page.goto('/kds');
    await expect(page.locator('h1')).toContainText('KDS MUTFAK EKRANI');
    await expect(page.locator('#wsStatusText')).toContainText('CANLI');

    // 2. Station tabs navigation
    const stations = ['GRILL', 'OVEN', 'COLD', 'BAR', 'EXPEDITOR'];
    for (const st of stations) {
      const btn = page.locator(`.station-btn[data-station="${st}"]`);
      await btn.click();
      await expect(btn).toHaveClass(/active/);
    }

    // Return to EXPEDITOR
    await page.locator('.station-btn[data-station="EXPEDITOR"]').click();

    // 3. Ticket interaction (if tickets present)
    const ticketCards = page.locator('.ticket-card');
    const ticketCount = await ticketCards.count();

    if (ticketCount > 0) {
      const firstTicket = ticketCards.first();
      await expect(firstTicket).toBeVisible();

      // Target item row
      const itemRow = firstTicket.locator('.item-row').first();
      await itemRow.click();
      await expect(itemRow).toHaveClass(/item-ready/);

      // Recall button interaction
      const recallBtn = page.locator('#recallBtn');
      await recallBtn.click();
      await expect(itemRow).not.toHaveClass(/item-ready/);

      // Keyboard bump bar test: Arrow navigation
      await page.keyboard.press('ArrowRight');
      await expect(firstTicket).toBeVisible();
      await page.keyboard.press('ArrowLeft');
      await expect(firstTicket).toBeVisible();

      // Keyboard recall (Z key)
      await page.keyboard.press('z');
      await expect(firstTicket).toBeVisible();

      // Keyboard bump ticket (Enter key)
      await page.keyboard.press('Enter');
      await expect(firstTicket).toBeVisible();
    }
  });

  test('Full Cross-Terminal Loop: Waiter order -> KDS display & bump -> Waiter alert & serve', async ({ browser }) => {
    const waiterContext = await browser.newContext();
    const kdsContext = await browser.newContext();

    const waiterPage = await waiterContext.newPage();
    const kdsPage = await kdsContext.newPage();

    waiterPage.on('dialog', async (d) => await d.accept());
    kdsPage.on('dialog', async (d) => await d.accept());

    // 1. Open KDS screen on GRILL station
    await kdsPage.goto('/kds');
    await kdsPage.locator('.station-btn[data-station="GRILL"]').click();

    // 2. Open Waiter screen and place order on Salon-3
    await waiterPage.goto('/waiter');
    await waiterPage.locator('.table-card', { hasText: 'Salon-3' }).first().click();

    // Select Antrikot (GRILL)
    const antrikotProd = waiterPage.locator('.product-card', { hasText: 'Antrikot Izgara' });
    await antrikotProd.click();
    await waiterPage.locator('button', { hasText: 'Sepete Ekle' }).click();

    // Submit order to KDS
    await waiterPage.locator('button', { hasText: 'MUTFAĞA İLET' }).click();
    await expect(waiterPage.locator('#viewTables')).toHaveClass(/active/);

    // 3. KDS GRILL screen should show ticket for Salon-3
    await kdsPage.locator('.station-btn[data-station="GRILL"]').click();
    const salon3Ticket = kdsPage.locator('.ticket-card', { hasText: 'Salon-3' });
    await expect(salon3Ticket).toBeVisible({ timeout: 5000 });

    // 4. Chef bumps the entire ticket on KDS
    const bumpBtn = salon3Ticket.locator('.bump-ticket-btn');
    await bumpBtn.click();
    await expect(salon3Ticket.locator('.item-row').first()).toHaveClass(/item-ready/, { timeout: 5000 });

    // 5. Waiter terminal alerts view check
    await waiterPage.locator('.nav-item', { hasText: 'Bildirimler' }).click();
    await expect(waiterPage.locator('#viewAlerts')).toHaveClass(/active/);

    // Waiter confirms delivery -> click "TESLİM EDİLDİ"
    const serveBtn = waiterPage.locator('.serve-btn', { hasText: 'TESLİM EDİLDİ' }).first();
    await expect(serveBtn).toBeVisible({ timeout: 5000 });
    await serveBtn.click();
    await expect(serveBtn).not.toBeVisible({ timeout: 5000 });

    // 6. After served, ticket disappears from KDS
    await kdsPage.locator('.station-btn[data-station="GRILL"]').click();
    await expect(salon3Ticket).not.toBeVisible({ timeout: 5000 });

    await waiterContext.close();
    await kdsContext.close();
  });
});
