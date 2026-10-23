import { test, expect, type Page, type Request, type Route } from '@playwright/test';
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
  await expect(status(page)).toHaveText('● Running');
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
  const posts = runnerPosts(page);
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
    await expect(page.locator('#runner-note')).toContainText('resend the same request, unless the task has changed meanwhile');
  }
  await start.click();
  await expect.poll(() => keys.length).toBe(4);
  expect(keys.slice(1)).toEqual([keys[0], keys[0], keys[0]]);
  const resume = page.getByRole('button', { name: 'Resume', exact: true });
  await expect(resume).toBeVisible();
  // A refusal is a definite answer: the next press of the same action is a new action with a new key.
  await resume.click();
  await expect.poll(() => keys.length).toBe(5);
  // A note about P1's end may stay beside the refusal, depending on whether the start's answer still showed P1 running.
  await expect(page.locator('#runner-note')).toHaveText(/(^|\. )✕ Stale task state\. The page has read it again; try again\.$/);
  await resume.click();
  await expect.poll(() => keys.length).toBe(6);
  // The same request apart from its key: only the refusal made the second press a new action.
  const { actionId: _fifth, ...fifth } = posts[4]!, { actionId: _sixth, ...sixth } = posts[5]!;
  expect(sixth).toEqual(fifth);
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
  await expect(status(page)).toHaveText('● Running · P1');
  // Hold the next poll, stop the item, then let the held poll answer: it was read before the stop, so it is dropped.
  let releasePoll!: () => void, pollHeld!: () => void;
  const pollSeen = new Promise<void>(resolve => { pollHeld = resolve; });
  const pollGate = new Promise<void>(resolve => { releasePoll = resolve; });
  let heldOne = false, holdLater = false, releaseLater!: () => void;
  const laterGate = new Promise<void>(resolve => { releaseLater = resolve; });
  let heldView: Record<string, any> | undefined;
  await page.route('**/api/runner', async route => {
    if (route.request().method() === 'GET' && !heldOne) {
      heldOne = true; heldView = await serverRunnerView(route); pollHeld(); await pollGate;
      await route.fulfill({ status: 200, json: heldView }); return;
    }
    // Later reads wait until the check below, so none can repair a state the held answer broke.
    if (route.request().method() === 'GET' && holdLater) await laterGate;
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
  holdLater = true;
  const reads = Number(await page.locator('#runner-note').getAttribute('data-reads'));
  releasePoll();
  // Proof the page handled the held answer: its count of settled reads moves on. Then the state is read once.
  await expect(page.locator('#runner-note')).toHaveAttribute('data-reads', String(reads + 1));
  expect(await stop.isHidden()).toBe(true);
  expect(await status(page).textContent()).toContain('Stopping');
  releaseLater();
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
    const view = await serverRunnerView(route);
    change(view);
    await route.fulfill({ status: 200, json: view });
  });
}
/**
 * The real server's `GET /api/runner` answer for an intercepted read. A plain fetch, not `route.fetch`: Playwright's
 * pooled connection can reach an earlier test's server on a reused port and fail with ECONNRESET (as clickReview in
 * review.spec.ts notes for its reads).
 */
async function serverRunnerView(route: Route): Promise<Record<string, any>> {
  const request = route.request(), response = await fetch(request.url(), { headers: { 'x-codeboost-token': request.headers()['x-codeboost-token'] ?? '' } });
  if (!response.ok) throw new Error(`The runner read answered ${response.status}.`);
  return await response.json() as Record<string, any>;
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
  await expect(page.locator('#task-banner-text')).toHaveText('! P2 changed files the plan did not declare: src/config.ts. Revise the plan to declare them, then approve the continuation.');
  // Review plan change is the banner's main action (the design's "Task states that wait on you").
  await expect(page.locator('#task-banner-plans')).toHaveClass('primary');
  await expect(page.locator('#task-banner-approve')).not.toHaveClass('primary');
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
  await expect(page.locator('#task-banner-text')).toHaveText('! P2 changed files the plan did not declare: src/config.ts. The current plan does not declare src/config.ts for P2.');
  await expect(page.locator('#task-banner-approve')).toBeHidden();
  await expect(page.locator('#task-banner-plans')).toBeVisible();
});

test('shows the needs-human and possibly-already-fixed banners with Cancel task and no run action', async ({ page }) => {
  await serve();
  let state: 'needs human' | 'possibly already fixed' = 'needs human';
  await viewWith(page, view => {
    view.startable = false;
    view.task.status = state;
    // Messages in runner/publishing.ts's formats.
    view.publish = { ...view.publish, last: state === 'needs human'
      ? { outcome: 'opened', draft: true, message: 'Pull request #7 is open as a draft; the task is needs human.', stateVersion: 1, at: '2026-10-23T12:00:00.000Z', number: 7 }
      : { outcome: 'possibly already fixed', draft: false, message: 'The issue may already be fixed (pull request owner/repo#401), so no pull request was opened.', stateVersion: 1, at: '2026-10-23T12:00:00.000Z' } };
  });
  await openReview(page, app.url);
  await expect(status(page)).toHaveText('! Needs human');
  await expect(page.locator('#task-banner-text')).toHaveText('! This task needs a person. Pull request #7 is open as a draft; the task is needs human.');
  await expect(page.locator('#run-action')).toBeHidden();
  await expect(page.locator('#cancel-task')).toBeVisible();
  state = 'possibly already fixed';
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(status(page)).toHaveText('! Possibly already fixed');
  await expect(page.locator('#task-banner-text')).toHaveText('! The issue may already be fixed (pull request owner/repo#401), so no pull request was opened.');
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
  // The Refresh reloaded the review but made no runner read while the start was in flight.
  expect(reads.length).toBe(before);
  fail();
});

