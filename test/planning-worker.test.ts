import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { AuthorRequest } from '../core/planning-author.ts';
import { createDemo } from '../scripts/demo.ts';
import { AgentWorker } from '../runner/question-agent.ts';
import { ASK_NAMING, createWorkerRoot, LeftoverLedger, PLANNING_NAMING } from '../runner/question-leftovers.ts';
import { CODEX_PLANNING_REFUSED, PLANNING_BUDGET_MS } from '../runner/planning-provider.ts';
import { NO_PLANNING_AGENT, PlanningAgent } from '../runner/planning.ts';
import { ReviewService } from '../runner/review.ts';

// Planning's worker, ledger and owner (#117), driven through the stub worker, which reports what reached it.
vi.setConfig({ testTimeout: 30_000 });
const STUB = new URL('./fixtures/question-worker-stub.ts', import.meta.url);
const roots: string[] = [], services: ReviewService[] = [], closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  services.splice(0).forEach(service => service.close());
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
  vi.restoreAllMocks();
});
function review() {
  const root = mkdtempSync(join(tmpdir(), 'codeboost-planning-worker-')); roots.push(root);
  const service = new ReviewService(createDemo(join(root, 'demo'))); services.push(service);
  return service;
}
const fileOf = (service: ReviewService) => statSync(realpathSync(service.config.database), { bigint: true });
function request(service: ReviewService, prompt = 'whoami'): AuthorRequest {
  const plan = service.store.getPlan(service.config.identity);
  return { mode: 'suggest', phase: 'planning', access: 'read-only', identity: service.config.identity, requestId: randomUUID(),
    issue: plan.issue, revision: plan.revision, prompt, schemaText: '{"type":"object"}' };
}
function agent(service: ReviewService) {
  const planning = new PlanningAgent(service, { url: STUB, env: { CLAUDE_CODE_OAUTH_TOKEN: 'test-token' } });
  closers.push(() => planning.close());
  return planning;
}
type WhoAmI = { kind: string; feature: string | null; owner: string; deadline: number | null; env: string | null };

it('gives planning its own owner token per database, apart from Ask\'s and the runner\'s', () => {
  const service = review(), file = fileOf(service), owner = service.store.planningOwnerToken(file);
  expect(owner).toMatch(/^[0-9a-f]{32}$/);
  expect(service.store.planningOwnerToken(file)).toBe(owner);
  expect(owner).not.toBe(service.store.askOwnerToken(file));
  expect(owner).not.toBe(service.store.runnerOwnerToken(file));
});

it('keeps planning\'s record and lock apart from Ask\'s, so each feature locks only itself', () => {
  const service = review(), database = realpathSync(service.config.database);
  const ask = LeftoverLedger.forDatabase(database), planning = LeftoverLedger.forDatabase(database, PLANNING_NAMING);
  expect(planning.path).toBe(`${database}.planning-leftovers.json`);
  expect(basename(planning.lockPath)).toMatch(/^codeboost-planlock-\d+-\d+\.sqlite$/);
  expect(basename(dirname(planning.lockPath))).toMatch(/^codeboost-planlocks-/);
  expect(planning.lockPath).not.toBe(ask.lockPath);
  ask.acquire(); planning.acquire();
  try {
    expect(() => LeftoverLedger.forDatabase(database, PLANNING_NAMING).acquire())
      .toThrow(/^Planning is off: another codeboost process is running planning for this review\. Stop it, then retry\.$/);
  } finally { planning.release(); ask.release(); }
});

