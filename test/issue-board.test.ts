import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IssueBoard } from '../web/issues.ts';
import { startServer } from '../web/server.ts';
import { createDemo } from '../scripts/demo.ts';
import type { IssueGateway, IssueSnapshot } from '../github/issues.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const snapshot = (retrievedAt = '2026-09-25T00:00:00.000Z'): IssueSnapshot => ({
  repository: 'owner/repo',
  retrievedAt,
  issues: [{
    repository: 'owner/repo', number: 1, title: 'One', body: 'Untrusted body text', url: 'https://github.com/owner/repo/issues/1',
    createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', comments: 0, positiveReactions: 0,
    labels: ['bug'], authorLogin: 'owner', authorAssociation: 'OWNER', trust: 'trusted',
  }],
});

/** A gateway whose fetches settle only when the test says so, even after abort. */
function heldGateway() {
  const calls: { signal: AbortSignal | undefined; result: ReturnType<typeof deferred<IssueSnapshot>> }[] = [];
  const gateway: IssueGateway = {
    repository: 'owner/repo',
    fetch(options = {}) {
      const result = deferred<IssueSnapshot>();
      calls.push({ signal: options.signal, result });
      return result.promise;
    },
  };
  return { gateway, calls };
}

describe('issue board', () => {
  it('reports an unconfigured board without fetching', async () => {
    const board = new IssueBoard(null, 'Add a repository.');
    expect(board.view()).toEqual({ configured: false, reason: 'Add a repository.' });
    await expect(board.refresh()).resolves.toEqual({ configured: false, reason: 'Add a repository.' });
  });

  it('joins concurrent refreshes into one retrieval', async () => {
    const { gateway, calls } = heldGateway();
    const board = new IssueBoard(gateway);
    const first = board.refresh(), second = board.refresh();
    expect(calls).toHaveLength(1);
    expect(board.view()).toMatchObject({ configured: true, refreshing: true, state: null });
    calls[0]!.result.resolve(snapshot());
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ refreshing: false, state: { state: 'fresh', issues: [{ number: 1, score: 20 }] } });
    expect(a.configured && a.state!.issues[0]).not.toHaveProperty('body');
  });

  it('a departing request stops waiting without cancelling the shared refresh', async () => {
    const { gateway, calls } = heldGateway();
    const board = new IssueBoard(gateway);
    const leaving = new AbortController();
    const first = board.refresh(leaving.signal), second = board.refresh();
    leaving.abort(new Error('client left'));
    await expect(first).rejects.toThrow('client left');
    expect(calls[0]!.signal!.aborted).toBe(false);
    calls[0]!.result.resolve(snapshot());
    await expect(second).resolves.toMatchObject({ state: { state: 'fresh' } });
  });

  it('keeps the last good list as stale when a later refresh fails', async () => {
    const { gateway, calls } = heldGateway();
    const board = new IssueBoard(gateway, undefined, () => new Date('2026-09-25T01:00:00.000Z'));
    const first = board.refresh();
    calls[0]!.result.resolve(snapshot());
    await first;
    const second = board.refresh();
    calls[1]!.result.reject(new Error('gh: HTTP 502'));
    await expect(second).resolves.toMatchObject({
      state: { state: 'stale', retrievedAt: '2026-09-25T00:00:00.000Z', failedAt: '2026-09-25T01:00:00.000Z', error: 'gh: HTTP 502', issues: [{ number: 1 }] },
    });
  });

  it('exposes only fresh board trust as a control-admission hint', async () => {
    const { gateway, calls } = heldGateway();
    const board = new IssueBoard(gateway);
    expect(board.trustStatus(1)).toBe('unknown');
    const first = board.refresh();
    calls[0]!.result.resolve({ ...snapshot(), issues: [{ ...snapshot().issues[0]!, trust: 'requires-approval' }] });
    await first;
    expect(board.trustStatus(1)).toBe('blocked');
    const second = board.refresh();
    calls[1]!.result.reject(new Error('gh: HTTP 502'));
    await second;
    expect(board.trustStatus(1)).toBe('unknown');
  });

  it('checks trust only for the requested non-collaborator issue', async () => {
    const { gateway, calls } = heldGateway(), trust = vi.fn(() => null);
    const board = new IssueBoard(gateway, undefined, undefined, trust);
    const issues = Array.from({ length: 1_000 }, (_, index) => ({ ...snapshot().issues[0]!, number: index + 1,
      title: `Issue ${index + 1}`, trust: 'requires-approval' as const }));
    const refresh = board.refresh();
    calls[0]!.result.resolve({ ...snapshot(), issues });
    await refresh;
    trust.mockClear();
    expect(board.trustStatus(1_000)).toBe('blocked');
    expect(trust).toHaveBeenCalledTimes(1);
    expect(trust).toHaveBeenCalledWith('owner/repo', 1_000);
  });

  it('shows a matching explicit decision before collaborator trust so its broader permission can be removed', async () => {
    const { gateway, calls } = heldGateway();
    const board = new IssueBoard(gateway, undefined, undefined, () => ({ repository: 'owner/repo', issue: 1,
      authorLogin: 'owner', trustedBy: 'local user', trustedAt: '2026-09-25T00:00:00.000Z', revokedAt: null }));
    const refresh = board.refresh();
    calls[0]!.result.resolve(snapshot());
    await refresh;
    expect(board.view()).toMatchObject({ state: { issues: [{ trust: 'approved', trustedBy: 'local user' }] } });
  });

  it('close aborts the refresh, awaits its settlement, and refuses new refreshes', async () => {
    const { gateway, calls } = heldGateway();
    const board = new IssueBoard(gateway);
    const waiting = board.refresh();
    waiting.catch(() => undefined);
    let closed = false;
    const closing = board.close().then(() => { closed = true; });
    expect(calls[0]!.signal!.aborted).toBe(true);
    expect(String(calls[0]!.signal!.reason)).toContain('shutdown');
    await new Promise(resolve => setTimeout(resolve, 10));
    // The gateway has not settled yet, so the board still owns the work.
    expect(closed).toBe(false);
    calls[0]!.result.reject(calls[0]!.signal!.reason);
    await closing;
    expect(closed).toBe(true);
    await expect(waiting).rejects.toThrow('shutdown');
    await expect(board.refresh()).rejects.toThrow('shutting down');
  });
});

