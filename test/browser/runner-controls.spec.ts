import { test, expect, type Page, type Request } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDemo } from '../../scripts/demo.ts';
import { startServer } from '../../web/server.ts';
import type { ReviewService } from '../../runner/review.ts';
import type { RunnerDeps } from '../../runner/coordinator.ts';
import { SafetyFindings, type ExecutionSources } from '../../runner/execution.ts';
import { approveItem } from '../../core/approvals.ts';
import { openReview, refreshReview } from './review-page.ts';

// Runner controls (#200) against a real server and runner. The runner's preparation always fails, so an admitted item
// ends `failed` without an agent (as in test/runner-start.test.ts): enough for start, resume, cancel and their guards.
type App = Awaited<ReturnType<typeof startServer>>;
let root: string, app: App;
const OWNER = 'd'.repeat(32);
async function approvePlan(service: ReviewService) {
  const view = await service.load();
  service.store.saveReview(service.config.identity, view.expected,
    view.items.map(item => approveItem(view.plan, view.segments, item.id, service.config.identity, item.count === 0)), []);
}
/** `prepare` decides when the item's preparation fails, so a test can hold an attempt in progress. */
async function serve(options: { approve?: boolean; prepare?: () => Promise<never> } = {}) {
  root = mkdtempSync(join(tmpdir(), 'codeboost-runner-ui-'));
  app = await startServer(createDemo(join(root, 'demo')), 0, undefined, undefined, 2_000, undefined, undefined, undefined, async service => {
    if (options.approve !== false) await approvePlan(service);
    const deps: RunnerDeps = { runnerOwner: OWNER, kinds: ['execute'], prepare: options.prepare ?? (async () => { throw new Error('no agent here'); }),
      cleanupPreparation: async () => undefined, start: () => { throw new Error('no agent here'); }, validate: () => null };
    const sources: ExecutionSources = { planContext: () => service.planContext(), checkpointContext: () => service.planContext(),
      issue: () => ({ text: { number: 1, title: '', body: '', comments: [] }, validate: () => undefined }), lessons: () => [], vendor: () => 'claude' };
    return { deps, sources, findings: new SafetyFindings(service.store),
      recovery: { finalized: [], requeue: [], removedDirectories: [], unknownEntries: [], unmatchedStorage: [], repairedMerges: [] } };
  });
  return app;
}
test.afterEach(async () => { await app?.close(); if (root) rmSync(root, { recursive: true, force: true }); });
const runnerPosts = (page: Page) => {
  const posts: Record<string, any>[] = [];
  page.on('request', (request: Request) => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/runner') posts.push(request.postDataJSON()); });
  return posts;
};
const status = (page: Page) => page.locator('#task-status');

test('shows no runner controls without a runner', async ({ page }) => {
  root = mkdtempSync(join(tmpdir(), 'codeboost-runner-ui-'));
  app = await startServer(createDemo(join(root, 'demo')), 0);
  const loaded = page.waitForResponse(response => new URL(response.url()).pathname === '/api/runner');
  await openReview(page, app.url);
  expect((await (await loaded).json()).available).toBe(false);
  for (const id of ['task-status', 'run-action', 'cancel-task', 'attempt-stop', 'attempt-retry', 'task-banner']) await expect(page.locator(`#${id}`)).toBeHidden();
});

test('starts an approved task with the versions on screen, then offers Resume once its item has run', async ({ page }) => {
  await serve();
  const posts = runnerPosts(page);
  await openReview(page, app.url);
  await expect(status(page)).toHaveText('○ In review');
  const start = page.getByRole('button', { name: 'Start', exact: true });
  await expect(start).toBeVisible();
  const review = await app.service.load(), before = app.service.store.getTask(app.service.config.identity).stateVersion;
  await start.click();
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]).toMatchObject({ action: 'start', expectedStateVersion: before, expectedReviewVersion: review.expected.reviewVersion });
  expect(posts[0]!.actionId).toMatch(/^[0-9a-f-]{36}$/);
  // The item's preparation fails, so the run ends with that item failed and the task still running: Resume is offered.
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  await expect(status(page)).toHaveText('○ Running');
  await expect(page.locator('#runner-note')).toContainText(/Running P1\.|Refresh to review/);
});

