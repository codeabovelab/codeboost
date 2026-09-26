import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
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
