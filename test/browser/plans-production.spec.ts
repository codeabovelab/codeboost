import { expect, test, type Page } from '@playwright/test';
import { lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InvocationHandle, InvocationInput } from '../../agents/contract.ts';
import type { AgentAdapterRequest } from '../../agents/adapters/types.ts';
import type { TaskFilesystems } from '../../agents/container/storage.ts';
import type { EditReply, Plan } from '../../core/plan.ts';
import type { AuthorProvider, AuthorRequest } from '../../core/planning-author.ts';
import type { IssueAccess, IssueText } from '../../github/issues.ts';
import type { MergeGateway } from '../../github/merge.ts';
import { createPlanningProvider, type PlanningDependencies } from '../../runner/planning-provider.ts';
import type { PlanningAgent } from '../../runner/planning.ts';
import type { ReviewConfig, ReviewService } from '../../runner/review.ts';
import { Store } from '../../runner/store.ts';
import { createDemo } from '../../scripts/demo.ts';
import { productionPlanning } from '../../web/planning.ts';
import { startServer } from '../../web/server.ts';

let root: string;
let app: Awaited<ReturnType<typeof startServer>> | undefined;

test.beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'codeboost-plans-production-browser-')); });
test.afterEach(async () => {
  await app?.close();
  app = undefined;
  rmSync(root, { recursive: true, force: true });
});

function productionConfig(): ReviewConfig {
  const demo = createDemo(join(root, 'review'));
  return { ...demo, demo: false, github: { repository: 'acme/retry-service', pullRequest: 7, issue: 3 } };
}

const issueAccess = async (number: number): Promise<IssueAccess> =>
  ({ number, authorLogin: 'maintainer', collaborator: true });
const issueText = async (number: number): Promise<IssueText> =>
  ({ number, title: 'Retries ignore the cap', body: 'Keep retry delays bounded.', comments: ['Preserve the public API.'] });

const mergeGateway: MergeGateway = {
  inspect: async () => ({ base: '0'.repeat(40), head: '1'.repeat(40), pullRequestState: 'OPEN', mergeable: 'MERGEABLE', rulesKnown: true,
    atomicBaseGuard: true, mergeQueue: false, requiredChecks: [], alreadyFixed: 'clear', pullRequest: 7, draft: false }),
  merge: async () => ({ url: 'https://github.com/acme/retry-service/pull/7' }),
};

function suggestion(revision: number): EditReply {
  return { schema_version: 1, base_revision: revision,
    reply: 'Name the operator-visible retry ceiling.', edits: [{
      op: 'set_field', item: 'P1', summary: 'Clarify the retry ceiling',
      reason: 'The current item should name the observable limit.', field: 'title',
      value: `Expose the bounded retry ceiling at r${revision + 1}`, file: null, check: null,
      check_index: null, depends_on: null, new_item: null,
    }] };
}

function draft(current: Plan): Plan {
  return { ...structuredClone(current), revision: current.revision + 1,
    summary: `Production draft for revision ${current.revision + 1}` };
}

/**
 * Lane D stand-ins keep this browser acceptance deterministic while exercising createPlanningProvider itself.
 * The real-Docker test owns the concrete clone, storage and Claude adapter implementations.
 */
function dBackedAgent(service: ReviewService, observations: {
  invocations: InvocationInput[]; schemas: string[]; prompts: string[]; releases: number[];
}): PlanningAgent {
  const outputs = new Map<string, string>();
  const filesystems = { fixture: true } as unknown as TaskFilesystems;
  const deps: PlanningDependencies = {
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'acceptance-token' },
    buildImage: () => `sha256:${'b'.repeat(64)}`,
    measureRepository: () => ({ checkoutBytes: 1_024, entries: 3, objectBytes: 2_048 }),
    createClone: options => ({ id: 'acceptance-clone', taskId: options.taskId, directory: options.parent, head: options.head }),
    prepareFilesystems: () => filesystems,
    removeFilesystems: released => { expect(released).toBe(filesystems); observations.releases.push(1); },
    capture: input => { observations.invocations.push(input); return Object.freeze(input); },
    startClaude: (request: AgentAdapterRequest, credential: string): InvocationHandle => {
      expect(credential).toBe('acceptance-token');
      expect(lstatSync(request.inputDirectory).mode & 0o222).toBe(0);
      observations.schemas.push(readFileSync(join(request.inputDirectory, 'schema.json'), 'utf8'));
      observations.prompts.push(request.prompt);
      const stdout = outputs.get(request.invocation.attemptId);
      if (stdout === undefined) throw new Error('Missing acceptance output.');
      return { attemptId: request.invocation.attemptId, cancel: () => undefined,
        settled: Promise.resolve({ attemptId: request.invocation.attemptId, context: request.invocation.context,
          exitCode: 0, signal: null, stdout, stderr: '' }) };
    },
  };
  const snapshot = service.store.getSnapshot(service.config.identity);
  const provider = createPlanningProvider({ vendor: 'claude', repository: service.reviewRepository().path,
    head: snapshot.head, snapshotId: snapshot.id, runnerOwner: '0123456789abcdef0123456789abcdef', deps });
  const agent: AuthorProvider & { close(): Promise<void> } = {
    async invoke(request: AuthorRequest, signal: AbortSignal) {
      const current = service.store.getPlan(request.identity);
      const expected = request.mode === 'draft' ? current.revision + 1 : current.revision;
      if (request.revision !== expected) throw new Error('Planning request revision does not match its mode.');
      outputs.set(request.requestId, JSON.stringify(request.mode === 'suggest' ? suggestion(request.revision) : draft(current)));
      return provider.invoke(request, signal);
    },
    async close() { /* createPlanningProvider has no process-level owner */ },
  };
  return agent as PlanningAgent;
}

