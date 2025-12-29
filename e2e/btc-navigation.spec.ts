import { test, expect } from '@playwright/test';

test('btc route preserves webhook table after navigation', async ({ page }) => {
  page.on('console', (msg) => {
    console.log(`[browser:${msg.type()}] ${msg.text()}`);
  });
  page.on('pageerror', (error) => {
    console.log(`[browser:error] ${error.message}`);
  });
  page.on('requestfailed', (request) => {
    console.log(`[requestfailed] ${request.url()} ${request.failure()?.errorText ?? ''}`);
  });

  await page.goto('/btc');

  await expect(page.getByText('TradingView Webhooks')).toBeVisible();

  const rows = page.locator('table mat-row');
  const hasRows = await rows.first().waitFor({ state: 'visible', timeout: 10000 }).then(
    () => true,
    () => false
  );

  if (!hasRows) {
    test.skip(true, 'No live webhook rows available from backend');
  }

  await page.getByRole('link', { name: 'Back to home' }).click();
  await expect(page).toHaveURL(/\/$/);

  await page.getByRole('link', { name: 'Open BTCUSDT' }).click();
  await expect(page).toHaveURL(/\/btc$/);

  await expect(page.getByText('TradingView Webhooks')).toBeVisible();
  await expect(rows.first()).toBeVisible();
});
