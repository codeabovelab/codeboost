import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthorProvider, AuthorRequest } from '../core/planning-author.ts';
import { ISSUE_READ_ACTIVE_MS, type IssueAccess, type IssueText } from '../github/issues.ts';
import { createDemo } from '../scripts/demo.ts';
import type { PlanningAgent } from '../runner/planning.ts';
import { ReviewService, type ReviewConfig } from '../runner/review.ts';
import { productionPlanning } from '../web/planning.ts';
import { DatabaseSync } from 'node:sqlite';
import { PLANNING_BUDGET_MS } from '../runner/planning-provider.ts';
import { PLANNING_SHUTDOWN_GRACE_MS, startServer, type PlanningDeps } from '../web/server.ts';
import { GuardRefusal } from '../runner/lifecycle.ts';
import { PLANNING_UNAVAILABLE, PlanningCheck } from '../runner/planning.ts';

// Production planning wiring (#117): when it is on, what each request is told, and how the server awaits the issue.
vi.setConfig({ testTimeout: 20_000 });
const roots: string[] = [], closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});
function demo(): ReviewConfig {
  const root = mkdtempSync(join(tmpdir(), 'codeboost-planning-prod-')); roots.push(root);
  return createDemo(join(root, 'demo'));
}
/** The demo as a production review of a GitHub issue; the server never contacts GitHub in these tests. */
function production(config = demo()): ReviewConfig {
  const service = new ReviewService(config), issue = service.store.getPlan(config.identity).issue; service.close();
  return { ...config, demo: false, github: { repository: 'acme/retry-service', pullRequest: 7, issue } };
}
const text = (number: number): IssueText => ({ number, title: 'Retries ignore the cap', body: 'Body with <tags>.', comments: ['Collaborator note.'] });
const issues = (issueText: (number: number, options?: { trustedAuthor?: string | null; expectedAccess?: IssueAccess }) => Promise<IssueText>, collaborator = true) => ({
  issueAccess: async (number: number) => ({ number, authorLogin: 'outside', collaborator }), issueText,
});
const closable = (close = vi.fn(async () => undefined),
  probe: (vendor: string, signal: AbortSignal) => Promise<void> = vi.fn(async () => undefined)) =>
  ({ close, invoke: vi.fn(), probe }) as unknown as PlanningAgent;
const verified = { verifyLock: () => undefined };

it('is off in a demo and without a github block, so neither plans', () => {
  const config = demo();
  expect(productionPlanning(config, verified)).toBeUndefined();
  expect(productionPlanning({ ...config, demo: false }, verified)).toBeUndefined();
  expect(productionPlanning(production(config), verified)).toBeTypeOf('function');
});

it('tells each request the GitHub issue, the repository and the base commit, read with a bound', async () => {
  const config = production(), service = new ReviewService(config); closers.push(() => service.close());
  const issueText = vi.fn(async (number: number, options?: { signal?: AbortSignal; timeoutMs?: number;
    trustedAuthor?: string | null; expectedAccess?: IssueAccess }) => text(number));
  const issueAccess = vi.fn(async (number: number, _options?: { signal?: AbortSignal; timeoutMs?: number }) =>
    ({ number, authorLogin: 'outside', collaborator: true }));
  const signal = new AbortController().signal;
  const deps = productionPlanning(config, { ...verified, issues: { issueAccess, issueText }, agent: () => closable() })!(service);
  expect(await deps.describe(signal)).toMatchObject({ issue: text(config.github!.issue), approvedLessons: [],
    repo: { name: 'acme/retry-service', baseRef: service.store.getSnapshot(config.identity).base }, validate: expect.any(Function) });
  expect(issueAccess.mock.calls[0]![1]!.signal).toBe(issueText.mock.calls[0]![1]!.signal);
  expect(issueAccess.mock.calls[0]![1]!.signal).not.toBe(signal);
  expect(issueAccess.mock.calls[0]![1]!.timeoutMs).toBe(ISSUE_READ_ACTIVE_MS);
  expect(issueText).toHaveBeenCalledWith(config.github!.issue, { signal: issueAccess.mock.calls[0]![1]!.signal,
    timeoutMs: ISSUE_READ_ACTIVE_MS, trustedAuthor: undefined,
    expectedAccess: { number: config.github!.issue, authorLogin: 'outside', collaborator: true } });
});

