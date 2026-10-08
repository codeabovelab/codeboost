import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDemo } from '../../scripts/demo.ts';
import { startServer, type PlanningDeps } from '../../web/server.ts';
import type { AuthorProvider, AuthorRequest } from '../../core/planning-author.ts';
import type { EditReply, Plan } from '../../core/plan.ts';

let root: string, app: Awaited<ReturnType<typeof startServer>>;
type Invocation = { request: AuthorRequest; signal: AbortSignal; resolve: (source: string) => void };

function planning() {
  const invocations: Invocation[] = [];
  const provider: AuthorProvider = { invoke: (request, signal) => new Promise((resolve, reject) => {
    invocations.push({ request, signal, resolve });
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) };
  const deps: PlanningDeps = {
    provider,
    describe: () => ({
      repo: { name: 'retry-service', baseRef: 'main' },
      issue: { number: 3, title: 'Retries', body: '', comments: [] },
      approvedLessons: [],
      validate: () => undefined,
    }),
  };
  return { deps, invocations };
}

test.beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'codeboost-plans-authoring-browser-'));
});
test.afterEach(async () => {
  await app?.close();
  rmSync(root, { recursive: true, force: true });
});

async function openPlans(page: Page, deps: PlanningDeps) {
  app = await startServer(createDemo(join(root, 'demo')), 0, undefined, undefined, undefined, undefined, undefined, deps);
  await page.goto(app.url);
  await page.getByRole('link', { name: 'Plans', exact: true }).click();
}

function suggestions(revision = 1): EditReply {
  return {
    schema_version: 1,
    base_revision: revision,
    reply: 'The retry title can state the operator-visible outcome more directly.',
    edits: [{
      op: 'set_field', item: 'P1', summary: 'Name the retry ceiling', reason: 'Operators need to know that retries stay bounded.',
      field: 'title', value: 'Expose the bounded retry ceiling', file: null, check: null, check_index: null, depends_on: null, new_item: null,
    }],
  };
}

function draft(current: Plan): Plan {
  return {
    ...structuredClone(current),
    revision: current.revision + 1,
    summary: 'Make retry limits visible to operators',
    items: current.items.map((item, index) => index === 0 ? { ...item, title: 'Expose the bounded retry ceiling' } : item),
  };
}

test('renders suggestion cards and preserves guidance edited after submission', async ({ page }) => {
  const { deps, invocations } = planning();
  await openPlans(page, deps);
  const guidance = page.getByLabel('Guidance');
  await guidance.fill('Make the plan clearer.');
  const suggest = page.locator('#plan-suggest');
  await suggest.focus();
  await suggest.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });

  await expect.poll(() => invocations.length).toBe(1);
  await expect(suggest).toBeFocused();
  await expect(suggest).toHaveAttribute('aria-disabled', 'true');
  await expect(page.locator('#plan-draft')).toHaveAttribute('aria-disabled', 'true');
  await page.mouse.move(0, 0);
  await expect.poll(async () => {
    const disabledColors = await Promise.all([suggest, page.locator('#plan-draft')].map(locator =>
      locator.evaluate(element => {
        const style = getComputedStyle(element);
        return { background: style.backgroundColor, border: style.borderColor, color: style.color };
      })));
    return JSON.stringify(disabledColors[0]) === JSON.stringify(disabledColors[1]);
  }).toBe(true);
  await guidance.fill('Keep these newer notes while the request runs.');
  invocations[0]!.resolve(JSON.stringify(suggestions()));

  await expect(page.getByRole('status').filter({ hasText: 'Suggestions ready for r1.' })).toBeVisible();
  await expect(page.getByRole('article', { name: 'Name the retry ceiling' })).toContainText('Set P1.title to Expose the bounded retry ceiling');
  await expect(guidance).toHaveValue('Keep these newer notes while the request runs.');
  await page.screenshot({ path: 'test-results/plans-authoring-desktop.png', fullPage: true });
  expect(invocations[0]!.request).toMatchObject({ mode: 'suggest', revision: 1 });
  expect(invocations[0]!.request.prompt).toContain('Make the plan clearer.');
});

