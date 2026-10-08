import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { buildAgentImage } from '../agents/container/image.ts';
import { exportTaskDiff, removeTaskFilesystemsAsync, type TaskStorageLimits } from '../agents/container/storage.ts';
import { recoverLeftovers } from '../agents/recovery.ts';
import { startClaudeInvocation } from '../agents/adapters/claude.ts';
import { startRunnerCommandInvocation } from '../agents/adapters/runner.ts';
import { GhAlreadyFixedGateway } from '../github/already-fixed.ts';
import { GhIssueGateway, withIssueReadDeadline, type IssueAccess, type IssueText } from '../github/issues.ts';
import { GhPullRequestGateway } from '../github/pull-requests.ts';
import { baseBranch } from '../github/validate.ts';
import { identityKey } from '../core/identity.ts';
import { combineRunnerDeps, type RunnerDeps } from './coordinator.ts';
import { DEFAULT_DIAGNOSTICS_CAP_BYTES } from './diagnostics.ts';
import { executionDeps, SafetyFindings, type AgentLauncher, type ExecutionSources, type GuardedIssueText } from './execution.ts';
import { GuardRefusal, isUuidV4, quoteForTerminal, type ShutdownCapability } from './lifecycle.ts';
import { recoverStartup, removalCommand, type RecoveryDeps, type RecoveryReport, type RunnerLock } from './recovery.ts';
import { GitBranchPusher, pushUrl } from './branch-push.ts';
import { PullRequestPublisher } from './publish.ts';
import type { ReviewService } from './review.ts';
import { ensureCommit, openRunnerRepository, ownerOnlyDirectory, type RunnerRepository } from './runner-repository.ts';
import { GitRebaser } from './rebase.ts';
import { createForeignConflictResolver } from './rebase-conflict.ts';
import { createTaskWorkspace, workspaceFilesystems } from './workspace.ts';
import { commandCheckDeps } from './checks.ts';
import { PreMergeCoordinator, type PreMergeAuthorization } from './pre-merge.ts';
import type { RunnerCoordinator } from './coordinator.ts';

/**
 * The production runner (#91): D's real workspace, launcher, recovery, export and removal, under the database's runner
 * token. Opt-in through the review configuration's `runner` block; demos never run it.
 */
export interface RunnerConfig {
  /** Absolute; owner-only. Attempt directories and the runner-owned repository live under `<root>/<runnerOwner>/`. */
  readonly root: string;
  /**
   * Absolute; owner-only. Partial output of stopped attempts is kept in `<diagnosticsDir>/<runnerOwner>`, one folder per
   * database, so runners of several databases sharing it never retain (delete) each other's files. Default `<root>`.
   */
  readonly diagnosticsDir?: string;
  readonly diagnosticsCapBytes?: number;
  /** Who runner commits are by. */
  readonly committer: { readonly name: string; readonly email: string };
  readonly limits?: Partial<TaskStorageLimits>;
}
/** Execute attempts write code: more room than Ask's read-only questions. tmpfs uses memory only for bytes stored. */
export const EXECUTE_STORAGE: TaskStorageLimits = Object.freeze({
  workBytes: 2 * 1024 * 1024 * 1024, workInodes: 262_144, metadataBytes: 1024 * 1024 * 1024, metadataInodes: 131_072,
});
/** The profile requires exactly one schema.json in the input mount; an execute answer is a plain-text summary. */
const EXECUTE_SCHEMA = '{"$schema":"https://json-schema.org/draft/2020-12/schema","title":"codeboost execute summary","type":"string"}\n';
/** How long one read of the issue serves later plan items: the length of a short multi-item run. */
export const ISSUE_REUSE_MS = 5 * 60_000;
export const RUNNER_NEEDS_GITHUB = 'The runner reads the plan\'s issue from GitHub: add a github block to the review configuration.';
export const RUNNER_CREDENTIAL_MISSING = 'The runner runs Claude Code, which needs CLAUDE_CODE_OAUTH_TOKEN. Create one with `claude setup-token`, set it, and restart codeboost.';