test('the review strip fits its runner controls at the 1280px minimum width', async ({ page }) => {
  await serve();
  await page.setViewportSize({ width: 1280, height: 800 });
  // The most controls the strip shows at once: status, Retry, a run action and Cancel task (Stop and Retry are never
  // offered together: the server offers a retry only when no attempt is active).
  await viewWith(page, view => { view.retryable = true; view.publish = { ...view.publish, available: true, publishable: true, draft: true }; });
  await openReview(page, app.url);
  for (const id of ['task-status', 'attempt-retry', 'run-action', 'cancel-task']) await expect(page.locator(`#${id}`)).toBeVisible();
  // This server has no merge gateway, so the merge controls a production task also shows are unhidden here with their
  // production labels (renderMergeControls), for this layout check only.
  await page.evaluate(() => { for (const [id, text] of [['merge', '3 blockers'], ['merge-details', 'Review blockers']] as [string, string][]) { const button = document.getElementById(id)!; button.hidden = false; button.textContent = text; } });
  const strip = await page.locator('#review-view .review-strip').evaluate(element => ({ scroll: element.scrollWidth, client: element.clientWidth }));
  expect(strip.scroll).toBeLessThanOrEqual(strip.client);
});

test('a poll that hides the focused Stop moves focus to Refresh', async ({ page }) => {
  let fail!: () => void;
  await serve({ prepare: () => new Promise<never>((_, reject) => { fail = () => reject(new Error('no agent here')); }) });
  await openReview(page, app.url);
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  const stop = page.getByRole('button', { name: 'Stop P1', exact: true });
  await stop.focus();
  await expect(stop).toBeFocused();
  // The item fails on its own; the next poll hides Stop.
  fail();
  await expect(stop).toBeHidden();
  await expect(page.locator('#reload')).toBeFocused();
});

test('a failed review action hides the focused Cancel task and moves focus to Refresh', async ({ page }) => {
  await serve({ approve: false });
  await openReview(page, app.url);
  await page.route('**/api/action', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Storage failed.' }) }));
  const cancel = page.locator('#cancel-task');
  await cancel.focus();
  // The approve shortcut sends a review action from the focused button; its failure runs showFailure, which leaves no
  // review on screen and so no runner controls.
  await page.keyboard.press('a');
  await expect(page.locator('#banner')).toHaveText('Storage failed. Refresh to review the latest state.');
  await expect(cancel).toBeHidden();
  await expect(status(page)).toBeHidden();
  await expect(page.locator('#reload')).toBeFocused();
});

test('polls every 2 s while work is in progress, backs off while nothing changes, and stops when it settles', async ({ page }) => {
  await serve();
  // A publish in progress that does not change between reads, then settles.
  let active = true;
  await viewWith(page, view => {
    view.startable = false;
    view.publish = { ...view.publish, available: true, active, last: active ? { outcome: 'publishing', draft: false, message: 'A pull request is being published.', stateVersion: 1, at: '2026-10-23T12:00:00.000Z' }
      : { outcome: 'opened', draft: false, message: 'Pull request #7 is open; the task is in review.', stateVersion: 1, at: '2026-10-23T12:00:00.000Z', number: 7 } };
  });
  await page.clock.install();
  let gets = 0;
  page.on('request', request => { if (request.method() === 'GET' && new URL(request.url()).pathname === '/api/runner') gets++; });
  await openReview(page, app.url);
  await expect(status(page)).toHaveText('○ In review · Publishing…');
  const reads = async () => Number(await page.locator('#runner-note').getAttribute('data-reads'));
  const settledReads = (count: number) => expect(page.locator('#runner-note')).toHaveAttribute('data-reads', String(count));
  const base = await reads();
  // Unchanged views: polls 2 s after the load, then 4 s and 8 s after each poll.
  await page.clock.runFor(2_000); await settledReads(base + 1);
  await page.clock.runFor(3_900); expect(await reads()).toBe(base + 1);
  await page.clock.runFor(100); await settledReads(base + 2);
  await page.clock.runFor(7_900); expect(await reads()).toBe(base + 2);
  await page.clock.runFor(100); await settledReads(base + 3);
  // The publish settles; the next poll (16 s later) shows its outcome, and none follows.
  active = false;
  await page.clock.runFor(16_000); await settledReads(base + 4);
  await expect(page.locator('#runner-note')).toHaveText('✓ Pull request #7 is open; the task is in review.');
  // Nothing is sent in 60 s, past the 30 s backoff cap: counted by requests sent, not reads that finished.
  const sent = gets;
  await page.clock.runFor(60_000);
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
  expect(gets).toBe(sent);
});

test('a running task with an approvable continuation shows the banner and Approve', async ({ page }) => {
  await serve();
  await viewWith(page, view => {
    view.startable = false;
    view.task.status = 'running';
    view.continuation = { checkpointId: 'c1', item: 'P2', completedItems: ['P1'], outOfScopePaths: ['src/config.ts'], next: 'P2', approved: false };
  });
  await openReview(page, app.url);
  await expect(page.locator('#task-banner-text')).toHaveText('! P2 changed files the plan did not declare: src/config.ts. Revise the plan to declare them, then approve the continuation.');
  await expect(page.locator('#task-banner-approve')).toBeVisible();
});

test('a task being cancelled offers no continuation approval', async ({ page }) => {
  await serve();
  await viewWith(page, view => {
    view.startable = false;
    view.task.status = 'needs amendment';
    view.task.cancelRequested = 'cancelled';
    view.continuation = { checkpointId: 'c1', item: 'P2', completedItems: ['P1'], outOfScopePaths: ['src/config.ts'], next: 'P2', approved: false };
  });
  await openReview(page, app.url);
  await expect(status(page)).toHaveText('! Needs amendment · Cancelling…');
  await expect(page.locator('#task-banner-approve')).toBeHidden();
});

test('names the outcome of a publish when it ends', async ({ page }) => {
  await serve();
  let active = true;
  await viewWith(page, view => {
    view.startable = false;
    view.publish = active ? { ...view.publish, available: true, active: true, last: { outcome: 'publishing', draft: false, message: 'A pull request is being published.', stateVersion: 1, at: '2026-10-23T12:00:00.000Z' } }
      : { ...view.publish, available: true, active: false, last: { outcome: 'failed', draft: false, message: 'The task belongs to another repository.', stateVersion: 1, at: '2026-10-23T12:00:00.000Z' } };
  });
  await page.clock.install();
  await openReview(page, app.url);
  await expect(status(page)).toHaveText('○ In review · Publishing…');
  active = false;
  await page.clock.runFor(2_000);
  await expect(page.locator('#runner-note')).toHaveText('✕ The task belongs to another repository.');
});

test('asks for Refresh instead of sending Start when the runner reports a newer review than the page shows', async ({ page }) => {
  await serve();
  const posts = runnerPosts(page);
  // The runner view comes from a read after another tab changed the review; the review on screen is older.
  await viewWith(page, view => { view.reviewVersion += 1; });
  await openReview(page, app.url);
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.locator('#runner-note')).toHaveText('! The review changed since this page loaded it. Press Refresh, check the review, then try again.');
  // The press was handled (the note) and sent nothing.
  expect(posts).toHaveLength(0);
});