test('accepts complete payloads for every edit operation', async ({ page }) => {
  const { deps } = planning();
  await openPlans(page, deps);
  const current = app.service.store.getPlan(app.service.config.identity);
  const snapshotId = app.service.load().snapshot.id;
  const card = (op: EditReply['edits'][number]['op'], payload: Record<string, unknown> = {}, item = 'P1') => ({
    op, item, summary: `Exercise ${op}`, reason: `The ${op} payload is complete.`,
    field: null, value: null, file: null, check: null, check_index: null, depends_on: null, new_item: null, ...payload,
  }) as EditReply['edits'][number];
  const newItem = { ...structuredClone(current.items[0]!), id: 'P4', depends_on: ['P1'] };
  const reply: EditReply = { ...suggestions(), reply: '😀'.repeat(4000), edits: [
    card('add_item', { new_item: newItem }, 'P4'),
    card('set_field', { field: 'intent', value: 'Explain the bounded retry behavior.' }),
    card('add_file', { file: { path: 'added.ts', kind: 'add', renamed_from: null, change: 'Add the helper.' } }),
    card('update_file', { file: { path: 'retry.ts', kind: 'edit', renamed_from: null, change: 'Clarify retries.' } }),
    card('remove_file', { value: 'retry.ts' }),
    card('add_check', { check: { type: 'check', text: 'Retries stay bounded.' } }),
    card('remove_check', { check_index: 0 }),
    card('set_depends', { depends_on: [] }),
    card('remove_item', {}, 'P3'),
  ] };
  const requestId = '12345678-1234-4123-8123-123456789abc';
  await page.route('**/api/plan/suggestions', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ result: { requestId } }),
  }));
  await page.route(`**/api/plan/suggestions/${requestId}`, route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({
      mode: 'suggest', state: 'ready', revision: 1, snapshotId, reply, reason: null,
    }),
  }));
  await page.getByRole('button', { name: 'Suggest edits' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Suggestions ready for r1.' })).toBeVisible();
  await expect(page.locator('.plan-author-reply')).toHaveText(reply.reply);
  await expect(page.locator('.suggestion-row')).toHaveCount(9);
  await expect(page.getByRole('button', { name: 'Suggest edits' })).not.toHaveAttribute('aria-disabled', 'true');
});