it('passes explicit trust into planning comments and refuses the next read after revocation', async () => {
  const config = production(), service = new ReviewService(config); closers.push(() => service.close());
  const issueText = vi.fn(async (number: number, options?: { trustedAuthor?: string | null }) =>
    ({ ...text(number), comments: options?.trustedAuthor === 'outside' ? ['Outside note.'] : [] }));
  const deps = productionPlanning(config, { ...verified, issues: issues(issueText, false), agent: () => closable() })!(service);
  service.store.setIssueTrust({ repository: config.github!.repository, issue: config.github!.issue, authorLogin: 'outside', trusted: true, trustedBy: 'local user' });
  await expect(deps.describe(new AbortController().signal)).resolves.toMatchObject({ issue: { comments: ['Outside note.'] } });
  expect(issueText).toHaveBeenLastCalledWith(config.github!.issue, expect.objectContaining({ trustedAuthor: 'outside' }));
  service.store.setIssueTrust({ repository: config.github!.repository, issue: config.github!.issue, authorLogin: 'outside', trusted: false, trustedBy: 'local user' });
  await expect(deps.describe(new AbortController().signal)).rejects.toThrow(/not trusted/);
});

it('refuses when the issue author or collaborator access changes between admission and the text read', async () => {
  const config = production(), service = new ReviewService(config); closers.push(() => service.close());
  const issueText = vi.fn(async (_number: number, options?: { expectedAccess?: IssueAccess }) => {
    expect(options?.expectedAccess).toEqual({ number: config.github!.issue, authorLogin: 'outside', collaborator: true });
    throw new Error(`Issue #${config.github!.issue}'s author or collaborator access changed during admission.`);
  });
  const deps = productionPlanning(config, { ...verified, issues: issues(issueText), agent: () => closable() })!(service);
  await expect(deps.describe(new AbortController().signal)).rejects.toThrow(/access changed during admission/);
});

it('refuses all-comments text when explicit trust is revoked during the awaited planning read', async () => {
  const config = production(), service = new ReviewService(config); closers.push(() => service.close());
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const issueText = async (number: number) => { started.resolve(); await release.promise; return text(number); };
  const deps = productionPlanning(config, { ...verified, issues: issues(issueText, false), agent: () => closable() })!(service);
  service.store.setIssueTrust({ repository: config.github!.repository, issue: config.github!.issue, authorLogin: 'outside', trusted: true, trustedBy: 'local user' });
  const description = deps.describe(new AbortController().signal);
  await started.promise;
  service.store.setIssueTrust({ repository: config.github!.repository, issue: config.github!.issue, authorLogin: 'outside', trusted: false, trustedBy: 'local user' });
  release.resolve();
  await expect(description).rejects.toThrow(/not trusted/);
});

it('carries explicit trust to the planning prompt boundary', async () => {
  const config = production(), service = new ReviewService(config); closers.push(() => service.close());
  const deps = productionPlanning(config, { ...verified, issues: issues(async number => text(number), false), agent: () => closable() })!(service);
  service.store.setIssueTrust({ repository: config.github!.repository, issue: config.github!.issue, authorLogin: 'outside', trusted: true, trustedBy: 'local user' });
  const described = await deps.describe(new AbortController().signal);
  service.store.setIssueTrust({ repository: config.github!.repository, issue: config.github!.issue, authorLogin: 'outside', trusted: false, trustedBy: 'local user' });
  expect(() => described.validate()).toThrow(/not trusted/);
});

it.each([['release', 'release'], ['', null]] as const)('names the configured base branch %j, or else the base commit, in the prompt', async (baseBranch, expected) => {
  const base = production(), config = { ...base, github: { ...base.github!, baseBranch } };
  const requests: AuthorRequest[] = [];
  const agent = () => ({ close: async () => undefined, invoke: async (request: AuthorRequest, signal: AbortSignal) => {
    requests.push(request); return new Promise<string>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } }) as unknown as PlanningAgent;
  const app = await startServer(config, 0, async () => 'answer', undefined, 2_000, undefined, undefined,
    productionPlanning(config, { ...verified, issues: issues(async number => text(number)), agent })!);
  closers.push(() => app.close());
  const call = async (method: string, path: string, body?: unknown) => (await fetch(`${new URL(app.url).origin}${path}`, { method,
    headers: { 'x-codeboost-token': app.token, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })).json() as Promise<Record<string, any>>;
  const view = await call('GET', '/api/review');
  await call('POST', '/api/plan/drafts', { expectedRevision: view.plan.revision, snapshotId: view.snapshot.id, feedback: '', actionId: randomUUID() });
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0]!.prompt).toContain(`"base_ref":${JSON.stringify(expected ?? view.snapshot.base)}`);
});