test('offers no Start while plan items are unapproved, and Cancel task asks once before cancelling', async ({ page }) => {
  await serve({ approve: false });
  const posts = runnerPosts(page);
  await openReview(page, app.url);
  await expect(status(page)).toHaveText('○ In review');
  await expect(page.locator('#run-action')).toBeHidden();
  const cancel = page.locator('#cancel-task');
  await cancel.click();
  await expect(cancel).toHaveText('Confirm cancel');
  await expect(page.locator('#runner-note')).toContainText('cannot be undone');
  // The first press sends nothing: the confirm window is 5 s, and this waits 1 s past the first press's handling.
  await page.waitForTimeout(1_000);
  expect(posts).toHaveLength(0);
  await cancel.click();
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]!.action).toBe('cancel-task');
  await expect(status(page)).toHaveText('– Cancelled');
  // Cancel hid itself while focused: focus moves to Refresh.
  await expect(cancel).toBeHidden();
  await expect(page.locator('#reload')).toBeFocused();
  expect(app.service.store.getTask(app.service.config.identity).status).toBe('cancelled');
});

test('the cancel confirmation lapses after 5 seconds', async ({ page }) => {
  await serve();
  await page.clock.install();
  const posts = runnerPosts(page);
  await openReview(page, app.url);
  const cancel = page.locator('#cancel-task');
  await cancel.click();
  await expect(cancel).toHaveText('Confirm cancel');
  await page.clock.runFor(5_100);
  await expect(cancel).toHaveText('Cancel task');
  await expect(page.locator('#runner-note')).toHaveText('');
  // A press after the lapse asks again instead of cancelling.
  await cancel.click();
  await expect(cancel).toHaveText('Confirm cancel');
  expect(posts).toHaveLength(0);
});

test('resends the same action ID after a 503 or a lost response, and uses a new one after a refusal', async ({ page }) => {
  await serve();
  const keys: string[] = [], answers: Array<'503' | 'lost' | 'unknown' | 'pass' | '409'> = ['503', 'lost', 'unknown', 'pass', '409', 'pass'];
  await page.route('**/api/runner', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    const body = route.request().postDataJSON();
    keys.push(body.actionId);
    const answer = answers[keys.length - 1];
    if (answer === 'lost') { await route.abort('failed'); return; }
    if (answer === '503') { await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'The review server is shutting down.' }) }); return; }
    if (answer === '409') { await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Stale task state. Reload before writing.' }) }); return; }
    if (answer === 'unknown') { await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Storage failed.', outcomeUnknown: true }) }); return; }
    await route.continue();
  });
  await openReview(page, app.url);
  const start = page.getByRole('button', { name: 'Start', exact: true });
  for (let click = 0; click < 3; click++) {
    await start.click();
    await expect.poll(() => keys.length).toBe(click + 1);
    await expect(page.locator('#runner-note')).toContainText('resend the same request');
  }
  await start.click();
  await expect.poll(() => keys.length).toBe(4);
  expect(keys.slice(1)).toEqual([keys[0], keys[0], keys[0]]);
  const resume = page.getByRole('button', { name: 'Resume', exact: true });
  await expect(resume).toBeVisible();
  // A refusal is a definite answer: the next press of the same action is a new action with a new key.
  await resume.click();
  await expect.poll(() => keys.length).toBe(5);
  await expect(page.locator('#runner-note')).toHaveText('✕ Stale task state. Reload before writing.');
  await resume.click();
  await expect.poll(() => keys.length).toBe(6);
  expect(keys[5]).not.toBe(keys[4]);
  expect(keys[4]).not.toBe(keys[0]);
});

test('keeps focus on the run action while its request is in flight, ignores a second press, and moves focus to Refresh when it hides', async ({ page }) => {
  // The item's preparation is held, so the answer shows it running and the run action has nothing to offer.
  let fail!: () => void;
  await serve({ prepare: () => new Promise<never>((_, reject) => { fail = () => reject(new Error('no agent here')); }) });
  const posts = runnerPosts(page);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/runner', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    await held;
    await route.continue();
  });
  await openReview(page, app.url);
  const start = page.getByRole('button', { name: 'Start', exact: true });
  await start.focus();
  await page.keyboard.press('Enter');
  await expect(start).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Enter');
  await expect(start).toBeFocused();
  release();
  await expect(page.locator('#runner-note')).toHaveText('✓ Running P1.');
  expect(posts).toHaveLength(1);
  // The answer shows P1 running: Start hid while focused, so focus is on Refresh, and Stop P1 is offered.
  await expect(page.locator('#run-action')).toBeHidden();
  await expect(page.locator('#reload')).toBeFocused();
  await expect(page.getByRole('button', { name: 'Stop P1', exact: true })).not.toHaveAttribute('aria-disabled', 'true');
  fail();
});