/** Check the `runner` block of a review configuration before anything is created. */
export function parseRunnerConfig(value: unknown): RunnerConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The runner block must be an object.');
  const v = value as Record<string, unknown>;
  const path = (field: string, text: unknown) => {
    if (typeof text !== 'string' || !isAbsolute(text)) throw new Error(`runner.${field} must be an absolute path.`);
    // D mounts paths under the root into containers, and a Docker mount cannot hold a comma or a line break: refused here,
    // before anything is created, instead of at every launch.
    if (/[\0\n\r,]/.test(text)) throw new Error(`runner.${field} cannot contain a comma or a line break: Docker cannot mount such a path.`);
    return text;
  };
  const committer = v.committer as Record<string, unknown> | undefined;
  // Git refuses angle brackets and newlines in an identity; a commit with them would fail only after the agent ran.
  const ident = (text: unknown) => typeof text === 'string' && text.trim() !== '' && text.length <= 200 && !/[<>\n\r\0]/.test(text);
  if (!committer || !ident(committer.name) || !ident(committer.email)) throw new Error('runner.committer needs a name and an email without <, > or line breaks.');
  const limits: Partial<TaskStorageLimits> = {};
  if (v.limits !== undefined) {
    if (!v.limits || typeof v.limits !== 'object' || Array.isArray(v.limits)) throw new Error('runner.limits must be an object.');
    for (const [key, n] of Object.entries(v.limits)) {
      if (!Object.hasOwn(EXECUTE_STORAGE, key) || !Number.isSafeInteger(n) || (n as number) < 1) throw new Error(`runner.limits.${key} is not a positive storage limit.`);
      (limits as Record<string, number>)[key] = n as number;
    }
  }
  const cap = v.diagnosticsCapBytes;
  if (cap !== undefined && (!Number.isSafeInteger(cap) || (cap as number) < 1)) throw new Error('runner.diagnosticsCapBytes must be a positive integer.');
  return Object.freeze({ root: path('root', v.root), ...(v.diagnosticsDir !== undefined ? { diagnosticsDir: path('diagnosticsDir', v.diagnosticsDir) } : {}),
    ...(cap !== undefined ? { diagnosticsCapBytes: cap as number } : {}),
    committer: Object.freeze({ name: committer.name as string, email: committer.email as string }), limits: Object.freeze(limits) });
}

/**
 * Lane D's recovery, export and removal for `recoverStartup`. Unlike Ask (#65), the runner looks for codeboost objects
 * without a runner label too, and every unowned object blocks startup (runner-lifecycle.md, "Unowned resources"): an
 * older build takes no lock this build can see, so one may still be running. Each is reported as a shell line that
 * removes it, with its reason as a comment, for a person to run once every older codeboost process has stopped.
 * `image` builds the agent image once D's recovery has stopped every leftover agent, so none keeps writing to its
 * storage during a long build, and before any export's deadline starts: the build blocks, and a timer armed before it
 * would fire as soon as it returned.
 */
export function dRecoveryDeps(image: () => string, rebaser?: Pick<GitRebaser, 'abort'>, rebasePlanKey?: string): RecoveryDeps {
  return {
    async recoverLeftovers(runnerOwner) {
      const report = await recoverLeftovers(runnerOwner, 120_000);
      // Any recovered storage may be exported, and every export needs the image.
      if (report.storage.length) image();
      return {
        // D's handle object itself: its trust is keyed by identity, so a copy would be refused.
        storage: report.storage.map(handle => ({ attemptId: handle.attemptId, allocationId: handle.allocationId, handle })),
        unowned: report.unowned.map(resource =>
          `${removalCommand(resource)}  # ${resource.reason}`),
      };
    },
    exportTaskDiff: (handle, input, maxBytes, signal) =>
      exportTaskDiff(handle as Parameters<typeof exportTaskDiff>[0], { base: input.base, metadataBaseline: input.metadataBaseline, imageId: image(), maxBytes, signal }),
    removeTaskFilesystems: handle => removeTaskFilesystemsAsync(handle as Parameters<typeof removeTaskFilesystemsAsync>[0]),
    ...(rebaser ? { abortRebase: async (planKey: string, marker: unknown) => {
      if (!rebasePlanKey || planKey !== rebasePlanKey)
        throw new Error('The interrupted rebase belongs to another configured plan; start that plan to recover it.');
      const attemptId = (marker as { attemptId?: unknown } | null)?.attemptId;
      const resultHead = (marker as { resultHead?: unknown } | null)?.resultHead;
      const resultState = (marker as { resultState?: unknown } | null)?.resultState;
      if (typeof attemptId !== 'string') throw new Error('The interrupted rebase has no attempt ID.');
      await rebaser.abort(attemptId, typeof resultHead === 'string' ? resultHead : undefined,
        ['none', 'prepared', 'uncertain', 'refused', 'ready'].includes(resultState as string)
          ? resultState as 'none' | 'prepared' | 'uncertain' | 'refused' | 'ready' : 'none');
    } } : {}),
  };
}