test('names Refresh when the server refuses a start for a stale review', async ({ page }) => {
  await serve();
  const posts = runnerPosts(page);
  await openReview(page, app.url);
  // Another tab saves the review after this page loaded both the review and the runner view.
  const view = await app.service.load();
  app.service.store.saveReview(app.service.config.identity, view.expected, view.items.map(() => null).filter(Boolean) as never[], []);
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect.poll(() => posts.length).toBe(1);
  await expect(page.locator('#runner-note')).toHaveText('✕ Stale review state. Press Refresh to load the latest state.');
  // Refresh, as the note asks, clears it.
  await refreshReview(page);
  await expect(page.locator('#runner-note')).toHaveText('');
});

test('shows a runner that needs a restart, and does not poll for it', async ({ page }) => {
  await serve();
  await page.clock.install();
  let gets = 0;
  page.on('request', request => { if (request.method() === 'GET' && new URL(request.url()).pathname === '/api/runner') gets++; });
  await viewWith(page, view => { view.startable = false; view.unresolved = { attemptId: 'a1', reason: 'storage-not-removed' }; });
  await openReview(page, app.url);
  await expect(status(page)).toHaveText("○ In review · Needs restart: an attempt's task storage could not be removed");
  await expect(status(page)).toHaveClass('bad');
  const seen = gets;
  // No poll in 60 s, past the 30 s backoff cap.
  await page.clock.runFor(60_000);
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
  expect(gets).toBe(seen);
});

test('a Refresh clears a runner read error and a work-ended note', async ({ page }) => {
  await serve();
  let failRead = true;
  await page.route('**/api/runner', async route => {
    if (route.request().method() === 'GET' && failRead) { failRead = false; await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Storage failed.' }) }); return; }
    await route.continue();
  });
  await openReview(page, app.url);
  await expect(page.locator('#runner-note')).toHaveText('✕ Could not read the runner state. Storage failed.');
  await refreshReview(page);
  await expect(page.locator('#runner-note')).toHaveText('');
  // A run that ends leaves its note until Refresh.
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.locator('#runner-note')).toContainText('Refresh to review its latest changes');
  await refreshReview(page);
  await expect(page.locator('#runner-note')).toHaveText('');
});

test('keeps polling while a run is between steps, and shows Resume once the runner offers it', async ({ page }) => {
  await serve();
  // Between steps of a run (an attempt's cleanup, the next item, the publish) the server's view names no live attempt
  // and offers nothing: `resumable` is false while the executor is busy (web/server.ts runChoice). This keeps the real
  // view after P1 failed, with `resumable` false until the run "ends".
  let busy = true;
  await viewWith(page, view => { if (busy) view.resumable = false; });
  await openReview(page, app.url);
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect.poll(() => app.service.store.recentAttempts(app.service.config.identity, 1)[0]?.state).toBe('failed');
  await expect(status(page)).toHaveText('● Running');
  await expect(page.locator('#run-action')).toBeHidden();
  // The page keeps polling: two more reads settle with nothing offered.
  const reads = Number(await page.locator('#runner-note').getAttribute('data-reads'));
  await expect(page.locator('#runner-note')).toHaveAttribute('data-reads', String(reads + 2), { timeout: 20_000 });
  busy = false;
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible({ timeout: 30_000 });
});