test('shows an item in progress with Stop, polls until it settles, and drops a poll read before the stop', async ({ page }) => {
  let fail!: () => void;
  await serve({ prepare: () => new Promise<never>((_, reject) => { fail = () => reject(new Error('no agent here')); }) });
  const posts = runnerPosts(page);
  await openReview(page, app.url);
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  const stop = page.getByRole('button', { name: 'Stop P1', exact: true });
  await expect(stop).toBeVisible();
  await expect(status(page)).toHaveText('○ Running · P1');
  // Hold the next poll, stop the item, then let the held poll answer: it was read before the stop, so it is dropped.
  let releasePoll!: () => void, pollHeld!: () => void;
  const pollSeen = new Promise<void>(resolve => { pollHeld = resolve; });
  const pollGate = new Promise<void>(resolve => { releasePoll = resolve; });
  let heldOne = false, delivered!: () => void;
  const heldDelivered = new Promise<void>(resolve => { delivered = resolve; });
  let heldView: Record<string, any> | undefined;
  await page.route('**/api/runner', async route => {
    if (route.request().method() === 'GET' && !heldOne) {
      heldOne = true; const response = await route.fetch(); heldView = await response.json(); pollHeld(); await pollGate;
      await route.fulfill({ response }); delivered(); return;
    }
    await route.continue();
  });
  await pollSeen;
  await stop.click();
  await expect.poll(() => posts.map(post => post.action)).toEqual(['start', 'cancel-attempt']);
  await expect(page.locator('#runner-note')).toHaveText('Stopping the item…');
  await expect(status(page)).toContainText('Stopping…');
  // The held poll was read while P1 ran with no stop, so applying it would offer Stop P1 again.
  expect(heldView!.stopRequested).toBeNull();
  expect(heldView!.attempts.find((attempt: { id: string }) => attempt.id === heldView!.task.currentAttemptId).state).toMatch(/pending|running/);
  releasePoll();
  // Proof the page handled it: the response was delivered, then the page ran a task after its handlers.
  await heldDelivered;
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 50)));
  await expect(stop).toBeHidden();
  await expect(status(page)).toContainText('Stopping…');
  fail();
  await expect(page.locator('#runner-note')).toContainText('Refresh to review its latest changes');
  await expect(stop).toBeHidden();
});

/**
 * Serves `GET /api/runner` as the real server answered it, with `change` applied. Only for states this runner cannot
 * reach (publishing, a scope checkpoint, a retryable non-execute attempt); every field `change` does not set is the
 * real server's. Actions still go to the real server.
 */
async function viewWith(page: Page, change: (view: Record<string, any>) => void) {
  await page.route('**/api/runner', async route => {
    if (route.request().method() !== 'GET') { await route.continue(); return; }
    const response = await route.fetch(), view = await response.json();
    change(view);
    await route.fulfill({ response, json: view });
  });
}

test('offers Publish draft PR when the server would publish, and shows the server refusal', async ({ page }) => {
  await serve();
  const posts = runnerPosts(page);
  await viewWith(page, view => { view.startable = false; view.publish = { ...view.publish, available: true, publishable: true, draft: true }; });
  await openReview(page, app.url);
  const publish = page.getByRole('button', { name: 'Publish draft PR', exact: true });
  await publish.click();
  await expect.poll(() => posts.map(post => post.action)).toEqual(['publish']);
  expect(posts[0]).not.toHaveProperty('expectedReviewVersion');
  // This test server is a demo with no publisher, so the real server refuses; the page shows its message.
  await expect(page.locator('#runner-note')).toHaveText('✕ Demos never publish pull requests.');
});

test('offers Retry for a retryable attempt and sends its attempt ID', async ({ page }) => {
  await serve();
  const posts = runnerPosts(page);
  const attemptId = '0b6e2f0a-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
  await viewWith(page, view => { view.retryable = true; view.task.currentAttemptId = attemptId; });
  await openReview(page, app.url);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]).toMatchObject({ action: 'retry', attemptId });
  await expect(page.locator('#runner-note')).toContainText('✕');
});

test('shows the needs-amendment banner, approves the continuation, and opens the Plans screen', async ({ page }) => {
  await serve();
  const posts = runnerPosts(page);
  await viewWith(page, view => {
    view.startable = false;
    view.task.status = 'needs amendment';
    view.continuation = { checkpointId: 'c1', item: 'P2', completedItems: ['P1'], outOfScopePaths: ['src/config.ts'], next: 'P2', approved: false };
  });
  await openReview(page, app.url);
  await expect(status(page)).toHaveText('! Needs amendment');
  await expect(page.locator('#task-banner-text')).toHaveText('P2 changed files the plan did not declare: src/config.ts. Revise the plan to declare them, then approve the continuation.');
  await page.getByRole('button', { name: 'Approve continuation', exact: true }).click();
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]).toMatchObject({ action: 'approve-continuation', expectedReviewVersion: (await app.service.load()).expected.reviewVersion });
  // The real task has no checkpoint, so the server refuses.
  await expect(page.locator('#runner-note')).toContainText('✕');
  await page.getByRole('button', { name: 'Review plan change', exact: true }).click();
  await expect(page.locator('#plans-view')).toBeVisible();
});