test('renders a whole next-revision draft without changing the current plan', async ({ page }) => {
  const { deps, invocations } = planning();
  await openPlans(page, deps);
  const current = app.service.store.getPlan(app.service.config.identity);
  const snapshotId = app.service.load().snapshot.id;
  let reads = 0;
  await page.route('**/api/plan/drafts/*', async route => {
    reads++;
    if (reads === 1) {
      const malformed = { ...draft(current), items: [{ id: 'P1', title: 'Incomplete item' }] };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        state: 'ready', revision: 1, snapshotId, plan: malformed, reason: null,
      }) });
      return;
    }
    await route.continue();
  });
  await page.getByLabel('Guidance').fill('Rewrite the plan around operator visibility.');
  await page.getByRole('button', { name: 'Draft next revision' }).click();
  await expect.poll(() => invocations.length).toBe(1);
  await expect(page.getByRole('status').filter({ hasText: 'Planning status response was incomplete, invalid' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Draft Make retry limits visible to operators' })).toHaveCount(0);
  invocations[0]!.resolve(JSON.stringify(draft(current)));

  await expect(page.getByRole('status').filter({ hasText: 'Draft ready for r1.' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Draft Make retry limits visible to operators' })).toContainText('P1 Expose the bounded retry ceiling');
  await expect(page.locator('#plans-revision')).toHaveText('r1');
  expect(app.service.store.getPlan(app.service.config.identity).revision).toBe(1);
});

test('applies a draft once while preserving newer review text and its attachment', async ({ page }) => {
  const { deps, invocations } = planning();
  app = await startServer(createDemo(join(root, 'demo')), 0, undefined, undefined, undefined, undefined, undefined, deps);
  await page.goto(app.url);
  await page.locator('.added [data-line]').first().click();
  await page.getByRole('button', { name: 'Ask about selection', exact: true }).click();
  await page.getByLabel('Question about this item').fill('Before Apply');
  await expect(page.locator('#attachment')).toContainText('retry.ts');
  await page.getByRole('link', { name: 'Plans', exact: true }).click();
  const current = app.service.store.getPlan(app.service.config.identity);
  await page.getByRole('button', { name: 'Draft next revision' }).click();
  await expect.poll(() => invocations.length).toBe(1);
  invocations[0]!.resolve(JSON.stringify(draft(current)));
  const apply = page.getByRole('button', { name: 'Apply draft', exact: true });
  await expect(apply).toBeVisible();

  let release!: () => void, arrived!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const captured = new Promise<void>(resolve => { arrived = resolve; });
  let applies = 0;
  await page.route('**/api/plan/drafts/*/apply', async route => { applies++; arrived(); await held; await route.continue(); });
  await apply.focus();
  await apply.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await captured;
  expect(applies).toBe(1);
  await expect(page.getByRole('button', { name: 'Applying…', exact: true })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Applying…', exact: true })).toHaveAttribute('aria-disabled', 'true');
  await page.getByRole('link', { name: 'Review', exact: true }).click();
  await page.getByLabel('Question about this item').fill('Edited while Apply was in flight');
  release();

  await expect(page.locator('#issue')).toContainText('r2');
  await expect(page.getByLabel('Question about this item')).toHaveValue('Edited while Apply was in flight');
  await expect(page.locator('#attachment')).toContainText('retry.ts');
  await expect(page.locator('#attachment')).not.toContainText('Outdated');
  expect(app.service.store.getPlan(app.service.config.identity).revision).toBe(2);
});

test('explains why Apply waits for an in-flight plan refresh', async ({ page }) => {
  const { deps, invocations } = planning();
  await openPlans(page, deps);
  const current = app.service.store.getPlan(app.service.config.identity);
  await page.getByRole('button', { name: 'Draft next revision' }).click();
  await expect.poll(() => invocations.length).toBe(1);
  invocations[0]!.resolve(JSON.stringify(draft(current)));
  const apply = page.getByRole('button', { name: 'Apply draft', exact: true });
  await expect(apply).toBeVisible();

  let release!: () => void, arrived!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const captured = new Promise<void>(resolve => { arrived = resolve; });
  await page.route('**/api/review', async route => { arrived(); await held; await route.continue(); });
  let applies = 0;
  await page.route('**/api/plan/drafts/*/apply', async route => { applies++; await route.continue(); });
  await page.locator('#plans-refresh').click();
  await captured;
  await apply.click();

  await expect(page.locator('#plan-author-status')).toHaveText('! Wait for the current plan or review action before applying this result.');
  await expect(apply).toBeFocused();
  expect(applies).toBe(0);
  expect(app.service.store.getPlan(app.service.config.identity).revision).toBe(1);
  release();
  await expect(page.locator('#plans-status')).toHaveText('✓ Revision r1 is current.');
  await expect(apply).toBeVisible();
});

test('keeps a committed draft applied when the authoritative reload fails', async ({ page }) => {
  const { deps, invocations } = planning();
  await openPlans(page, deps);
  const current = app.service.store.getPlan(app.service.config.identity);
  await page.getByRole('button', { name: 'Draft next revision' }).click();
  await expect.poll(() => invocations.length).toBe(1);
  invocations[0]!.resolve(JSON.stringify(draft(current)));
  let reloads = 0;
  await page.route('**/api/review', async route => {
    reloads++;
    if (reloads === 1) await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Temporary review read failure' }) });
    else await route.continue();
  });
  await page.getByRole('button', { name: 'Apply draft', exact: true }).click();

  await expect(page.locator('#plans-status')).toContainText('Revision r2 was applied, but the current plan could not reload');
  await expect(page.getByRole('button', { name: 'Apply draft', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retry Apply', exact: true })).toHaveCount(0);
  await expect(page.locator('#plans-revision')).toHaveText('r1');
  expect(app.service.store.getPlan(app.service.config.identity).revision).toBe(2);
  await page.locator('#plans-refresh').click();
  await expect(page.locator('#plans-revision')).toHaveText('r2');
  expect(reloads).toBe(2);
  expect(app.service.store.getPlan(app.service.config.identity).revision).toBe(2);
});

test('accepts a later authoritative revision when reloading a committed Apply', async ({ page }) => {
  const { deps, invocations } = planning();
  await openPlans(page, deps);
  const current = app.service.store.getPlan(app.service.config.identity);
  await page.getByRole('button', { name: 'Draft next revision' }).click();
  await expect.poll(() => invocations.length).toBe(1);
  invocations[0]!.resolve(JSON.stringify(draft(current)));
  await page.route('**/api/review', async route => {
    const later = app.service.store.getPlan(app.service.config.identity);
    expect(later.revision).toBe(2);
    later.revision++;
    later.summary = 'A concurrent authoritative revision';
    app.service.store.importRevision(JSON.stringify(later), 'json', app.service.planContextForAmendment(), 2);
    await route.continue();
  });
  await page.getByRole('button', { name: 'Apply draft', exact: true }).click();

  await expect(page.locator('#plans-revision')).toHaveText('r3');
  await expect(page.locator('#plans-status')).toHaveText('✓ Revision r3 is current.');
  await expect(page.locator('#plan-suggest')).not.toHaveAttribute('aria-disabled', 'true');
  expect(app.service.store.getPlan(app.service.config.identity).revision).toBe(3);
});

test('blocks stale authoring after a suggestion commits but its authoritative reload fails', async ({ page }) => {
  const { deps, invocations } = planning();
  await openPlans(page, deps);
  const reply = suggestions();
  reply.edits.push({ ...reply.edits[0]!, summary: 'Clarify retry intent', reason: 'The intent should name the visible limit.',
    field: 'intent', value: 'Explain the operator-visible retry limit.' });
  await page.getByRole('button', { name: 'Suggest edits' }).click();
  await expect.poll(() => invocations.length).toBe(1);
  invocations[0]!.resolve(JSON.stringify(reply));
  let reloads = 0;
  await page.route('**/api/review', async route => {
    reloads++;
    if (reloads === 1) await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Temporary review read failure' }) });
    else await route.continue();
  });
  await page.getByRole('button', { name: 'Apply this edit' }).first().click();

  await expect(page.locator('#plans-status')).toContainText('Revision r2 was applied, but the current plan could not reload');
  await expect(page.getByRole('button', { name: 'Refresh suggestions', exact: true })).toHaveCount(0);
  await expect(page.locator('#plan-draft')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.locator('#plan-suggest')).toHaveAttribute('aria-disabled', 'true');
  await page.locator('#plan-suggest').evaluate((button: HTMLButtonElement) => button.click());
  expect(invocations).toHaveLength(1);
  await expect(page.locator('#plans-refresh')).toBeFocused();
  expect(app.service.store.getPlan(app.service.config.identity).revision).toBe(2);

  await page.locator('#plans-refresh').click();
  await expect(page.locator('#plans-revision')).toHaveText('r2');
  await expect(page.getByRole('button', { name: 'Refresh suggestions', exact: true })).toBeVisible();
  await expect(page.locator('#plan-suggest')).not.toHaveAttribute('aria-disabled', 'true');

  const next = app.service.store.getPlan(app.service.config.identity);
  next.revision++;
  next.summary = 'A later authoritative revision';
  app.service.store.importRevision(JSON.stringify(next), 'json', app.service.planContextForAmendment(), 2);
  await page.locator('#plans-refresh').click();
  await expect(page.locator('#plans-revision')).toHaveText('r3');
  await page.locator('#plan-suggest').click();
  await expect.poll(() => invocations.length).toBe(2);
  expect(invocations[1]!.request).toMatchObject({ mode: 'suggest', revision: 3 });
  invocations[1]!.resolve(JSON.stringify(suggestions(3)));
  await expect(page.getByRole('status').filter({ hasText: 'Suggestions ready for r3.' })).toBeVisible();
});

test('keeps Apply retryable when success names the wrong revision', async ({ page }) => {
  const { deps, invocations } = planning();
  await openPlans(page, deps);
  const current = app.service.store.getPlan(app.service.config.identity);
  await page.getByRole('button', { name: 'Draft next revision' }).click();
  await expect.poll(() => invocations.length).toBe(1);
  invocations[0]!.resolve(JSON.stringify(draft(current)));
  await page.route('**/api/plan/drafts/*/apply', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ result: { revision: 3 } }),
  }));
  await page.getByRole('button', { name: 'Apply draft', exact: true }).click();

  await expect(page.getByRole('button', { name: 'Retry Apply', exact: true })).toBeVisible();
  await expect(page.locator('#plans-status')).toContainText('Apply returned success without the expected revision');
  expect(app.service.store.getPlan(app.service.config.identity).revision).toBe(1);
});

test('replays an ambiguous suggestion Apply, stales siblings, and refreshes before the next edit', async ({ page }) => {
  const { deps, invocations } = planning();
  await openPlans(page, deps);
  const first = suggestions();
  first.edits.push({ ...first.edits[0]!, summary: 'Clarify retry intent', reason: 'The intent should name the visible limit.',
    field: 'intent', value: 'Explain the operator-visible retry limit.' });
  await page.getByLabel('Guidance').fill('Improve the retry item.');
  await page.getByRole('button', { name: 'Suggest edits' }).click();
  await expect.poll(() => invocations.length).toBe(1);
  invocations[0]!.resolve(JSON.stringify(first));
  await expect(page.getByRole('button', { name: 'Apply this edit' })).toHaveCount(2);
  await page.getByLabel('Guidance').fill('Keep this newer guidance.');

  const sent: unknown[] = [];
  await page.route('**/api/plan/suggestions/*/apply', async route => {
    sent.push(route.request().postDataJSON());
    if (sent.length === 1) { await route.fetch(); await route.abort('failed'); }
    else await route.continue();
  });
  await page.getByRole('button', { name: 'Apply this edit' }).first().click();
  await expect(page.getByRole('button', { name: 'Retry Apply', exact: true })).toBeVisible();
  await expect(page.locator('#plan-suggest')).toHaveAttribute('aria-disabled', 'true');
  await page.locator('#plan-suggest').evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  expect(invocations).toHaveLength(1);
  expect(app.service.store.getPlan(app.service.config.identity).revision).toBe(2);
  await page.getByRole('button', { name: 'Retry Apply', exact: true }).click();
  await expect(page.locator('#plans-revision')).toHaveText('r2');
  await expect(page.getByRole('button', { name: 'Refresh suggestions', exact: true })).toBeFocused();
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]);
  expect(app.service.store.getPlan(app.service.config.identity).revision).toBe(2);
  await expect(page.getByRole('button', { name: 'Apply this edit' })).toHaveCount(0);
  await expect(page.getByText('Plan changed — refresh suggestions', { exact: false })).toBeVisible();

  await page.getByRole('button', { name: 'Refresh suggestions', exact: true }).click();
  await expect.poll(() => invocations.length).toBe(2);
  expect(invocations[1]!.request).toMatchObject({ mode: 'suggest', revision: 2 });
  expect(invocations[1]!.request.prompt).toContain('Clarify retry intent');
  await expect(page.getByLabel('Guidance')).toHaveValue('Keep this newer guidance.');
  invocations[1]!.resolve(JSON.stringify(suggestions(2)));
  await expect(page.getByRole('button', { name: 'Apply this edit', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Apply this edit', exact: true }).click();
  await expect(page.locator('#plans-revision')).toHaveText('r3');
  expect(app.service.store.getPlan(app.service.config.identity).revision).toBe(3);
});

test('retries an ambiguous suggestion start with the exact request', async ({ page }) => {
  const { deps, invocations } = planning();
  await openPlans(page, deps);
  const sent: unknown[] = [];
  await page.route('**/api/plan/suggestions', async route => {
    sent.push(route.request().postDataJSON());
    if (sent.length === 1) await route.abort('failed');
    else await route.continue();
  });
  const guidance = page.getByLabel('Guidance');
  await guidance.fill('Use the submitted guidance.');
  await page.getByRole('button', { name: 'Suggest edits' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'request outcome is unknown' })).toBeVisible();
  await guidance.fill('Do not replace these newer notes.');
  await page.getByRole('button', { name: 'Retry suggestion request' }).click();
  await expect.poll(() => invocations.length).toBe(1);
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]);
  expect(invocations[0]!.request.prompt).toContain('Use the submitted guidance.');
  invocations[0]!.resolve(JSON.stringify(suggestions()));
  await expect(page.getByRole('status').filter({ hasText: 'Suggestions ready for r1.' })).toBeVisible();
  await expect(guidance).toHaveValue('Do not replace these newer notes.');
});

test('reports a definite stale start refusal after an import advances the plan', async ({ page }) => {
  const { deps, invocations } = planning();
  let release!: () => void, arrived!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const captured = new Promise<void>(resolve => { arrived = resolve; });
  const describe = deps.describe;
  deps.describe = async signal => { arrived(); await held; return describe(signal); };
  await openPlans(page, deps);
  const current = app.service.store.getPlan(app.service.config.identity);
  await page.getByRole('button', { name: 'Suggest edits' }).click();
  await captured;
  await page.getByLabel('Plan file').setInputFiles({
    name: 'next-plan.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(draft(current))),
  });
  await page.getByRole('button', { name: 'Import next revision' }).click();
  await expect(page.locator('#plans-revision')).toHaveText('r2');
  release();

  await expect(page.getByRole('status').filter({ hasText: 'Suggestion failed.' })).toContainText('Stale plan revision or snapshot');
  await expect(page.getByRole('status').filter({ hasText: 'generated for r1' })).toHaveCount(0);
  expect(invocations).toHaveLength(0);
  expect(app.service.store.getPlan(app.service.config.identity).revision).toBe(2);
});

test('keeps ownership while a malformed status response is retried', async ({ page }) => {
  const { deps, invocations } = planning();
  await openPlans(page, deps);
  let reads = 0;
  await page.route('**/api/plan/suggestions/*', async route => {
    reads++;
    if (reads === 1) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: 'surprise' }) });
      return;
    }
    await route.continue();
  });
  const suggest = page.locator('#plan-suggest');
  await suggest.click();
  await expect.poll(() => invocations.length).toBe(1);
  await expect(page.getByRole('status').filter({ hasText: 'Planning status response was incomplete, invalid' })).toBeVisible();
  await expect(suggest).toHaveAttribute('aria-disabled', 'true');
  await suggest.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  expect(invocations).toHaveLength(1);
  invocations[0]!.resolve(JSON.stringify(suggestions()));
  await expect(page.getByRole('status').filter({ hasText: 'Suggestions ready for r1.' })).toBeVisible();
});