test('an unresolved marker hides Stop for its attempt and stops polling', async ({ page }) => {
  let fail!: () => void;
  await serve({ prepare: () => new Promise<never>((_, reject) => { fail = () => reject(new Error('no agent here')); }) });
  let unresolved = false, gets = 0;
  page.on('request', request => { if (request.method() === 'GET' && new URL(request.url()).pathname === '/api/runner') gets++; });
  // The real view of a held item, with the marker a result that could not be saved leaves (its row stays pending).
  await viewWith(page, view => { if (unresolved) view.unresolved = { attemptId: view.task.currentAttemptId, reason: 'result-not-saved' }; });
  await page.clock.install();
  await openReview(page, app.url);
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop P1', exact: true })).toBeVisible();
  unresolved = true;
  await page.clock.runFor(2_000);
  await expect(status(page)).toHaveText("● Running · Needs restart: an attempt's result could not be saved");
  await expect(page.locator('#attempt-stop')).toBeHidden();
  // P1 has not ended: no note says it did.
  await expect(page.locator('#runner-note')).toHaveText('✓ Running P1.');
  // Nothing is sent in 60 s, past the 30 s backoff cap.
  const sent = gets;
  await page.clock.runFor(60_000);
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
  expect(gets).toBe(sent);
  fail();
});

test('stops polling a running task that is offered nothing after a minute of unchanged reads, and asks for Refresh', async ({ page }) => {
  await serve();
  // A running task the server offers nothing for, which does not change: for example its time budget ran out while it
  // was idle (web/server.ts runChoice refuses it for the view). The real view after P1 failed, with `resumable` false.
  let gets = 0;
  page.on('request', request => { if (request.method() === 'GET' && new URL(request.url()).pathname === '/api/runner') gets++; });
  await viewWith(page, view => { view.resumable = false; });
  await page.clock.install();
  await openReview(page, app.url);
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect.poll(() => app.service.store.recentAttempts(app.service.config.identity, 1)[0]?.state).toBe('failed');
  await expect(status(page)).toHaveText('● Running');
  // Each poll is scheduled when the read before it settles, and none waits more than 30 s: advance 30 s at a time,
  // waiting for a read to settle after each step, until polling stops. Short delays can let more than one poll run
  // within a step. Five unchanged reads stop it; the first read after Start may still change and restart the count.
  const note = page.locator('#runner-note'), asks = '! Nothing has changed for a minute. Press Refresh to check again.';
  const startReads = Number(await note.getAttribute('data-reads'));
  for (let step = 0; !(await note.textContent())!.endsWith(asks); step++) {
    expect(step).toBeLessThan(10);
    const reads = Number(await note.getAttribute('data-reads'));
    await page.clock.runFor(30_000);
    await expect.poll(async () => Number(await note.getAttribute('data-reads')) > reads || (await note.textContent())!.endsWith(asks)).toBe(true);
  }
  expect(Number(await note.getAttribute('data-reads')) - startReads).toBeGreaterThanOrEqual(5);
  // Nothing is sent in the next 120 s.
  const sent = gets;
  await page.clock.runFor(120_000);
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
  expect(gets).toBe(sent);
  // Refresh reads again and clears the note.
  await refreshReview(page);
  await expect(page.locator('#runner-note')).toHaveText('');
  expect(gets).toBeGreaterThan(sent);
});

test('does not poll a running task that is offered Publish PR', async ({ page }) => {
  await serve();
  let gets = 0;
  page.on('request', request => { if (request.method() === 'GET' && new URL(request.url()).pathname === '/api/runner') gets++; });
  // A running task whose items have all run and whose publish was refused: the server offers Publish again
  // (runner/publishing.ts mode()). The real view after P1 failed, with that offer.
  await viewWith(page, view => { view.resumable = false; view.publish = { ...view.publish, available: true, publishable: true, draft: false }; });
  await page.clock.install();
  await openReview(page, app.url);
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Publish PR', exact: true })).toBeVisible();
  // Nothing is sent in 120 s, and no note says nothing is offered.
  const sent = gets;
  await page.clock.runFor(120_000);
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
  expect(gets).toBe(sent);
  expect(await page.locator('#runner-note').textContent()).not.toContain('Nothing has changed');
});

