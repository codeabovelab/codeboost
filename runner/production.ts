import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { buildAgentImage } from '../agents/container/image.ts';
import { exportTaskDiff, removeTaskFilesystemsAsync, type TaskStorageLimits } from '../agents/container/storage.ts';
import { recoverLeftovers } from '../agents/recovery.ts';
import { startClaudeInvocation } from '../agents/adapters/claude.ts';
import { GhIssueGateway } from '../github/issues.ts';
import { identityKey } from '../core/identity.ts';
import type { RunnerDeps } from './coordinator.ts';
import { DEFAULT_DIAGNOSTICS_CAP_BYTES } from './diagnostics.ts';
import { executionDeps, SafetyFindings, type AgentLauncher, type ExecutionSources } from './execution.ts';
import { isUuidV4, type ShutdownCapability } from './lifecycle.ts';
import { recoverStartup, type RecoveryDeps, type RecoveryReport, type RunnerLock } from './recovery.ts';
import type { ReviewService } from './review.ts';
import { openRunnerRepository, ownerOnlyDirectory } from './runner-repository.ts';
import { createTaskWorkspace, workspaceFilesystems } from './workspace.ts';

/**
 * The production runner (#91): D's real workspace, launcher, recovery, export and removal, under the database's runner
 * token. Opt-in through the review configuration's `runner` block; demos never run it.
 */
