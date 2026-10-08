import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDemo } from '../../scripts/demo.ts';
import { startServer } from '../../web/server.ts';
import type { MergeGateway, MergeQueueGateway } from '../../github/merge.ts';
import { fixtureGit } from '../fixtures/git.ts';

let root: string, app: Awaited<ReturnType<typeof startServer>>;
test.beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'codeboost-plans-browser-'));
  app = await startServer(createDemo(join(root, 'demo')), 0);
});
test.afterEach(async () => {
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

const nextPlan = {
  schema_version: 1,
  issue: 3,
  revision: 2,
  summary: 'Make retry limits visible to operators',
  items: [
    {
      id: 'P1',
      title: 'Expose the retry ceiling',
      intent: 'Keep the bounded delay and make its ceiling explicit.',
      files: [{ path: 'retry.ts', kind: 'edit', renamed_from: null, change: 'Name the retry ceiling.' }],
      acceptance: [{ type: 'check', text: 'The delay never exceeds five seconds.' }],
      depends_on: [],
    },
    {
      id: 'P2',
      title: 'Document the named limit',
      intent: 'Explain the operator-visible retry ceiling.',
      files: [{ path: 'RETRYING.md', kind: 'rename', renamed_from: 'README.md', change: 'Rename and update the retry guide.' }],
      acceptance: [{ type: 'check', text: 'The documentation names the five-second limit.' }],
      depends_on: ['P1'],
    },
  ],
  questions: ['Should operators be able to lower the ceiling?'],
} as const;

const yaml = `schema_version: 1
issue: 3
revision: 2
summary: Make retry limits visible to operators
items:
  - id: P1
    title: Expose the retry ceiling
    intent: Keep the bounded delay and make its ceiling explicit.
    files:
      - path: retry.ts
        kind: edit
        renamed_from: null
        change: Name the retry ceiling.
    acceptance:
      - type: check
        text: The delay never exceeds five seconds.
    depends_on: []
  - id: P2
    title: Document the named limit
    intent: Explain the operator-visible retry ceiling.
    files:
      - path: RETRYING.md
        kind: rename
        renamed_from: README.md
        change: Rename and update the retry guide.
    acceptance:
      - type: check
        text: The documentation names the five-second limit.
    depends_on: [P1]
questions:
  - Should operators be able to lower the ceiling?
`;

for (const fixture of [
  { format: 'JSON', name: 'plan.json', mimeType: 'application/json', source: JSON.stringify(nextPlan) },
  { format: 'YAML', name: 'plan.yaml', mimeType: 'application/yaml', source: yaml },
]) {
  test(`displays the current plan and imports the next ${fixture.format} revision without losing a review draft`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(app.url);
    await page.getByLabel('Question about this item').fill('Keep this unsent question.');

    await page.getByRole('link', { name: 'Plans', exact: true }).click();
    await expect(page).toHaveURL(/\?view=plans$/);
    await expect(page.getByRole('link', { name: 'Plans', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { name: 'Make retries predictable and document the behavior' })).toBeVisible();
    await expect(page.locator('#plans-revision')).toHaveText('r1');
    await expect(page.getByRole('article', { name: 'Bound exponential retries' })).toContainText('retry.ts');
    await expect(page.getByRole('article', { name: 'Document retry behavior' })).toContainText('Depends on P1');

    await page.getByLabel('Plan file').setInputFiles({ name: fixture.name, mimeType: fixture.mimeType, buffer: Buffer.from(fixture.source) });
    await expect(page.locator('#plan-file-details')).toContainText(`${fixture.name} · ${fixture.format}`);
    await page.getByRole('button', { name: 'Import next revision' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Revision r2 is current.' })).toBeVisible();
    await expect(page.locator('#plans-revision')).toHaveText('r2');
    await expect(page.getByRole('heading', { name: 'Make retry limits visible to operators' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Open questions' })).toBeVisible();
    await expect(page.getByText('Should operators be able to lower the ceiling?')).toBeVisible();
    const renamed = page.getByRole('article', { name: 'Document the named limit' });
    await expect(renamed).toContainText('Depends on P1');
    await expect(renamed.getByText('README.md')).toBeVisible();
    await expect(renamed.getByText('RETRYING.md')).toBeVisible();

    await page.getByRole('link', { name: 'Review', exact: true }).click();
    await expect(page.getByLabel('Question about this item')).toHaveValue('Keep this unsent question.');
    await page.getByRole('link', { name: 'Plans', exact: true }).click();
    await page.reload();
    await expect(page).toHaveURL(/\?view=plans$/);
    await expect(page.locator('#plans-revision')).toHaveText('r2');
    if (fixture.format === 'JSON') await page.screenshot({ path: 'test-results/plans-desktop.png', fullPage: true });
    expect(errors).toEqual([]);
  });
}

test('shows a rejected import without replacing the current plan', async ({ page }) => {
  await page.goto(app.url);
  await page.getByRole('link', { name: 'Plans', exact: true }).click();
  const wrongIssue = JSON.stringify({ ...nextPlan, issue: 413 });
  await page.getByLabel('Plan file').setInputFiles({ name: 'wrong-issue.json', mimeType: 'application/json', buffer: Buffer.from(wrongIssue) });
  await page.getByRole('button', { name: 'Import next revision' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Could not import the plan.' })).toContainText('selected issue');
  await expect(page.locator('#plans-revision')).toHaveText('r1');
  expect(app.service.store.getPlan(app.service.config.identity).revision).toBe(1);
});

test('keeps focus and a newly selected file when an older import response returns', async ({ page }) => {
  await page.goto(app.url);
  await page.getByRole('link', { name: 'Plans', exact: true }).click();
  const file = page.getByLabel('Plan file');
  await file.setInputFiles({ name: 'plan.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(nextPlan)) });
  let release!: () => void, arrived!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const captured = new Promise<void>(resolve => { arrived = resolve; });
  let requests = 0;
  await page.route('**/api/plan/import', async route => {
    requests++;
    arrived();
    await held;
    await route.continue();
  });
  const submit = page.locator('#plan-import');
  await submit.focus();
  await submit.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await captured;
  await expect(submit).toBeFocused();
  await expect(submit).toHaveAttribute('aria-disabled', 'true');
  await file.setInputFiles({ name: 'review-later.yaml', mimeType: 'application/yaml', buffer: Buffer.from(yaml) });
  release();
  await expect(page.getByRole('status').filter({ hasText: 'Revision r2 is current.' })).toBeVisible();
  await expect(page.locator('#plan-file-details')).toContainText('review-later.yaml · YAML');
  expect(requests).toBe(1);
});

test('reuses the exact import action after an ambiguous response', async ({ page }) => {
  await page.goto(app.url);
  await page.getByRole('link', { name: 'Plans', exact: true }).click();
  await page.getByLabel('Plan file').setInputFiles({ name: 'plan.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(nextPlan)) });
  const sent: unknown[] = [];
  await page.route('**/api/plan/import', async route => {
    sent.push(route.request().postDataJSON());
    if (sent.length === 1) await route.abort('failed');
    else await route.continue();
  });
  await page.getByRole('button', { name: 'Import next revision' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Could not import the plan.' })).toBeVisible();
  await page.getByRole('button', { name: 'Import next revision' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Revision r2 is current.' })).toBeVisible();
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]);
});

test('replays an ambiguous committed import after refresh without creating another revision', async ({ page }) => {
  await page.goto(app.url);
  await page.getByRole('link', { name: 'Plans', exact: true }).click();
  await page.getByLabel('Plan file').setInputFiles({ name: 'plan.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(nextPlan)) });
  const sent: unknown[] = [];
  await page.route('**/api/plan/import', async route => {
    sent.push(route.request().postDataJSON());
    if (sent.length === 1) {
      await route.fetch();
      await route.abort('failed');
      return;
    }
    await route.continue();
  });
  await page.getByRole('button', { name: 'Import next revision' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Could not import the plan.' })).toBeVisible();
  await page.locator('#plans-refresh').click();
  await expect(page.getByRole('status').filter({ hasText: 'Revision r2 is current.' })).toBeVisible();
  await page.getByRole('button', { name: 'Import next revision' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Revision r2 is current.' })).toBeVisible();
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]);
  expect(app.service.store.getPlan(app.service.config.identity).revision).toBe(2);
});

test('does not let a replayed import reload overwrite a newer terminal merge observation', async ({ page }) => {
  test.slow();
  const config = { ...app.service.config, demo: false };
  await app.close();
  chmodSync(join(config.repository, 'run.sh'), 0o644);
  fixtureGit(config.repository, 'commit', '-am', 'Restore declared scope');
  let appRef: typeof app;
  const gateway: MergeGateway & MergeQueueGateway = {
    inspect: async () => {
      const snapshot = appRef.service.load().snapshot;
      return { base: snapshot.base, head: snapshot.head, pullRequestState: 'OPEN', mergeable: 'MERGEABLE', rulesKnown: true,
        atomicBaseGuard: true, mergeQueue: true, requiredChecks: [], alreadyFixed: 'clear', pullRequest: 7, draft: false };
    },
    queueWatermark: async () => null,
    merge: async () => ({ url: 'https://github.com/example/repo/pull/7' }),
    inspectQueue: async head => ({ state: 'queued', reviewedHead: head, entryId: 'MQE_1', phase: 'QUEUED', position: 1,
      enqueuedAt: '2026-10-07T08:00:00Z', queueHead: head }),
  };
  app = appRef = await startServer(config, 0, undefined, gateway);
  await page.goto(app.url);
  await page.getByRole('link', { name: 'Plans', exact: true }).click();
  await page.getByLabel('Plan file').setInputFiles({ name: 'plan.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(nextPlan)) });
  const sent: unknown[] = [];
  await page.route('**/api/plan/import', async route => {
    sent.push(route.request().postDataJSON());
    if (sent.length === 1) {
      await route.fetch();
      await route.abort('failed');
      return;
    }
    await route.continue();
  });
  await page.getByRole('button', { name: 'Import next revision' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Could not import the plan.' })).toBeVisible();
  await page.locator('#plans-refresh').click();
  await expect(page.getByRole('status').filter({ hasText: 'Revision r2 is current.' })).toBeVisible();

  let view = app.service.load();
  for (const segment of view.segments.filter(value => value.row === 'Unplanned' || value.row === 'Ambiguous'))
    view = app.service.act({ action: 'accept', key: segment.key, token: view.token });
  for (const item of view.items)
    view = app.service.act({ action: 'approve', item: item.id, confirmNoChange: item.count === 0, token: view.token });
  await page.getByRole('link', { name: 'Review', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Merge PR', exact: true })).toBeEnabled();
  page.on('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Merge PR', exact: true }).click();
  await expect.poll(() => app.service.store.getMergeAttempt(config.identity)?.state).toBe('queued');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Merge queued', exact: true })).toBeDisabled();

  let releaseReload!: () => void, reloadArrived!: () => void;
  const heldReload = new Promise<void>(resolve => { releaseReload = resolve; });
  const capturedReload = new Promise<void>(resolve => { reloadArrived = resolve; });
  let queued!: Record<string, unknown>;
  await page.route('**/api/review', async route => {
    const response = await route.fetch();
    const refreshed = await response.json();
    queued = refreshed.merge.queue;
    refreshed.repository = 'import-replay-refreshed';
    refreshed.merge.blockers.push({ code: 'check', message: 'Fresh replay blocker is pending.' });
    reloadArrived();
    await heldReload;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(refreshed) });
  });
  await page.getByRole('link', { name: 'Plans', exact: true }).click();
  await page.getByRole('button', { name: 'Import next revision' }).click();
  await capturedReload;
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]);
  expect(queued.actionId).toEqual(expect.any(String));

  await page.route('**/api/merge', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ queue: { ...queued, state: 'merged', phase: null, position: null,
      occurredAt: '2026-10-07T08:08:00Z', url: 'https://github.com/example/repo/pull/7', reason: null } }),
  }));
  const mergedPoll = page.waitForResponse(response => response.url().endsWith('/api/merge'));
  await page.getByRole('link', { name: 'Review', exact: true }).click();
  await page.getByRole('button', { name: /P1 Expose the retry ceiling/ }).click();
  await mergedPoll;
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByRole('button', { name: 'Merged', exact: true })).toBeDisabled();
  await page.unroute('**/api/merge');

  const staleReloadResponse = page.waitForResponse(response => response.url().endsWith('/api/review'));
  releaseReload();
  await (await staleReloadResponse).finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator('#repository')).toHaveText('import-replay-refreshed');
  await expect(page.getByRole('button', { name: 'Merged', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Merge status', exact: true }).click();
  await expect(page.locator('#dialog-body')).toContainText('merged');
  await expect(page.locator('#dialog-body')).toContainText('Fresh replay blocker is pending.');
});

test('preserves an unresolved import retry while another file is definitely refused', async ({ page }) => {
  await page.goto(app.url);
  await page.getByRole('link', { name: 'Plans', exact: true }).click();
  const file = page.getByLabel('Plan file');
  const source = JSON.stringify(nextPlan);
  await file.setInputFiles({ name: 'plan.json', mimeType: 'application/json', buffer: Buffer.from(source) });
  const sent: unknown[] = [];
  await page.route('**/api/plan/import', async route => {
    sent.push(route.request().postDataJSON());
    if (sent.length === 1) {
      await route.fetch();
      await route.abort('failed');
      return;
    }
    await route.continue();
  });
  await page.getByRole('button', { name: 'Import next revision' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Could not import the plan.' })).toBeVisible();

  const wrongIssue = JSON.stringify({ ...nextPlan, issue: 413 });
  await file.setInputFiles({ name: 'wrong-issue.json', mimeType: 'application/json', buffer: Buffer.from(wrongIssue) });
  await page.getByRole('button', { name: 'Import next revision' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Could not import the plan.' })).toContainText('Stale plan revision.');

  await page.locator('#plans-refresh').click();
  await expect(page.getByRole('status').filter({ hasText: 'Revision r2 is current.' })).toBeVisible();
  await file.setInputFiles({ name: 'plan.json', mimeType: 'application/json', buffer: Buffer.from(source) });
  await page.getByRole('button', { name: 'Import next revision' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Revision r2 is current.' })).toBeVisible();
  expect(sent).toHaveLength(3);
  expect(sent[2]).toEqual(sent[0]);
  expect(app.service.store.getPlan(app.service.config.identity).revision).toBe(2);
});

test('reports a committed import separately when reloading the plan fails', async ({ page }) => {
  await page.goto(app.url);
  await page.getByRole('link', { name: 'Plans', exact: true }).click();
  await page.getByLabel('Plan file').setInputFiles({ name: 'plan.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(nextPlan)) });
  await page.route('**/api/review', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Reload unavailable.' }) }));
  await page.getByRole('button', { name: 'Import next revision' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Revision r2 was imported' })).toContainText('could not reload');
  await expect(page.locator('#plans-revision')).toHaveText('r1');
  expect(app.service.store.getPlan(app.service.config.identity).revision).toBe(2);
});

test('does not let an older Review refresh overwrite a committed import', async ({ page }) => {
  await page.goto(app.url);
  let release!: () => void, arrived!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const captured = new Promise<void>(resolve => { arrived = resolve; });
  let reads = 0;
  await page.route('**/api/review', async route => {
    reads++;
    if (reads !== 1) { await route.continue(); return; }
    const old = await route.fetch();
    arrived();
    await held;
    await route.fulfill({ response: old });
  });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await captured;
  await page.getByRole('link', { name: 'Plans', exact: true }).click();
  await page.getByLabel('Plan file').setInputFiles({ name: 'plan.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(nextPlan)) });
  await page.getByRole('button', { name: 'Import next revision' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Revision r2 is current.' })).toBeVisible();
  await page.getByRole('link', { name: 'Review', exact: true }).click();
  await page.getByRole('button', { name: 'Approve P1', exact: true }).click();
  await expect(page.getByText('1 of 2 approved')).toBeVisible();
  await page.getByRole('link', { name: 'Plans', exact: true }).click();
  const staleReviewResponse = page.waitForResponse(response => response.url().endsWith('/api/review'));
  release();
  await (await staleReviewResponse).finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator('#reload')).toHaveText('Refresh');
  await expect(page.locator('#plans-revision')).toHaveText('r2');
  await expect(page.getByRole('status').filter({ hasText: 'Revision r2 is current.' })).toBeVisible();
  expect(app.service.store.getPlan(app.service.config.identity).revision).toBe(2);
});

test('clears stale Plans data when a Review refresh fails after navigation', async ({ page }) => {
  await page.goto(app.url);
  let release!: () => void, arrived!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const captured = new Promise<void>(resolve => { arrived = resolve; });
  await page.route('**/api/review', async route => {
    arrived();
    await held;
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Review read failed.' }) });
  });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await captured;
  await page.getByRole('link', { name: 'Plans', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Make retries predictable and document the behavior' })).toBeVisible();
  release();
  await expect(page.locator('#reload')).toHaveText('Refresh');
  await expect(page.locator('#plans-summary')).toHaveText('Plan unavailable');
  await expect(page.locator('#plans-status')).toContainText('Could not read this branch’s history. Review read failed. Use Refresh to retry.');
});

test('updates a settled Plans revision status when Review refresh observes a newer plan', async ({ page }) => {
  await page.goto(app.url);
  await page.getByRole('link', { name: 'Plans', exact: true }).click();
  await page.locator('#plans-refresh').click();
  await expect(page.getByRole('status').filter({ hasText: 'Revision r1 is current.' })).toBeVisible();

  const response = await fetch(new URL('/api/plan/import', app.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-codeboost-token': app.token },
    body: JSON.stringify({ source: JSON.stringify(nextPlan), format: 'json', expectedRevision: 1, actionId: randomUUID() }),
  });
  expect(response.status).toBe(200);

  await page.getByRole('link', { name: 'Review', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByRole('link', { name: 'Plans', exact: true }).click();
  await expect(page.locator('#plans-revision')).toHaveText('r2');
  await expect(page.getByRole('status').filter({ hasText: 'Revision r2 is current.' })).toBeVisible();
  await expect(page.locator('#plans-status')).not.toContainText('Revision r1 is current.');
});

test('clears a Plans load-failure status when Review refresh recovers', async ({ page }) => {
  await page.goto(app.url);
  let release!: () => void, arrived!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const captured = new Promise<void>(resolve => { arrived = resolve; });
  await page.route('**/api/review', async route => {
    arrived();
    await held;
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Review read failed.' }) });
  });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await captured;
  await page.getByRole('link', { name: 'Plans', exact: true }).click();
  release();
  await expect(page.locator('#plans-status')).toContainText('Could not read this branch’s history. Review read failed.');

  await page.unroute('**/api/review');
  await page.getByRole('link', { name: 'Review', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByRole('link', { name: 'Plans', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Revision r1 is current.' })).toBeVisible();
  await expect(page.locator('#plans-status')).not.toContainText('Review read failed.');
});

test('does not let an older failed Review refresh replace newer Plans validation feedback', async ({ page }) => {
  await page.goto(app.url);
  let release!: () => void, arrived!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const captured = new Promise<void>(resolve => { arrived = resolve; });
  await page.route('**/api/review', async route => {
    arrived();
    await held;
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Older Review failure.' }) });
  });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await captured;
  await page.getByRole('link', { name: 'Plans', exact: true }).click();
  await page.getByLabel('Plan file').setInputFiles({ name: 'plan.txt', mimeType: 'text/plain', buffer: Buffer.from('not a plan') });
  await page.getByRole('button', { name: 'Import next revision' }).click();
  await expect(page.locator('#plans-status')).toContainText('Choose a JSON or YAML plan file.');

  const staleReviewResponse = page.waitForResponse(response => response.url().endsWith('/api/review'));
  release();
  await (await staleReviewResponse).finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator('#plans-summary')).toHaveText('Plan unavailable');
  await expect(page.locator('#plans-status')).toContainText('Choose a JSON or YAML plan file.');
  await expect(page.locator('#plans-status')).not.toContainText('Older Review failure.');
});

test('does not let a question poll started during Plans refresh replace its completed answer', async ({ page }) => {
  const config = app.service.config;
  await app.close();
  app = await startServer(config, 0, (_prompt, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
  await page.goto(app.url);
  await page.getByLabel('Question about this item').fill('Will this answer finish?');
  await page.getByRole('button', { name: 'Ask agent', exact: true }).click();
  await expect(page.getByText('Agent · Answering…', { exact: true })).toBeVisible();
  const note = app.service.store.getReviewNotes(config.identity).find(value => value.text === 'Will this answer finish?')!;

  let releaseRefresh!: () => void, refreshArrived!: () => void;
  const heldRefresh = new Promise<void>(resolve => { releaseRefresh = resolve; });
  const capturedRefresh = new Promise<void>(resolve => { refreshArrived = resolve; });
  await page.route('**/api/review', async route => {
    const response = await route.fetch();
    const refreshed = await response.json();
    const completed = refreshed.notes.find((value: { id: string }) => value.id === note.id);
    completed.answer = { ...completed.answer, status: 'complete', text: 'The fresh completed answer.' };
    completed.answerActive = false;
    refreshArrived();
    await heldRefresh;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(refreshed) });
  });
  await page.getByRole('link', { name: 'Plans', exact: true }).click();
  await page.locator('#plans-refresh').click();
  await capturedRefresh;

  let releasePoll!: () => void, pollArrived!: () => void;
  const heldPoll = new Promise<void>(resolve => { releasePoll = resolve; });
  const capturedPoll = new Promise<void>(resolve => { pollArrived = resolve; });
  await page.route('**/api/questions', async route => {
    const response = await route.fetch();
    pollArrived();
    await heldPoll;
    await route.fulfill({ response });
  });
  await capturedPoll;
  releaseRefresh();
  await expect(page.locator('#plans-status')).toContainText('Revision r1 is current.');
  await page.getByRole('link', { name: 'Review', exact: true }).click();
  await expect(page.getByText('The fresh completed answer.', { exact: true })).toBeVisible();
  const stalePollResponse = page.waitForResponse(response => response.url().endsWith('/api/questions'));
  releasePoll();
  await stalePollResponse;
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByText('The fresh completed answer.', { exact: true })).toBeVisible();
  await expect(page.getByText('Agent · Answering…', { exact: true })).toHaveCount(0);
});

test('does not let an older Plans refresh replace an answer completed while it was pending', async ({ page }) => {
  const config = app.service.config;
  await app.close();
  app = await startServer(config, 0, (_prompt, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
  await page.goto(app.url);
  await page.getByLabel('Question about this item').fill('Did this finish during refresh?');
  await page.getByRole('button', { name: 'Ask agent', exact: true }).click();
  await expect(page.getByText('Agent · Answering…', { exact: true })).toBeVisible();
  const note = app.service.store.getReviewNotes(config.identity).find(value => value.text === 'Did this finish during refresh?')!;

  let releaseRefresh!: () => void, refreshArrived!: () => void;
  const heldRefresh = new Promise<void>(resolve => { releaseRefresh = resolve; });
  const capturedRefresh = new Promise<void>(resolve => { refreshArrived = resolve; });
  await page.route('**/api/review', async route => {
    const response = await route.fetch();
    refreshArrived();
    await heldRefresh;
    await route.fulfill({ response });
  });
  await page.getByRole('link', { name: 'Plans', exact: true }).click();
  await page.locator('#plans-refresh').click();
  await capturedRefresh;

  const completedAnswer = { ...note.answer, status: 'complete', text: 'The poll completed this answer.' };
  const completedPoll = page.waitForResponse(response => response.url().endsWith('/api/questions'));
  let polls = 0;
  await page.route('**/api/questions', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ notes: polls++ === 0 ? [{ id: note.id, answer: completedAnswer, answerActive: false }] : [] }),
  }));
  await completedPoll;
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator('#notes')).toContainText('The poll completed this answer.');

  releaseRefresh();
  await expect(page.locator('#plans-status')).toContainText('Revision r1 is current.');
  await page.getByRole('link', { name: 'Review', exact: true }).click();
  await expect(page.getByText('The poll completed this answer.', { exact: true })).toBeVisible();
  await expect(page.getByText('Agent · Answering…', { exact: true })).toHaveCount(0);
});

test('does not let an older Plans refresh replace an answer failure from the same attempt', async ({ page }) => {
  const config = app.service.config;
  await app.close();
  app = await startServer(config, 0, (_prompt, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
  await page.goto(app.url);
  await page.getByLabel('Question about this item').fill('Will this failure stay visible?');
  await page.getByRole('button', { name: 'Ask agent', exact: true }).click();
  await expect(page.getByText('Agent · Answering…', { exact: true })).toBeVisible();
  const note = app.service.store.getReviewNotes(config.identity).find(value => value.text === 'Will this failure stay visible?')!;

  let releaseRefresh!: () => void, refreshArrived!: () => void;
  const heldRefresh = new Promise<void>(resolve => { releaseRefresh = resolve; });
  const capturedRefresh = new Promise<void>(resolve => { refreshArrived = resolve; });
  await page.route('**/api/review', async route => {
    const response = await route.fetch();
    refreshArrived();
    await heldRefresh;
    await route.fulfill({ response });
  });
  await page.getByRole('link', { name: 'Plans', exact: true }).click();
  await page.locator('#plans-refresh').click();
  await capturedRefresh;

  const failedAnswer = { ...note.answer, status: 'failed', error: 'The agent failed during refresh.' };
  const failedPoll = page.waitForResponse(response => response.url().endsWith('/api/questions'));
  let polls = 0;
  await page.route('**/api/questions', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ notes: polls++ === 0 ? [{ id: note.id, answer: failedAnswer, answerActive: false }] : [] }),
  }));
  await failedPoll;
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator('#notes')).toContainText('The agent failed during refresh.');

  releaseRefresh();
  await expect(page.locator('#plans-status')).toContainText('Revision r1 is current.');
  await page.getByRole('link', { name: 'Review', exact: true }).click();
  await expect(page.getByText('! The agent failed during refresh.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry answer', exact: true })).toBeVisible();
  await expect(page.getByText('Agent · Answering…', { exact: true })).toHaveCount(0);
});

test('does not let an older Plans refresh restore cancellation activity after failure settles', async ({ page }) => {
  const config = app.service.config;
  await app.close();
  app = await startServer(config, 0, (_prompt, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
  await page.goto(app.url);
  await page.getByLabel('Question about this item').fill('Did cancellation settle during refresh?');
  await page.getByRole('button', { name: 'Ask agent', exact: true }).click();
  await expect(page.getByText('Agent · Answering…', { exact: true })).toBeVisible();
  const note = app.service.store.getReviewNotes(config.identity).find(value => value.text === 'Did cancellation settle during refresh?')!;
  const failedAnswer = { ...note.answer, status: 'failed', error: 'The agent timed out.' };

  let releaseRefresh!: () => void, refreshArrived!: () => void;
  const heldRefresh = new Promise<void>(resolve => { releaseRefresh = resolve; });
  const capturedRefresh = new Promise<void>(resolve => { refreshArrived = resolve; });
  await page.route('**/api/review', async route => {
    const response = await route.fetch();
    const refreshed = await response.json();
    const failed = refreshed.notes.find((value: { id: string }) => value.id === note.id);
    failed.answer = failedAnswer;
    failed.answerActive = true;
    refreshArrived();
    await heldRefresh;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(refreshed) });
  });
  await page.getByRole('link', { name: 'Plans', exact: true }).click();
  await page.locator('#plans-refresh').click();
  await capturedRefresh;

  let polls = 0;
  const settledPoll = page.waitForResponse(response => response.url().endsWith('/api/questions'));
  await page.route('**/api/questions', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ notes: polls++ === 0 ? [{ id: note.id, answer: failedAnswer, answerActive: false }] : [] }),
  }));
  await settledPoll;
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.getByRole('link', { name: 'Review', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry answer', exact: true })).toBeVisible();

  const staleReviewResponse = page.waitForResponse(response => response.url().endsWith('/api/review'));
  releaseRefresh();
  await (await staleReviewResponse).finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByRole('button', { name: 'Retry answer', exact: true })).toBeVisible();
  await expect(page.getByText('Agent · Finishing cancellation…', { exact: true })).toHaveCount(0);
});

test('does not let an older Plans refresh re-enable merge after it commits', async ({ page }) => {
  test.slow();
  const config = { ...app.service.config, demo: false };
  await app.close();
  chmodSync(join(config.repository, 'run.sh'), 0o644);
  fixtureGit(config.repository, 'commit', '-am', 'Restore declared scope');
  const gateway: MergeGateway = {
    inspect: async () => {
      const snapshot = app.service.load().snapshot;
      return { base: snapshot.base, head: snapshot.head, pullRequestState: 'OPEN', mergeable: 'MERGEABLE', rulesKnown: true,
        atomicBaseGuard: true, mergeQueue: false, requiredChecks: [], alreadyFixed: 'clear', pullRequest: 7, draft: false };
    },
    merge: async () => ({ url: 'https://github.com/example/repo/pull/7' }),
  };
  app = await startServer(config, 0, undefined, gateway);
  let view = app.service.load();
  for (const segment of view.segments.filter(value => value.row === 'Unplanned' || value.row === 'Ambiguous'))
    view = app.service.act({ action: 'accept', key: segment.key, token: view.token });
  for (const item of view.items)
    view = app.service.act({ action: 'approve', item: item.id, confirmNoChange: item.count === 0, token: view.token });
  await page.goto(app.url);
  await expect(page.getByRole('button', { name: 'Merge PR', exact: true })).toBeEnabled();
  await page.getByRole('link', { name: 'Plans', exact: true }).click();
  let release!: () => void, arrived!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const captured = new Promise<void>(resolve => { arrived = resolve; });
  await page.route('**/api/review', async route => {
    const old = await route.fetch();
    arrived();
    await held;
    await route.fulfill({ response: old });
  });
  await page.locator('#plans-refresh').click();
  await captured;
  await page.getByRole('link', { name: 'Review', exact: true }).click();
  page.on('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Merge PR', exact: true }).click();
  await expect(page.locator('#banner')).toContainText('Merge submitted.');
  await page.getByRole('link', { name: 'Plans', exact: true }).click();
  await expect(page.locator('#plans-refresh')).toHaveText('Refresh plan');
  await expect(page.locator('#plans-status')).toBeEmpty();
  await page.getByRole('link', { name: 'Review', exact: true }).click();
  const staleReviewResponse = page.waitForResponse(response => response.url().endsWith('/api/review'));
  release();
  await (await staleReviewResponse).finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator('#plans-refresh')).toHaveText('Refresh plan');
  await expect(page.locator('#merge')).toBeDisabled();
  await page.getByRole('link', { name: 'Plans', exact: true }).click();
  await expect(page.locator('#plans-status')).toBeEmpty();
  expect(app.service.store.getMergeAttempt(config.identity)?.state).toBe('merged');
});

test('does not let a merge poll started during a review action replace restored retry readiness', async ({ page }) => {
  test.slow();
  const config = { ...app.service.config, demo: false };
  await app.close();
  chmodSync(join(config.repository, 'run.sh'), 0o644);
  fixtureGit(config.repository, 'commit', '-am', 'Restore declared scope');
  let appRef: typeof app;
  const gateway: MergeGateway & MergeQueueGateway = {
    inspect: async () => {
      const snapshot = appRef.service.load().snapshot;
      return { base: snapshot.base, head: snapshot.head, pullRequestState: 'OPEN', mergeable: 'MERGEABLE', rulesKnown: true,
        atomicBaseGuard: true, mergeQueue: true, requiredChecks: [], alreadyFixed: 'clear', pullRequest: 7, draft: false };
    },
    queueWatermark: async () => null,
    merge: async () => ({ url: 'https://github.com/example/repo/pull/7' }),
    inspectQueue: async head => ({ state: 'queued', reviewedHead: head, entryId: 'MQE_1', phase: 'QUEUED', position: 1,
      enqueuedAt: '2026-10-08T08:00:00Z', queueHead: head }),
  };
  app = appRef = await startServer(config, 0, undefined, gateway);
  let review = app.service.load();
  for (const segment of review.segments.filter(value => value.row === 'Unplanned' || value.row === 'Ambiguous'))
    review = app.service.act({ action: 'accept', key: segment.key, token: review.token });
  for (const item of review.items)
    review = app.service.act({ action: 'approve', item: item.id, confirmNoChange: item.count === 0, token: review.token });
  const attempt = app.service.store.beginMergeAttempt(config.identity, review.expected as never, review.snapshot.head, null, 'queue', randomUUID());
  app.service.store.queueMergeAttempt(config.identity, attempt.id, 'https://github.com/example/repo/pull/7');

  let actionPending = false;
  let releasePoll!: () => void, pollArrived!: () => void;
  const heldPoll = new Promise<void>(resolve => { releasePoll = resolve; });
  const capturedPoll = new Promise<void>(resolve => { pollArrived = resolve; });
  const queued = { kind: 'queue', state: 'queued', actionId: attempt.actionId, reviewedHead: review.snapshot.head,
    url: 'https://github.com/example/repo/pull/7', reason: null, phase: 'QUEUED', position: 1,
    occurredAt: '2026-10-08T08:00:00Z', retryable: false };
  await page.route('**/api/merge', async route => {
    if (!actionPending) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ queue: queued }) });
      return;
    }
    pollArrived();
    await heldPoll;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ queue: queued }) });
  });
  await page.goto(app.url);
  await expect(page.getByRole('button', { name: 'Merge queued', exact: true })).toBeDisabled();
  app.service.store.finishMergeAttempt(config.identity, attempt.id, { state: 'removed', reason: 'Required check failed.' });
  const retryReview = await page.request.get(new URL('/api/review', app.url).toString(), {
    headers: { 'x-codeboost-token': app.token },
  });
  const actionResponse = await retryReview.json();
  expect(actionResponse.merge).toMatchObject({ ready: true, action: 'retry' });

  let releaseAction!: () => void, actionArrived!: () => void;
  const heldAction = new Promise<void>(resolve => { releaseAction = resolve; });
  const capturedAction = new Promise<void>(resolve => { actionArrived = resolve; });
  await page.route('**/api/action', async route => {
    actionPending = true;
    actionArrived();
    await heldAction;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(actionResponse) });
  });

  await page.getByRole('button', { name: 'Request change', exact: true }).click();
  await page.getByLabel('Change to request').fill('Keep retry readiness after this response.');
  await page.getByRole('button', { name: 'Save change request', exact: true }).click();
  await capturedAction;
  await page.getByRole('button', { name: /P2 Document retry behavior/ }).click();
  await capturedPoll;
  const actionFinished = page.waitForResponse(response => response.url().endsWith('/api/action'));
  releaseAction();
  await (await actionFinished).finished();
  await expect(page.getByRole('button', { name: 'Retry merge', exact: true })).toBeEnabled();

  const stalePollFinished = page.waitForResponse(response => response.url().endsWith('/api/merge'));
  releasePoll();
  await (await stalePollFinished).finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByRole('button', { name: 'Retry merge', exact: true })).toBeEnabled();
  expect(app.service.store.getMergeAttempt(config.identity)).toMatchObject({ id: attempt.id, state: 'removed' });
});

test('lets a full refresh verify retry readiness after a matching terminal poll', async ({ page }) => {
  test.slow();
  const config = { ...app.service.config, demo: false };
  await app.close();
  chmodSync(join(config.repository, 'run.sh'), 0o644);
  fixtureGit(config.repository, 'commit', '-am', 'Restore declared scope');
  let appRef: typeof app;
  const gateway: MergeGateway & MergeQueueGateway = {
    inspect: async () => {
      const snapshot = appRef.service.load().snapshot;
      return { base: snapshot.base, head: snapshot.head, pullRequestState: 'OPEN', mergeable: 'MERGEABLE', rulesKnown: true,
        atomicBaseGuard: true, mergeQueue: true, requiredChecks: [], alreadyFixed: 'clear', pullRequest: 7, draft: false };
    },
    queueWatermark: async () => null,
    merge: async () => ({ url: 'https://github.com/example/repo/pull/7' }),
    inspectQueue: async head => ({ state: 'queued', reviewedHead: head, entryId: 'MQE_1', phase: 'QUEUED', position: 1,
      enqueuedAt: '2026-10-08T08:00:00Z', queueHead: head }),
  };
  app = appRef = await startServer(config, 0, undefined, gateway);
  let review = app.service.load();
  for (const segment of review.segments.filter(value => value.row === 'Unplanned' || value.row === 'Ambiguous'))
    review = app.service.act({ action: 'accept', key: segment.key, token: review.token });
  for (const item of review.items)
    review = app.service.act({ action: 'approve', item: item.id, confirmNoChange: item.count === 0, token: review.token });
  const attempt = app.service.store.beginMergeAttempt(config.identity, review.expected as never, review.snapshot.head, null, 'queue', randomUUID());
  app.service.store.queueMergeAttempt(config.identity, attempt.id, 'https://github.com/example/repo/pull/7');

  await page.goto(app.url);
  await expect(page.getByRole('button', { name: 'Merge queued', exact: true })).toBeDisabled();
  app.service.store.finishMergeAttempt(config.identity, attempt.id, { state: 'removed', reason: 'Required check failed.' });

  let releaseRefresh!: () => void, refreshArrived!: () => void;
  const heldRefresh = new Promise<void>(resolve => { releaseRefresh = resolve; });
  const capturedRefresh = new Promise<void>(resolve => { refreshArrived = resolve; });
  await page.route('**/api/review', async route => {
    const response = await route.fetch();
    const refreshed = await response.json();
    expect(refreshed.merge).toMatchObject({ ready: true, action: 'retry', queue: {
      actionId: attempt.actionId, reviewedHead: review.snapshot.head, state: 'removed',
    } });
    refreshArrived();
    await heldRefresh;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(refreshed) });
  });
  await page.getByRole('link', { name: 'Plans', exact: true }).click();
  await page.locator('#plans-refresh').click();
  await capturedRefresh;

  const terminalQueue = {
    kind: 'queue', state: 'removed', actionId: attempt.actionId, reviewedHead: review.snapshot.head,
    url: 'https://github.com/example/repo/pull/7', reason: 'Required check failed.', phase: null, position: null,
    occurredAt: '2026-10-08T08:05:00Z', retryable: true,
  };
  await page.route('**/api/merge', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ queue: terminalQueue }),
  }));
  const terminalPoll = page.waitForResponse(response => response.url().endsWith('/api/merge'));
  await page.getByRole('link', { name: 'Review', exact: true }).click();
  await page.getByRole('button', { name: /P1 Bound exponential retries/ }).click();
  await terminalPoll;
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator('#banner')).toContainText('Refresh to verify retry readiness.');
  await expect(page.getByRole('button', { name: /blocker/, exact: true })).toBeDisabled();
  await page.unroute('**/api/merge');

  const refreshResponse = page.waitForResponse(response => response.url().endsWith('/api/review'));
  releaseRefresh();
  await (await refreshResponse).finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByRole('button', { name: 'Retry merge', exact: true })).toBeEnabled();
  await expect(page.locator('#banner')).not.toContainText('Refresh to verify retry readiness.');
  expect(app.service.store.getMergeAttempt(config.identity)).toMatchObject({ id: attempt.id, state: 'removed' });
});

test('lets a terminal full response replace an active poll for the same merge attempt', async ({ page }) => {
  test.slow();
  const config = { ...app.service.config, demo: false };
  await app.close();
  chmodSync(join(config.repository, 'run.sh'), 0o644);
  fixtureGit(config.repository, 'commit', '-am', 'Restore declared scope');
  let appRef: typeof app;
  const gateway: MergeGateway & MergeQueueGateway = {
    inspect: async () => {
      const snapshot = appRef.service.load().snapshot;
      return { base: snapshot.base, head: snapshot.head, pullRequestState: 'OPEN', mergeable: 'MERGEABLE', rulesKnown: true,
        atomicBaseGuard: true, mergeQueue: true, requiredChecks: [], alreadyFixed: 'clear', pullRequest: 7, draft: false };
    },
    queueWatermark: async () => null,
    merge: async () => ({ url: 'https://github.com/example/repo/pull/7' }),
    inspectQueue: async head => ({ state: 'queued', reviewedHead: head, entryId: 'MQE_1', phase: 'QUEUED', position: 1,
      enqueuedAt: '2026-10-08T08:00:00Z', queueHead: head }),
  };
  app = appRef = await startServer(config, 0, undefined, gateway);
  let review = app.service.load();
  for (const segment of review.segments.filter(value => value.row === 'Unplanned' || value.row === 'Ambiguous'))
    review = app.service.act({ action: 'accept', key: segment.key, token: review.token });
  for (const item of review.items)
    review = app.service.act({ action: 'approve', item: item.id, confirmNoChange: item.count === 0, token: review.token });
  const attempt = app.service.store.beginMergeAttempt(config.identity, review.expected as never, review.snapshot.head, null, 'queue', randomUUID());
  app.service.store.queueMergeAttempt(config.identity, attempt.id, 'https://github.com/example/repo/pull/7');

  await page.goto(app.url);
  await expect(page.getByRole('button', { name: 'Merge queued', exact: true })).toBeDisabled();
  app.service.store.finishMergeAttempt(config.identity, attempt.id, { state: 'removed', reason: 'Required check failed.' });

  let releaseRefresh!: () => void, refreshArrived!: () => void;
  const heldRefresh = new Promise<void>(resolve => { releaseRefresh = resolve; });
  const capturedRefresh = new Promise<void>(resolve => { refreshArrived = resolve; });
  await page.route('**/api/review', async route => {
    const response = await route.fetch();
    const refreshed = await response.json();
    expect(refreshed.merge).toMatchObject({ ready: true, action: 'retry', queue: {
      actionId: attempt.actionId, reviewedHead: review.snapshot.head, state: 'removed',
    } });
    refreshArrived();
    await heldRefresh;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(refreshed) });
  });
  await page.getByRole('link', { name: 'Plans', exact: true }).click();
  await page.locator('#plans-refresh').click();
  await capturedRefresh;

  await page.route('**/api/merge', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ queue: {
      kind: 'queue', state: 'queued', actionId: attempt.actionId, reviewedHead: review.snapshot.head,
      url: 'https://github.com/example/repo/pull/7', reason: null, phase: 'QUEUED', position: 2,
      occurredAt: '2026-10-08T08:05:00Z', retryable: false,
    } }),
  }));
  const activePoll = page.waitForResponse(response => response.url().endsWith('/api/merge'));
  await page.getByRole('link', { name: 'Review', exact: true }).click();
  await page.getByRole('button', { name: /P1 Bound exponential retries/ }).click();
  await activePoll;
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator('#banner')).toContainText('Merge queued at position 2.');

  const refreshResponse = page.waitForResponse(response => response.url().endsWith('/api/review'));
  releaseRefresh();
  await (await refreshResponse).finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByRole('button', { name: 'Retry merge', exact: true })).toBeEnabled();
  await expect(page.locator('#banner')).not.toContainText('Merge queued at position 2.');
  expect(app.service.store.getMergeAttempt(config.identity)).toMatchObject({ id: attempt.id, state: 'removed' });
});