test('offers Cancel task again for a cancel held by an unread push, and bounds its polling', async ({ page }) => {
  await serve();
  const posts = runnerPosts(page);
  let gets = 0;
  page.on('request', request => { if (request.method() === 'GET' && new URL(request.url()).pathname === '/api/runner') gets++; });
  // As the server reports a cancel held by a push whose outcome could not be read (web/server.ts cancel-task): the
  // task keeps `cancelRequested` and its push marker (runner/store.ts PushMarker), and no work runs. Sending the cancel
  // again settles it.
  await viewWith(page, view => {
    view.startable = false;
    view.task.cancelRequested = 'cancelled';
    view.task.pushInProgress = { attemptId: '7d0c2f4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f', branch: 'codeboost/3-retries', from: 'a'.repeat(40),
      to: 'b'.repeat(40), snapshotId: 's1', startedAt: 1_760_000_000_000 };
  });
  await page.clock.install();
  await openReview(page, app.url);
  await expect(status(page)).toHaveText('○ In review · Cancelling…');
  const note = page.locator('#runner-note');
  const asks = '! Nothing has changed for a minute. Press Cancel task again to retry the cancel, or Refresh to check again.';
  for (let step = 0; (await note.textContent()) !== asks; step++) {
    expect(step).toBeLessThan(10);
    const reads = Number(await note.getAttribute('data-reads'));
    await page.clock.runFor(30_000);
    await expect.poll(async () => Number(await note.getAttribute('data-reads')) > reads || (await note.textContent()) === asks).toBe(true);
  }
  // Nothing is sent in the next 120 s.
  const sent = gets;
  await page.clock.runFor(120_000);
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
  expect(gets).toBe(sent);
  // The confirmation's question shows after the note while it is armed, and goes when it lapses.
  const cancel = page.locator('#cancel-task');
  await cancel.click();
  await expect(note).toHaveText(`${asks} ! Cancelling stops any running work and closes this task's pull requests. It cannot be undone. Press Confirm cancel to go on.`);
  await page.clock.runFor(5_100);
  await expect(note).toHaveText(asks);
  await cancel.click();
  await cancel.click();
  await expect.poll(() => posts.map(post => post.action)).toEqual(['cancel-task']);
});

test('a cancel that an unresolved marker holds offers no Cancel task', async ({ page }) => {
  await serve();
  // The attempt row stays pending under the marker, so the server refuses a second cancel (runner/store.ts cancelTask).
  await viewWith(page, view => { view.startable = false; view.task.cancelRequested = 'cancelled';
    view.unresolved = { attemptId: '7d0c2f4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f', reason: 'result-not-saved' }; });
  await openReview(page, app.url);
  await expect(status(page)).toContainText('Needs restart');
  await expect(page.locator('#cancel-task')).toBeHidden();
});

test('a good poll clears a read error while the cancel question is armed, and the question stays', async ({ page }) => {
  let fail!: () => void;
  await serve({ prepare: () => new Promise<never>((_, reject) => { fail = () => reject(new Error('no agent here')); }) });
  let failRead = false;
  await page.route('**/api/runner', async route => {
    if (route.request().method() === 'GET' && failRead) { failRead = false; await route.fulfill({ status: 500, json: { error: 'Storage failed.' } }); return; }
    await route.continue();
  });
  await page.clock.install();
  await openReview(page, app.url);
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop P1', exact: true })).toBeVisible();
  const note = page.locator('#runner-note');
  // P1 runs, so the page polls (2 s, then backing off while nothing changes). The next poll fails.
  failRead = true;
  let reads = Number(await note.getAttribute('data-reads'));
  await page.clock.runFor(2_000);
  await expect(note).toHaveAttribute('data-reads', String(reads + 1));
  await expect(note).toHaveText('✕ Could not read the runner state. Storage failed.');
  await page.locator('#cancel-task').click();
  const question = "! Cancelling stops any running work and closes this task's pull requests. It cannot be undone. Press Confirm cancel to go on.";
  await expect(note).toHaveText(`✕ Could not read the runner state. Storage failed. ${question}`);
  // The next poll (4 s after the failed one) succeeds within the 5 s confirmation: it clears the read error only.
  reads = Number(await note.getAttribute('data-reads'));
  await page.clock.runFor(4_000);
  await expect(note).toHaveAttribute('data-reads', String(reads + 1));
  await expect(note).toHaveText(question);
  await expect(page.locator('#cancel-task')).toHaveText('Confirm cancel');
  fail();
});

test('the cancel question goes when a read hides Cancel task', async ({ page }) => {
  await serve();
  let closed = false;
  await viewWith(page, view => { if (closed) view.task.status = 'cancelled'; });
  await openReview(page, app.url);
  const note = page.locator('#runner-note');
  await page.locator('#cancel-task').click();
  await expect(note).toContainText('Press Confirm cancel');
  // Another tab cancels the task; the next read shows it closed.
  closed = true;
  await page.evaluate(() => (document.getElementById('plans-refresh') as HTMLButtonElement).click());
  await expect(status(page)).toHaveText('– Cancelled');
  await expect(page.locator('#cancel-task')).toBeHidden();
  await expect(note).toHaveText('');
});

test('a background note that arrives while the cancel question is shown waits behind it until the question goes', async ({ page }) => {
  let fail!: () => void;
  await serve({ prepare: () => new Promise<never>((_, reject) => { fail = () => reject(new Error('no agent here')); }) });
  let failRead = false;
  await page.route('**/api/runner', async route => {
    if (route.request().method() === 'GET' && failRead) { failRead = false; await route.fulfill({ status: 500, json: { error: 'Storage failed.' } }); return; }
    await route.continue();
  });
  await page.clock.install();
  await openReview(page, app.url);
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop P1', exact: true })).toBeVisible();
  const note = page.locator('#runner-note'), cancel = page.locator('#cancel-task');
  await cancel.click();
  await expect(note).toContainText('Press Confirm cancel');
  // The next poll (2 s after Start's answer) fails while the question is shown.
  failRead = true;
  const reads = Number(await note.getAttribute('data-reads'));
  await page.clock.runFor(2_000);
  await expect(note).toHaveAttribute('data-reads', String(reads + 1));
  // The question and its button stay; the read error waits behind it and shows when the confirmation lapses.
  expect(await note.textContent()).toContain('Press Confirm cancel');
  await expect(cancel).toHaveText('Confirm cancel');
  await page.clock.runFor(3_100);
  await expect(cancel).toHaveText('Cancel task');
  await expect(note).toHaveText('✕ Could not read the runner state. Storage failed.');
  fail();
});