test('rejects failed output and marks consumed output stale', async ({ page }) => {
  const { deps } = planning();
  await openPlans(page, deps);
  const snapshotId = app.service.load().snapshot.id;
  let reads = 0, starts = 0;
  let releaseConsumed!: () => void;
  const consumedHeld = new Promise<void>(resolve => { releaseConsumed = resolve; });
  await page.route('**/api/plan/suggestions', route => {
    starts++;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      result: { requestId: '12345678-1234-4123-8123-123456789abc' },
    }) });
  });
  await page.route('**/api/plan/suggestions/*', async route => {
    reads++;
    if (reads > 1) await consumedHeld;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      mode: 'suggest', state: reads === 1 ? 'failed' : 'consumed', revision: 1, snapshotId,
      reply: suggestions(), reason: reads === 1 ? 'The provider refused the request.' : null,
    }) });
  });
  const suggest = page.locator('#plan-suggest');
  await suggest.click();
  await expect(page.getByRole('status').filter({ hasText: 'Planning status response was incomplete, invalid' })).toBeVisible();
  await expect(suggest).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByRole('article', { name: 'Name the retry ceiling' })).toHaveCount(0);
  await expect.poll(() => reads).toBeGreaterThanOrEqual(2);
  releaseConsumed();
  await expect(page.getByRole('status').filter({ hasText: 'Stale suggestions · generated for r1' })).toBeVisible();
  await expect(page.getByRole('article', { name: 'Name the retry ceiling' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Dismiss suggestions' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Apply this edit' })).toHaveCount(0);
  await expect(suggest).toHaveAttribute('aria-disabled', 'true');
  await suggest.evaluate((button: HTMLButtonElement) => button.click());
  expect(starts).toBe(1);
});