test('does not let an older review action response replace a newer queued observation', async ({ page }) => {
  test.slow();
  const config = { ...app.service.config, demo: false };
  await app.close();
  chmodSync(join(config.repository, 'run.sh'), 0o644);
  fixtureGit(config.repository, 'commit', '-am', 'Restore declared scope');
  let appRef: typeof app;
  const gateway: MergeGateway & MergeQueueGateway = {
    inspect: async () => {
      const snapshot = appRef.service.load().snapshot;
      return { base: snapshot.base, head: snapshot.head, pullRequestState: 'OPEN', mergeable: 'MERGEABLE', rulesKnown: true,
        atomicBaseGuard: true, mergeQueue: true, requiredChecks: [], alreadyFixed: 'clear', pullRequest: 7, draft: false };
    },
    queueWatermark: async () => null,
    merge: async () => ({ url: 'https://github.com/example/repo/pull/7' }),
    inspectQueue: async head => ({ state: 'queued', reviewedHead: head, entryId: 'MQE_3', phase: 'QUEUED', position: 2,
      enqueuedAt: '2026-10-08T08:10:00Z', queueHead: head }),
  };
  app = appRef = await startServer(config, 0, undefined, gateway);
  let review = app.service.load();
  for (const segment of review.segments.filter(value => value.row === 'Unplanned' || value.row === 'Ambiguous'))
    review = app.service.act({ action: 'accept', key: segment.key, token: review.token });
  for (const item of review.items)
    review = app.service.act({ action: 'approve', item: item.id, confirmNoChange: item.count === 0, token: review.token });
  const attempt = app.service.store.beginMergeAttempt(config.identity, review.expected as never, review.snapshot.head, null, 'queue', randomUUID());
  app.service.store.queueMergeAttempt(config.identity, attempt.id, 'https://github.com/example/repo/pull/7');
  app.service.store.observeQueuedMerge(config.identity, attempt.id, { entryId: 'MQE_3', phase: 'QUEUED', position: 3 });

  let releaseAction!: () => void, actionArrived!: () => void;
  const heldAction = new Promise<void>(resolve => { releaseAction = resolve; });
  const capturedAction = new Promise<void>(resolve => { actionArrived = resolve; });
  let actionPending = false;
  await page.route('**/api/action', async route => {
    const response = await route.fetch();
    const actionResponse = await response.json();
    expect(actionResponse.merge.queue).toMatchObject({ actionId: attempt.actionId, reviewedHead: review.snapshot.head,
      state: 'queued', phase: 'QUEUED', position: 3 });
    actionPending = true;
    actionArrived();
    await heldAction;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(actionResponse) });
  });
  let polls = 0, releaseLaterPolls!: () => void;
  const heldLaterPolls = new Promise<void>(resolve => { releaseLaterPolls = resolve; });
  await page.route('**/api/merge', async route => {
    if (!actionPending) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ queue: {
        kind: 'queue', state: 'queued', actionId: attempt.actionId, reviewedHead: review.snapshot.head,
        url: 'https://github.com/example/repo/pull/7', reason: null, phase: 'QUEUED', position: 3,
        occurredAt: '2026-10-08T08:05:00Z', retryable: false,
      } }) });
      return;
    }
    polls++;
    if (polls > 1) await heldLaterPolls;
    await route.continue();
  });

  await page.goto(app.url);
  await expect(page.getByRole('button', { name: 'Merge queued', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Request change', exact: true }).click();
  await page.getByLabel('Change to request').fill('Preserve queue progress after this response.');
  await page.getByRole('button', { name: 'Save change request', exact: true }).click();
  await capturedAction;
  try {
    const queuedPoll = page.waitForResponse(async response => response.url().endsWith('/api/merge') &&
      (await response.json()).queue?.position === 2);
    await page.getByRole('button', { name: /P2 Document retry behavior/ }).click();
    await (await queuedPoll).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByRole('button', { name: 'Merge queued', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Merge status', exact: true }).click();
    await expect(page.locator('#dialog-body')).toContainText('position 2');
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    expect(app.service.store.getMergeAttempt(config.identity)).toMatchObject({ id: attempt.id, state: 'queued', position: 2 });

    const staleAction = page.waitForResponse(response => response.url().endsWith('/api/action'));
    releaseAction();
    await (await staleAction).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByRole('button', { name: 'Merge queued', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: /P1 Bound exponential retries/ }).click();
    await expect(page.getByText('Preserve queue progress after this response.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Merge status', exact: true }).click();
    await expect(page.locator('#dialog-body')).toContainText('position 2');
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    expect(app.service.store.getMergeAttempt(config.identity)).toMatchObject({ id: attempt.id, state: 'queued' });
    expect(app.service.store.getReviewNotes(config.identity).some(note => note.text === 'Preserve queue progress after this response.')).toBe(true);
  } finally {
    releaseLaterPolls();
  }
});

for (const mismatch of [
  { label: 'action ID', change: (queue: Record<string, unknown>) => ({ ...queue, actionId: randomUUID() }) },
  { label: 'reviewed head', change: (queue: Record<string, unknown>) => ({ ...queue, reviewedHead: 'f'.repeat(40) }) },
]) {
  test(`does not preserve a newer queue observation with a different ${mismatch.label}`, async ({ page }) => {
    test.slow();
    const config = { ...app.service.config, demo: false };
    await app.close();
    chmodSync(join(config.repository, 'run.sh'), 0o644);
    fixtureGit(config.repository, 'commit', '-am', 'Restore declared scope');
    let appRef: typeof app;
    const gateway: MergeGateway & MergeQueueGateway = {
      inspect: async () => {
        const snapshot = appRef.service.load().snapshot;
        return { base: snapshot.base, head: snapshot.head, pullRequestState: 'OPEN', mergeable: 'MERGEABLE', rulesKnown: true,
          atomicBaseGuard: true, mergeQueue: true, requiredChecks: [], alreadyFixed: 'clear', pullRequest: 7, draft: false };
      },
      queueWatermark: async () => null,
      merge: async () => ({ url: 'https://github.com/example/repo/pull/7' }),
      inspectQueue: async head => ({ state: 'queued', reviewedHead: head, entryId: 'MQE_identity', phase: 'QUEUED', position: 3,
        enqueuedAt: '2026-10-08T08:15:00Z', queueHead: head }),
    };
    app = appRef = await startServer(config, 0, undefined, gateway);
    let review = app.service.load();
    for (const segment of review.segments.filter(value => value.row === 'Unplanned' || value.row === 'Ambiguous'))
      review = app.service.act({ action: 'accept', key: segment.key, token: review.token });
    for (const item of review.items)
      review = app.service.act({ action: 'approve', item: item.id, confirmNoChange: item.count === 0, token: review.token });
    const attempt = app.service.store.beginMergeAttempt(config.identity, review.expected as never, review.snapshot.head, null, 'queue', randomUUID());
    app.service.store.queueMergeAttempt(config.identity, attempt.id, 'https://github.com/example/repo/pull/7');
    app.service.store.observeQueuedMerge(config.identity, attempt.id, { entryId: 'MQE_identity', phase: 'QUEUED', position: 3 });
    const observed = mismatch.change({
      kind: 'queue', state: 'queued', actionId: attempt.actionId, reviewedHead: review.snapshot.head,
      url: 'https://github.com/example/repo/pull/7', reason: null, phase: 'QUEUED', position: 2,
      occurredAt: '2026-10-08T08:16:00Z', retryable: false,
    });

    let releaseAction!: () => void, actionArrived!: () => void;
    const heldAction = new Promise<void>(resolve => { releaseAction = resolve; });
    const capturedAction = new Promise<void>(resolve => { actionArrived = resolve; });
    await page.route('**/api/action', async route => {
      const response = await route.fetch();
      const actionResponse = await response.json();
      expect(actionResponse.merge.queue).toMatchObject({ actionId: attempt.actionId, reviewedHead: review.snapshot.head,
        state: 'queued', position: 3 });
      actionArrived();
      await heldAction;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(actionResponse) });
    });

    await page.goto(app.url);
    await expect(page.getByRole('button', { name: 'Merge queued', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Request change', exact: true }).click();
    const note = `Keep the action response for a different ${mismatch.label}.`;
    await page.getByLabel('Change to request').fill(note);
    await page.getByRole('button', { name: 'Save change request', exact: true }).click();
    await capturedAction;

    let polls = 0, releaseLaterPolls!: () => void;
    const heldLaterPolls = new Promise<void>(resolve => { releaseLaterPolls = resolve; });
    await page.route('**/api/merge', async route => {
      polls++;
      if (polls > 1) await heldLaterPolls;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ queue: observed }) });
    });
    try {
      const mismatchedPoll = page.waitForResponse(async response => response.url().endsWith('/api/merge') &&
        (await response.json()).queue?.position === 2);
      await page.getByRole('button', { name: /P2 Document retry behavior/ }).click();
      await (await mismatchedPoll).finished();
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await page.getByRole('button', { name: 'Merge status', exact: true }).click();
      await expect(page.locator('#dialog-body')).toContainText('position 2');
      await page.getByRole('button', { name: 'Close', exact: true }).click();

      const staleAction = page.waitForResponse(response => response.url().endsWith('/api/action'));
      releaseAction();
      await (await staleAction).finished();
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await page.getByRole('button', { name: /P1 Bound exponential retries/ }).click();
      await expect(page.getByText(note, { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Merge status', exact: true }).click();
      await expect(page.locator('#dialog-body')).toContainText('position 3');
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      expect(app.service.store.getMergeAttempt(config.identity)).toMatchObject({ id: attempt.id, reviewedHead: review.snapshot.head, position: 3 });
      expect(app.service.store.getReviewNotes(config.identity).some(saved => saved.text === note)).toBe(true);
    } finally {
      releaseLaterPolls();
    }
  });
}

test('does not let an older Plans refresh replace a confirmed queued merge with submitting', async ({ page }) => {
  test.slow();
  const config = { ...app.service.config, demo: false };
  await app.close();
  chmodSync(join(config.repository, 'run.sh'), 0o644);
  fixtureGit(config.repository, 'commit', '-am', 'Restore declared scope');
  let appRef: typeof app;
  const gateway: MergeGateway & MergeQueueGateway = {
    inspect: async () => {
      const snapshot = appRef.service.load().snapshot;
      return { base: snapshot.base, head: snapshot.head, pullRequestState: 'OPEN', mergeable: 'MERGEABLE', rulesKnown: true,
        atomicBaseGuard: true, mergeQueue: true, requiredChecks: [], alreadyFixed: 'clear', pullRequest: 7, draft: false };
    },
    queueWatermark: async () => null,
    merge: async () => ({ url: 'https://github.com/example/repo/pull/7' }),
    inspectQueue: async head => ({ state: 'queued', reviewedHead: head, entryId: 'MQE_2', phase: 'QUEUED', position: 2,
      enqueuedAt: '2026-10-08T08:05:00Z', queueHead: head }),
  };
  app = appRef = await startServer(config, 0, undefined, gateway);
  let review = app.service.load();
  for (const segment of review.segments.filter(value => value.row === 'Unplanned' || value.row === 'Ambiguous'))
    review = app.service.act({ action: 'accept', key: segment.key, token: review.token });
  for (const item of review.items)
    review = app.service.act({ action: 'approve', item: item.id, confirmNoChange: item.count === 0, token: review.token });
  const attempt = app.service.store.beginMergeAttempt(config.identity, review.expected as never, review.snapshot.head, null, 'queue', randomUUID());

  await page.goto(app.url);
  await expect(page.getByRole('button', { name: 'Submitting…', exact: true })).toBeDisabled();
  let releaseRefresh!: () => void, refreshArrived!: () => void;
  const heldRefresh = new Promise<void>(resolve => { releaseRefresh = resolve; });
  const capturedRefresh = new Promise<void>(resolve => { refreshArrived = resolve; });
  await page.route('**/api/review', async route => {
    const response = await route.fetch();
    const stale = await response.json();
    expect(stale.merge.queue).toMatchObject({ actionId: attempt.actionId, reviewedHead: review.snapshot.head, state: 'submitting' });
    refreshArrived();
    await heldRefresh;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(stale) });
  });
  await page.getByRole('link', { name: 'Plans', exact: true }).click();
  await page.locator('#plans-refresh').click();
  await capturedRefresh;

  let polls = 0, releaseLaterPolls!: () => void;
  const heldLaterPolls = new Promise<void>(resolve => { releaseLaterPolls = resolve; });
  await page.route('**/api/merge', async route => {
    polls++;
    if (polls > 1) await heldLaterPolls;
    await route.continue();
  });
  try {
    const queuedPoll = page.waitForResponse(response => response.url().endsWith('/api/merge'));
    await page.getByRole('link', { name: 'Review', exact: true }).click();
    await page.getByRole('button', { name: /P2 Document retry behavior/ }).click();
    await (await queuedPoll).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByRole('button', { name: 'Merge queued', exact: true })).toBeDisabled();

    const staleRefresh = page.waitForResponse(response => response.url().endsWith('/api/review'));
    releaseRefresh();
    await (await staleRefresh).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByRole('button', { name: 'Merge queued', exact: true })).toBeDisabled();
    expect(app.service.store.getMergeAttempt(config.identity)).toMatchObject({ id: attempt.id, state: 'queued' });
  } finally {
    releaseLaterPolls();
  }
});