/**
 * D's Claude start call for an execute attempt. The input mount holds only the schema, in the attempt's own directory,
 * which the coordinator removes with the rest of its preparation once D settled.
 */
export function claudeLauncher(o: { imageId: string; runnerRoot: string; runnerOwner: string; token: string;
  start?: typeof startClaudeInvocation }): AgentLauncher {
  return (input, prompt, workspace, treeCheck) => {
    if (!isUuidV4(input.attemptId)) throw new Error('Attempt ID must be a UUID v4.');
    const directory = join(o.runnerRoot, o.runnerOwner, 'attempts', input.attemptId, 'input');
    mkdirSync(directory, { mode: 0o755 });
    // The container user reads it; the directory stays writable by its owner, so cleanup can remove it.
    chmodSync(directory, 0o755);
    const schema = join(directory, 'schema.json');
    writeFileSync(schema, EXECUTE_SCHEMA, { mode: 0o444, flag: 'wx' });
    // The umask narrows a create mode (077 gives 0400), and D refuses a schema the container user cannot read.
    chmodSync(schema, 0o444);
    // D requires the pre-launch tree check made for this storage (#81): it mounts the head's gitlinks from it.
    return (o.start ?? startClaudeInvocation)({ invocation: input, filesystems: workspaceFilesystems(workspace), inputDirectory: directory,
      imageId: o.imageId, prompt, networkAllocationId: randomUUID(), treeCheck }, o.token);
  };
}

/** D's credential-free read-only container for one item's exact `cmd:` argv arrays. */
export function runnerCommandLauncher(o: { imageId: string; runnerRoot: string; runnerOwner: string;
  start?: typeof startRunnerCommandInvocation }) {
  return (input: Parameters<typeof startRunnerCommandInvocation>[0]['invocation'], commands: string,
    workspace: Parameters<typeof workspaceFilesystems>[0]) => {
    if (!isUuidV4(input.attemptId)) throw new Error('Attempt ID must be a UUID v4.');
    const directory = join(o.runnerRoot, o.runnerOwner, 'attempts', input.attemptId, 'input');
    mkdirSync(directory, { mode: 0o755 });
    chmodSync(directory, 0o755);
    const schema = join(directory, 'schema.json');
    writeFileSync(schema, commands, { mode: 0o444, flag: 'wx' });
    chmodSync(schema, 0o444);
    return (o.start ?? startRunnerCommandInvocation)({ invocation: input, filesystems: workspaceFilesystems(workspace),
      inputDirectory: directory, imageId: o.imageId, prompt: '', networkAllocationId: randomUUID() });
  };
}

/**
 * What startup recovery left for a person (runner-lifecycle.md: never removed automatically), one line each. Docker
 * labels and file names are not codeboost's, so each is quoted: a newline or control character in one cannot forge a line.
 */
export function recoveryWarnings(report: Pick<RecoveryReport, 'unmatchedStorage' | 'unknownEntries'>): string[] {
  return [...report.unmatchedStorage.map(attemptId => `Task storage labelled with attempt ${quoteForTerminal(attemptId)} matches no attempt of this database; it was left in place.`),
    ...report.unknownEntries.map(entry => `Unknown entry in the runner's attempt directory, left in place: ${quoteForTerminal(entry)}`)];
}