test('rejects a status response for the wrong planning operation', async ({ page }) => {
  const { deps, invocations } = planning();
  await openPlans(page, deps);
  const current = app.service.store.getPlan(app.service.config.identity);
  const snapshotId = app.service.load().snapshot.id;
  let reads = 0;
  await page.route('**/api/plan/suggestions/*', async route => {
    reads++;
    if (reads === 1) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        mode: 'draft', state: 'ready', revision: 1, snapshotId, reply: suggestions(), reason: null,
      }) });
      return;
    }
    await route.continue();
  });
  const suggest = page.locator('#plan-suggest');
  await suggest.click();
  await expect.poll(() => invocations.length).toBe(1);
  await expect(page.getByRole('status').filter({ hasText: 'Planning status response was incomplete, invalid' })).toBeVisible();
  await expect(page.getByRole('article', { name: 'Name the retry ceiling' })).toHaveCount(0);
  await expect(suggest).toHaveAttribute('aria-disabled', 'true');
  invocations[0]!.resolve(JSON.stringify(suggestions()));
  await expect(page.getByRole('status').filter({ hasText: 'Suggestions ready for r1.' })).toBeVisible();

  let draftReads = 0;
  await page.route('**/api/plan/drafts/*', async route => {
    draftReads++;
    if (draftReads === 1) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        mode: 'suggest', state: 'ready', revision: 1, snapshotId, plan: draft(current), reason: null,
      }) });
      return;
    }
    await route.continue();
  });
  await page.getByRole('button', { name: 'Draft next revision' }).click();
  await expect.poll(() => invocations.length).toBe(2);
  await expect(page.getByRole('status').filter({ hasText: 'Planning status response was incomplete, invalid' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Draft Make retry limits visible to operators' })).toHaveCount(0);
  invocations[1]!.resolve(JSON.stringify(draft(current)));
  await expect(page.getByRole('status').filter({ hasText: 'Draft ready for r1.' })).toBeVisible();
});

test('marks invalidated output stale when it moves into history', async ({ page }) => {
  const { deps, invocations } = planning();
  await openPlans(page, deps);
  const current = app.service.store.getPlan(app.service.config.identity);
  const snapshotId = app.service.load().snapshot.id;
  let reads = 0;
  await page.route('**/api/plan/suggestions/*', async route => {
    reads++;
    if (reads === 1) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        mode: 'suggest', state: 'invalidated', revision: 1, snapshotId, reply: suggestions(),
        reason: 'The planning checkpoint changed.',
      }) });
      return;
    }
    await route.continue();
  });
  await page.getByRole('button', { name: 'Suggest edits' }).click();
  await expect.poll(() => invocations.length).toBe(1);
  await expect(page.getByRole('status').filter({ hasText: 'Suggestions became stale.' })).toBeVisible();
  invocations[0]!.resolve(JSON.stringify(suggestions()));
  await page.getByRole('button', { name: 'Draft next revision' }).click();
  await expect.poll(() => invocations.length).toBe(2);
  const historical = page.locator('.plan-author-result-heading').filter({ hasText: 'Earlier suggested edits' });
  await expect(historical).toContainText('! Stale');
  await expect(historical).not.toContainText('Earlier result');
  invocations[1]!.resolve(JSON.stringify(draft(current)));
  await expect(page.getByRole('status').filter({ hasText: 'Draft ready for r1.' })).toBeVisible();
});