it('fails requests an earlier process left pending, only after the lock is verified', () => {
  const config = production(), service = new ReviewService(config); closers.push(() => service.close());
  const store = service.store, expected = { revision: store.getPlan(config.identity).revision, snapshotId: store.getSnapshot(config.identity).id };
  const pending = store.beginSuggestions(config.identity, expected, 'draft');
  // A lock that no longer names this database: nothing is settled, and startup stops.
  const refused = productionPlanning(config, { verifyLock: () => { throw new Error('The database path changed.'); }, agent: () => closable() })!;
  expect(() => refused(service)).toThrow('The database path changed.');
  expect(store.getDraft(config.identity, pending).state).toBe('pending');
  const order: string[] = [], settle = vi.spyOn(store, 'settleInterruptedRequests');
  productionPlanning(config, { verifyLock: () => { order.push('verified'); expect(settle).not.toHaveBeenCalled(); }, agent: () => closable() })!(service);
  expect(order).toEqual(['verified']);
  expect(store.getDraft(config.identity, pending)).toMatchObject({ state: 'failed', reason: 'The server stopped before this request finished. Ask again.' });
});

it('closes the Store and starts nothing when the planning setup refuses', async () => {
  const config = production(), close = vi.spyOn(ReviewService.prototype, 'close');
  const setup = productionPlanning(config, { verifyLock: () => { throw new Error('The database path changed.'); }, agent: () => closable() })!;
  await expect(startServer(config, 0, async () => 'answer', undefined, 2_000, undefined, undefined, setup)).rejects.toThrow('The database path changed.');
  expect(close).toHaveBeenCalledTimes(1);
  close.mockRestore();
});

it('closes the planning agent when the server closes', async () => {
  const config = production(), close = vi.fn(async () => undefined);
  const setup = productionPlanning(config, { ...verified, issues: issues(async number => text(number)), agent: () => closable(close) })!;
  const app = await startServer(config, 0, async () => 'answer', undefined, 2_000, undefined, undefined, setup);
  await app.close();
  expect(close).toHaveBeenCalledTimes(1);
});