test('the Plans screen refresh clears a note that asked for Refresh', async ({ page }) => {
  await serve();
  await viewWith(page, view => { view.reviewVersion += 1; });
  await openReview(page, app.url);
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  const note = page.locator('#runner-note');
  await expect(note).toHaveText('! The review changed since this page loaded it. Press Refresh, check the review, then try again.');
  await page.evaluate(() => (document.getElementById('plans-refresh') as HTMLButtonElement).click());
  await expect(page.locator('#plans-status')).toContainText('is current');
  await expect(note).toHaveText('');
});

test('a note about ended work survives a failed poll and the good poll after it, and shows with the quiet note', async ({ page }) => {
  let fail!: () => void;
  await serve({ prepare: () => new Promise<never>((_, reject) => { fail = () => reject(new Error('no agent here')); }) });
  let failRead = false;
  await page.route('**/api/runner', async route => {
    if (route.request().method() !== 'GET') { await route.continue(); return; }
    if (failRead) { failRead = false; await route.fulfill({ status: 500, json: { error: 'Storage failed.' } }); return; }
    // The run stays between steps after P1 (nothing offered), so polling goes on.
    const view = await serverRunnerView(route);
    view.resumable = false;
    await route.fulfill({ status: 200, json: view });
  });
  await page.clock.install();
  await openReview(page, app.url);
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop P1', exact: true })).toBeVisible();
  const note = page.locator('#runner-note');
  // One poll at a time: advance a second at a time until the next read settles (a poll waits at most 30 s).
  const step = async () => {
    const reads = Number(await note.getAttribute('data-reads'));
    for (let second = 0; Number(await note.getAttribute('data-reads')) === reads; second++) {
      expect(second).toBeLessThan(40);
      await page.clock.runFor(1_000);
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
    }
    await expect(note).toHaveAttribute('data-reads', String(reads + 1));
  };
  fail();
  await expect.poll(() => app.service.store.recentAttempts(app.service.config.identity, 1)[0]?.state).toBe('failed');
  const ended = '✕ P1 failed. The task is now running. Refresh to review its latest changes.';
  while ((await note.textContent()) !== ended) await step();
  failRead = true;
  await step();
  await expect(note).toHaveText(`${ended} ✕ Could not read the runner state. Storage failed.`);
  await step();
  await expect(note).toHaveText(ended);
  const quiet = '! Nothing has changed for a minute. Press Refresh to check again.';
  for (let polls = 0; (await note.textContent()) !== `${ended} ${quiet}`; polls++) { expect(polls).toBeLessThan(10); await step(); }
});

test('a stale-review Start while the cancel question is armed keeps the question', async ({ page }) => {
  await serve();
  const posts = runnerPosts(page);
  await viewWith(page, view => { view.reviewVersion += 1; });
  await openReview(page, app.url);
  const note = page.locator('#runner-note'), cancel = page.locator('#cancel-task');
  await cancel.click();
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(note).toHaveText('! The review changed since this page loaded it. Press Refresh, check the review, then try again. '
    + "! Cancelling stops any running work and closes this task's pull requests. It cannot be undone. Press Confirm cancel to go on.");
  await expect(cancel).toHaveText('Confirm cancel');
  expect(posts).toHaveLength(0);
});

test('a runner read after a review action clears the quiet note when it shows a change', async ({ page }) => {
  await serve({ approve: false });
  // A task the server reports running with nothing offered, unchanged, until the flag drops.
  let faked = true;
  await viewWith(page, view => { if (faked) view.task.status = 'running'; });
  await page.clock.install();
  await openReview(page, app.url);
  await expect(status(page)).toHaveText('● Running');
  const note = page.locator('#runner-note'), quiet = '! Nothing has changed for a minute. Press Refresh to check again.';
  for (let polls = 0; (await note.textContent()) !== quiet; polls++) {
    expect(polls).toBeLessThan(10);
    const reads = Number(await note.getAttribute('data-reads'));
    await page.clock.runFor(30_000);
    await expect.poll(async () => Number(await note.getAttribute('data-reads')) > reads || (await note.textContent()) === quiet).toBe(true);
  }
  // A review action (approving P1 with its shortcut) reloads the review and reads the runner; that read shows a change.
  faked = false;
  const reads = Number(await note.getAttribute('data-reads'));
  await page.keyboard.press('a');
  await expect(note).toHaveAttribute('data-reads', String(reads + 1));
  await expect(status(page)).toHaveText('○ In review');
  await expect(note).toHaveText('');
});

