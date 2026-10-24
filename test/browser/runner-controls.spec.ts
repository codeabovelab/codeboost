import { test, expect, type Page, type Request, type Route } from '@playwright/test';
import { request as httpRequest } from 'node:http';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDemo } from '../../scripts/demo.ts';
import { startServer, type PlanningDeps } from '../../web/server.ts';
import type { AuthorProvider } from '../../core/planning-author.ts';
import type { Plan } from '../../core/plan.ts';
import type { ReviewService } from '../../runner/review.ts';
import type { RunnerDeps } from '../../runner/coordinator.ts';
import { SafetyFindings, type ExecutionSources } from '../../runner/execution.ts';
import { approveItem } from '../../core/approvals.ts';
import type { MergeGateway, MergeQueueGateway } from '../../github/merge.ts';
import type { IssueTrustGateway } from '../../github/issues.ts';
import { SETTLED_BEFORE_JOB_MERGE, type MergeJobView } from '../../runner/merge-job.ts';
import { fixtureGit } from '../fixtures/git.ts';
import { openReview, refreshReview } from './review-page.ts';

// Runner controls (#200) against a real server and runner. The runner's preparation always fails, so an admitted item
// ends `failed` without an agent (as in test/runner-start.test.ts): enough for start, resume, cancel and their guards.
type App = Awaited<ReturnType<typeof startServer>>;
let root: string, app: App;
const OWNER = 'd'.repeat(32);
// What the server stores in `task.cancelRequested`: the cancel's action ID (runner/store.ts cancelTask).
const CANCEL_ACTION = '3f2b6c1d-4e5a-4b7c-9d8e-0f1a2b3c4d5e';
async function approvePlan(service: ReviewService) {
  const view = await service.load();
  service.store.saveReview(service.config.identity, view.expected,
    view.items.map(item => approveItem(view.plan, view.segments, item.id, service.config.identity, item.count === 0)), []);
}
/** `prepare` decides when the item's preparation fails, so a test can hold an attempt in progress. */
async function serve(options: { approve?: boolean; prepare?: () => Promise<never>; mergeGateway?: MergeGateway | (MergeGateway & MergeQueueGateway);
  planning?: PlanningDeps; issueGateway?: IssueTrustGateway } = {}) {
  root = mkdtempSync(join(tmpdir(), 'codeboost-runner-ui-'));
  const demo = createDemo(join(root, 'demo'));
  // A merge needs a review that is not a demo, with the demo's out-of-scope change undone (as review.spec.ts does). An
  // issue gateway needs a github block naming the review's issue (as test/runner-start.test.ts gives it).
  const config = options.issueGateway ? { ...demo, demo: false, github: { repository: options.issueGateway.repository, issue: 3, pullRequest: 1 } }
    : options.mergeGateway ? { ...demo, demo: false } : demo;
  if (options.mergeGateway) { chmodSync(join(config.repository, 'run.sh'), 0o644); fixtureGit(config.repository, 'commit', '-am', 'Restore declared scope'); }
  app = await startServer(config, 0, undefined, options.mergeGateway, 2_000, options.issueGateway, undefined, options.planning, async service => {
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
  // Nothing is cut at this width, so neither the status nor the issue title carries a tooltip to be read twice.
  await expect(status(page)).not.toHaveAttribute('title');
  await expect(page.locator('#issue-title')).not.toHaveAttribute('title');
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
 * A request from the test to the server on a connection of its own. Neither `route.fetch` nor Node's `fetch` is safe
 * here: both keep connections alive in a pool, and a pooled connection can reach an earlier test's server on a reused
 * port, or be closed by the server between tests, and answer with ECONNRESET.
 */
/** What the test reads of a server answer. */
type ServerAnswer = { ok: boolean; status: number; json: () => Promise<any> };
function unpooled(url: string, options: { method?: string; body?: string; headers: Record<string, string> }): Promise<ServerAnswer> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: options.method ?? 'GET', headers: options.headers, agent: false }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => { const status = response.statusCode ?? 0, text = Buffer.concat(chunks).toString('utf8');
        resolve({ ok: status >= 200 && status < 300, status, json: async () => JSON.parse(text) }); });
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end(options.body);
  });
}
/** The real server's `GET /api/runner` answer for an intercepted read. */
async function serverRunnerView(route: Route): Promise<Record<string, any>> {
  const request = route.request(), response = await unpooled(request.url(), { headers: { 'x-codeboost-token': request.headers()['x-codeboost-token'] ?? '' } });
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
  // A running task whose current attempt failed. The server offers a retry only for a non-execute attempt, which this
  // runner never makes, so `retryable` is set here; every other field is the real view after P1 failed.
  let offerRetry = false;
  await viewWith(page, view => { if (offerRetry) { view.retryable = true; view.resumable = false; } });
  await openReview(page, app.url);
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect.poll(() => app.service.store.recentAttempts(app.service.config.identity, 1)[0]?.state).toBe('failed');
  offerRetry = true;
  await refreshReview(page);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect.poll(() => posts.length).toBe(2);
  expect(posts[1]).toMatchObject({ action: 'retry', attemptId: app.service.store.getTask(app.service.config.identity).currentAttemptId });
  // The real server refuses: a plan item runs again by resuming.
  await expect(page.locator('#runner-note')).toContainText('A plan item is run again by resuming the task');
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

test('the review strip keeps every control on one line at the 1280px minimum width', async ({ page }) => {
  await serve();
  await page.setViewportSize({ width: 1280, height: 800 });
  // The widest the strip gets: the longest status word and restart reason, Retry, the longest run action (Publish draft
  // PR, offered once neither Start nor Resume is) and Cancel task. Shapes only: the page reads the status, the marker's
  // reason, `startable`, `retryable` and the publish flags to choose what to show, nothing else from them here.
  await viewWith(page, view => { view.task.status = 'possibly already fixed'; view.startable = false; view.retryable = true;
    view.publish = { ...view.publish, available: true, publishable: true, draft: true };
    view.unresolved = { attemptId: '7d0c2f4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f', reason: 'preparation-not-removed' }; });
  await openReview(page, app.url);
  for (const id of ['task-status', 'attempt-retry', 'run-action', 'cancel-task']) await expect(page.locator(`#${id}`)).toBeVisible();
  await expect(page.locator('#run-action')).toHaveText('Publish draft PR');
  // The web font decides the widths: measure only once it has loaded. The issue title is made long enough to need cutting.
  await page.evaluate(async () => { await document.fonts.ready; document.getElementById('issue-title')!.textContent = '#3 Make retries predictable and document the behavior of every client of the retry policy in the service'; });
  await expect(page.locator('#task-status')).toHaveAttribute('title', "Possibly already fixed, Needs restart: an attempt's preparation files could not be removed");
  // This server has no merge gateway, so the merge controls a production task also shows are unhidden here with their
  // widest production labels (renderMergeControls), and Cancel task gets its armed label, for this layout check only.
  await page.evaluate(() => { for (const [id, text] of [['merge', 'Requesting merge…'], ['merge-details', 'Review blockers'], ['cancel-task', 'Confirm cancel']] as [string, string][]) { const button = document.getElementById(id)!; button.hidden = false; button.textContent = text; } });
  // No horizontal overflow; every visible child sits inside the strip's box and is one line tall (a button is 28 px, text
  // less), so a wrapped title or button fails here; and the plan revision is never cut.
  const boxes = await page.locator('#review-view .review-strip').evaluate(strip => {
    const rect = strip.getBoundingClientRect();
    const revision = document.getElementById('issue-revision')!, title = document.getElementById('issue-title')!;
    return { scroll: strip.scrollWidth, client: strip.clientWidth, top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right,
      revision: { text: revision.textContent, width: revision.getBoundingClientRect().width, scroll: revision.scrollWidth },
      title: { width: title.getBoundingClientRect().width, scroll: title.scrollWidth },
      children: [...strip.children].filter(child => !(child as HTMLElement).hidden).map(child => { const box = child.getBoundingClientRect();
        return { id: child.id || child.tagName, top: box.top, bottom: box.bottom, left: box.left, right: box.right }; }) };
  });
  expect(boxes.scroll).toBeLessThanOrEqual(boxes.client);
  for (const child of boxes.children) {
    expect(child.top, `${child.id} top`).toBeGreaterThanOrEqual(boxes.top);
    expect(child.bottom, `${child.id} bottom`).toBeLessThanOrEqual(boxes.bottom);
    expect(child.left, `${child.id} left`).toBeGreaterThanOrEqual(boxes.left);
    expect(child.right, `${child.id} right`).toBeLessThanOrEqual(boxes.right);
    expect(child.bottom - child.top, `${child.id} one line`).toBeLessThanOrEqual(28);
  }
  // The title gives way (cut, with an ellipsis) and the revision stays whole.
  expect(boxes.title.width).toBeLessThan(boxes.title.scroll);
  expect(boxes.revision.text).toBe('\u00a0· r1');
  expect(Math.round(boxes.revision.width)).toBeGreaterThanOrEqual(boxes.revision.scroll);
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
    view.task.cancelRequested = CANCEL_ACTION;
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
  await viewWith(page, view => { view.startable = false; view.unresolved = { attemptId: '7d0c2f4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f', reason: 'storage-not-removed' }; });
  await openReview(page, app.url);
  await expect(status(page)).toHaveText("○ In review · Needs restart: an attempt's task storage could not be removed");
  await expect(status(page)).toHaveClass('bad');
  // The reason is readable in the banner, not only in the status's tooltip.
  await expect(page.locator('#task-banner')).toBeVisible();
  await expect(page.locator('#task-banner-text')).toHaveText("! The runner needs a restart: an attempt's task storage could not be removed.");
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
    view.task.cancelRequested = CANCEL_ACTION;
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
  await viewWith(page, view => { view.startable = false; view.task.cancelRequested = CANCEL_ACTION;
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
    const response = await unpooled(route.request().url(), { headers: { 'x-codeboost-token': route.request().headers()['x-codeboost-token'] ?? '' } });
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
  // The reload keeps the note and re-renders it as it is; count its child mutations, which a rewrite would add to.
  await page.evaluate(() => { const counts = { note: 0 }; (window as unknown as { __rewrites: { note: number } }).__rewrites = counts;
    new MutationObserver(records => { counts.note += records.length; }).observe(document.getElementById('runner-note')!, { childList: true, characterData: true, subtree: true }); });
  releaseReview();
  // The reload applies (and reads the runner again); the note it could not have shown stays, and is not rewritten.
  await expect(note).toHaveAttribute('data-reads', String(reads + 1));
  await expect(note).toHaveText(ended);
  expect(await page.evaluate(() => (window as unknown as { __rewrites: { note: number } }).__rewrites.note)).toBe(0);
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
  await viewWith(page, view => { view.startable = false; view.task.cancelRequested = CANCEL_ACTION; view.task.pushInProgress = marker; });
  // The server's answer to that cancel (web/server.ts cancel-task with a push marker): `stopping`, and its runner view
  // with the marker still set while the branch is read again. Left out: the bumped `stateVersion` the real cancel
  // writes (runner/store.ts cancelTask), which only a later action would read, and none is sent here.
  await page.route('**/api/runner', async route => {
    if (route.request().method() !== 'POST') { await route.fallback(); return; }
    const view = await serverRunnerView(route);
    view.startable = false; view.task.cancelRequested = CANCEL_ACTION; view.task.pushInProgress = marker;
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

test('offers Close pull requests for a cancelled task whose close is owed, and sends it', async ({ page }) => {
  await serve();
  const posts = runnerPosts(page);
  // A cancelled task whose pull requests did not close (runner/publishing.ts mode() answers `close`).
  await viewWith(page, view => { view.startable = false; view.task.status = 'cancelled';
    view.publish = { ...view.publish, available: true, closable: true,
      last: { outcome: 'failed', draft: false, action: 'close', message: 'GitHub refused to close pull request #7.', stateVersion: 1, at: '2026-10-23T12:05:00.000Z' } }; });
  await openReview(page, app.url);
  await expect(status(page)).toHaveText('– Cancelled');
  await page.getByRole('button', { name: 'Close pull requests', exact: true }).click();
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]).toMatchObject({ action: 'close-pull-requests' });
  expect(posts[0]).not.toHaveProperty('expectedReviewVersion');
  // This demo server has no publisher, so it refuses.
  await expect(page.locator('#runner-note')).toHaveText('✕ Demos never publish pull requests.');
});

test('adds a spent time budget to the needs-human banner after the failure it names', async ({ page }) => {
  await serve();
  let needsHuman = false;
  // After P1 failed, a spent budget moved the idle task to needs human without a new attempt (runner/store.ts
  // startAttempt): the current attempt is still P1's failed one.
  await viewWith(page, view => { if (needsHuman) { view.task.status = 'needs human'; view.task.budgetDeadline = Date.now() - 1_000; view.resumable = false; } });
  await openReview(page, app.url);
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect.poll(() => app.service.store.recentAttempts(app.service.config.identity, 1)[0]?.state).toBe('failed');
  needsHuman = true;
  await refreshReview(page);
  // The attempt's own reason is not the budget, so its failure is named, and the spent budget is added.
  const diagnostic = app.service.store.recentAttempts(app.service.config.identity, 1)[0]!.diagnostic!;
  await expect(page.locator('#task-banner-text')).toHaveText(`! This task needs a person. ${diagnostic.slice(0, 300)} Its time budget has also run out.`);
});

test('names a failed attempt\'s diagnostic in the needs-human banner', async ({ page }) => {
  await serve();
  let needsHuman = false;
  await viewWith(page, view => { if (needsHuman) { view.task.status = 'needs human'; view.resumable = false; } });
  await openReview(page, app.url);
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect.poll(() => app.service.store.recentAttempts(app.service.config.identity, 1)[0]?.state).toBe('failed');
  const diagnostic = app.service.store.recentAttempts(app.service.config.identity, 1)[0]!.diagnostic;
  expect(diagnostic).toBeTruthy();
  needsHuman = true;
  await refreshReview(page);
  await expect(page.locator('#task-banner-text')).toHaveText(`! This task needs a person. ${diagnostic!.slice(0, 300)}`);
});

test('shows the needs-approval banner and an approved continuation\'s text', async ({ page }) => {
  await serve();
  let state: 'needs approval' | 'approved' = 'needs approval';
  await viewWith(page, view => {
    view.startable = false;
    if (state === 'needs approval') view.task.status = 'needs approval';
    else { view.task.status = 'needs amendment';
      view.continuation = { checkpointId: 'c1', item: 'P2', completedItems: ['P1'], outOfScopePaths: ['src/config.ts'], next: 'P2', approved: true }; }
  });
  await openReview(page, app.url);
  await expect(page.locator('#task-banner-text')).toHaveText('! This task needs your approval before it continues.');
  state = 'approved';
  await refreshReview(page);
  await expect(page.locator('#task-banner-text')).toHaveText('! P2 changed files the plan did not declare: src/config.ts. The continuation is approved; resume the task.');
  await expect(page.locator('#task-banner-approve')).toBeHidden();
});

test('shows a stop whose reason is not saved yet', async ({ page }) => {
  let fail!: () => void;
  await serve({ prepare: () => new Promise<never>((_, reject) => { fail = () => reject(new Error('no agent here')); }) });
  let stopping = false;
  // The coordinator's status while the stop's reason write has not succeeded (runner/coordinator.ts status()).
  await viewWith(page, view => { if (stopping) view.stopRequested = { attemptId: view.task.currentAttemptId, reason: 'cancelled', saved: false }; });
  await openReview(page, app.url);
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop P1', exact: true })).toBeVisible();
  stopping = true;
  await refreshReview(page);
  await expect(status(page)).toHaveText('● Running · Stopping (not saved yet)');
  await expect(page.locator('#attempt-stop')).toBeHidden();
  fail();
});

test('names a publish message as the needs-human cause while the budget is unspent, and names a time-limit stop as the budget', async ({ page }) => {
  await serve();
  let state: 'publish' | 'time-limit' = 'publish';
  await viewWith(page, view => {
    view.startable = false; view.task.status = 'needs human'; view.task.budgetDeadline = Date.now() + 3_600_000;
    view.publish = { ...view.publish, last: { outcome: 'opened', draft: true, message: 'Pull request #7 is open as a draft; the task is needs human.', stateVersion: 1, at: '2026-10-23T12:00:00.000Z', number: 7 } };
    // A stopped attempt whose first reason is the time limit (runner/lifecycle.ts FIRST_REASONS); the page reads only
    // these fields of it.
    // A time-limit stop happens only at or after the deadline, which is never moved later (runner/store.ts).
    if (state === 'time-limit') { view.task.budgetDeadline = Date.now() - 1_000; view.task.currentAttemptId = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
      view.attempts = [{ id: view.task.currentAttemptId, kind: 'execute', item: 'P1', state: 'cancelled', firstReason: 'time-limit', diagnostic: null }]; }
  });
  await openReview(page, app.url);
  await expect(page.locator('#task-banner-text')).toHaveText('! This task needs a person. Pull request #7 is open as a draft; the task is needs human.');
  state = 'time-limit';
  await refreshReview(page);
  await expect(page.locator('#task-banner-text')).toHaveText("! This task needs a person. The task's time budget ran out.");
});

test('offers Cancel task during a merge submission and shows the server\'s refusal', async ({ page }) => {
  await serve();
  // A real merge attempt being submitted (as review.spec.ts makes one): the server refuses a cancel while it lasts.
  const view = await app.service.load();
  app.service.store.beginMergeAttempt(app.service.config.identity, { ...view.expected, reviewVersion: view.expected.reviewVersion! }, view.snapshot.head, null, 'direct');
  await openReview(page, app.url);
  const cancel = page.locator('#cancel-task');
  await expect(cancel).toBeVisible();
  await cancel.click(); await cancel.click();
  await expect(page.locator('#runner-note')).toContainText('✕ A merge is in progress. Cancel the task after it finishes or fails.');
  expect(app.service.store.getTask(app.service.config.identity).status).not.toBe('cancelled');
});

test('reads the runner state again after a merge, so the header shows the task merged', async ({ page }) => {
  // GitHub as review.spec.ts's direct-merge tests answer it: an open, mergeable PR with an atomic base guard.
  const gateway: MergeGateway = {
    inspect: async () => { const snapshot = (await app.service.load()).snapshot; return { base: snapshot.base, head: snapshot.head, pullRequestState: 'OPEN',
      mergeable: 'MERGEABLE', rulesKnown: true, atomicBaseGuard: true, mergeQueue: false, requiredChecks: [], alreadyFixed: 'clear', pullRequest: 7, draft: false }; },
    merge: async () => ({ url: 'https://github.com/example/repo/pull/7' }),
  };
  await serve({ mergeGateway: gateway });
  let view = await app.service.load();
  for (const segment of view.segments.filter(value => value.row === 'Unplanned' || value.row === 'Ambiguous')) view = await app.service.act({ action: 'accept', key: segment.key, token: view.token });
  for (const item of view.items) if (item.state !== 'approved') view = await app.service.act({ action: 'approve', item: item.id, confirmNoChange: item.count === 0, token: view.token });
  await openReview(page, app.url);
  await expect(status(page)).toHaveText('○ In review');
  await expect(page.locator('#cancel-task')).toBeVisible();
  page.on('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Merge PR', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Merged', exact: true })).toBeVisible();
  // Without a Refresh, the header follows the task to merged and offers no Cancel task.
  await expect(status(page)).toHaveText('✓ Merged');
  await expect(page.locator('#cancel-task')).toBeHidden();
  expect(app.service.store.getTask(app.service.config.identity).status).toBe('merged');
});

/** Accepts every Unplanned and Ambiguous segment and approves every item, so Merge PR is offered (as review.spec.ts does). */
async function readyToMerge() {
  let view = await app.service.load();
  for (const segment of view.segments.filter(value => value.row === 'Unplanned' || value.row === 'Ambiguous')) view = await app.service.act({ action: 'accept', key: segment.key, token: view.token });
  for (const item of view.items) if (item.state !== 'approved') view = await app.service.act({ action: 'approve', item: item.id, confirmNoChange: item.count === 0, token: view.token });
}

test('reads the runner state again when a merge queue poll sees the merge land', async ({ page }) => {
  let phase: 'queued' | 'merged' = 'queued';
  // GitHub as review.spec.ts's merge-queue tests answer it.
  const gateway: MergeGateway & MergeQueueGateway = {
    inspect: async () => { const snapshot = (await app.service.load()).snapshot; return { base: snapshot.base, head: snapshot.head, pullRequestState: 'OPEN',
      mergeable: 'MERGEABLE', rulesKnown: true, atomicBaseGuard: true, mergeQueue: true, requiredChecks: [], alreadyFixed: 'clear', pullRequest: 7, draft: false }; },
    queueWatermark: async () => null,
    merge: async () => ({ url: 'https://github.com/example/repo/pull/7' }),
    inspectQueue: async head => phase === 'queued'
      ? { state: 'queued', reviewedHead: head, entryId: 'MQE_1', phase: 'AWAITING_CHECKS', position: 2, enqueuedAt: '2026-09-24T08:00:00Z', queueHead: head }
      : { state: 'merged', reviewedHead: head, mergedAt: '2026-09-24T08:10:00Z' },
  };
  await serve({ mergeGateway: gateway });
  await readyToMerge();
  await openReview(page, app.url);
  page.on('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Merge PR', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Merge queued', exact: true })).toBeVisible();
  await expect(status(page)).toHaveText('○ In review');
  // The queue poll sees the merge land; without a Refresh the header follows the task to merged.
  phase = 'merged';
  await expect(page.getByRole('button', { name: 'Merged', exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(status(page)).toHaveText('✓ Merged');
  await expect(page.locator('#cancel-task')).toBeHidden();
});

test('reads the runner state again when a polled merge job ends', async ({ page }) => {
  const gateway: MergeGateway = {
    inspect: async () => { const snapshot = (await app.service.load()).snapshot; return { base: snapshot.base, head: snapshot.head, pullRequestState: 'OPEN',
      mergeable: 'MERGEABLE', rulesKnown: true, atomicBaseGuard: true, mergeQueue: false, requiredChecks: [], alreadyFixed: 'clear', pullRequest: 7, draft: false }; },
    merge: async () => { throw new Error('This test answers every merge request itself.'); },
  };
  await serve({ mergeGateway: gateway });
  await readyToMerge();
  // A merge job record as runner/merge-job.ts mergeJobView sends it, without `steps` and `cancelRequested`: the page draws
  // the step list from `steps` and the poll reads `cancelRequested`, and neither matters to the runner read this test
  // checks. This harness has no merge jobs (they need pre-merge preparation), so the click's answer and the job poll are
  // served here in the server's shapes ({...review, job} and {queue, job}); the click's `merge` is the review's, with
  // `job` and no job-mapped blockers (it has none).
  const job = (state: MergeJobView['state'], step: MergeJobView['step'], revision: number, reason: string | null = null): MergeJobView => ({
    id: '0f6b0000-0000-4000-8000-0000000000f1', mergeActionId: null, reason, checks: [], url: null, sequence: 1, revision,
    startedAt: '2026-10-11T00:00:00Z', updatedAt: '2026-10-11T00:00:00Z', state, step });
  const running = job('running', 'preparing', 1), blocked = job('blocked', null, 5, 'Required check failed: ci. Fix it, then Retry merge.');
  let ended = false;
  await page.route('**/api/action', async route => {
    const body = route.request().postDataJSON();
    if (body.action !== 'merge') { await route.continue(); return; }
    const reviewResponse = await unpooled(route.request().url().replace('/api/action', '/api/review'), { headers: { 'x-codeboost-token': route.request().headers()['x-codeboost-token'] ?? '' } });
    const review = await reviewResponse.json() as Record<string, any>;
    await route.fulfill({ status: 200, json: { ...review, merge: { ...review.merge, ready: false, action: null, job: running, settledBeforeJobMerge: SETTLED_BEFORE_JOB_MERGE }, job: running } });
  });
  await page.route('**/api/merge', async route => { await route.fulfill({ status: 200, json: { queue: null, job: ended ? blocked : running } }); });
  await openReview(page, app.url);
  page.on('dialog', dialog => dialog.accept());
  const note = page.locator('#runner-note');
  const before = Number(await note.getAttribute('data-reads'));
  await page.getByRole('button', { name: 'Merge PR', exact: true }).click();
  await expect(page.locator('#banner')).toContainText('Preparing');
  // The click reads the runner once it settles; wait for that read, so the one counted below can only follow the job's end.
  await expect.poll(async () => Number(await note.getAttribute('data-reads'))).toBe(before + 1);
  // The job ends; the poll that sees it is followed by a runner read.
  const reads = Number(await note.getAttribute('data-reads'));
  ended = true;
  await expect(page.locator('#merge')).toHaveText(/blocked/i, { timeout: 15_000 });
  await expect.poll(async () => Number(await note.getAttribute('data-reads'))).toBeGreaterThan(reads);
});

test('reads the runner state after a merge whose review reload failed', async ({ page }) => {
  const gateway: MergeGateway = {
    inspect: async () => { const snapshot = (await app.service.load()).snapshot; return { base: snapshot.base, head: snapshot.head, pullRequestState: 'OPEN',
      mergeable: 'MERGEABLE', rulesKnown: true, atomicBaseGuard: true, mergeQueue: false, requiredChecks: [], alreadyFixed: 'clear', pullRequest: 7, draft: false }; },
    merge: async () => ({ url: 'https://github.com/example/repo/pull/7' }),
  };
  await serve({ mergeGateway: gateway });
  await readyToMerge();
  // The real server merges; its answer is replaced by the one it sends when its review reload fails after the merge
  // (web/server.ts: mergeResult, mergeQueue null for a direct merge, mergeRefreshRequired).
  await page.route('**/api/action', async route => {
    const request = route.request(), body = request.postDataJSON();
    if (body.action !== 'merge') { await route.continue(); return; }
    const response = await unpooled(request.url(), { method: 'POST', body: request.postData() ?? '', headers: { 'content-type': 'application/json', 'x-codeboost-token': request.headers()['x-codeboost-token'] ?? '' } });
    const answer = await response.json() as Record<string, any>;
    if (!response.ok) throw new Error(`The merge answered ${response.status}: ${JSON.stringify(answer)}`);
    await route.fulfill({ status: 200, json: { mergeResult: answer.mergeResult, mergeQueue: null, mergeRefreshRequired: true } });
  });
  await openReview(page, app.url);
  page.on('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Merge PR', exact: true }).click();
  await expect(page.locator('#banner')).toContainText('Merge submitted.');
  // The merge state on screen did not change (no attempt before, none in the answer), yet the header follows the task.
  await expect(status(page)).toHaveText('✓ Merged');
  await expect(page.locator('#cancel-task')).toBeHidden();
});

test('a Refresh that shows a changed merge state reads the runner once', async ({ page }) => {
  // A merge gateway, so the review carries the merge status (without one it has none, and nothing changes).
  await serve({ mergeGateway: {
    inspect: async () => { const snapshot = (await app.service.load()).snapshot; return { base: snapshot.base, head: snapshot.head, pullRequestState: 'OPEN',
      mergeable: 'MERGEABLE', rulesKnown: true, atomicBaseGuard: true, mergeQueue: false, requiredChecks: [], alreadyFixed: 'clear', pullRequest: 7, draft: false }; },
    merge: async () => ({ url: 'https://github.com/example/repo/pull/7' }) } });
  let gets = 0;
  page.on('request', request => { if (request.method() === 'GET' && new URL(request.url()).pathname === '/api/runner') gets++; });
  await openReview(page, app.url);
  await expect(status(page)).toHaveText('○ In review');
  // Another tab starts a merge: the next review load shows a merge attempt the page has not seen.
  const view = await app.service.load();
  app.service.store.beginMergeAttempt(app.service.config.identity, { ...view.expected, reviewVersion: view.expected.reviewVersion! }, view.snapshot.head, null, 'direct');
  const before = gets;
  await refreshReview(page);
  await expect.poll(() => gets).toBe(before + 1);
  // No second read follows: the task is in review with nothing running, so nothing polls; this waits 3 s, past the
  // 2 s first poll delay.
  await page.waitForTimeout(3_000);
  expect(gets).toBe(before + 1);
});

test('reads the runner state after a plan import, so Start goes when the new revision is unapproved', async ({ page }) => {
  await serve();
  await openReview(page, app.url);
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeVisible();
  // The next revision of the current plan with a new summary: its items need approval again before they run.
  const plan = (await app.service.load()).plan;
  const next = { ...plan, revision: plan.revision + 1, summary: `${plan.summary} (revised)` };
  await page.getByRole('link', { name: 'Plans', exact: true }).click();
  await page.getByLabel('Plan file').setInputFiles({ name: 'plan.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(next)) });
  await page.getByRole('button', { name: 'Import next revision' }).click();
  await expect(page.getByRole('status').filter({ hasText: `Revision r${next.revision} is current.` })).toBeVisible();
  expect((await (await unpooled(`${new URL(app.url).origin}/api/runner`, { headers: { 'x-codeboost-token': app.token } })).json() as { startable: boolean }).startable).toBe(false);
  await page.locator('#review-link').click();
  await expect(page.locator('#run-action')).toBeHidden();
});

test('reads the runner state after a draft is applied, so Start goes when the new revision is unapproved', async ({ page }) => {
  // A planning provider that answers with the next draft when the test says so (as plans-authoring.spec.ts's does).
  let answer!: (source: string) => void;
  const provider: AuthorProvider = { invoke: () => new Promise(resolve => { answer = resolve; }) };
  await serve({ planning: { provider, describe: () => ({ repo: { name: 'retry-service', baseRef: 'main' },
    issue: { number: 3, title: 'Retries', body: '', comments: [] }, approvedLessons: [], validate: () => undefined }) } });
  await openReview(page, app.url);
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Plans', exact: true }).click();
  const current: Plan = app.service.store.getPlan(app.service.config.identity);
  await page.getByRole('button', { name: 'Draft next revision' }).click();
  await expect.poll(() => typeof answer).toBe('function');
  answer(JSON.stringify({ ...structuredClone(current), revision: current.revision + 1,
    items: current.items.map((item, index) => index === 0 ? { ...item, title: 'Expose the bounded retry ceiling' } : item) }));
  await page.getByRole('button', { name: 'Apply draft', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: `Revision r${current.revision + 1} is current.` })).toBeVisible();
  await page.locator('#review-link').click();
  await expect(page.locator('#run-action')).toBeHidden();
});

/**
 * GitHub as the issue board reads it: issue #3 by an author outside the repository, so it needs a person's trust before it
 * can run (github/issues.ts RepositoryIssue, IssueAccess). Left out, as nothing here reads them: `fetch` ignores `signal`
 * and `timeoutMs` (the real gateway aborts on them), `issueAccess` and `issueText` answer for any number, and `issueText`
 * is never called (no runner action is sent).
 */
const outsideAuthorGateway: IssueTrustGateway = {
  repository: 'owner/repo',
  async fetch() { return { repository: 'owner/repo', retrievedAt: new Date().toISOString(), issues: [{ repository: 'owner/repo', number: 3, title: 'Make retries predictable',
    body: '', url: 'https://github.com/owner/repo/issues/3', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', comments: 0, positiveReactions: 0,
    labels: [], authorLogin: 'outside', authorAssociation: 'NONE', trust: 'requires-approval' }] }; },
  async issueAccess(number) { return { number, authorLogin: 'outside', collaborator: false }; },
  async issueText(number) { return { number, title: 'Make retries predictable', body: '', comments: [] }; },
};

test('reads the runner state when the issue board loads and when the issue\'s trust changes', async ({ page }) => {
  await serve({ issueGateway: outsideAuthorGateway });
  await openReview(page, app.url);
  // Until the board has loaded, the server does not know the issue is untrusted, and offers Start.
  const start = page.getByRole('button', { name: 'Start', exact: true });
  await expect(start).toBeVisible();
  await page.getByRole('link', { name: 'Issues', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Trust this issue', exact: true })).toBeVisible();
  // The board loaded: the issue is untrusted, so the runner no longer offers Start, which the header shows without Refresh.
  await page.locator('#review-link').click();
  await expect(page.locator('#run-action')).toBeHidden();
  // Trusting the issue offers it again.
  await page.getByRole('link', { name: 'Issues', exact: true }).click();
  await page.getByRole('button', { name: 'Trust this issue', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Remove trust', exact: true })).toBeVisible();
  await page.locator('#review-link').click();
  await expect(start).toBeVisible();
});

/** The next revision of the current plan, which needs approval again before its items run. */
async function nextRevision() {
  const plan = (await app.service.load()).plan;
  return { ...plan, revision: plan.revision + 1, summary: `${plan.summary} (revised)` };
}
/** Imports `next` through the Plans screen, with `answer` deciding what the page sees of the import's answer. */
async function importThrough(page: Page, next: Record<string, unknown>, answer: (route: Route, response: ServerAnswer) => Promise<void>) {
  await page.getByRole('link', { name: 'Plans', exact: true }).click();
  await page.getByLabel('Plan file').setInputFiles({ name: 'plan.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(next)) });
  let once = true;
  await page.route('**/api/plan/import', async route => {
    if (!once) { await route.continue(); return; }
    once = false;
    // The real server saves the revision; only the page's view of the answer is changed.
    const request = route.request();
    const response = await unpooled(request.url(), { method: 'POST', body: request.postData() ?? '', headers: { 'content-type': 'application/json', 'x-codeboost-token': request.headers()['x-codeboost-token'] ?? '' } });
    await answer(route, response);
  });
  await page.getByRole('button', { name: 'Import next revision' }).click();
}

test('reads the runner state after an import whose answer was lost, since the revision may have been saved', async ({ page }) => {
  await serve();
  await openReview(page, app.url);
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeVisible();
  const next = await nextRevision();
  await importThrough(page, next, async route => { await route.abort('failed'); });
  await expect(page.getByRole('status').filter({ hasText: 'Could not import the plan.' })).toBeVisible();
  expect(app.service.store.getPlan(app.service.config.identity).revision).toBe(next.revision);
  await page.locator('#review-link').click();
  await expect(page.locator('#run-action')).toBeHidden();
});

test('reads the runner state after an import whose review reload failed', async ({ page }) => {
  await serve();
  await openReview(page, app.url);
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeVisible();
  const next = await nextRevision();
  let failReload = false;
  await page.route('**/api/review', async route => {
    if (!failReload) { await route.continue(); return; }
    failReload = false;
    await route.fulfill({ status: 500, json: { error: 'History failed.' } });
  });
  await importThrough(page, next, async (route, response) => { failReload = true; await route.fulfill({ status: response.status, json: await response.json() }); });
  await expect(page.locator('#plans-status')).toContainText('but the current plan could not reload.');
  await page.locator('#review-link').click();
  await expect(page.locator('#run-action')).toBeHidden();
});

/** Drafts and applies the next revision through the Plans screen, with `answer` deciding what the page sees of Apply's answer. */
async function applyThrough(page: Page, answer: (route: Route, response: ServerAnswer) => Promise<void>) {
  let reply!: (source: string) => void;
  const provider: AuthorProvider = { invoke: () => new Promise(resolve => { reply = resolve; }) };
  await serve({ planning: { provider, describe: () => ({ repo: { name: 'retry-service', baseRef: 'main' },
    issue: { number: 3, title: 'Retries', body: '', comments: [] }, approvedLessons: [], validate: () => undefined }) } });
  await openReview(page, app.url);
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Plans', exact: true }).click();
  const current: Plan = app.service.store.getPlan(app.service.config.identity);
  await page.getByRole('button', { name: 'Draft next revision' }).click();
  await expect.poll(() => typeof reply).toBe('function');
  reply(JSON.stringify({ ...structuredClone(current), revision: current.revision + 1,
    items: current.items.map((item, index) => index === 0 ? { ...item, title: 'Expose the bounded retry ceiling' } : item) }));
  await page.route('**/api/plan/drafts/*/apply', async route => {
    const request = route.request();
    const response = await unpooled(request.url(), { method: 'POST', body: request.postData() ?? '', headers: { 'content-type': 'application/json', 'x-codeboost-token': request.headers()['x-codeboost-token'] ?? '' } });
    await answer(route, response);
  });
  await page.getByRole('button', { name: 'Apply draft', exact: true }).click();
  return current.revision + 1;
}

test('reads the runner state after an Apply whose answer was lost, since the revision may have been saved', async ({ page }) => {
  const revision = await applyThrough(page, async route => { await route.abort('failed'); });
  await expect(page.getByRole('status').filter({ hasText: 'Could not confirm Apply.' })).toBeVisible();
  expect(app.service.store.getPlan(app.service.config.identity).revision).toBe(revision);
  await page.locator('#review-link').click();
  await expect(page.locator('#run-action')).toBeHidden();
});

test('reads the runner state after an Apply whose review reload failed', async ({ page }) => {
  let failReload = false;
  await page.route('**/api/review', async route => {
    if (!failReload) { await route.continue(); return; }
    failReload = false;
    await route.fulfill({ status: 500, json: { error: 'History failed.' } });
  });
  await applyThrough(page, async (route, response) => { failReload = true; await route.fulfill({ status: response.status, json: await response.json() }); });
  await expect(page.locator('#plans-status')).toContainText('but the current plan could not reload.');
  await page.locator('#review-link').click();
  await expect(page.locator('#run-action')).toBeHidden();
});

test('a review action\'s answer clears the note about ended work, as Refresh does', async ({ page }) => {
  await serve();
  await openReview(page, app.url);
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  const note = page.locator('#runner-note');
  await expect(note).toContainText('P1 failed.');
  // A change request is a review action; its answer is the review reloaded (web/server.ts), which now shows P1's changes.
  await page.getByRole('button', { name: 'Request change', exact: true }).click();
  await page.getByLabel('Change to request').fill('Add a test for the upper bound.');
  await page.getByRole('button', { name: 'Save change request' }).click();
  await expect(page.getByText('Add a test for the upper bound.')).toBeVisible();
  await expect(note).not.toContainText('P1 failed.');
});

test('reads the runner state after a board refresh whose answer was lost, since the server\'s refresh went on', async ({ page }) => {
  await serve({ issueGateway: outsideAuthorGateway });
  let gets = 0;
  page.on('request', request => { if (request.method() === 'GET' && new URL(request.url()).pathname === '/api/runner') gets++; });
  // The board's refresh reaches the server and completes (the route runs it), and the page loses the answer.
  let lost = false;
  await page.route('**/api/issues', async route => {
    if (route.request().method() !== 'POST' || lost) { await route.continue(); return; }
    lost = true;
    const request = route.request();
    await unpooled(request.url(), { method: 'POST', body: request.postData() ?? '', headers: { 'content-type': 'application/json', 'x-codeboost-token': request.headers()['x-codeboost-token'] ?? '' } });
    await route.abort('failed');
  });
  await openReview(page, app.url);
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeVisible();
  const before = gets;
  await page.getByRole('link', { name: 'Issues', exact: true }).click();
  await expect(page.locator('#issues-status')).toContainText('Could not refresh issues.');
  // One read followed the failed load; the board the server has says the issue is untrusted, so Start goes.
  await expect.poll(() => gets).toBe(before + 1);
  await page.locator('#review-link').click();
  await expect(page.locator('#run-action')).toBeHidden();
});

test('a cancel held by an interrupted rebase needs a restart: no Cancel task, no polling', async ({ page }) => {
  await serve();
  let gets = 0;
  page.on('request', request => { if (request.method() === 'GET' && new URL(request.url()).pathname === '/api/runner') gets++; });
  // After a restart, a cancel requested during a pre-merge preparation that died mid-rebase: the task keeps the cancel and
  // its rebase marker (runner/store.ts RebaseMarker, as the pre-merge path saves one before Git moves) while no
  // preparation runs it; the server refuses another cancel until recovery settles it.
  await viewWith(page, view => {
    view.startable = false; view.task.cancelRequested = CANCEL_ACTION;
    view.task.rebaseInProgress = { attemptId: '7d0c2f4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f', oldBase: 'a'.repeat(40), oldHead: 'b'.repeat(40), onto: 'c'.repeat(40),
      oldHistory: null, startedAt: 1_760_000_000_000, resultState: 'none', resultHead: null, resultMappings: null, resolvedConflicts: [], conflict: null, processGroup: null };
  });
  await page.clock.install();
  await openReview(page, app.url);
  await expect(status(page)).toHaveText('○ In review · Needs restart: an interrupted rebase waits for recovery');
  await expect(page.locator('#cancel-task')).toBeHidden();
  // Nothing is sent in 60 s, past the 30 s backoff cap.
  const sent = gets;
  await page.clock.runFor(60_000);
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
  expect(gets).toBe(sent);
});

test('a rebase marker with its preparation running is work in progress, not a restart', async ({ page }) => {
  await serve();
  // During a pre-merge preparation the marker and the active flag are set together (runner/pre-merge.ts).
  await viewWith(page, view => {
    view.startable = false; view.preMerge = { ...view.preMerge, available: true, active: true };
    view.task.rebaseInProgress = { attemptId: '7d0c2f4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f', oldBase: 'a'.repeat(40), oldHead: 'b'.repeat(40), onto: 'c'.repeat(40),
      oldHistory: null, startedAt: 1_760_000_000_000, resultState: 'none', resultHead: null, resultMappings: null, resolvedConflicts: [], conflict: null, processGroup: null };
  });
  await openReview(page, app.url);
  await expect(status(page)).toHaveText('○ In review');
  await expect(page.locator('#cancel-task')).toBeVisible();
});

/** A rebase marker as runner/store.ts RebaseMarker shapes it, for a preparation that died before Git moved. */
const deadRebaseMarker = { attemptId: '7d0c2f4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f', oldBase: 'a'.repeat(40), oldHead: 'b'.repeat(40), onto: 'c'.repeat(40),
  oldHistory: null, startedAt: 1_760_000_000_000, resultState: 'none', resultHead: null, resultMappings: null, resolvedConflicts: [], conflict: null, processGroup: null };

test('a first cancel on a task that needs a restart says the task closes at the restart', async ({ page }) => {
  await serve();
  // No cancel yet, so Cancel task is offered; the server admits the first cancel and answers `stopping` with the marker
  // still set (runner/store.ts cancelTask; web/server.ts cancel-task), and nothing can run until the restart. Left out:
  // the bumped `stateVersion` the real cancel writes, which only a later action would read, and none is sent here.
  await viewWith(page, view => { view.startable = false; view.task.rebaseInProgress = deadRebaseMarker; });
  await page.route('**/api/runner', async route => {
    if (route.request().method() !== 'POST') { await route.fallback(); return; }
    const view = await serverRunnerView(route);
    view.startable = false; view.task.rebaseInProgress = deadRebaseMarker; view.task.cancelRequested = CANCEL_ACTION;
    await route.fulfill({ status: 200, json: { result: { outcome: 'stopping' }, runner: view } });
  });
  await openReview(page, app.url);
  await expect(status(page)).toHaveText('○ In review · Needs restart: an interrupted rebase waits for recovery');
  const cancel = page.locator('#cancel-task');
  await cancel.click(); await cancel.click();
  await expect(page.locator('#runner-note')).toHaveText('Cancelling: the task closes when the runner restarts and recovers.');
  await expect(cancel).toBeHidden();
});

test('names a pre-merge command check\'s Stop as stopping the checks', async ({ page }) => {
  let fail!: () => void;
  await serve({ prepare: () => new Promise<never>((_, reject) => { fail = () => reject(new Error('no agent here')); }) });
  // The real live attempt, read as a pre-merge command check (kind `check`, runner/store.ts startAttempt): the page
  // reads only its kind, item, state and id.
  let asCheck = false;
  await viewWith(page, view => { if (asCheck) for (const attempt of view.attempts) if (attempt.id === view.task.currentAttemptId) attempt.kind = 'check'; });
  await openReview(page, app.url);
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop P1', exact: true })).toBeVisible();
  asCheck = true;
  await refreshReview(page);
  await expect(page.getByRole('button', { name: 'Stop P1 checks', exact: true })).toBeVisible();
  fail();
});

test('a cancel under a marker whose attempt row has settled closes the task at once', async ({ page }) => {
  await serve();
  // Task storage that could not be removed after a saved terminal write (runner-lifecycle.md): the row has settled, so
  // the real server's cancel closes the task at once. The marker is this fake's (the coordinator keeps a real one in
  // memory until a restart), so the cancel's answer, forwarded to the real server, gets it added too.
  const unresolved = { attemptId: '7d0c2f4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f', reason: 'storage-not-removed' };
  await viewWith(page, view => { view.startable = false; view.unresolved = unresolved; });
  await page.route('**/api/runner', async route => {
    if (route.request().method() !== 'POST') { await route.fallback(); return; }
    const request = route.request();
    const response = await unpooled(request.url(), { method: 'POST', body: request.postData() ?? '', headers: { 'content-type': 'application/json', 'x-codeboost-token': request.headers()['x-codeboost-token'] ?? '' } });
    const answer = await response.json() as Record<string, any>;
    if (response.ok) answer.runner.unresolved = unresolved;
    await route.fulfill({ status: response.status, json: answer });
  });
  await openReview(page, app.url);
  await expect(status(page)).toHaveText("○ In review · Needs restart: an attempt's task storage could not be removed");
  const cancel = page.locator('#cancel-task');
  await cancel.click(); await cancel.click();
  await expect(page.locator('#runner-note')).toHaveText('✓ Task cancelled.');
  await expect(status(page)).toHaveText("– Cancelled · Needs restart: an attempt's task storage could not be removed");
  expect(app.service.store.getTask(app.service.config.identity).status).toBe('cancelled');
});

test('a restart the runner needs comes before the waiting state in the banner', async ({ page }) => {
  await serve();
  await viewWith(page, view => {
    view.startable = false; view.task.status = 'needs amendment';
    view.continuation = { checkpointId: 'c1', item: 'P2', completedItems: ['P1'], outOfScopePaths: ['src/config.ts'], next: null, approved: false,
      reason: 'The current plan does not declare src/config.ts for P2.' };
    view.unresolved = { attemptId: '7d0c2f4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f', reason: 'result-not-saved' };
  });
  await openReview(page, app.url);
  await expect(page.locator('#task-banner-text')).toHaveText("! The runner needs a restart: an attempt's result could not be saved. "
    + '! P2 changed files the plan did not declare: src/config.ts. The current plan does not declare src/config.ts for P2.');
});

test('polls that change nothing do not rewrite the banner, the note or the status, so they are not re-announced', async ({ page }) => {
  await serve();
  // A needs-human task whose draft publish is in progress: polled, and nothing in the view changes between polls. The
  // real server has no publish, so a cancel closes the task at once, which puts a note on screen; the fake keeps the
  // task needs human and publishing on every later read, so the banner, the note and the status all show and stay.
  const fake = (view: Record<string, any>) => { view.startable = false; view.task.status = 'needs human';
    view.publish = { ...view.publish, available: true, active: true, last: { outcome: 'publishing', draft: true, message: 'A pull request is being published.', stateVersion: 1, at: '2026-10-23T12:00:00.000Z' } }; };
  await viewWith(page, fake);
  // The cancel's answer, forwarded to the real server, gets the same fake fields, so the view it applies stays busy.
  await page.route('**/api/runner', async route => {
    if (route.request().method() !== 'POST') { await route.fallback(); return; }
    const request = route.request();
    const response = await unpooled(request.url(), { method: 'POST', body: request.postData() ?? '', headers: { 'content-type': 'application/json', 'x-codeboost-token': request.headers()['x-codeboost-token'] ?? '' } });
    const answer = await response.json() as Record<string, any>;
    if (response.ok) fake(answer.runner);
    await route.fulfill({ status: response.status, json: answer });
  });
  await page.clock.install();
  await openReview(page, app.url);
  const banner = page.locator('#task-banner-text'), note = page.locator('#runner-note');
  await expect(banner).toHaveText('! This task needs a person. A pull request is being published.');
  const cancel = page.locator('#cancel-task');
  await cancel.click(); await cancel.click();
  await expect(note).toHaveText('✓ Task cancelled.');
  // One poll after the answer, so the view on screen is a read's; all three texts are set.
  let reads = Number(await note.getAttribute('data-reads'));
  await page.clock.runFor(2_000);
  await expect(note).toHaveAttribute('data-reads', String(reads + 1));
  await expect(status(page)).toHaveText('! Needs human · Publishing…');
  await expect(banner).toHaveText('! This task needs a person. A pull request is being published.');
  await expect(note).toHaveText('✓ Task cancelled.');
  // Count child mutations (text node replacements) of the three live texts over the next polls, which change nothing.
  await page.evaluate(() => { const counts: Record<string, number> = {}; (window as unknown as { __rewrites: Record<string, number> }).__rewrites = counts;
    for (const id of ['task-banner-text', 'runner-note', 'task-status']) { counts[id] = 0; new MutationObserver(records => { counts[id] = (counts[id] ?? 0) + records.length; })
      .observe(document.getElementById(id)!, { childList: true, characterData: true, subtree: true }); } });
  for (const step of [2_000, 4_000, 8_000]) { reads = Number(await note.getAttribute('data-reads')); await page.clock.runFor(step); await expect(note).toHaveAttribute('data-reads', String(reads + 1)); }
  expect(await page.evaluate(() => (window as unknown as { __rewrites: Record<string, number> }).__rewrites)).toEqual({ 'task-banner-text': 0, 'runner-note': 0, 'task-status': 0 });
});

test('the issue title carries its full text as a tooltip only while the strip cuts it', async ({ page }) => {
  await serve();
  await page.setViewportSize({ width: 1280, height: 800 });
  // A long plan summary, as the review reports it: only `plan.summary` is changed in the real answer.
  let summary = 'Make retries predictable and document the behavior of every client of the retry policy in the service and its tests';
  await page.route('**/api/review', async route => {
    const response = await unpooled(route.request().url(), { headers: { 'x-codeboost-token': route.request().headers()['x-codeboost-token'] ?? '' } });
    const review = await response.json() as Record<string, any>;
    if (response.ok) review.plan = { ...review.plan, summary };
    await route.fulfill({ status: response.status, json: review });
  });
  // The status is cut too (the longest status and restart reason), and its reason can change without a width change.
  let reason: 'preparation-not-removed' | 'storage-not-removed' = 'preparation-not-removed';
  await viewWith(page, view => { view.startable = false; view.task.status = 'possibly already fixed';
    view.unresolved = { attemptId: '7d0c2f4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f', reason }; });
  await openReview(page, app.url);
  await page.evaluate(() => document.fonts.ready);
  const title = page.locator('#issue-title');
  // On first load, measured once the runner's controls are placed: both cut, so each tooltip holds its full text.
  await expect(title).toHaveAttribute('title', `#3 ${summary}`);
  await expect(status(page)).toHaveAttribute('title', "Possibly already fixed, Needs restart: an attempt's preparation files could not be removed");
  // Each text changes while still cut: the tooltips follow the text (here the flex row shares its width a little
  // differently, which the size observers see; the case with no size change has its own test below).
  reason = 'storage-not-removed'; summary = `${summary}, and every caller of its callers`;
  await refreshReview(page);
  await expect(status(page)).toHaveAttribute('title', "Possibly already fixed, Needs restart: an attempt's task storage could not be removed");
  await expect(title).toHaveAttribute('title', `#3 ${summary}`);
  // A wider window cuts nothing: the tooltips go, with no render in between.
  await page.setViewportSize({ width: 2400, height: 800 });
  await expect(title).not.toHaveAttribute('title');
  await expect(status(page)).not.toHaveAttribute('title');
  // Back at the minimum, and after a Refresh made while the review view was hidden (the Plans screen), it is cut again.
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(title).toHaveAttribute('title', `#3 ${summary}`);
  await page.getByRole('link', { name: 'Plans', exact: true }).click();
  await page.evaluate(() => (document.getElementById('plans-refresh') as HTMLButtonElement).click());
  await expect(page.locator('#plans-status')).toContainText('is current');
  await page.locator('#review-link').click();
  await expect(title).toHaveAttribute('title', `#3 ${summary}`);
});

/**
 * The review strip at 1280 px with the status at its 40% maximum (the longest status and a restart reason). `summary`
 * is what the review reports as the plan summary; `reason` the fake marker's reason; both can change for the next load.
 */
async function cappedStrip(page: Page, texts: { summary: string; reason: 'preparation-not-removed' | 'storage-not-removed' }) {
  await serve();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.route('**/api/review', async route => {
    const response = await unpooled(route.request().url(), { headers: { 'x-codeboost-token': route.request().headers()['x-codeboost-token'] ?? '' } });
    const review = await response.json() as Record<string, any>;
    if (response.ok) review.plan = { ...review.plan, summary: texts.summary };
    await route.fulfill({ status: response.status, json: review });
  });
  await viewWith(page, view => { view.startable = false; view.task.status = 'possibly already fixed';
    view.unresolved = { attemptId: '7d0c2f4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f', reason: texts.reason }; });
  await openReview(page, app.url);
  await page.evaluate(() => document.fonts.ready);
  const widths = () => page.evaluate(() => { const strip = document.querySelector('#review-view .review-strip')!;
    const inner = strip.clientWidth - parseFloat(getComputedStyle(strip).paddingLeft) - parseFloat(getComputedStyle(strip).paddingRight);
    return { inner, status: document.getElementById('task-status')!.getBoundingClientRect().width, title: document.getElementById('issue-title')!.getBoundingClientRect().width }; });
  return widths;
}

test('a summary change that leaves the cut widths as they are still updates the title tooltip', async ({ page }) => {
  // The title is cut by less than the status's excess over its cap, so a summary change (a plan import or Apply editing
  // it) changes no width: no size observer fires, and only the measurement after the render sees the new text.
  const texts = { summary: 'Make retries predictable across the service', reason: 'preparation-not-removed' as const };
  const widths = await cappedStrip(page, texts);
  const title = page.locator('#issue-title');
  await expect(title).toHaveAttribute('title', `#3 ${texts.summary}`);
  const before = await widths();
  expect(before.status).toBeCloseTo(before.inner * 0.4, 0);
  expect(before.title).toBeLessThan(await title.evaluate(element => element.scrollWidth));
  texts.summary = `${texts.summary}.`;
  await refreshReview(page);
  expect(await widths()).toEqual(before);
  await expect(title).toHaveAttribute('title', `#3 ${texts.summary}`);
});

test('a status change that leaves the cut widths as they are still updates the status tooltip', async ({ page }) => {
  // A short title that is not cut: the status keeps its cap with either restart reason, so the reason changing (a read
  // after the runner's state moved) changes no width, and only the measurement after the render sees the new text.
  const texts = { summary: 'Fix retries', reason: 'preparation-not-removed' as const as 'preparation-not-removed' | 'storage-not-removed' };
  const widths = await cappedStrip(page, texts);
  await expect(status(page)).toHaveAttribute('title', "Possibly already fixed, Needs restart: an attempt's preparation files could not be removed");
  await expect(page.locator('#issue-title')).not.toHaveAttribute('title');
  const before = await widths();
  expect(before.status).toBeCloseTo(before.inner * 0.4, 0);
  texts.reason = 'storage-not-removed';
  await refreshReview(page);
  expect(await widths()).toEqual(before);
  await expect(status(page)).toHaveAttribute('title', "Possibly already fixed, Needs restart: an attempt's task storage could not be removed");
});
