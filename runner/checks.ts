import { createHash } from 'node:crypto';
import type { InvocationHandle, InvocationInput } from '../agents/contract.ts';
import { commandAllowed, commandArgv } from '../core/plan.ts';
import type { PlanIdentity } from '../core/identity.ts';
import { findIdentity, type TaskWorkspace, type WorkspaceRef } from './execution.ts';
import type { PreparedAttempt, RunnerDeps } from './coordinator.ts';
import type { AttemptRecord, Store } from './store.ts';

export interface CommandCheckResult { head: string; commandsDigest: string; passed: true }
interface Private { workspace: WorkspaceRef; head: string; commands: readonly (readonly string[])[]; commandsDigest: string }
export type RunnerCommandLauncher = (input: InvocationInput, commands: string, workspace: WorkspaceRef) => InvocationHandle;

export function commandDigest(commands: readonly (readonly string[])[]): string {
  if (commands.some(argv => argv.some(argument => !argument.isWellFormed())))
    throw new Error('Command arguments must be well-formed Unicode.');
  return createHash('sha256').update(JSON.stringify(commands)).digest('hex');
}

/** Read-only, head-bound `cmd:` attempts. A non-zero command exit is a failed attempt and never passing evidence. */
export function commandCheckDeps(store: Store, workspace: TaskWorkspace,
  launch: RunnerCommandLauncher, context: (identity: PlanIdentity) => { allowedCommands: readonly (readonly string[])[] },
  runnerOwner: string): RunnerDeps {
  return {
    runnerOwner, kinds: ['check'],
    async prepare(attempt, signal) {
      if (attempt.kind !== 'check' || !attempt.item) throw new Error('Command-check deps run one plan item.');
      const identity = findIdentity(store, attempt), plan = store.getPlan(identity, attempt.context.planRevision);
      const item = plan.items.find(candidate => candidate.id === attempt.item);
      if (!item) throw new Error('Unknown command-check item.');
      const allowed = context(identity).allowedCommands;
      const commands = item.acceptance.filter(check => check.type === 'cmd').map(check => commandArgv(check.text));
      if (!commands.length) throw new Error('This plan item has no command checks.');
      if (commands.some(argv => !commandAllowed(argv, allowed))) throw new Error('A command check is not approved in allowedCommands.');
      const head = store.getSnapshot(identity, attempt.context.snapshotId).head;
      const materialized = await workspace.materialize(attempt, head, signal);
      return { clone: materialized.clone, vendor: 'runner', approvedArgv: commands,
        private: { workspace: materialized, head, commands, commandsDigest: commandDigest(commands) } satisfies Private };
    },
    async cleanupPreparation(attempt) { await workspace.cleanupPreparation?.(attempt); },
    start(input, prepared) {
      const data = prepared.private as Private;
      return launch(input, JSON.stringify(data.commands), data.workspace);
    },
    validate() { throw new Error('Command checks publish through finish().'); },
    async finish(attempt, result, prepared) {
      if (result.exitCode !== 0 || result.stopReason) throw new Error('Command checks did not pass.');
      const data = prepared.private as Private;
      return { value: { head: data.head, commandsDigest: data.commandsDigest, passed: true } satisfies CommandCheckResult };
    },
    async release(_attempt, prepared) { await workspace.release?.((prepared.private as Private).workspace); },
  };
}