export interface RunnerConfig {
  /** Absolute; owner-only. Attempt directories and the runner-owned repository live under `<root>/<runnerOwner>/`. */
  readonly root: string;
  /** Absolute; owner-only. Partial output of stopped attempts. Default `<root>/diagnostics`. */
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
export const RUNNER_CREDENTIAL_MISSING = 'The runner runs Claude Code, which needs CLAUDE_CODE_OAUTH_TOKEN. Create one with `claude setup-token`, set it, and restart codeboost.';

/** Check the `runner` block of a review configuration before anything is created. */
export function parseRunnerConfig(value: unknown): RunnerConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The runner block must be an object.');
  const v = value as Record<string, unknown>;
  const path = (field: string, text: unknown) => {
    if (typeof text !== 'string' || !isAbsolute(text) || text.includes('\0')) throw new Error(`runner.${field} must be an absolute path.`);
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
      if (!(key in EXECUTE_STORAGE) || !Number.isSafeInteger(n) || (n as number) < 1) throw new Error(`runner.limits.${key} is not a positive storage limit.`);
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
 * older build takes no lock this build can see, so one may still be running. Each is reported as the command that
 * removes it, for a person to run once every older codeboost process has stopped.
 */
export function dRecoveryDeps(imageId: string): RecoveryDeps {
  return {
    async recoverLeftovers(runnerOwner) {
      const report = await recoverLeftovers(runnerOwner, 120_000);
      return {
        // D's handle object itself: its trust is keyed by identity, so a copy would be refused.
        storage: report.storage.map(handle => ({ attemptId: handle.attemptId, allocationId: handle.allocationId, handle })),
        unowned: report.unowned.map(resource =>
          `docker ${resource.kind} rm${resource.kind === 'container' ? ' -f' : ''} ${resource.id ?? resource.name} (${resource.reason})`),
      };
    },
    exportTaskDiff: (handle, input, maxBytes, signal) =>
      exportTaskDiff(handle as Parameters<typeof exportTaskDiff>[0], { base: input.base, metadataBaseline: input.metadataBaseline, imageId, maxBytes, signal }),
    removeTaskFilesystems: handle => removeTaskFilesystemsAsync(handle as Parameters<typeof removeTaskFilesystemsAsync>[0]),
  };
}

/**
 * D's Claude start call for an execute attempt. The input mount holds only the schema, in the attempt's own directory,
 * which the coordinator removes with the rest of its preparation once D settled.
 */
export function claudeLauncher(o: { imageId: string; runnerRoot: string; runnerOwner: string; token: string;
  start?: typeof startClaudeInvocation }): AgentLauncher {
  return (input, prompt, workspace) => {
    if (!isUuidV4(input.attemptId)) throw new Error('Attempt ID must be a UUID v4.');
    const directory = join(o.runnerRoot, o.runnerOwner, 'attempts', input.attemptId, 'input');
    mkdirSync(directory, { mode: 0o755 });
    // The container user reads it; the directory stays writable by its owner, so cleanup can remove it.
    chmodSync(directory, 0o755);
    writeFileSync(join(directory, 'schema.json'), EXECUTE_SCHEMA, { mode: 0o444, flag: 'wx' });
    return (o.start ?? startClaudeInvocation)({ invocation: input, filesystems: workspaceFilesystems(workspace), inputDirectory: directory,
      imageId: o.imageId, prompt, networkAllocationId: randomUUID() }, o.token);
  };
}

export interface RunnerAssembly {
  readonly deps: RunnerDeps;
  readonly sources: ExecutionSources;
  readonly findings: SafetyFindings;
  readonly recovery: RecoveryReport;
}
/**
 * Startup with a runner, after the Store opened and before the server admits anything (runner-lifecycle.md, "Startup
 * recovery"): verify the lock still names the database, build the agent image, run recovery under the database's
 * runner token, then assemble the execution deps. Any failure stops startup; the caller closes the Store.
 */
export async function setUpRunner(o: { service: ReviewService; capability: ShutdownCapability; config: RunnerConfig; lock: Pick<RunnerLock, 'file' | 'verify'>;
  env: Readonly<Record<string, string | undefined>>; buildImage?: () => string; recovery?: (imageId: string) => RecoveryDeps;
  /** Told before the slow part (the image build and recovery) starts. */
  onSlowStart?: () => void }): Promise<RunnerAssembly> {
  const { service, config } = o, review = service.config;
  if (review.demo) throw new Error('Demos never run the runner.');
  if (!review.github) throw new Error('The runner reads the plan\'s issue from GitHub: add a github block to the review configuration.');
  const token = o.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) throw new Error(RUNNER_CREDENTIAL_MISSING);
  // Decision 1, step 4: the database path still names the locked file, now that the Store has opened it.
  o.lock.verify();
  const runnerOwner = service.store.runnerOwnerToken(o.lock.file);
  ownerOnlyDirectory(config.root);
  const diagnosticsDir = config.diagnosticsDir ?? join(config.root, 'diagnostics');
  ownerOnlyDirectory(diagnosticsDir);
  o.onSlowStart?.();
  const imageId = (o.buildImage ?? buildAgentImage)();
  const recovery = await recoverStartup({ store: service.store, runnerOwner, runnerRoot: config.root, diagnosticsDir,
    diagnosticsCapBytes: config.diagnosticsCapBytes, deps: (o.recovery ?? dRecoveryDeps)(imageId) });
  const identity = review.identity;
  const repository = await openRunnerRepository({ runnerRoot: config.root, runnerOwner, repositoryId: identity.repositoryId, source: review.repository });
  // The review reads runner commits from the same repository the runner writes; a configured path must agree.
  if (review.runnerRepository !== undefined && review.runnerRepository !== repository.path)
    throw new Error(`runnerRepository (${review.runnerRepository}) is not the runner's repository (${repository.path}); remove it from the configuration.`);
  review.runnerRepository = repository.path;
  const workspace = createTaskWorkspace({ store: service.store, runnerRoot: config.root, runnerOwner, repository, imageId,
    limits: { ...EXECUTE_STORAGE, ...config.limits }, committer: config.committer });
  const issues = new GhIssueGateway(review.github.repository);
  const only = (requested: typeof identity) => {
    if (identityKey(requested) !== identityKey(identity)) throw new Error('This server runs only its configured plan.');
  };
  const sources: ExecutionSources = {
    planContext: requested => { only(requested); return service.planContext(); },
    issue: (requested, signal) => { only(requested); return issues.issueText(service.store.getPlan(identity).issue, { signal, timeoutMs: 30_000 }); },
    // Learning (L1–L4) is not built: no lesson is approved yet.
    lessons: () => [],
    // Codex is refused in every phase (#93).
    vendor: () => 'claude',
  };
  const findings = new SafetyFindings(service.store, o.capability);
  const deps = executionDeps(service.store, workspace, claudeLauncher({ imageId, runnerRoot: config.root, runnerOwner, token }), sources, runnerOwner, findings,
    { diagnostics: { directory: diagnosticsDir, capBytes: config.diagnosticsCapBytes ?? DEFAULT_DIAGNOSTICS_CAP_BYTES } });
  return { deps, sources, findings, recovery };
}
