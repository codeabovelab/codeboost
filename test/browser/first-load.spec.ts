import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDemo } from '../../scripts/demo.ts';
import { startServer } from '../../web/server.ts';

// These tests act while the page's first review load is still pending, so they must not use openReview/reloadReview,
// which wait for that load to finish.
const LOADING = 'Linking changes to plan items…';

let root: string, app: Awaited<ReturnType<typeof startServer>>;
test.beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'codeboost-first-load-browser-'));
  app = await startServer(createDemo(join(root, 'demo')), 0);
});
test.afterEach(async () => {
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

/** Opens the page with its first /api/review request held in the browser until the test calls `release`. */
async function openWithHeldReview(page: Page, url: string, answer: 'pass' | 'fail' = 'pass') {
  let release!: () => void, arrived!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { arrived = resolve; });
  await page.route('**/api/review', async route => {
    arrived();
    await held;
    if (answer === 'fail') await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'History unavailable.' }) });
    else await route.continue();
  }, { times: 1 });
  await page.goto(url, { waitUntil: 'commit' });
  await reached;
  await expect(page.locator('#banner')).toHaveText(LOADING);
  return release;
}

// app.url carries the session token in its hash; the view goes in the query before it.
function plansUrl() {
  const url = new URL(app.url);
  url.search = '?view=plans';
  return url.href;
}

function countRequests(page: Page, path: string) {
  const seen: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname === path) seen.push(request.method()); });
  return seen;
}

const nextPlan = {
  schema_version: 1,
  issue: 3,
  revision: 2,
  summary: 'Make retry limits visible to operators',
  items: [{
    id: 'P1',
    title: 'Expose the retry ceiling',
    intent: 'Keep the bounded delay and make its ceiling explicit.',
    files: [{ path: 'retry.ts', kind: 'edit', renamed_from: null, change: 'Name the retry ceiling.' }],
    acceptance: [{ type: 'check', text: 'The delay never exceeds five seconds.' }],
    depends_on: [],
  }],
  questions: [],
};

test('keeps question and change-request text typed before the first review load and gives it to the first item', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const actions = countRequests(page, '/api/action');
  const release = await openWithHeldReview(page, app.url);

  await page.getByLabel('Question about this item').fill('Typed before the review loaded.');
  await page.getByRole('button', { name: 'Request change', exact: true }).click();
  await page.getByLabel('Change to request').fill('Change typed before the review loaded.');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.getByLabel('Question about this item')).toHaveValue('Typed before the review loaded.');
  // Typed after the last mode switch: only the page's handling of the response can save this part.
  await page.getByLabel('Question about this item').press('End');
  await page.getByLabel('Question about this item').pressSequentially(' Still typing.');

  release();
  await expect(page.locator('#banner')).not.toHaveText(LOADING, { timeout: 30_000 });
  await expect(page.locator('[data-select="P1"]')).toHaveAttribute('aria-current', 'true');
  await expect(page.getByLabel('Question about this item')).toHaveValue('Typed before the review loaded. Still typing.');
  await expect(page.getByLabel('Question about this item')).toBeFocused();
  await expect(page.getByText('Retained draft')).toHaveCount(0);
  await page.getByRole('button', { name: 'Request change', exact: true }).click();
  await expect(page.getByLabel('Change to request')).toHaveValue('Change typed before the review loaded.');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();

  // The text now belongs to P1: another item starts empty, and P1 still has it on return.
  await page.locator('[data-select="P2"]').click();
  await expect(page.getByLabel('Question about this item')).toHaveValue('');
  await page.locator('[data-select="P1"]').click();
  await expect(page.getByLabel('Question about this item')).toHaveValue('Typed before the review loaded. Still typing.');

  expect(actions).toEqual([]);
  expect(app.service.store.getReviewNotes(app.service.config.identity)).toEqual([]);
  expect(errors).toEqual([]);
});

test('keeps text typed before a failed first load and gives it to the first item when Refresh succeeds', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const release = await openWithHeldReview(page, app.url, 'fail');
  await page.getByLabel('Question about this item').fill('Typed before the failed load.');
  await page.getByRole('button', { name: 'Request change', exact: true }).click();
  await page.getByLabel('Change to request').fill('Change typed before the failed load.');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  // Typed after the last mode switch, so no mode switch saved this part.
  await page.getByLabel('Question about this item').press('End');
  await page.getByLabel('Question about this item').pressSequentially(' Still typing.');

  release();
  await expect(page.locator('#banner')).toContainText('Could not read this branch’s history.');
  await expect(page.getByLabel('Question about this item')).toBeDisabled();
  await expect(page.getByLabel('Question about this item')).toHaveValue('Typed before the failed load. Still typing.');

  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('[data-select="P1"]')).toHaveAttribute('aria-current', 'true', { timeout: 30_000 });
  await expect(page.getByLabel('Question about this item')).toBeEnabled();
  await expect(page.getByLabel('Question about this item')).toHaveValue('Typed before the failed load. Still typing.');
  await expect(page.getByText('Retained draft')).toHaveCount(0);
  await page.getByRole('button', { name: 'Request change', exact: true }).click();
  await expect(page.getByLabel('Change to request')).toHaveValue('Change typed before the failed load.');
  expect(app.service.store.getReviewNotes(app.service.config.identity)).toEqual([]);
  expect(errors).toEqual([]);
});