test('does not let merge polls started during Review or Plans refresh overwrite full responses', async ({ page }) => {
  test.slow();
  const config = { ...app.service.config, demo: false };
  await app.close();
  chmodSync(join(config.repository, 'run.sh'), 0o644);
  fixtureGit(config.repository, 'commit', '-am', 'Restore declared scope');
  let appRef: typeof app;
  const gateway: MergeGateway & MergeQueueGateway = {
    inspect: async () => {
      const snapshot = appRef.service.load().snapshot;
      return { base: snapshot.base, head: snapshot.head, pullRequestState: 'OPEN', mergeable: 'MERGEABLE', rulesKnown: true,
        atomicBaseGuard: true, mergeQueue: true, requiredChecks: [], alreadyFixed: 'clear', pullRequest: 7, draft: false };
    },
    queueWatermark: async () => null,
    merge: async () => ({ url: 'https://github.com/example/repo/pull/7' }),
    inspectQueue: async head => ({ state: 'queued', reviewedHead: head, entryId: 'MQE_1', phase: 'QUEUED', position: 1,
      enqueuedAt: '2026-10-07T08:00:00Z', queueHead: head }),
  };
  app = appRef = await startServer(config, 0, undefined, gateway);
  let view = app.service.load();
  for (const segment of view.segments.filter(value => value.row === 'Unplanned' || value.row === 'Ambiguous'))
    view = app.service.act({ action: 'accept', key: segment.key, token: view.token });
  for (const item of view.items)
    view = app.service.act({ action: 'approve', item: item.id, confirmNoChange: item.count === 0, token: view.token });

  await page.goto(app.url);
  page.on('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Merge PR', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Merge queued', exact: true })).toBeDisabled();
  let releaseReviewRefresh!: () => void, reviewRefreshArrived!: () => void;
  const heldReviewRefresh = new Promise<void>(resolve => { releaseReviewRefresh = resolve; });
  const capturedReviewRefresh = new Promise<void>(resolve => { reviewRefreshArrived = resolve; });
  await page.route('**/api/review', async route => {
    const current = await route.fetch();
    const refreshed = await current.json();
    refreshed.repository = 'retry-service-refreshed';
    reviewRefreshArrived();
    await heldReviewRefresh;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(refreshed) });
  });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await capturedReviewRefresh;
  let releaseReviewPoll!: () => void, reviewPollArrived!: () => void;
  const heldReviewPoll = new Promise<void>(resolve => { releaseReviewPoll = resolve; });
  const capturedReviewPoll = new Promise<void>(resolve => { reviewPollArrived = resolve; });
  await page.route('**/api/merge', async route => {
    reviewPollArrived();
    await heldReviewPoll;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ queue: {
      state: 'removed', reviewedHead: view.snapshot.head, url: null, reason: 'Old Review refresh poll result.', phase: null,
      position: null, occurredAt: '2026-10-07T08:04:00Z', retryable: true,
    } }) });
  });
  await page.getByRole('button', { name: /P2 Document retry behavior/ }).click();
  await capturedReviewPoll;
  releaseReviewRefresh();
  await expect(page.locator('#repository')).toHaveText('retry-service-refreshed');
  const staleReviewPollResponse = page.waitForResponse(response => response.url().endsWith('/api/merge'));
  releaseReviewPoll();
  await staleReviewPollResponse;
  await page.waitForTimeout(100);
  await expect(page.locator('#banner')).not.toContainText('Old Review refresh poll result.');
  await expect(page.getByRole('button', { name: 'Merge queued', exact: true })).toBeDisabled();
  await page.unroute('**/api/review');
  await page.unroute('**/api/merge');

  let releaseRefresh!: () => void, refreshArrived!: () => void;
  const heldRefresh = new Promise<void>(resolve => { releaseRefresh = resolve; });
  const capturedRefresh = new Promise<void>(resolve => { refreshArrived = resolve; });
  await page.route('**/api/review', async route => {
    const current = await route.fetch();
    refreshArrived();
    await heldRefresh;
    await route.fulfill({ response: current });
  });
  await page.getByRole('link', { name: 'Plans', exact: true }).click();
  await page.locator('#plans-refresh').click();
  await capturedRefresh;

  let releasePoll!: () => void, pollArrived!: () => void;
  const heldPoll = new Promise<void>(resolve => { releasePoll = resolve; });
  const capturedPoll = new Promise<void>(resolve => { pollArrived = resolve; });
  await page.route('**/api/merge', async route => {
    pollArrived();
    await heldPoll;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ queue: {
      state: 'removed', reviewedHead: view.snapshot.head, url: null, reason: 'Old refresh poll result.', phase: null,
      position: null, occurredAt: '2026-10-07T08:05:00Z', retryable: true,
    } }) });
  });
  await page.getByRole('link', { name: 'Review', exact: true }).click();
  await page.getByRole('button', { name: /P2 Document retry behavior/ }).click();
  await capturedPoll;
  releaseRefresh();
  await expect(page.locator('#plans-status')).toContainText('Revision r1 is current.');
  const stalePollResponse = page.waitForResponse(response => response.url().endsWith('/api/merge'));
  releasePoll();
  await stalePollResponse;
  await page.waitForTimeout(100);
  await expect(page.locator('#banner')).not.toContainText('Old refresh poll result.');
  await expect(page.getByRole('button', { name: 'Merge queued', exact: true })).toBeDisabled();
});

