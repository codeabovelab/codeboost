import { createHash } from 'node:crypto';
import type { InvocationContext, Phase, StopReason } from '../agents/contract.ts';

/** F1 runner lifecycle vocabulary. See docs/implementation/runner-lifecycle.md. */
export type AttemptState = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'stale';
export type FirstReason = 'cancelled' | 'shutdown' | 'stale' | 'time-limit';
export type AttemptKind = 'planning' | 'question' | 'review' | 'check' | 'execute' | 'fix' | 'rebase-fix';
export type TaskStatus = 'queued' | 'running' | 'needs human' | 'needs amendment' | 'needs approval'
  | 'possibly already fixed' | 'in review' | 'approved but merge blocked' | 'merged' | 'cancelled';

export const TASK_STATUSES: readonly TaskStatus[] = ['queued', 'running', 'needs human', 'needs amendment', 'needs approval',
  'possibly already fixed', 'in review', 'approved but merge blocked', 'merged', 'cancelled'];
export const CLOSED_STATUSES: readonly TaskStatus[] = ['merged', 'cancelled'];
export const TERMINAL_STATES: readonly AttemptState[] = ['completed', 'failed', 'cancelled', 'stale'];
export const FIRST_REASONS: readonly FirstReason[] = ['cancelled', 'shutdown', 'stale', 'time-limit'];
/** Each F attempt kind runs under exactly one existing D phase. */
export const ATTEMPT_PHASES = {
  planning: 'planning', question: 'questions', review: 'review', check: 'review',
  execute: 'execute', fix: 'fix', 'rebase-fix': 'fix',
} as const satisfies Record<AttemptKind, Phase>;
export const WRITABLE_KINDS: readonly AttemptKind[] = ['execute', 'fix', 'rebase-fix'];
export const MAX_REASON = 4000;
export const MAX_RESULT_BYTES = 1024 * 1024;
export const DEFAULT_TASK_BUDGET_MS = 2 * 60 * 60 * 1000;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Attempt, action and allocation IDs are lowercase UUID v4s; anything else is refused before use. */
export function isUuidV4(value: unknown): value is string { return typeof value === 'string' && UUID_V4.test(value); }
export function assertUuidV4(value: unknown, name: string): asserts value is string {
  if (!isUuidV4(value)) throw new GuardRefusal(`${name} must be a lowercase UUID v4.`);
}

/** A guard refused the action. Refusals are definite outcomes and are recorded for replay. */
export class GuardRefusal extends Error {}
/** Reusing an action ID for a different request. */
export class ActionIdReused extends GuardRefusal {}

export function bounded(reason: string): string {
  const text = reason.trim() || 'No reason given.';
  return text.length > MAX_REASON ? `${text.slice(0, MAX_REASON - 1)}…` : text;
}

/** Stable fingerprint of a user action request; key order does not matter. */
export function requestHash(kind: string, request: unknown): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]))
      : value;
  return createHash('sha256').update(JSON.stringify([kind, canonical(request)])).digest('hex');
}

export interface Settlement {
  /** F's first reason: the durable one, or the in-memory one if its write failed. */
  firstReason: FirstReason | null;
  contextCurrent: boolean;
  stopReason?: StopReason;
  exitCode: number | null;
  /** Output passed validation (schema, size and, for writable attempts, the file-scope audit). */
  valid: boolean;
  /** Bounded actionable detail from the provider, used for generic failures. */
  detail?: string;
}
export interface Classification {
  state: Exclude<AttemptState, 'pending' | 'running'>;
  reason: string | null;
  /** The task budget ran out; the task moves to needs human unless it is closed or a cancel is pending. */
  timeLimit: boolean;
}

/** Terminal-state precedence at settlement. Order matters; see "Rules for the running state", rule 2. */
export function classifySettlement(s: Settlement): Classification {
  const dFailure = s.stopReason === 'timeout' || s.stopReason === 'output-limit' || s.stopReason === 'capture-failure';
  const dReason = () => s.stopReason === 'timeout' ? 'Timed out.' : bounded(s.detail ?? `Agent stopped: ${s.stopReason}.`);
  switch (s.firstReason) {
    case 'cancelled': return { state: 'cancelled', reason: 'Cancelled.', timeLimit: false };
    // D keeps the first reason it received: a non-shutdown stop reason proves D stopped before shutdown reached it.
    case 'shutdown': return dFailure ? { state: 'failed', reason: dReason(), timeLimit: false }
      : { state: 'cancelled', reason: 'Stopped by shutdown', timeLimit: false };
    case 'stale': return { state: 'stale', reason: bounded(s.detail ?? 'The plan, snapshot, assignment or referenced code changed.'), timeLimit: false };
    case 'time-limit': return { state: 'cancelled', reason: 'Task time limit reached', timeLimit: true };
  }
  if (!s.contextCurrent) return { state: 'stale', reason: 'The plan, snapshot, assignment or referenced code changed.', timeLimit: false };
  if (dFailure) return { state: 'failed', reason: dReason(), timeLimit: false };
  if (s.exitCode === 0 && s.valid) return { state: 'completed', reason: null, timeLimit: false };
  return { state: 'failed', reason: bounded(s.detail ?? `Agent exited with code ${s.exitCode ?? 'none'}.`), timeLimit: false };
}

export function sameContext(a: InvocationContext, b: InvocationContext): boolean {
  return a.snapshotId === b.snapshotId && a.planId === b.planId && a.planRevision === b.planRevision
    && a.assignmentId === b.assignmentId && a.referencedCodeHash === b.referencedCodeHash && a.stateVersion === b.stateVersion;
}