test('rejects a status observation bound to another snapshot', async ({ page }) => {
  const { deps, invocations } = planning();
  await openPlans(page, deps);
  let reads = 0;
  await page.route('**/api/plan/suggestions/*', async route => {
    reads++;
    if (reads === 1) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        mode: 'suggest', state: 'ready', revision: 1, snapshotId: 'foreign-snapshot', reply: suggestions(), reason: null,
      }) });
      return;
    }
    await route.continue();
  });
  const suggest = page.locator('#plan-suggest');
  await suggest.click();
  await expect.poll(() => invocations.length).toBe(1);
  await expect(page.getByRole('status').filter({ hasText: 'belonged to another plan context' })).toBeVisible();
  await expect(suggest).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByRole('article', { name: 'Name the retry ceiling' })).toHaveCount(0);
  invocations[0]!.resolve(JSON.stringify(suggestions()));
  await expect(page.getByRole('status').filter({ hasText: 'Suggestions ready for r1.' })).toBeVisible();
});

test('rejects an operation-specific payload that is unsafe to render', async ({ page }) => {
  const { deps, invocations } = planning();
  await openPlans(page, deps);
  const snapshotId = app.service.load().snapshot.id;
  let reads = 0;
  await page.route('**/api/plan/suggestions/*', async route => {
    reads++;
    if (reads <= 2) {
      const reply = suggestions();
      const malformedEdit = reads === 1
        ? { ...reply.edits[0], op: 'add_item', field: null, value: null, new_item: null }
        : { ...reply.edits[0], op: 'add_file', field: null, value: null, file: { path: 'partial.ts' } };
      const malformed = { ...reply, edits: [malformedEdit] };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        mode: 'suggest', state: 'ready', revision: 1, snapshotId, reply: malformed, reason: null,
      }) });
      return;
    }
    await route.continue();
  });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const suggest = page.locator('#plan-suggest');
  await suggest.click();
  await expect.poll(() => invocations.length).toBe(1);
  await expect(page.getByRole('status').filter({ hasText: 'Planning status response was incomplete, invalid' })).toBeVisible();
  await expect(suggest).toHaveAttribute('aria-disabled', 'true');
  await expect.poll(() => reads).toBeGreaterThanOrEqual(2);
  await expect(page.getByRole('article', { name: 'Name the retry ceiling' })).toHaveCount(0);
  expect(errors).toEqual([]);
  invocations[0]!.resolve(JSON.stringify(suggestions()));
  await expect(page.getByRole('status').filter({ hasText: 'Suggestions ready for r1.' })).toBeVisible();
});