test('does not let an older Plans refresh overwrite a newer terminal merge observation', async ({ page }) => {
  test.slow();
  const config = { ...app.service.config, demo: false };
  await app.close();
  chmodSync(join(config.repository, 'run.sh'), 0o644);
  fixtureGit(config.repository, 'commit', '-am', 'Restore declared scope');
  let appRef: typeof app;
  const gateway: MergeGateway & MergeQueueGateway = {
    inspect: async () => {
      const snapshot = appRef.service.load().snapshot;
      return { base: snapshot.base, head: snapshot.head, pullRequestState: 'OPEN', mergeable: 'MERGEABLE', rulesKnown: true,
        atomicBaseGuard: true, mergeQueue: true, requiredChecks: [], alreadyFixed: 'clear', pullRequest: 7, draft: false };
    },
    queueWatermark: async () => null,
    merge: async () => ({ url: 'https://github.com/example/repo/pull/7' }),
    inspectQueue: async head => ({ state: 'queued', reviewedHead: head, entryId: 'MQE_1', phase: 'QUEUED', position: 1,
      enqueuedAt: '2026-10-07T08:00:00Z', queueHead: head }),
  };
  app = appRef = await startServer(config, 0, undefined, gateway);
  let view = app.service.load();
  for (const segment of view.segments.filter(value => value.row === 'Unplanned' || value.row === 'Ambiguous'))
    view = app.service.act({ action: 'accept', key: segment.key, token: view.token });
  for (const item of view.items)
    view = app.service.act({ action: 'approve', item: item.id, confirmNoChange: item.count === 0, token: view.token });

  await page.goto(app.url);
  page.on('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Merge PR', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Merge queued', exact: true })).toBeDisabled();

  let releaseRefresh!: () => void, refreshArrived!: () => void;
  const heldRefresh = new Promise<void>(resolve => { releaseRefresh = resolve; });
  const capturedRefresh = new Promise<void>(resolve => { refreshArrived = resolve; });
  let queued!: Record<string, unknown>;
  await page.route('**/api/review', async route => {
    const response = await route.fetch();
    const refreshed = await response.json();
    queued = refreshed.merge.queue;
    refreshed.repository = 'poll-first-refreshed';
    refreshed.merge.blockers.push({ code: 'check', message: 'Fresh required check is pending.' });
    refreshArrived();
    await heldRefresh;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(refreshed) });
  });
  await page.getByRole('link', { name: 'Plans', exact: true }).click();
  await page.locator('#plans-refresh').click();
  await capturedRefresh;
  expect(queued.actionId).toEqual(expect.any(String));

  await page.route('**/api/merge', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ queue: { ...queued, state: 'merged', phase: null, position: null,
      occurredAt: '2026-10-07T08:06:00Z', url: 'https://github.com/example/repo/pull/7', reason: null } }),
  }));
  const mergedPoll = page.waitForResponse(response => response.url().endsWith('/api/merge'));
  await page.getByRole('link', { name: 'Review', exact: true }).click();
  await page.getByRole('button', { name: /P1 Bound exponential retries/ }).click();
  await mergedPoll;
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByRole('button', { name: 'Merged', exact: true })).toBeDisabled();
  await page.unroute('**/api/merge');

  releaseRefresh();
  await expect(page.locator('#repository')).toHaveText('poll-first-refreshed');
  await page.waitForTimeout(100);
  await expect(page.getByRole('button', { name: 'Merged', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Merge status', exact: true }).click();
  await expect(page.locator('#dialog-body')).toContainText('merged');
  await expect(page.locator('#dialog-body')).toContainText('GitHub confirmed that the reviewed head was merged.');
  await expect(page.locator('#dialog-body')).toContainText('Fresh required check is pending.');
});

test('does not let an older Review refresh overwrite a newer terminal merge observation', async ({ page }) => {
  test.slow();
  const config = { ...app.service.config, demo: false };
  await app.close();
  chmodSync(join(config.repository, 'run.sh'), 0o644);
  fixtureGit(config.repository, 'commit', '-am', 'Restore declared scope');
  let appRef: typeof app;
  const gateway: MergeGateway & MergeQueueGateway = {
    inspect: async () => {
      const snapshot = appRef.service.load().snapshot;
      return { base: snapshot.base, head: snapshot.head, pullRequestState: 'OPEN', mergeable: 'MERGEABLE', rulesKnown: true,
        atomicBaseGuard: true, mergeQueue: true, requiredChecks: [], alreadyFixed: 'clear', pullRequest: 7, draft: false };
    },
    queueWatermark: async () => null,
    merge: async () => ({ url: 'https://github.com/example/repo/pull/7' }),
    inspectQueue: async head => ({ state: 'queued', reviewedHead: head, entryId: 'MQE_1', phase: 'QUEUED', position: 1,
      enqueuedAt: '2026-10-07T08:00:00Z', queueHead: head }),
  };
  app = appRef = await startServer(config, 0, undefined, gateway);
  let view = app.service.load();
  for (const segment of view.segments.filter(value => value.row === 'Unplanned' || value.row === 'Ambiguous'))
    view = app.service.act({ action: 'accept', key: segment.key, token: view.token });
  for (const item of view.items)
    view = app.service.act({ action: 'approve', item: item.id, confirmNoChange: item.count === 0, token: view.token });

  await page.goto(app.url);
  page.on('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Merge PR', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Merge queued', exact: true })).toBeDisabled();

  let releaseRefresh!: () => void, refreshArrived!: () => void;
  const heldRefresh = new Promise<void>(resolve => { releaseRefresh = resolve; });
  const capturedRefresh = new Promise<void>(resolve => { refreshArrived = resolve; });
  let queued!: Record<string, unknown>;
  await page.route('**/api/review', async route => {
    const response = await route.fetch();
    const refreshed = await response.json();
    queued = refreshed.merge.queue;
    refreshed.repository = 'review-poll-first-refreshed';
    refreshed.merge.blockers.push({ code: 'check', message: 'Fresh Review blocker is pending.' });
    refreshArrived();
    await heldRefresh;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(refreshed) });
  });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await capturedRefresh;
  expect(queued.actionId).toEqual(expect.any(String));

  await page.route('**/api/merge', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ queue: { ...queued, state: 'merged', phase: null, position: null,
      occurredAt: '2026-10-07T08:07:00Z', url: 'https://github.com/example/repo/pull/7', reason: null } }),
  }));
  const mergedPoll = page.waitForResponse(response => response.url().endsWith('/api/merge'));
  await page.getByRole('button', { name: /P1 Bound exponential retries/ }).click();
  await mergedPoll;
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByRole('button', { name: 'Merged', exact: true })).toBeDisabled();
  await page.unroute('**/api/merge');

  const staleReviewResponse = page.waitForResponse(response => response.url().endsWith('/api/review'));
  releaseRefresh();
  await (await staleReviewResponse).finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator('#repository')).toHaveText('review-poll-first-refreshed');
  await expect(page.getByRole('button', { name: 'Merged', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Merge status', exact: true }).click();
  await expect(page.locator('#dialog-body')).toContainText('merged');
  await expect(page.locator('#dialog-body')).toContainText('Fresh Review blocker is pending.');
});

test('keeps merge-queue polling current across Plans refresh and import outcomes', async ({ page }) => {
  test.slow();
  const config = { ...app.service.config, demo: false };
  await app.close();
  chmodSync(join(config.repository, 'run.sh'), 0o644);
  fixtureGit(config.repository, 'commit', '-am', 'Restore declared scope');
  let appRef: typeof app;
  const gateway: MergeGateway & MergeQueueGateway = {
    inspect: async () => {
      const snapshot = appRef.service.load().snapshot;
      return { base: snapshot.base, head: snapshot.head, pullRequestState: 'OPEN', mergeable: 'MERGEABLE', rulesKnown: true,
        atomicBaseGuard: true, mergeQueue: true, requiredChecks: [], alreadyFixed: 'clear', pullRequest: 7, draft: false };
    },
    queueWatermark: async () => null,
    merge: async () => ({ url: 'https://github.com/example/repo/pull/7' }),
    inspectQueue: async head => ({ state: 'queued', reviewedHead: head, entryId: 'MQE_1', phase: 'QUEUED', position: 1,
      enqueuedAt: '2026-10-07T08:00:00Z', queueHead: head }),
  };
  app = appRef = await startServer(config, 0, undefined, gateway);
  let view = app.service.load();
  for (const segment of view.segments.filter(value => value.row === 'Unplanned' || value.row === 'Ambiguous'))
    view = app.service.act({ action: 'accept', key: segment.key, token: view.token });
  for (const item of view.items)
    view = app.service.act({ action: 'approve', item: item.id, confirmNoChange: item.count === 0, token: view.token });

  let release!: () => void, releaseNew!: () => void, arrived!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const heldNew = new Promise<void>(resolve => { releaseNew = resolve; });
  const captured = new Promise<void>(resolve => { arrived = resolve; });
  let polls = 0;
  await page.route('**/api/merge', async route => {
    polls++;
    if (polls === 1) {
      arrived();
      await held;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ queue: {
        state: 'removed', reviewedHead: view.snapshot.head, url: null, reason: 'Old poll result.', phase: null,
        position: null, occurredAt: '2026-10-07T08:05:00Z', retryable: true,
      } }) });
      return;
    }
    await heldNew;
    await route.continue();
  });
  await page.goto(app.url);
  page.on('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Merge PR', exact: true }).click();
  await captured;
  await page.getByRole('link', { name: 'Plans', exact: true }).click();
  await page.locator('#plans-refresh').click();
  await expect(page.getByRole('status').filter({ hasText: 'Revision r1 is current.' })).toBeVisible();
  const staleResponse = page.waitForResponse(response => response.url().endsWith('/api/merge'));
  release();
  try {
    await staleResponse;
    await page.waitForTimeout(100);
    await page.getByRole('link', { name: 'Review', exact: true }).click();
    await expect(page.locator('#banner')).not.toContainText('Old poll result.');
    await expect(page.getByRole('button', { name: 'Merge queued', exact: true })).toBeDisabled();
  } finally {
    releaseNew();
  }
  const pollsBeforeRefusal = polls;
  const resumedPollResponse = page.waitForResponse(response => response.url().endsWith('/api/merge'));
  await page.getByRole('link', { name: 'Plans', exact: true }).click();
  const wrongIssue = JSON.stringify({ ...nextPlan, issue: 413 });
  await page.getByLabel('Plan file').setInputFiles({ name: 'wrong-issue.json', mimeType: 'application/json', buffer: Buffer.from(wrongIssue) });
  await page.getByRole('button', { name: 'Import next revision' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Could not import the plan.' })).toBeVisible();
  await expect.poll(() => polls, { timeout: 10000 }).toBeGreaterThan(pollsBeforeRefusal);
  await resumedPollResponse;

  await page.unroute('**/api/merge');
  const authoritative = await (await fetch(new URL('/api/review', app.url), { headers: { 'x-codeboost-token': app.token } })).json();
  authoritative.plan = nextPlan;
  authoritative.merge = { ...authoritative.merge, ready: false, action: null, queue: null,
    blockers: [{ code: 'plan-changed', message: 'The plan changed.' }] };
  let releaseImportResponse!: () => void, importRequestArrived!: () => void;
  const heldImportResponse = new Promise<void>(resolve => { releaseImportResponse = resolve; });
  const capturedImportRequest = new Promise<void>(resolve => { importRequestArrived = resolve; });
  await page.route('**/api/plan/import', async route => {
    importRequestArrived();
    await heldImportResponse;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ result: { revision: 2 } }) });
  });
  let releaseReload!: () => void, reloadArrived!: () => void;
  const heldReload = new Promise<void>(resolve => { releaseReload = resolve; });
  const capturedReload = new Promise<void>(resolve => { reloadArrived = resolve; });
  await page.route('**/api/review', async route => {
    reloadArrived();
    await heldReload;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(authoritative) });
  });
  let releaseImportPoll!: () => void, importPollArrived!: () => void;
  const heldImportPoll = new Promise<void>(resolve => { releaseImportPoll = resolve; });
  const capturedImportPoll = new Promise<void>(resolve => { importPollArrived = resolve; });
  await page.getByLabel('Plan file').setInputFiles({ name: 'plan.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(nextPlan)) });
  await page.getByRole('button', { name: 'Import next revision' }).click();
  await capturedImportRequest;
  await page.route('**/api/merge', async route => {
    importPollArrived();
    await heldImportPoll;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ queue: {
      state: 'removed', reviewedHead: view.snapshot.head, url: null, reason: 'Old import poll result.', phase: null,
      position: null, occurredAt: '2026-10-07T08:10:00Z', retryable: true,
    } }) });
  });
  releaseImportResponse();
  await capturedReload;
  await capturedImportPoll;
  releaseReload();
  await expect(page.getByRole('status').filter({ hasText: 'Revision r2 is current.' })).toBeVisible();
  const staleImportResponse = page.waitForResponse(response => response.url().endsWith('/api/merge'));
  releaseImportPoll();
  await staleImportResponse;
  await page.waitForTimeout(100);
  await expect(page.locator('#plans-revision')).toHaveText('r2');
  await expect(page.locator('#banner')).not.toContainText('Old import poll result.');
});