test('refuses a plan import made before the first review load, says why, and imports once the plan appears', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const imports = countRequests(page, '/api/plan/import');
  const release = await openWithHeldReview(page, plansUrl());

  await expect(page.locator('#plans-summary')).toHaveText('Loading plan…');
  await expect(page.locator('#plans-status')).toHaveText('Loading the current plan…');
  const importButton = page.getByRole('button', { name: 'Import next revision' });
  await expect(importButton).toHaveAttribute('aria-disabled', 'true');
  // aria-disabled keeps the control reachable: keyboard activation must explain the refusal, not do nothing. With no
  // file chosen yet, the browser's own file check must not answer instead.
  await importButton.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#plans-status')).toHaveText('! The plan is still loading. Nothing was imported. Import after it appears.');
  await expect(page.locator('#plans-status')).toHaveClass('warn');
  await expect(importButton).toBeFocused();
  await page.locator('#plans-status').evaluate(element => { element.textContent = ''; });
  await page.getByLabel('Plan file').setInputFiles({ name: 'plan.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(nextPlan)) });
  await importButton.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#plans-status')).toHaveText('! The plan is still loading. Nothing was imported. Import after it appears.');
  await expect(importButton).toBeFocused();

  release();
  await expect(page.locator('#plans-status')).toHaveText('✓ Revision r1 is current.', { timeout: 30_000 });
  await expect(page.locator('#plans-revision')).toHaveText('r1');
  await expect(importButton).not.toHaveAttribute('aria-disabled', 'true');
  expect(imports).toEqual([]);
  expect(app.service.store.getPlan(app.service.config.identity).revision).toBe(1);

  // The file chosen during the load is still selected and imports normally now.
  await expect(page.locator('#plan-file-details')).toHaveText('plan.json · JSON');
  await importButton.click();
  await expect(page.locator('#plans-status')).toHaveText('✓ Revision r2 is current.', { timeout: 30_000 });
  expect(imports).toEqual(['POST']);
  expect(app.service.store.getPlan(app.service.config.identity).revision).toBe(2);
  expect(errors).toEqual([]);
});

test('refuses a plan import after the first review load failed, and says why', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const imports = countRequests(page, '/api/plan/import');
  const release = await openWithHeldReview(page, plansUrl(), 'fail');
  release();
  await expect(page.locator('#plans-status')).toContainText('✕ Could not read this branch’s history. History unavailable.');
  await expect(page.locator('#plans-summary')).toHaveText('Plan unavailable');
  await expect(page.locator('#plan-author-status')).toHaveText('Load a plan before asking the agent.');

  const importButton = page.getByRole('button', { name: 'Import next revision' });
  await expect(importButton).toHaveAttribute('aria-disabled', 'true');
  await importButton.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#plans-status')).toHaveText('✕ No plan is loaded, so nothing was imported. Use Refresh plan, then import.');
  await expect(page.locator('#plans-status')).toHaveClass('bad');
  await expect(importButton).toBeFocused();
  await page.locator('#plans-status').evaluate(element => { element.textContent = ''; });
  await page.getByLabel('Plan file').setInputFiles({ name: 'plan.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(nextPlan)) });
  await importButton.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#plans-status')).toHaveText('✕ No plan is loaded, so nothing was imported. Use Refresh plan, then import.');
  expect(imports).toEqual([]);
  expect(app.service.store.getPlan(app.service.config.identity).revision).toBe(1);
  expect(errors).toEqual([]);
});

test('refuses a plan import during Refresh plan after a failed first load, and keeps the refresh result', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const imports = countRequests(page, '/api/plan/import');
  const release = await openWithHeldReview(page, plansUrl(), 'fail');
  release();
  await expect(page.locator('#plans-status')).toContainText('✕ Could not read this branch’s history.');

  let releaseRefresh!: () => void, refreshArrived!: () => void;
  const heldRefresh = new Promise<void>(resolve => { releaseRefresh = resolve; });
  const refreshReached = new Promise<void>(resolve => { refreshArrived = resolve; });
  await page.route('**/api/review', async route => {
    refreshArrived();
    await heldRefresh;
    await route.continue();
  }, { times: 1 });
  await page.getByRole('button', { name: 'Refresh plan' }).click();
  await refreshReached;
  await expect(page.locator('#plans-summary')).toHaveText('Loading plan…');
  await expect(page.locator('#plan-author-status')).toHaveText('The plan is still loading. Ask the agent after it appears.');

  const importButton = page.getByRole('button', { name: 'Import next revision' });
  await expect(importButton).toHaveAttribute('aria-disabled', 'true');
  await page.getByLabel('Plan file').setInputFiles({ name: 'plan.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(nextPlan)) });
  await importButton.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#plans-status')).toHaveText('! The plan is still loading. Nothing was imported. Import after it appears.');

  releaseRefresh();
  await expect(page.locator('#plans-status')).toHaveText('✓ Revision r1 is current.', { timeout: 30_000 });
  await expect(page.locator('#plans-revision')).toHaveText('r1');
  await expect(importButton).not.toHaveAttribute('aria-disabled', 'true');
  expect(imports).toEqual([]);
  expect(app.service.store.getPlan(app.service.config.identity).revision).toBe(1);
  expect(errors).toEqual([]);
});