async function boot(config: ReviewConfig, observations: {
  invocations: InvocationInput[]; schemas: string[]; prompts: string[]; releases: number[];
}) {
  const setup = productionPlanning(config, { verifyLock: () => undefined, issues: { issueAccess, issueText },
    agent: service => dBackedAgent(service, observations) });
  expect(setup).toBeDefined();
  if (!setup) throw new Error('Production planning was not configured.');
  app = await startServer(config, 0, undefined, mergeGateway, undefined, undefined, undefined, setup);
}

async function openPlans(page: Page) {
  await page.goto(app!.url);
  await page.getByRole('link', { name: 'Plans', exact: true }).click();
}

function runningApp() {
  if (!app) throw new Error('Acceptance server is not running.');
  return app;
}

test('persists browser-applied provider suggestions and drafts through the production Store', async ({ page }) => {
  const config = productionConfig();
  const baselineStore = new Store(config.database);
  const baseRef = baselineStore.getSnapshot(config.identity).base;
  baselineStore.close();
  const observations = { invocations: [] as InvocationInput[], schemas: [] as string[], prompts: [] as string[], releases: [] as number[] };
  await boot(config, observations);
  await openPlans(page);

  await page.getByLabel('Guidance').fill('Make the retry ceiling explicit.');
  await page.getByRole('button', { name: 'Suggest edits' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Suggestions ready for r1.' })).toBeVisible();
  await expect(page.getByRole('article', { name: 'Clarify the retry ceiling' })).toBeVisible();
  await page.getByRole('button', { name: 'Apply this edit', exact: true }).click();
  await expect(page.locator('#plans-revision')).toHaveText('r2');

  await runningApp().close();
  app = undefined;
  const afterSuggestion = new Store(config.database);
  const persistedSuggestion = afterSuggestion.getPlan(config.identity);
  expect(persistedSuggestion.revision).toBe(2);
  expect(persistedSuggestion.items.find(item => item.id === 'P1')).toMatchObject({
    title: 'Expose the bounded retry ceiling at r2',
  });
  afterSuggestion.close();

  await boot(config, observations);
  await openPlans(page);
  await expect(page.locator('#plans-revision')).toHaveText('r2');
  await page.getByRole('button', { name: 'Draft next revision' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Draft ready for r2.' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Draft Production draft for revision 3' })).toBeVisible();
  await page.getByRole('button', { name: 'Apply draft', exact: true }).click();
  await expect(page.locator('#plans-revision')).toHaveText('r3');

  await runningApp().close();
  app = undefined;
  const reopened = new Store(config.database);
  const persistedDraft = reopened.getPlan(config.identity);
  expect(persistedDraft).toMatchObject({ revision: 3, summary: 'Production draft for revision 3' });
  expect(persistedDraft.items.find(item => item.id === 'P1')).toMatchObject({
    title: 'Expose the bounded retry ceiling at r2',
  });
  reopened.close();
  expect(observations.invocations).toHaveLength(2);
  expect(observations.invocations.map(value => ({ phase: value.phase, argv: value.approvedArgv,
    revision: value.context.planRevision, snapshot: value.context.snapshotId }))).toEqual([
    { phase: 'planning', argv: [], revision: 1, snapshot: observations.invocations[0]!.context.snapshotId },
    { phase: 'planning', argv: [], revision: 3, snapshot: observations.invocations[0]!.context.snapshotId },
  ]);
  expect(observations.schemas).toHaveLength(2);
  expect(observations.schemas.map(schema => (JSON.parse(schema) as { title: string }).title)).toEqual([
    'codeboost plan edit', 'codeboost plan',
  ]);
  for (const prompt of observations.prompts) {
    expect(prompt).toContain('acme/retry-service');
    expect(prompt).toContain(baseRef);
    expect(prompt).toContain('Retries ignore the cap');
    expect(prompt).toContain('Keep retry delays bounded.');
    expect(prompt).toContain('Preserve the public API.');
  }
  expect(observations.prompts[0]).toContain('Make the retry ceiling explicit.');
  expect(observations.prompts[1]).toContain('Expose the bounded retry ceiling at r2');
  expect(observations.prompts[1]).toContain('"revision":2');
  expect(observations.releases).toHaveLength(2);
});
