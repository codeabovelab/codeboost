import { expect, type Page } from '@playwright/test';

/**
 * Every page load fetches the review once and shows "Linking changes to plan items…" until it has applied the answer
 * (or its failure). The server runs in this test process; while its review loads blocked the event loop, Playwright
 * could not act until a load had finished. They no longer block, so a test that acts on the loaded page waits for it.
 */
const LOADING = 'Linking changes to plan items…';

export async function openReview(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.locator('#banner')).not.toHaveText(LOADING, { timeout: 30_000 });
}

export async function reloadReview(page: Page): Promise<void> {
  await page.reload();
  await expect(page.locator('#banner')).not.toHaveText(LOADING, { timeout: 30_000 });
}

/**
 * Clicks Refresh and waits for a review response and for the page to apply it, so the next step acts on the refreshed
 * page. Call it on a settled page: a click the page ignores (another action in progress) starts no load and fails here,
 * unless another review request was already in flight.
 */
export async function refreshReview(page: Page): Promise<void> {
  const answered = page.waitForResponse(response => new URL(response.url()).pathname === '/api/review', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await answered;
  await expect(page.locator('#banner')).not.toHaveText(LOADING, { timeout: 30_000 });
}