describe('issue endpoints', { timeout: 30_000 }, () => {
  let root: string | undefined;
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });

  function call(url: string, token: string, method: 'GET' | 'POST', body?: unknown) {
    const target = new URL(url);
    return new Promise<{ status: number; body: any }>((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = request({ host: target.hostname, port: target.port, path: '/api/issues', method, headers: {
        'x-codeboost-token': token, ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
      } }, res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      });
      req.on('error', reject);
      req.end(payload);
    });
  }

  it('serves the ranked list and rejects unknown issue actions', async () => {
    root = mkdtempSync(join(tmpdir(), 'codeboost-issues-'));
    const { gateway, calls } = heldGateway();
    const app = await startServer(createDemo(join(root, 'demo')), 0, undefined, undefined, undefined, gateway);
    try {
      expect((await call(app.url, app.token, 'GET')).body).toEqual({ configured: true, repository: 'owner/repo', refreshing: false, state: null });
      expect((await call(app.url, app.token, 'POST', { action: 'trust', number: 1 })).status).toBe(409);
      const refreshing = call(app.url, app.token, 'POST', { action: 'refresh' });
      await expect.poll(() => calls.length).toBe(1);
      calls[0]!.result.resolve(snapshot());
      const response = await refreshing;
      expect(response.status).toBe(200);
      expect(response.body.state).toMatchObject({ state: 'fresh', issues: [{ number: 1, reasons: ['20 points: bug label'] }] });
    } finally { await app.close(); }
  });

  it('records repository-and-author-bound trust, replays it, and refuses a stale author precondition', async () => {
    root = mkdtempSync(join(tmpdir(), 'codeboost-issues-trust-'));
    let author: string | null = 'outside', accessReads = 0;
    const base = snapshot(), external = { ...base, issues: [{ ...base.issues[0]!, authorLogin: author, trust: 'requires-approval' as const }] };
    const gateway = {
      repository: 'owner/repo',
      async fetch() { return { ...external, issues: [{ ...external.issues[0]!, authorLogin: author }] }; },
      async issueAccess(number: number) { accessReads++; return { number, authorLogin: author, collaborator: false }; },
      async issueText(number: number) { return { number, title: 'One', body: '', comments: [] }; },
    };
    const app = await startServer(createDemo(join(root, 'demo')), 0, undefined, undefined, undefined, gateway);
    try {
      await call(app.url, app.token, 'POST', { action: 'refresh' });
      const actionId = randomUUID(), requestBody = { action: 'trust', actionId, number: 1, authorLogin: 'outside' };
      const trusted = await call(app.url, app.token, 'POST', requestBody);
      expect(trusted).toMatchObject({ status: 200, body: { state: { issues: [{ trust: 'approved', trustedBy: 'local user' }] } } });
      expect((await call(app.url, app.token, 'POST', requestBody)).body).toEqual(trusted.body);
      expect(accessReads).toBe(1);
      const untrustId = randomUUID();
      expect(await call(app.url, app.token, 'POST', { ...requestBody, actionId: untrustId, action: 'untrust' }))
        .toMatchObject({ status: 200, body: { state: { issues: [{ trust: 'requires-approval' }] } } });
      expect(await call(app.url, app.token, 'POST', { ...requestBody, actionId: randomUUID() }))
        .toMatchObject({ status: 200, body: { state: { issues: [{ trust: 'approved' }] } } });
      const replayedUntrust = await call(app.url, app.token, 'POST', { ...requestBody, actionId: untrustId, action: 'untrust' });
      expect(replayedUntrust).toMatchObject({ status: 200, body: { state: { issues: [{ trust: 'approved' }] } } });
      expect(accessReads).toBe(3);
      author = 'renamed';
      const stale = await call(app.url, app.token, 'POST', { ...requestBody, actionId: randomUUID(), action: 'untrust' });
      expect(stale).toMatchObject({ status: 409, body: { error: expect.stringMatching(/author changed/i) } });
    } finally { await app.close(); }
  });

  it('records an issue-access failure under the trust action ID and replays the same 502 without another read', async () => {
    root = mkdtempSync(join(tmpdir(), 'codeboost-issues-trust-failure-'));
    let accessReads = 0, fail = true;
    const gateway = {
      repository: 'owner/repo',
      async fetch() { return snapshot(); },
      async issueAccess(number: number) { accessReads++; if (fail) throw new Error('GitHub unavailable');
        return { number, authorLogin: 'outside', collaborator: false }; },
      async issueText(number: number) { return { number, title: 'One', body: '', comments: [] }; },
    };
    const app = await startServer(createDemo(join(root, 'demo')), 0, undefined, undefined, undefined, gateway);
    try {
      await call(app.url, app.token, 'POST', { action: 'refresh' });
      const requestBody = { action: 'trust', actionId: randomUUID(), number: 1, authorLogin: 'outside' };
      expect(await call(app.url, app.token, 'POST', requestBody)).toMatchObject({ status: 502,
        body: { error: expect.stringMatching(/GitHub unavailable/) } });
      fail = false;
      expect(await call(app.url, app.token, 'POST', requestBody)).toMatchObject({ status: 502,
        body: { error: expect.stringMatching(/GitHub unavailable/) } });
      expect(accessReads).toBe(1);
    } finally { await app.close(); }
  });

  it('a disconnected browser stops waiting while the shared refresh continues for another caller', async () => {
    root = mkdtempSync(join(tmpdir(), 'codeboost-issues-'));
    const { gateway, calls } = heldGateway();
    const waits: Promise<unknown>[] = [];
    const original = IssueBoard.prototype.refresh;
    const spy = vi.spyOn(IssueBoard.prototype, 'refresh').mockImplementation(function (this: IssueBoard, signal) {
      const wait = original.call(this, signal);
      waits.push(wait.then(() => 'settled', error => String(error)));
      return wait;
    });
    const app = await startServer(createDemo(join(root, 'demo')), 0, undefined, undefined, undefined, gateway);
    try {
      const target = new URL(app.url);
      const payload = JSON.stringify({ action: 'refresh' });
      const leaving = request({ host: target.hostname, port: target.port, path: '/api/issues', method: 'POST', headers: {
        'x-codeboost-token': app.token, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload),
      } });
      leaving.on('error', () => undefined);
      leaving.end(payload);
      await expect.poll(() => calls.length).toBe(1);
      const staying = call(app.url, app.token, 'POST', { action: 'refresh' });
      await expect.poll(() => waits.length).toBe(2);
      leaving.destroy();
      await expect(waits[0]).resolves.toContain('Client disconnected');
      expect(calls[0]!.signal!.aborted).toBe(false);
      calls[0]!.result.resolve(snapshot());
      await expect(staying).resolves.toMatchObject({ status: 200, body: { state: { state: 'fresh' } } });
      expect(calls).toHaveLength(1);
    } finally { spy.mockRestore(); await app.close(); }
  });

  it('stops waiting when the response closed before the Issues listener was attached', async () => {
    root = mkdtempSync(join(tmpdir(), 'codeboost-issues-'));
    const { gateway, calls } = heldGateway();
    const waits: Promise<unknown>[] = [];
    let closed = false;
    let closedBeforeRefresh = false;
    let disconnectNext = true;
    const resumeHandler = deferred<void>();
    const original = IssueBoard.prototype.refresh;
    const spy = vi.spyOn(IssueBoard.prototype, 'refresh').mockImplementation(function (this: IssueBoard, signal) {
      closedBeforeRefresh = closed;
      const wait = original.call(this, signal);
      waits.push(wait.then(() => 'settled', error => String(error)));
      return wait;
    });
    const app = await startServer(createDemo(join(root, 'demo')), 0, undefined, undefined, undefined, gateway,
      undefined, undefined, undefined, { beforeIssueRefreshWait: () => resumeHandler.promise });
    app.server.prependListener('request', (req, res) => {
      if (req.url !== '/api/issues' || !disconnectNext) return;
      disconnectNext = false;
      req.once('end', () => {
        res.once('close', () => { closed = true; resumeHandler.resolve(); });
        res.destroy();
      });
    });
    try {
      const leaving = call(app.url, app.token, 'POST', { action: 'refresh' }).catch(() => undefined);
      await expect.poll(() => waits.length).toBe(1);
      expect(closedBeforeRefresh).toBe(true);
      const staying = call(app.url, app.token, 'POST', { action: 'refresh' });
      await expect.poll(() => waits.length).toBe(2);
      let settled = false;
      void waits[0]!.then(() => { settled = true; });
      await expect.poll(() => settled, { timeout: 500 }).toBe(true);
      expect(await waits[0]).toContain('Client disconnected');
      expect(calls[0]!.signal!.aborted).toBe(false);
      calls[0]!.result.resolve(snapshot());
      await expect(staying).resolves.toMatchObject({ status: 200, body: { state: { state: 'fresh' } } });
      expect(calls).toHaveLength(1);
      await leaving;
    } finally {
      calls[0]?.result.resolve(snapshot());
      spy.mockRestore();
      await app.close();
    }
  });

  it('shutdown aborts an admitted refresh and waits for the retrieval to settle', async () => {
    root = mkdtempSync(join(tmpdir(), 'codeboost-issues-'));
    const { gateway, calls } = heldGateway();
    const app = await startServer(createDemo(join(root, 'demo')), 0, undefined, undefined, 50, gateway);
    const admitted = call(app.url, app.token, 'POST', { action: 'refresh' }).catch(error => error);
    await expect.poll(() => calls.length).toBe(1);
    let closed = false;
    const closing = app.close().then(() => { closed = true; });
    await expect.poll(() => calls[0]!.signal!.aborted).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(closed).toBe(false);
    calls[0]!.result.reject(calls[0]!.signal!.reason);
    await closing;
    const response = await admitted;
    expect(response instanceof Error || response.status !== 200).toBe(true);
  });

  it('reports a review without a GitHub repository as not configured', async () => {
    root = mkdtempSync(join(tmpdir(), 'codeboost-issues-'));
    const app = await startServer({ ...createDemo(join(root, 'demo')), demo: false }, 0);
    try {
      const response = await call(app.url, app.token, 'POST', { action: 'refresh' });
      expect(response.body).toMatchObject({ configured: false, reason: expect.stringContaining('GitHub repository') });
    } finally { await app.close(); }
  });
});