it('never deletes Ask\'s folders when planning clears its own', () => {
  const service = review(), database = realpathSync(service.config.database);
  // An Ask root stamped with an Ask lock nobody holds is an orphan to Ask, and nothing to planning.
  const askLock = join(tmpdir(), `codeboost-asklocks-${process.getuid?.() ?? 'user'}`, 'codeboost-asklock-999999-999999.sqlite');
  const askRoot = createWorkerRoot(askLock, ASK_NAMING); roots.push(askRoot);
  const planningRoot = createWorkerRoot('', PLANNING_NAMING); roots.push(planningRoot);
  writeFileSync(`${database}.planning-leftovers.json`, JSON.stringify({ roots: [planningRoot] }));
  LeftoverLedger.forDatabase(database, PLANNING_NAMING).assertClear();
  expect(existsSync(planningRoot)).toBe(false);
  expect(existsSync(askRoot)).toBe(true);
  expect(existsSync(`${database}.planning-leftovers.json`)).toBe(false);
  // Ask's own check does delete it, so the folder above was one a careless planning check could have deleted.
  LeftoverLedger.forDatabase(database).assertClear();
  expect(existsSync(askRoot)).toBe(false);
});

it('refuses a worker whose ledger serves another feature, and plans only on planning\'s worker', async () => {
  const service = review();
  expect(() => new AgentWorker(STUB, LeftoverLedger.forDatabase(service.config.database), { naming: PLANNING_NAMING }))
    .toThrow('A worker and its ledger must serve the same feature.');
  const ask = new AgentWorker(STUB, undefined, { env: { CLAUDE_CODE_OAUTH_TOKEN: 'test-token' } });
  closers.push(() => ask.close());
  await expect(ask.plan({ provider: 'claude', repository: '/repo', head: 'a'.repeat(40), attemptId: randomUUID(), taskId: 't',
    deadline: Date.now() + 60_000, prompt: 'whoami', schemaText: '{}', context: { snapshotId: 's', planId: 'p', planRevision: 1,
      assignmentId: 'a', referencedCodeHash: 'a'.repeat(40), stateVersion: 0 } }, new AbortController().signal))
    .rejects.toThrow('This worker does not run plans.');
});

it('runs a request in planning\'s worker, under a planning root, with the planning owner and a deadline inside the budget', async () => {
  const service = review();
  service.store.setQuestionProvider('claude');
  const before = Date.now();
  const reply = JSON.parse(await agent(service).invoke(request(service), new AbortController().signal)) as WhoAmI;
  expect(reply).toMatchObject({ kind: 'plan', feature: 'planning', owner: service.store.planningOwnerToken(fileOf(service)) });
  expect(basename(reply.env!)).toMatch(/^codeboost-plan-[A-Za-z0-9]{6}$/);
  // The worker's deadline leaves its settle margin before E3's timer, which uses the whole budget.
  expect(reply.deadline).toBeGreaterThan(before);
  expect(reply.deadline).toBeLessThanOrEqual(Date.now() + PLANNING_BUDGET_MS - 5_000);
});

it('recovers only planning\'s owner before its first request', async () => {
  const service = review();
  service.store.setQuestionProvider('claude');
  const reply = JSON.parse(await agent(service).invoke(request(service, 'recoveries'), new AbortController().signal)) as
    { recovered: string[]; owner: string };
  const file = fileOf(service);
  expect(reply.recovered).toEqual([service.store.planningOwnerToken(file)]);
  expect(reply.recovered).not.toContain(service.store.askOwnerToken(file));
});

it.each([
  ['no agent is chosen', null, NO_PLANNING_AGENT],
  ['Codex is chosen (#93)', 'codex', CODEX_PLANNING_REFUSED],
] as const)('refuses a request before any lock, worker or Docker work when %s', async (_, vendor, message) => {
  const service = review();
  if (vendor) {
    // The Store refuses Codex since #75; a database from before then still holds it.
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(service.config.database);
    try { db.prepare("INSERT INTO app_settings VALUES ('question_provider',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(vendor); }
    finally { db.close(); }
  }
  const acquire = vi.spyOn(LeftoverLedger.prototype, 'acquire');
  await expect(agent(service).invoke(request(service), new AbortController().signal)).rejects.toThrow(message);
  expect(acquire).not.toHaveBeenCalled();
});