test('renders hostile suggestion and draft fields only as literal text', async ({ page }) => {
  const { deps, invocations } = planning();
  await openPlans(page, deps);
  const current = app.service.store.getPlan(app.service.config.identity);
  const hostileReply = '<img id="g2-injected-image" src=x onerror="window.__g2Injected=true">';
  const hostileSummary = '\"><svg id="g2-injected-svg" onload="window.__g2Injected=true">';
  const hostileReason = '<script id="g2-injected-script">window.__g2Injected=true</script>';
  const hostileValue = '</p><button id="g2-injected-button">bad</button>';
  const reply = suggestions();
  reply.reply = hostileReply;
  reply.edits[0] = { ...reply.edits[0]!, summary: hostileSummary, reason: hostileReason, value: hostileValue };
  await page.getByRole('button', { name: 'Suggest edits' }).click();
  await expect.poll(() => invocations.length).toBe(1);
  invocations[0]!.resolve(JSON.stringify(reply));
  await expect(page.locator('#plan-author-result')).toContainText(hostileReply);
  await expect(page.locator('#plan-author-result')).toContainText(hostileSummary);
  await expect(page.locator('#plan-author-result')).toContainText(hostileReason);
  await expect(page.locator('#plan-author-result')).toContainText(hostileValue);

  const hostileDraftSummary = '<img id="g2-draft-image" src=x onerror="window.__g2Injected=true">';
  const hostileDraftTitle = '\"><button id="g2-draft-button">draft</button>';
  const hostileDraft = draft(current);
  hostileDraft.summary = hostileDraftSummary;
  hostileDraft.items[0] = { ...hostileDraft.items[0]!, title: hostileDraftTitle };
  await page.getByRole('button', { name: 'Draft next revision' }).click();
  await expect.poll(() => invocations.length).toBe(2);
  invocations[1]!.resolve(JSON.stringify(hostileDraft));
  await expect(page.locator('#plan-author-result')).toContainText(hostileDraftSummary);
  await expect(page.locator('#plan-author-result')).toContainText(hostileDraftTitle);
  for (const selector of ['#g2-injected-image', '#g2-injected-svg', '#g2-injected-script', '#g2-injected-button', '#g2-draft-image', '#g2-draft-button'])
    await expect(page.locator(selector)).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__g2Injected)).toBeUndefined();
});