/** Moved to github/validate.ts so the server can check it without loading the runner (#121). */
export { baseBranch };

export interface RunnerAssembly {
  readonly deps: RunnerDeps;
  /**
   * Builds the task's PR publisher (#103) once the coordinator exists: `closing` is its admission flag, read before each
   * irreversible GitHub change. Absent: nothing is published (tests that only run items).
   */
  readonly publisher?: (closing: () => boolean) => PullRequestPublisher;
  /** The environment the publisher's gh calls and push run with; its token values are removed from recorded errors. */
  readonly env?: NodeJS.ProcessEnv;
  /** Tests only: the delay of the publisher's short retry (SHORT_RETRY_MS, 30 s). */
  readonly shortRetryMs?: number;
  /** F5 production refresh/rebase/check coordinator, built against the configured task PR. */
  readonly preMerge?: (runner: RunnerCoordinator, inspect: (signal?: AbortSignal) => Promise<{ base: string; head: string }>,
    authorize: (signal: AbortSignal) => Promise<PreMergeAuthorization>) => PreMergeCoordinator;
  readonly sources: ExecutionSources;
  readonly findings: SafetyFindings;
  readonly recovery: RecoveryReport;
}
/**
 * Startup with a runner, after the Store opened and before the server admits anything (runner-lifecycle.md, "Startup
 * recovery"): verify the lock still names the database, run recovery under the database's runner token, build the
 * agent image (once D's recovery returns, if it found any storage; otherwise after recovery), then assemble the
 * execution deps. Any failure stops startup; the caller closes the Store.
 */