test('a continuation the revised plan cannot satisfy shows its reason and no Approve', async ({ page }) => {
  await serve();
  await viewWith(page, view => {
    view.startable = false;
    view.task.status = 'needs amendment';
    view.continuation = { checkpointId: 'c1', item: 'P2', completedItems: ['P1'], outOfScopePaths: ['src/config.ts'], next: null, approved: false,
      reason: 'The current plan does not declare src/config.ts for P2.' };
  });
  await openReview(page, app.url);
  await expect(page.locator('#task-banner-text')).toHaveText('P2 changed files the plan did not declare: src/config.ts. The current plan does not declare src/config.ts for P2.');
  await expect(page.locator('#task-banner-approve')).toBeHidden();
  await expect(page.locator('#task-banner-plans')).toBeVisible();
});

test('shows the needs-human and possibly-already-fixed banners with Cancel task and no run action', async ({ page }) => {
  await serve();
  let state: 'needs human' | 'possibly already fixed' = 'needs human';
  await viewWith(page, view => {
    view.startable = false;
    view.task.status = state;
    view.publish = { ...view.publish, last: { outcome: state === 'needs human' ? 'opened' : 'possibly already fixed',
      message: state === 'needs human' ? 'Opened draft pull request #7.' : 'The issue may already be fixed (#401 links to it), so no pull request was opened.' } };
  });
  await openReview(page, app.url);
  await expect(status(page)).toHaveText('! Needs human');
  await expect(page.locator('#task-banner-text')).toHaveText('This task needs a person. Opened draft pull request #7.');
  await expect(page.locator('#run-action')).toBeHidden();
  await expect(page.locator('#cancel-task')).toBeVisible();
  state = 'possibly already fixed';
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(status(page)).toHaveText('! Possibly already fixed');
  await expect(page.locator('#task-banner-text')).toHaveText('The issue may already be fixed (#401 links to it), so no pull request was opened.');
  await expect(page.locator('#cancel-task')).toBeVisible();
});

test('a Refresh while an action is in flight does not replace its answer with a runner read from before it', async ({ page }) => {
  let fail!: () => void;
  await serve({ prepare: () => new Promise<never>((_, reject) => { fail = () => reject(new Error('no agent here')); }) });
  let release!: () => void, posted!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), seen = new Promise<void>(resolve => { posted = resolve; });
  const reads: number[] = [];
  await page.route('**/api/runner', async route => {
    if (route.request().method() !== 'POST') { reads.push(Date.now()); await route.continue(); return; }
    posted(); await held; await route.continue();
  });
  await openReview(page, app.url);
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await seen;
  // The start has not reached the server yet. A Refresh now reloads the review; any runner read it makes sees no start.
  const before = reads.length;
  await refreshReview(page);
  release();
  await expect(page.locator('#runner-note')).toHaveText('✓ Running P1.');
  // The action's answer shows P1 running: Stop P1 is offered and Start is not.
  await expect(page.getByRole('button', { name: 'Stop P1', exact: true })).toBeVisible();
  await expect(page.locator('#run-action')).toBeHidden();
  expect(reads.length).toBeGreaterThanOrEqual(before);
  fail();
});

test('the review strip fits its runner controls at the 1280px minimum width', async ({ page }) => {
  await serve();
  await page.setViewportSize({ width: 1280, height: 800 });
  // Every control the strip can show at once while an item runs: status, Stop, Retry, a run action and Cancel task.
  await viewWith(page, view => { view.retryable = true; view.publish = { ...view.publish, available: true, publishable: true, draft: true }; });
  await openReview(page, app.url);
  for (const id of ['task-status', 'attempt-retry', 'run-action', 'cancel-task']) await expect(page.locator(`#${id}`)).toBeVisible();
  // This server has no merge gateway, so the merge controls a production task also shows are unhidden here with their
  // production labels (renderMergeControls), for this layout check only.
  await page.evaluate(() => { for (const [id, text] of [['merge', '3 blockers'], ['merge-details', 'Review blockers']]) { const button = document.getElementById(id)!; button.hidden = false; button.textContent = text; } });
  const strip = await page.locator('#review-view .review-strip').evaluate(element => ({ scroll: element.scrollWidth, client: element.clientWidth }));
  expect(strip.scroll).toBeLessThanOrEqual(strip.client);
});
