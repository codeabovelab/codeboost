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
  await guidance.fill('Keep these newer notes while the request runs.');
  invocations[0]!.resolve(JSON.stringify(suggestions()));

  await expect(page.getByRole('status').filter({ hasText: 'Suggestions ready for r1.' })).toBeVisible();
  await expect(page.getByRole('article', { name: 'Name the retry ceiling' })).toContainText('Set P1.title to Expose the bounded retry ceiling');
  await expect(guidance).toHaveValue('Keep these newer notes while the request runs.');
  await page.screenshot({ path: 'test-results/plans-authoring-desktop.png', fullPage: true });
  expect(invocations[0]!.request).toMatchObject({ mode: 'suggest', revision: 1 });
  expect(invocations[0]!.request.prompt).toContain('Make the plan clearer.');
});

test('renders a whole next-revision draft without changing the current plan', async ({ page }) => {
  const { deps, invocations } = planning();
  await openPlans(page, deps);
  const current = app.service.store.getPlan(app.service.config.identity);
  await page.getByLabel('Guidance').fill('Rewrite the plan around operator visibility.');
  await page.getByRole('button', { name: 'Draft next revision' }).click();
  await expect.poll(() => invocations.length).toBe(1);
  invocations[0]!.resolve(JSON.stringify(draft(current)));

  await expect(page.getByRole('status').filter({ hasText: 'Draft ready for r1.' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Draft Make retry limits visible to operators' })).toContainText('P1 Expose the bounded retry ceiling');
  await expect(page.locator('#plans-revision')).toHaveText('r1');
  expect(app.service.store.getPlan(app.service.config.identity).revision).toBe(1);
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
  expect(app.service.store.getPlan(app.service.config.identity).revision).toBe(1);
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
  expect(app.service.store.getPlan(app.service.config.identity).revision).toBe(2);
});