test('keeps a completed result when the next request is refused', async ({ page }) => {
  const { deps, invocations } = planning();
  await openPlans(page, deps);
  await page.getByRole('button', { name: 'Suggest edits' }).click();
  await expect.poll(() => invocations.length).toBe(1);
  invocations[0]!.resolve(JSON.stringify(suggestions()));
  await expect(page.getByRole('article', { name: 'Name the retry ceiling' })).toBeVisible();
  await page.route('**/api/plan/drafts', route => route.fulfill({
    status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Drafting is temporarily unavailable.' }),
  }));
  await page.getByRole('button', { name: 'Draft next revision' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Draft failed.' })).toContainText('temporarily unavailable');
  await expect(page.getByRole('article', { name: 'Name the retry ceiling' })).toBeVisible();
  await expect(page.getByText('Earlier suggested edits')).toBeVisible();
});

test('dismisses ready suggestions without changing the plan', async ({ page }) => {
  const { deps, invocations } = planning();
  await openPlans(page, deps);
  await page.getByRole('button', { name: 'Suggest edits' }).click();
  await expect.poll(() => invocations.length).toBe(1);
  invocations[0]!.resolve(JSON.stringify(suggestions()));
  const dismiss = page.locator('#plan-author-dismiss');
  await expect(dismiss).toBeVisible();
  let release!: () => void, arrived!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const captured = new Promise<void>(resolve => { arrived = resolve; });
  await page.route('**/api/plan/suggestions/*/cancel', async route => { arrived(); await held; await route.continue(); });
  await dismiss.focus();
  await dismiss.click();
  await captured;
  await expect(dismiss).toBeFocused();
  await expect(dismiss).toHaveAttribute('aria-disabled', 'true');
  release();
  await expect(page.getByRole('status').filter({ hasText: 'Suggestions dismissed.' })).toBeVisible();
  await expect(page.getByRole('article', { name: 'Name the retry ceiling' })).toHaveCount(0);
  expect(app.service.store.getPlan(app.service.config.identity).revision).toBe(1);
});

test('ignores a ready poll response that returns after dismissal completes', async ({ page }) => {
  await page.addInitScript(() => {
    const nativeSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (typeof handler === 'function' && handler.toString().includes('pollPlanAuthor'))
        (window as typeof window & { __planAuthorPoll?: () => void }).__planAuthorPoll = handler as () => void;
      return nativeSetTimeout(handler, timeout, ...args);
    }) as typeof window.setTimeout;
  });
  const { deps, invocations } = planning();
  await openPlans(page, deps);
  await page.getByRole('button', { name: 'Suggest edits' }).click();
  await expect.poll(() => invocations.length).toBe(1);
  invocations[0]!.resolve(JSON.stringify(suggestions()));
  const dismiss = page.locator('#plan-author-dismiss');
  await expect(dismiss).toBeVisible();

  let release!: () => void, arrived!: () => void, requestId = '';
  const held = new Promise<void>(resolve => { release = resolve; });
  const captured = new Promise<void>(resolve => { arrived = resolve; });
  let heldOldPoll = false;
  await page.route('**/api/plan/suggestions/*', async route => {
    if (route.request().method() !== 'GET' || heldOldPoll) { await route.fallback(); return; }
    heldOldPoll = true;
    requestId = new URL(route.request().url()).pathname.split('/').at(-1) ?? '';
    const response = await route.fetch();
    arrived();
    await held;
    await route.fulfill({ response });
  });
  await page.evaluate(() => {
    (window as typeof window & { __planAuthorPoll?: () => void }).__planAuthorPoll?.();
  });
  await captured;

  await dismiss.click();
  await expect(page.getByRole('status').filter({ hasText: 'Suggestions dismissed.' })).toBeVisible();
  await expect(page.getByRole('article', { name: 'Name the retry ceiling' })).toHaveCount(0);
  expect(app.service.store.getSuggestions(app.service.config.identity, requestId).state).toBe('cancelled');
  release();

  await expect(page.getByRole('status').filter({ hasText: 'Suggestions dismissed.' })).toBeVisible();
  await expect(page.getByRole('article', { name: 'Name the retry ceiling' })).toHaveCount(0);
  expect(app.service.store.getSuggestions(app.service.config.identity, requestId).state).toBe('cancelled');
});

test('blocks repeat dismissal until an ambiguous cancellation is reconciled', async ({ page }) => {
  const { deps, invocations } = planning();
  await openPlans(page, deps);
  await page.getByRole('button', { name: 'Suggest edits' }).click();
  await expect.poll(() => invocations.length).toBe(1);
  invocations[0]!.resolve(JSON.stringify(suggestions()));
  const dismiss = page.locator('#plan-author-dismiss');
  await expect(dismiss).toBeVisible();
  let cancels = 0, release!: () => void, arrived!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const captured = new Promise<void>(resolve => { arrived = resolve; });
  await page.route('**/api/plan/suggestions/*/cancel', async route => {
    cancels++;
    if (cancels === 1) await route.abort('failed');
    else await route.continue();
  });
  await page.route('**/api/plan/suggestions/*', async route => {
    if (route.request().method() !== 'GET') { await route.fallback(); return; }
    const response = await route.fetch();
    arrived();
    await held;
    await route.fulfill({ response });
  });
  await dismiss.click();
  await captured;
  await expect(dismiss).toHaveAttribute('aria-disabled', 'true');
  await dismiss.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  expect(cancels).toBe(1);
  release();
  await expect(page.getByRole('button', { name: 'Dismiss suggestions' })).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss suggestions' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Suggestions dismissed.' })).toBeVisible();
  expect(cancels).toBe(2);
});

test('marks a delayed suggestion poll stale after an import advances the plan', async ({ page }) => {
  const { deps, invocations } = planning();
  await openPlans(page, deps);
  const current = app.service.store.getPlan(app.service.config.identity);
  let release!: () => void, arrived!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const captured = new Promise<void>(resolve => { arrived = resolve; });
  let heldReady = false;
  await page.route('**/api/plan/suggestions/*', async route => {
    const response = await route.fetch();
    const body = await response.json();
    if (!heldReady && body.state === 'ready') {
      heldReady = true;
      arrived();
      await held;
    }
    await route.fulfill({ response, body: JSON.stringify(body) });
  });
  await page.getByRole('button', { name: 'Suggest edits' }).click();
  await expect.poll(() => invocations.length).toBe(1);
  invocations[0]!.resolve(JSON.stringify(suggestions()));
  await captured;

  await page.getByLabel('Plan file').setInputFiles({
    name: 'next-plan.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(draft(current))),
  });
  await page.getByRole('button', { name: 'Import next revision' }).click();
  await expect(page.locator('#plans-revision')).toHaveText('r2');
  release();

  await expect(page.getByRole('status').filter({ hasText: 'Stale suggestions · generated for r1' })).toBeVisible();
  await expect(page.getByRole('article', { name: 'Name the retry ceiling' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Dismiss suggestions' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Apply this edit' })).toHaveCount(0);
  expect(app.service.store.getPlan(app.service.config.identity).revision).toBe(2);
});