export async function setUpRunner(o: { service: ReviewService; capability: ShutdownCapability; config: RunnerConfig; lock: Pick<RunnerLock, 'file' | 'verify'>;
  env: Readonly<Record<string, string | undefined>>; buildImage?: () => string; recovery?: (image: () => string) => RecoveryDeps;
  /** Told before the slow part (recovery and the image build) starts. */
  onSlowStart?: () => void }): Promise<RunnerAssembly> {
  const { service, config } = o, review = service.config;
  if (review.demo) throw new Error('Demos never run the runner.');
  if (!review.github) throw new Error(RUNNER_NEEDS_GITHUB);
  const base = baseBranch(review.github);
  // The push URL too (the repository's shape, GH_HOST), before recovery and the image build rather than after them.
  pushUrl(review.github.repository, o.env as NodeJS.ProcessEnv);
  const token = o.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) throw new Error(RUNNER_CREDENTIAL_MISSING);
  // Decision 1, step 4: the database path still names the locked file, now that the Store has opened it.
  o.lock.verify();
  const runnerOwner = service.store.runnerOwnerToken(o.lock.file);
  ownerOnlyDirectory(config.root);
  // Per database (its runner token): retention reads references from this Store only, so it must never see another
  // database's files. The lock is per database, so two runners can share a root or a configured directory.
  const diagnosticsDir = ownerOnlyDirectory(config.diagnosticsDir ?? config.root, runnerOwner, 'diagnostics');
  o.onSlowStart?.();
  let built: string | undefined;
  const image = () => built ??= (o.buildImage ?? buildAgentImage)();
  const identity = review.identity;
  const rebasePlanKey = identityKey(identity);
  let repositoryPromise: Promise<RunnerRepository> | undefined, rebaserPromise: Promise<GitRebaser> | undefined;
  let authorizePreMerge: ((signal: AbortSignal) => Promise<PreMergeAuthorization>) | undefined;
  const getRepository = () => repositoryPromise ??= openRunnerRepository({ runnerRoot: config.root, runnerOwner,
    repositoryId: identity.repositoryId, source: review.repository }).then(async repository => {
      // The review and rebase recovery read the same runner-owned repository that execution writes.
      if (review.runnerRepository !== undefined && review.runnerRepository !== repository.path)
        throw new Error(`runnerRepository (${review.runnerRepository}) is not the runner's repository (${repository.path}); remove it from the configuration.`);
      // A fresh bare repository has no objects yet. Seed the recorded snapshot before selecting it for review reads;
      // otherwise the server cannot render the initial review, and no execution attempt can get far enough to import it.
      const snapshot = service.store.getSnapshot(identity);
      await ensureCommit(repository, snapshot.base);
      await ensureCommit(repository, snapshot.head);
      review.runnerRepository = repository.path;
      return repository;
    });
  // Assemble the trusted local rewrite/conflict engine here so startup can recover its durable markers. The F5
  // coordinator below is its only live entry point; exposing the raw rebaser would bypass refresh, admission and checks.
  const getRebaser = () => rebaserPromise ??= getRepository().then(repository => new GitRebaser({ repository,
    runnerRoot: config.root, runnerOwner, committer: config.committer,
    onProcessStarting: attemptId => o.capability.run(() => service.store.setRebaseProcessGroup(rebasePlanKey, attemptId, null, 'spawning')),
    onProcessGroup: (attemptId, group) => o.capability.run(() => service.store.setRebaseProcessGroup(rebasePlanKey, attemptId, 'spawning', group)),
    onProcessGroupSettled: (attemptId, group) => o.capability.run(() => service.store.setRebaseProcessGroup(rebasePlanKey, attemptId, group, null)),
    onProcessUnsettled: (attemptId, group) => o.capability.run(() => service.store.setRebaseProcessGroup(rebasePlanKey, attemptId, group, 'unsettled')),
    onResultPrepared: (attemptId, head, history, conflicts) => o.capability.run(() => service.store.prepareRebaseResult(rebasePlanKey, attemptId, head, history, conflicts)),
    onResultState: (attemptId, state) => state === 'ready'
      ? o.capability.run(() => service.store.completeRebaseResult(rebasePlanKey, attemptId))
      : o.capability.run(() => service.store.setRebaseResultState(rebasePlanKey, attemptId, state)),
    resolveForeignConflict: createForeignConflictResolver({ store: service.store, identity, planKey: rebasePlanKey,
      repository, runnerOwner, image, token,
      authorize: signal => {
        if (!authorizePreMerge) throw new GuardRefusal('Issue trust admission is not configured.');
        return authorizePreMerge(signal).then(async authorization => {
          await authorization.refresh();
          return () => authorization.validate();
        });
      },
      limits: { ...EXECUTE_STORAGE, ...config.limits } }) }));
  const recovery = await recoverStartup({ store: service.store, runnerOwner, runnerRoot: config.root, diagnosticsDir,
    diagnosticsCapBytes: config.diagnosticsCapBytes,
    deps: o.recovery ? o.recovery(image) : dRecoveryDeps(image,
      { abort: async (attemptId, resultHead, state) => (await getRebaser()).abort(attemptId, resultHead, state) }, rebasePlanKey) });
  service.store.settleInterruptedPreMergeActions(identity);
  const repository = await getRepository();
  const imageId = image();
  const workspace = createTaskWorkspace({ store: service.store, runnerRoot: config.root, runnerOwner, repository, imageId,
    limits: { ...EXECUTE_STORAGE, ...config.limits }, committer: config.committer });
  const issues = new GhIssueGateway(review.github.repository);
  /**
   * The last issue text read, reused for ISSUE_REUSE_MS: a plan's items run one after another and would otherwise each
   * read the issue, every collaborator page and every comment page again. Only a completed read is kept. The window is
   * measured on the monotonic clock, so a wall-clock step back cannot stretch it.
   */
  let lastRead: { access: IssueAccess; trustedAuthor: string | null | undefined; at: number; text: IssueText } | null = null;
  const issueText = (number: number, signal: AbortSignal): Promise<GuardedIssueText> => withIssueReadDeadline(signal, async (readSignal, timeoutMs) => {
    const access = await issues.issueAccess(number, { signal: readSignal, timeoutMs });
    const trust = service.store.issueTrust(review.github!.repository, number);
    const explicitlyTrusted = trust?.revokedAt === null && trust.authorLogin === access.authorLogin;
    if (!access.collaborator && !explicitlyTrusted) throw new GuardRefusal(`Issue #${number} is not trusted for its current author.`);
    const trustedAuthor = explicitlyTrusted ? access.authorLogin : undefined;
    const validate = () => {
      if (trustedAuthor === undefined) return;
      const current = service.store.issueTrust(review.github!.repository, number);
      if (!current || current.revokedAt !== null || current.authorLogin !== trustedAuthor)
        throw new GuardRefusal(`Issue #${number} is not trusted for its current author.`);
    };
    // Explicit trust deliberately admits every comment and is fully represented by `trustedAuthor`. Collaborator-only
    // reads depend on the complete current collaborator set, which IssueAccess does not carry, so never cache them.
    if (trustedAuthor !== undefined && lastRead && lastRead.access.number === number && lastRead.access.authorLogin === access.authorLogin
      && lastRead.access.collaborator === access.collaborator && lastRead.trustedAuthor === trustedAuthor
      && performance.now() - lastRead.at < ISSUE_REUSE_MS) return { text: lastRead.text, validate };
    const at = performance.now(), text = await issues.issueText(number, { signal: readSignal, timeoutMs, trustedAuthor, expectedAccess: access });
    validate();
    lastRead = { access, trustedAuthor, at, text };
    return { text, validate };
  });
  const only = (requested: typeof identity) => {
    if (identityKey(requested) !== identityKey(identity)) throw new Error('This server runs only its configured plan.');
  };
  const sources: ExecutionSources = {
    planContext: requested => { only(requested); return service.planContext(); },
    checkpointContext: (requested, head) => { only(requested); return service.planContextAt(head); },
    issue: (requested, signal) => { only(requested); return issueText(service.store.getPlan(identity).issue, signal); },
    // Learning (L1–L4) is not built: no lesson is approved yet.
    lessons: () => [],
    // Codex is refused in every phase (#93).
    vendor: () => 'claude',
  };
  const findings = new SafetyFindings(service.store, o.capability);
  const deps = combineRunnerDeps(
    executionDeps(service.store, workspace, claudeLauncher({ imageId, runnerRoot: config.root, runnerOwner, token }), sources, runnerOwner, findings,
      { diagnostics: { directory: diagnosticsDir, capBytes: config.diagnosticsCapBytes ?? DEFAULT_DIAGNOSTICS_CAP_BYTES } }),
    commandCheckDeps(service.store, workspace,
      runnerCommandLauncher({ imageId, runnerRoot: config.root, runnerOwner }), review.allowedCommands ?? [], runnerOwner));
  const github = review.github;
  // Never a `url` here (#101 review, finding 6): the push goes to the configured repository on GH_HOST, from the runner's
  // own repository. Only commits the ledger records as codeboost's may be overwritten. The F3 rebase foundation can
  // write mapped foreign entries, but #22 does not wire their external push until its later durable-action slice.
  const pusher = new GitBranchPusher({ repository, repositoryId: identity.repositoryId, remote: github.repository, env: o.env as NodeJS.ProcessEnv,
    ownedCommits: requested => service.store.getLedger(requested).filter(entry => entry.origin === 'owned').map(entry => entry.sha) });
  // The same environment as the push, so the PR calls go to the same GH_HOST with the same credentials.
  const env = o.env as NodeJS.ProcessEnv;
  const publisher = (closing: () => boolean) => new PullRequestPublisher(service.store, { checks: new GhAlreadyFixedGateway({ repository: github.repository, env }),
    pulls: new GhPullRequestGateway({ repository: github.repository, env }), pusher, closing }, { repository: github.repository, baseBranch: base });
  const rebaser = await getRebaser();
  const preMerge = (runner: RunnerCoordinator,
    inspect: (signal?: AbortSignal) => Promise<{ base: string; head: string }>,
    authorize: (signal: AbortSignal) => Promise<PreMergeAuthorization>) => {
    authorizePreMerge = authorize;
    return new PreMergeCoordinator(service, runner, rebaser, {
      inspect,
      fetch: (pair, signal) => pusher.fetchCommits([pair.base, pair.head], signal),
    }, undefined, o.capability, authorize);
  };
  return { deps, sources, findings, recovery, publisher, env, preMerge };
}