test('a Refresh whose review was read before an item ended keeps the note about that end', async ({ page }) => {
  let fail!: () => void;
  await serve({ prepare: () => new Promise<never>((_, reject) => { fail = () => reject(new Error('no agent here')); }) });
  let holdReview = false, releaseReview!: () => void, reviewSent!: () => void;
  const reviewGate = new Promise<void>(resolve => { releaseReview = resolve; }), sent = new Promise<void>(resolve => { reviewSent = resolve; });
  await page.route('**/api/review', async route => {
    if (!holdReview) { await route.continue(); return; }
    holdReview = false;
    // Read now, before P1 ends, and answered after.
    const response = await fetch(route.request().url(), { headers: { 'x-codeboost-token': route.request().headers()['x-codeboost-token'] ?? '' } });
    const body = await response.json();
    reviewSent(); await reviewGate;
    await route.fulfill({ status: response.status, json: body });
  });
  await openReview(page, app.url);
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop P1', exact: true })).toBeVisible();
  holdReview = true;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await sent;
  fail();
  const note = page.locator('#runner-note'), ended = '✕ P1 failed. The task is now running. Refresh to review its latest changes.';
  await expect(note).toHaveText(ended);
  const reads = Number(await note.getAttribute('data-reads'));
  releaseReview();
  // The reload applies (and reads the runner again); the note it could not have shown stays.
  await expect(note).toHaveAttribute('data-reads', String(reads + 1));
  await expect(note).toHaveText(ended);
});

test('a later success replaces a stale task-state refusal', async ({ page }) => {
  await serve();
  let refused = false;
  await page.route('**/api/runner', async route => {
    if (route.request().method() === 'POST' && !refused) { refused = true; await route.fulfill({ status: 409, json: { error: 'Stale task state. Reload before writing.' } }); return; }
    await route.continue();
  });
  await openReview(page, app.url);
  const cancel = page.locator('#cancel-task'), note = page.locator('#runner-note');
  await cancel.click(); await cancel.click();
  await expect(note).toHaveText('✕ Stale task state. The page has read it again; try again.');
  await cancel.click(); await cancel.click();
  await expect(note).toHaveText('✓ Task cancelled.');
  await expect(note).toHaveClass('good');
});

test('a publish outcome survives a failed poll and the good poll after it', async ({ page }) => {
  await serve();
  let active = true, failRead = false;
  // A running task between steps (polled), whose publish is in progress, then settles.
  await page.route('**/api/runner', async route => {
    if (route.request().method() !== 'GET') { await route.continue(); return; }
    if (failRead) { failRead = false; await route.fulfill({ status: 500, json: { error: 'Storage failed.' } }); return; }
    const view = await serverRunnerView(route);
    view.startable = false;
    view.task.status = 'running';
    view.publish = { ...view.publish, available: true, active, last: active
      ? { outcome: 'publishing', draft: false, message: 'A pull request is being published.', stateVersion: 1, at: '2026-10-23T12:00:00.000Z' }
      : { outcome: 'opened', draft: false, message: 'Pull request #7 is open; the task is running.', stateVersion: 1, at: '2026-10-23T12:00:00.000Z', number: 7 } };
    await route.fulfill({ status: 200, json: view });
  });
  await page.clock.install();
  await openReview(page, app.url);
  const note = page.locator('#runner-note');
  const step = async () => {
    const reads = Number(await note.getAttribute('data-reads'));
    for (let second = 0; Number(await note.getAttribute('data-reads')) === reads; second++) {
      expect(second).toBeLessThan(40);
      await page.clock.runFor(1_000);
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
    }
  };
  await expect(status(page)).toHaveText('● Running · Publishing…');
  active = false;
  await step();
  const opened = '✓ Pull request #7 is open; the task is running.';
  await expect(note).toHaveText(opened);
  failRead = true;
  await step();
  await expect(note).toHaveText(`${opened} ✕ Could not read the runner state. Storage failed.`);
  await step();
  await expect(note).toHaveText(opened);
});

test('a failed read after the quiet note shows the read error, not the quiet note', async ({ page }) => {
  await serve();
  let failRead = false;
  await page.route('**/api/runner', async route => {
    if (route.request().method() !== 'GET') { await route.continue(); return; }
    if (failRead) { failRead = false; await route.fulfill({ status: 500, json: { error: 'Storage failed.' } }); return; }
    // A task the server reports running with nothing offered, unchanged.
    const view = await serverRunnerView(route);
    view.task.status = 'running'; view.startable = false;
    await route.fulfill({ status: 200, json: view });
  });
  await page.clock.install();
  await openReview(page, app.url);
  const note = page.locator('#runner-note'), quiet = '! Nothing has changed for a minute. Press Refresh to check again.';
  for (let polls = 0; (await note.textContent()) !== quiet; polls++) {
    expect(polls).toBeLessThan(10);
    const reads = Number(await note.getAttribute('data-reads'));
    await page.clock.runFor(30_000);
    await expect.poll(async () => Number(await note.getAttribute('data-reads')) > reads || (await note.textContent()) === quiet).toBe(true);
  }
  // Refresh reloads the review; its runner read fails.
  failRead = true;
  await refreshReview(page);
  await expect(note).toHaveText('✕ Could not read the runner state. Storage failed.');
});