async function serve(planning: PlanningDeps) {
  const config = demo();
  const app = await startServer(config, 0, async () => 'answer', undefined, 2_000, undefined, undefined, () => planning);
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await app.close(); } };
  closers.push(close);
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${new URL(app.url).origin}${path}`, { method, headers: { 'x-codeboost-token': app.token,
      ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  const view = (await api('GET', '/api/review')).body;
  const start = (actionId = randomUUID()) => api('POST', '/api/plan/suggestions', { expectedRevision: view.plan.revision,
    snapshotId: view.snapshot.id, feedback: '', actionId });
  /** Suggestion requests the Store recorded, read from the database itself. */
  const recorded = () => {
    const db = new DatabaseSync(config.database);
    try { return (db.prepare('SELECT COUNT(*) AS n FROM requests').get() as { n: number }).n; } finally { db.close(); }
  };
  return { api, start, view, close, recorded };
}
/** A provider that holds each request until it is aborted, as a running container would. */
function holding() {
  const requests: AuthorRequest[] = [];
  const provider: AuthorProvider = { invoke: (request, signal) => { requests.push(request);
    return new Promise<string>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } };
  return { provider, requests };
}
const issueOf = (number: number) => ({ issue: text(number), approvedLessons: [], repo: { name: 'acme/retry-service', baseRef: 'abc' },
  validate: () => undefined });

it('awaits the issue before starting a suggestion, and sends it to the provider', async () => {
  const requests: AuthorRequest[] = [];
  // Holds each request open until shutdown aborts it, as a running container would.
  const provider: AuthorProvider = { invoke: (request, signal) => { requests.push(request);
    return new Promise<string>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } };
  let resolve!: (value: Awaited<ReturnType<PlanningDeps['describe']>>) => void;
  const described = new Promise<Awaited<ReturnType<PlanningDeps['describe']>>>(done => { resolve = done; });
  const { start, view } = await serve({ provider, describe: () => described });
  const started = start();
  await new Promise(done => setTimeout(done, 50));
  expect(requests).toHaveLength(0);
  resolve({ issue: text(view.plan.issue), approvedLessons: [], repo: { name: 'acme/retry-service', baseRef: 'abc' }, validate: () => undefined });
  const response = await started;
  expect(response).toMatchObject({ status: 200, body: { result: { requestId: expect.any(String) } } });
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0]!.prompt).toContain('Retries ignore the cap');
  expect(requests[0]!.prompt).toContain('acme/retry-service');
});

it('starts no suggestion when the issue cannot be read, and durably replays GitHub\'s 502', async () => {
  let available = false;
  const invoke = vi.fn(), describe = vi.fn(async () => {
    if (!available) throw new Error('GitHub is unreachable.');
    return issueOf(1);
  });
  const { start, recorded } = await serve({ provider: { invoke }, describe });
  const actionId = randomUUID(), response = await start(actionId);
  expect(response).toMatchObject({ status: 502, body: { error: 'The issue could not be read from GitHub: GitHub is unreachable.' } });
  available = true;
  expect(await start(actionId)).toEqual(response);
  expect(invoke).not.toHaveBeenCalled();
  expect(describe).toHaveBeenCalledTimes(1);
  expect(recorded()).toBe(0);
});

it('preserves a planning trust refusal as 409 instead of labelling it a GitHub read failure', async () => {
  let trusted = false;
  const invoke = vi.fn(), describe = vi.fn(async () => {
    if (!trusted) throw new GuardRefusal('Issue is not trusted.');
    return issueOf(1);
  });
  const { start, recorded } = await serve({ provider: { invoke }, describe });
  const actionId = randomUUID();
  expect(await start(actionId)).toMatchObject({ status: 409, body: { error: 'Issue is not trusted.' } });
  trusted = true;
  expect(await start(actionId)).toMatchObject({ status: 409, body: { error: 'Issue is not trusted.' } });
  expect(invoke).not.toHaveBeenCalled();
  expect(describe).toHaveBeenCalledTimes(1);
  expect(recorded()).toBe(0);
});

it('revalidates planning trust after describe resolves and before constructing the prompt', async () => {
  let trusted = true;
  const invoke = vi.fn(), description = issueOf(1);
  const describe = () => new Promise<ReturnType<typeof issueOf> & { validate(): void }>(resolve => {
    resolve({ ...description, validate: () => { if (!trusted) throw new GuardRefusal('Issue is not trusted.'); } });
    queueMicrotask(() => { trusted = false; });
  });
  const { start, recorded } = await serve({ provider: { invoke }, describe });
  expect(await start()).toMatchObject({ status: 409, body: { error: 'Issue is not trusted.' } });
  expect(invoke).not.toHaveBeenCalled();
  expect(recorded()).toBe(0);
});

it('replays a recorded start without reading GitHub again', async () => {
  const { provider } = holding(), describe = vi.fn();
  const { start, view } = await serve({ provider, describe });
  describe.mockResolvedValueOnce(issueOf(view.plan.issue));
  const actionId = randomUUID(), first = await start(actionId);
  expect(first.status).toBe(200);
  describe.mockRejectedValue(new Error('GitHub is unreachable.'));
  expect(await start(actionId)).toEqual(first);
  expect(describe).toHaveBeenCalledTimes(1);
});

it('reads nothing from GitHub for a start against a stale revision', async () => {
  const describe = vi.fn();
  const { api, view } = await serve({ provider: holding().provider, describe });
  const response = await api('POST', '/api/plan/suggestions', { expectedRevision: view.plan.revision + 1, snapshotId: view.snapshot.id,
    feedback: '', actionId: randomUUID() });
  expect(response).toMatchObject({ status: 409, body: { error: 'Stale plan revision or snapshot. Reload before asking for suggestions.' } });
  expect(describe).not.toHaveBeenCalled();
});

it('refuses a start with 503, recording nothing, when shutdown begins while the issue is read', async () => {
  let resolve!: (value: ReturnType<typeof issueOf>) => void;
  const { start, view, close, recorded } = await serve({ provider: holding().provider,
    describe: () => new Promise(done => { resolve = done; }) });
  const started = start();
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
  const closing = close();
  resolve(issueOf(view.plan.issue));
  expect(await started).toMatchObject({ status: 503 });
  await closing;
  expect(recorded()).toBe(0);
});

it('gives E3 the whole planning budget, not its 120-second default', async () => {
  const { provider } = holding();
  const { start, view } = await serve({ provider, describe: async () => issueOf(view.plan.issue) });
  const delays: (number | undefined)[] = [], real = globalThis.setTimeout;
  const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
    delays.push(ms); return real(fn, ms, ...rest); }) as typeof setTimeout);
  try { expect((await start()).status).toBe(200); } finally { spy.mockRestore(); }
  expect(delays).toContain(PLANNING_BUDGET_MS);
  expect(delays).not.toContain(120_000);
});

it('ends a planning request that does not settle after shutdown aborts it by closing its worker', async () => {
  // A request stuck in lane D's synchronous setup ignores its abort until its worker is abandoned.
  let reject!: (error: Error) => void, issue = 0;
  const order: string[] = [];
  const served = await serve({ provider: { invoke: () => new Promise((_, fail) => { reject = fail; }) },
    describe: async () => issueOf(issue), close: async () => { order.push('planning closed'); reject(new Error('worker abandoned')); } });
  issue = served.view.plan.issue;
  expect((await served.start()).status).toBe(200);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const closing = served.close().then(() => order.push('server closed'));
    await vi.advanceTimersByTimeAsync(PLANNING_SHUTDOWN_GRACE_MS - 1);
    expect(order).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    await closing;
    expect(order).toEqual(['planning closed', 'server closed']);
  } finally { vi.useRealTimers(); }
});

// #164: the planning check, through productionPlanning's setup with a stand-in agent whose `probe` is the check.
describe('the planning check (#164)', () => {
  /** The production setup on a review whose Settings chose `vendor`, with a stand-in agent and issue reads. */
  function checked(probe: (vendor: string, signal: AbortSignal) => Promise<void>, vendor: 'claude' | 'codex' | null = 'claude',
    recheckMs?: number, admitWaitMs?: number, issueText = vi.fn(async (number: number) => text(number))) {
    const config = production(), service = new ReviewService(config); closers.push(() => service.close());
    if (vendor) service.store.setQuestionProvider(vendor);
    const issueAccess = vi.fn(async (number: number) => ({ number, authorLogin: 'outside', collaborator: true }));
    const close = vi.fn(async () => undefined), agent = closable(close, vi.fn(probe));
    const deps = productionPlanning(config, { ...verified, issues: { issueAccess, issueText }, agent: () => agent, recheckMs,
      admitWaitMs })!(service);
    return { deps, service, agent, issueAccess, close, probe: vi.mocked(agent.probe) };
  }
  const signal = () => new AbortController().signal;

  it('starts at setup with the vendor chosen in Settings, and that one check serves every later request', async () => {
    const { deps, probe, issueAccess } = checked(async () => undefined);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe.mock.calls[0]![0]).toBe('claude');
    await deps.describe(signal());
    await deps.describe(signal());
    expect(probe).toHaveBeenCalledTimes(1);
    expect(issueAccess).toHaveBeenCalledTimes(2);
  });

  it('refuses a request with the check\'s reason, before it reads the issue, and checks again only after the wait', async () => {
    const { deps, probe, issueAccess } = checked(async () => { throw new Error('Claude could not sign in.'); });
    const refusal = await Promise.resolve(deps.describe(signal())).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(GuardRefusal);
    expect((refusal as Error).message).toMatch(new RegExp(`^${PLANNING_UNAVAILABLE} .*The check said: Claude could not sign in\\.$`));
    // Inside the wait, the same failure refuses at once.
    await expect(deps.describe(signal())).rejects.toThrow('Claude could not sign in.');
    expect(probe).toHaveBeenCalledTimes(1);
    expect(issueAccess).not.toHaveBeenCalled();
  });

  it('checks again once the wait after a failure is over, and admits once a check passes', async () => {
    let fail = true;
    const { deps, probe, issueAccess } = checked(async () => { if (fail) throw new Error('Docker is not running.'); }, 'claude', 0);
    await expect(deps.describe(signal())).rejects.toThrow('Docker is not running.');
    fail = false;
    await expect(deps.describe(signal())).resolves.toMatchObject({ issue: { title: 'Retries ignore the cap' } });
    expect(probe).toHaveBeenCalledTimes(2);
    // A passed check is kept: the wait applies only to a failure.
    fail = true;
    await deps.describe(signal());
    expect(probe).toHaveBeenCalledTimes(2);
    expect(issueAccess).toHaveBeenCalledTimes(2);
  });

  it('makes every request wait for the one running check, and a request that stops waiting leaves it running', async () => {
    let pass!: () => void;
    const { deps, probe } = checked((_vendor, probeSignal) => new Promise<void>((resolve, reject) => {
      pass = resolve; probeSignal.addEventListener('abort', () => reject(probeSignal.reason), { once: true });
    }));
    const leaving = new AbortController(), left = deps.describe(leaving.signal), waiting = deps.describe(signal());
    leaving.abort(new Error('The browser went away.'));
    await expect(left).rejects.toThrow('The browser went away.');
    pass();
    await expect(waiting).resolves.toMatchObject({ issue: { title: 'Retries ignore the cap' } });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe.mock.calls[0]![1].aborted).toBe(false);
  });

  it('checks nothing while no agent is chosen, then checks the vendor chosen before its first request', async () => {
    const { deps, service, probe, issueAccess } = checked(async () => undefined, null);
    expect(probe).not.toHaveBeenCalled();
    // No vendor: the request goes on, and the agent refuses it later with NO_PLANNING_AGENT, as before.
    await deps.describe(signal());
    expect(probe).not.toHaveBeenCalled();
    service.store.setQuestionProvider('claude');
    await deps.describe(signal());
    // Settings refuse Codex now, but a database from before #75 may still hold it.
    vi.spyOn(service.store, 'questionProvider').mockReturnValue('codex');
    await deps.describe(signal());
    expect(probe.mock.calls.map(call => call[0])).toEqual(['claude', 'codex']);
    expect(issueAccess).toHaveBeenCalledTimes(3);
  });

  it('checks the vendor chosen while a request waited, before it admits the request', async () => {
    let pass!: () => void;
    const { deps, service, probe } = checked(vendor => vendor === 'claude' ? new Promise<void>(resolve => { pass = resolve; })
      : Promise.reject(new Error('Codex cannot write plans yet.')));
    const waiting = Promise.resolve(deps.describe(signal()));
    vi.spyOn(service.store, 'questionProvider').mockReturnValue('codex');
    pass();
    await expect(waiting).rejects.toThrow('Codex cannot write plans yet.');
    expect(probe.mock.calls.map(call => call[0])).toEqual(['claude', 'codex']);
  });

  it('refuses to invoke an agent whose check has not passed, when Settings changed after the recorded action', async () => {
    const made = checked(async () => undefined);
    await made.deps.describe(signal());
    vi.spyOn(made.service.store, 'questionProvider').mockReturnValue('codex');
    const request = {} as Parameters<typeof made.deps.provider.invoke>[0];
    expect(() => made.deps.provider.invoke(request, signal())).toThrow('still checking');
    expect(made.agent.invoke).not.toHaveBeenCalled();
  });

  it('cancels a running check on close, and closes the agent only once it stopped', async () => {
    const order: string[] = [];
    // The check settles a while after it is cancelled, as a worker job does.
    const { deps, probe, close } = checked((_vendor, probeSignal) => new Promise<void>((_, reject) =>
      probeSignal.addEventListener('abort', () => setTimeout(() => { order.push('check stopped'); reject(probeSignal.reason); }, 50),
        { once: true })));
    close.mockImplementation(async () => { order.push('agent closed'); });
    await deps.close!();
    expect(probe.mock.calls[0]![1].aborted).toBe(true);
    expect(order).toEqual(['check stopped', 'agent closed']);
  });

  it('fails the check, and refuses with its reason, when the probe throws instead of rejecting', async () => {
    const check = new PlanningCheck(() => { throw new Error('No worker could start.'); }, () => 'claude');
    expect(() => check.start()).not.toThrow();
    const refusal = await check.admit(signal()).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(GuardRefusal);
    expect((refusal as Error).message).toContain('No worker could start.');
  });

  it('cancels a running check that a check for another vendor replaced', async () => {
    let vendor: 'claude' | 'codex' = 'claude';
    const signals: AbortSignal[] = [];
    const check = new PlanningCheck((_vendor, probeSignal) => { signals.push(probeSignal); return new Promise<void>(() => undefined); },
      () => vendor, { waitMs: 10 });
    check.start();
    vendor = 'codex';
    await expect(check.admit(signal())).rejects.toThrow('still checking');
    expect(signals.map(probeSignal => probeSignal.aborted)).toEqual([true, false]);
    await check.close(10);
    expect(signals[1]!.aborted).toBe(true);
  });

  it('keeps a multi-line reason whole, at the end of the refusal', async () => {
    const reason = 'Planning stays off until they are deleted. Delete them, then retry:\nrm -rf \'/tmp/codeboost-planning-x\'';
    const check = new PlanningCheck(async () => { throw new Error(reason); }, () => 'claude');
    const refusal = await check.admit(signal()).catch((error: unknown) => error);
    expect((refusal as Error).message.endsWith(`The check said: ${reason}`)).toBe(true);
  });

  it('keeps waiting, rather than failing, when its check was replaced and the vendor changed back', async () => {
    let vendor: 'claude' | 'codex' = 'claude', count = 0;
    const check = new PlanningCheck((_probed, probeSignal) => {
      count += 1;
      // The third check (Claude again) passes; the first two wait until cancelled.
      if (count === 3) return Promise.resolve();
      return new Promise<void>((_, reject) => probeSignal.addEventListener('abort', () => reject(probeSignal.reason), { once: true }));
    }, () => vendor);
    const waiting = check.admit(signal());
    vendor = 'codex';
    const other = check.admit(signal()).catch(() => undefined);
    vendor = 'claude';
    await expect(Promise.all([waiting, check.admit(signal())])).resolves.toEqual([undefined, undefined]);
    await other;
    expect(count).toBe(3);
  });

  it('moves a waiting request to a newer check at once, without waiting for the replaced one to stop', async () => {
    let vendor: 'claude' | 'codex' = 'claude', count = 0;
    // The first check ignores its cancellation, as a worker job stuck in a synchronous build does; the third passes.
    const check = new PlanningCheck(() => { count += 1; return count === 3 ? Promise.resolve() : new Promise<void>(() => undefined); },
      () => vendor, { waitMs: 5_000 });
    const started = performance.now(), waiting = check.admit(signal());
    vendor = 'codex';
    void check.admit(signal()).catch(() => undefined);
    vendor = 'claude';
    void check.admit(signal()).catch(() => undefined);
    await expect(waiting).resolves.toBeUndefined();
    expect(performance.now() - started).toBeLessThan(2_000);
    await check.close(10);
  });

  it('never throws from the deferred check when the Store cannot be read', async () => {
    let fail = false;
    const probe = vi.fn(async () => undefined);
    const check = new PlanningCheck(probe, () => { if (fail) throw new Error('database is closed'); return 'claude'; });
    const uncaught = vi.fn();
    process.on('uncaughtException', uncaught);
    try {
      expect(() => check.assertPassed()).toThrow('still checking');
      fail = true;
      await new Promise(resolve => setImmediate(resolve));
      expect(uncaught).not.toHaveBeenCalled();
      expect(probe).not.toHaveBeenCalled();
    } finally { process.off('uncaughtException', uncaught); }
  });

  it('starts no check after close', async () => {
    let vendor: 'claude' | 'codex' = 'claude';
    const probe = vi.fn(async () => undefined), check = new PlanningCheck(probe, () => vendor);
    check.start();
    await check.close();
    vendor = 'codex';
    await expect(check.admit(signal())).rejects.toThrow('Planning is stopping.');
    expect(() => check.assertPassed()).toThrow('still checking');
    await new Promise(resolve => setImmediate(resolve));
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('bounds a request\'s whole wait, across a vendor change, by one deadline', async () => {
    let vendor: 'claude' | 'codex' = 'claude';
    // Claude's check passes at 2 s, after the vendor changed; Codex's never ends.
    const check = new PlanningCheck(probed => new Promise<void>(resolve => {
      if (probed === 'claude') setTimeout(resolve, 2_000);
    }), () => vendor, { waitMs: 2_200 });
    const started = performance.now(), waiting = check.admit(signal()).catch((error: unknown) => error);
    await new Promise(resolve => setTimeout(resolve, 100));
    vendor = 'codex';
    // One deadline ends the wait at 2.2 s; a fresh 2.2 s for Codex would end it at 4.2 s.
    const refusal = await waiting;
    expect(refusal).toBeInstanceOf(GuardRefusal);
    expect((refusal as Error).message).toContain('still checking');
    expect(performance.now() - started).toBeLessThan(3_500);
    await check.close(10);
  });

  it('waits a bounded time on close for a check that never stops', async () => {
    const check = new PlanningCheck(() => new Promise<void>(() => undefined), () => 'claude');
    check.start();
    const started = performance.now();
    await check.close(100);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('refuses a request as still starting when the check outlasts its wait, and admits it once the check passed', async () => {
    let pass!: () => void;
    const { deps, issueAccess } = checked(() => new Promise<void>(resolve => { pass = resolve; }), 'claude', undefined, 50);
    const refusal = await Promise.resolve(deps.describe(signal())).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(GuardRefusal);
    expect((refusal as Error).message).toMatch(new RegExp(`^${PLANNING_UNAVAILABLE} codeboost is still checking the planning agent\\. .* Retry shortly\\.$`));
    expect(issueAccess).not.toHaveBeenCalled();
    pass();
    await expect(deps.describe(signal())).resolves.toMatchObject({ issue: { title: 'Retries ignore the cap' } });
  });

  it('refuses at the start a vendor chosen while the issue was read, and checks it (#164)', async () => {
    let service!: ReviewService;
    const issueText = vi.fn(async (number: number) => {
      vi.spyOn(service.store, 'questionProvider').mockReturnValue('codex');
      return text(number);
    });
    // (The provider, too, checks again when it is invoked: "refuses to invoke an agent whose check has not passed".)
    const made = checked(async () => undefined, 'claude', undefined, undefined, issueText);
    service = made.service;
    const described = await made.deps.describe(signal());
    expect(() => described.validate()).toThrow(`${PLANNING_UNAVAILABLE} codeboost is still checking the planning agent.`);
    // validate runs inside the Store's transaction, so the new vendor's check starts only on the next turn.
    expect(made.probe.mock.calls.map(call => call[0])).toEqual(['claude']);
    await new Promise(resolve => setImmediate(resolve));
    expect(made.probe.mock.calls.map(call => call[0])).toEqual(['claude', 'codex']);
    // Once that check passed, the same request is admitted.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(() => described.validate()).not.toThrow();
  });

  it('refuses a start through the server with 409, recording no request and starting no agent', async () => {
    const config = production(), probe = vi.fn(async () => { throw new Error('Claude could not sign in.'); });
    const service = new ReviewService(config); service.store.setQuestionProvider('claude'); service.close();
    const agent = closable(undefined, probe), issueAccess = vi.fn();
    const setup = productionPlanning(config, { ...verified, issues: { issueAccess, issueText: vi.fn() }, agent: () => agent })!;
    const app = await startServer(config, 0, async () => 'answer', undefined, 2_000, undefined, undefined, setup);
    closers.push(() => app.close());
    const api = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${new URL(app.url).origin}${path}`, { method, headers: { 'x-codeboost-token': app.token,
        ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: response.status, body: await response.json() as Record<string, any> };
    };
    const view = (await api('GET', '/api/review')).body;
    const started = await api('POST', '/api/plan/suggestions', { expectedRevision: view.plan.revision,
      snapshotId: view.snapshot.id, feedback: '', actionId: randomUUID() });
    expect(started.status).toBe(409);
    expect(started.body.error).toMatch(new RegExp(`^${PLANNING_UNAVAILABLE} .*Claude could not sign in\\.`));
    const db = new DatabaseSync(config.database);
    try { expect((db.prepare('SELECT COUNT(*) AS n FROM requests').get() as { n: number }).n).toBe(0); } finally { db.close(); }
    expect(agent.invoke).not.toHaveBeenCalled();
    expect(issueAccess).not.toHaveBeenCalled();
  });
});