test('names a publish that started and settled between two reads', async ({ page }) => {
  await serve();
  let settled = false;
  // A running task between steps (polled). Its publish starts and ends between two reads, so no read sees it active.
  await viewWith(page, view => {
    view.startable = false; view.task.status = 'running';
    view.publish = { ...view.publish, available: true, active: false, last: settled
      ? { outcome: 'failed', draft: false, message: 'The task belongs to another repository.', stateVersion: 2, at: '2026-10-23T12:05:00.000Z' }
      : { outcome: 'not published', draft: false, message: 'This task reached its status before publishing existed.', stateVersion: 1, at: '2026-10-23T12:00:00.000Z' } };
  });
  await page.clock.install();
  await openReview(page, app.url);
  const note = page.locator('#runner-note');
  await expect(note).toHaveText('');
  settled = true;
  const reads = Number(await note.getAttribute('data-reads'));
  await page.clock.runFor(2_000);
  await expect(note).toHaveAttribute('data-reads', String(reads + 1));
  await expect(note).toHaveText('✕ The task belongs to another repository.');
});

test('a resent cancel held by a push says the push is being checked', async ({ page }) => {
  await serve();
  const marker = { attemptId: '7d0c2f4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f', branch: 'codeboost/3-retries', from: 'a'.repeat(40),
    to: 'b'.repeat(40), snapshotId: 's1', startedAt: 1_760_000_000_000 };
  await viewWith(page, view => { view.startable = false; view.task.cancelRequested = 'cancelled'; view.task.pushInProgress = marker; });
  // The server's answer to that cancel (web/server.ts cancel-task with a push marker): `stopping`, and its runner view
  // with the marker still set while the branch is read again.
  await page.route('**/api/runner', async route => {
    if (route.request().method() !== 'POST') { await route.fallback(); return; }
    const view = await serverRunnerView(route);
    view.startable = false; view.task.cancelRequested = 'cancelled'; view.task.pushInProgress = marker;
    await route.fulfill({ status: 200, json: { result: { outcome: 'stopping' }, runner: view } });
  });
  await openReview(page, app.url);
  const cancel = page.locator('#cancel-task');
  await cancel.click(); await cancel.click();
  await expect(page.locator('#runner-note')).toHaveText("Cancelling: checking the outcome of the task's last push.");
});

test('a Publish press after a lost answer and a settled publish is a new action, and its outcome shows once', async ({ page }) => {
  await serve();
  const posts = runnerPosts(page);
  let settled = false, lost = true;
  const failed = { outcome: 'failed', draft: false, message: 'The task belongs to another repository.', stateVersion: 1, at: '2026-10-23T12:05:00.000Z' };
  // The publish offered; once the lost request's job has settled `failed`, it is offered again (a failure leaves the
  // publish owed, runner/publishing.ts) with the same task state version.
  await viewWith(page, view => {
    view.startable = false;
    view.publish = { ...view.publish, available: true, publishable: true, draft: false, last: settled ? failed
      : { outcome: 'not published', draft: false, message: 'This task reached its status before publishing existed.', stateVersion: 1, at: '2026-10-23T12:00:00.000Z' } };
  });
  await page.route('**/api/runner', async route => {
    if (route.request().method() !== 'POST' || !lost) { await route.fallback(); return; }
    lost = false; settled = true;
    await route.abort('failed');
  });
  await openReview(page, app.url);
  const publish = page.getByRole('button', { name: 'Publish PR', exact: true }), note = page.locator('#runner-note');
  await publish.click();
  // The lost answer's follow-up read shows the job settled.
  await expect(note).toContainText('✕ The task belongs to another repository.');
  await publish.click();
  await expect.poll(() => posts.length).toBe(2);
  expect(posts[1]!.actionId).not.toBe(posts[0]!.actionId);
  // The demo server refuses the new publish; the failure from the first job shows once.
  await expect(note).toHaveText('✕ The task belongs to another repository. ✕ Demos never publish pull requests.');
});

test('a replayed publish answer that carries the settled record names it once', async ({ page }) => {
  await serve();
  const failed = { outcome: 'failed', draft: false, message: 'The task belongs to another repository.', stateVersion: 1, at: '2026-10-23T12:05:00.000Z' };
  await viewWith(page, view => {
    view.startable = false;
    view.publish = { ...view.publish, available: true, publishable: true, draft: false,
      last: { outcome: 'not published', draft: false, message: 'This task reached its status before publishing existed.', stateVersion: 1, at: '2026-10-23T12:00:00.000Z' } };
  });
  // A replay of a publish whose job has settled: the server answers with the saved response, which recordPublish
  // replaced with the settled record (web/server.ts publish), and the view now names that record.
  await page.route('**/api/runner', async route => {
    if (route.request().method() !== 'POST') { await route.fallback(); return; }
    const view = await serverRunnerView(route);
    view.startable = false;
    view.publish = { ...view.publish, available: true, publishable: true, draft: false, last: failed };
    // The saved answer is the record without its stateVersion and at (runner/store.ts publishActionResponse).
    const { stateVersion: _version, at: _at, ...result } = failed;
    await route.fulfill({ status: 200, json: { result, runner: view } });
  });
  await openReview(page, app.url);
  await page.getByRole('button', { name: 'Publish PR', exact: true }).click();
  await expect(page.locator('#runner-note')).toHaveText('✕ The task belongs to another repository.');
});
