import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Store, type ReviewState, type SnippetReference } from './store.ts';
import type { PlanIdentity } from '../core/identity.ts';
import { readHistory } from '../git/history.ts';
import { execFileSync } from 'node:child_process';
import { HARDENED_GIT_OPTIONS, hardenedGitEnvironment } from '../scripts/git-environment.ts';
import { commandArgv, PlanError, type BaseEntry, type PlanContext } from '../core/plan.ts';
import { linkHistory } from '../core/linking.ts';
import { applyChoices, approvalStates, approveItem, choiceKeys, fingerprint, reviewedSegment, stable } from '../core/approvals.ts';
import type { PlanItem } from '../core/plan.ts';
import type { GhMergeConfig } from '../github/merge.ts';
import { GuardRefusal } from './lifecycle.ts';
import { commandDigest } from './checks.ts';

export interface ReviewConfig { database: string; repository: string;
  /** The runner-owned repository (#87) holding the production task branch, including its original imported head. */
  runnerRepository?: string;
  identity: PlanIdentity; pathIdentity: { caseSensitive: boolean; unicodeNormalization: 'none' | 'NFC' }; demo?: boolean; github?: GhMergeConfig;
  /** Exact complete argv arrays a stored plan may execute as `cmd:` acceptance checks. */
  allowedCommands?: readonly (readonly string[])[];
  /** The runner block, parsed by `parseRunnerConfig`. Its presence also makes the merge target the task's published PR (#121). */
  runner?: unknown }
export class ReviewService {
  store: Store;
  config: ReviewConfig;
  /**
   * The base tree listing of the last base commit read. A commit's tree never changes, so a later call for the same
   * base reuses it instead of running Git again on the server's thread (each runner item asks for it, #91).
   */
  #baseEntries: { base: string; entries: readonly BaseEntry[] } | null = null;
  #pathKey: (path: string) => string;
  constructor(config: ReviewConfig) {
    if (typeof config.pathIdentity?.caseSensitive !== 'boolean' || !['none', 'NFC'].includes(config.pathIdentity.unicodeNormalization)) throw new Error('Known checkout path identity is required.');
    this.config = config;
    if (config.allowedCommands !== undefined && (!Array.isArray(config.allowedCommands)
      || config.allowedCommands.some(argv => !Array.isArray(argv) || argv.length === 0
        || argv.some(arg => typeof arg !== 'string' || arg.includes('\0')))))
      throw new Error('allowedCommands must contain complete literal argv arrays.');
    this.#pathKey = path => {
      if (!config.pathIdentity.caseSensitive && /[^\x20-\x7e]/.test(path)) throw new Error('Non-ASCII case-insensitive paths require a filesystem-specific identity adapter.');
      const normalized = config.pathIdentity.unicodeNormalization === 'NFC' ? path.normalize('NFC') : path;
      return config.pathIdentity.caseSensitive ? normalized : normalized.toLowerCase();
    };
    this.store = new Store(config.database, this.#pathKey);
  }
  close() { this.store.close(); }
  /**
   * Where the task's reviewed commits are. Production configures the runner-owned repository after importing the task's
   * original head, so it remains authoritative even when every execution attempt is unchanged. Without one, the review
   * observes the user's repository and HEAD (demo and planted-review behavior).
   */
  reviewRepository(): { path: string; runnerOwned: boolean } {
    if (this.config.runnerRepository) return { path: this.config.runnerRepository, runnerOwned: true };
    if (this.store.hasRunnerCommit(this.config.identity))
      throw new Error('This task has runner commits, so its review needs the runner-owned repository, which is not configured.');
    return { path: this.config.repository, runnerOwned: false };
  }
  load(options: { maxDurationMs?: number } = {}) {
    const { identity } = this.config;
    const reviewVersion = this.store.reviewVersion(identity);
    const plan = this.store.getPlan(identity);
    let snapshot = this.store.getSnapshot(identity);
    const reviewed = this.reviewRepository();
    // HEAD changes in the user's repository are observed; no Git mutation is performed by the review service. Runner
    // commits move the head only through the Store, in the same transaction as their ledger entries, so there the
    // recorded head is read as it is: observing the user's HEAD would record its older commit and roll the task back.
    const history = readHistory(reviewed.path, snapshot.base, reviewed.runnerOwned ? snapshot.head : 'HEAD',
      options.maxDurationMs === undefined ? {} : { maxDurationMs: options.maxDurationMs });
    if (history.head !== snapshot.head) snapshot = this.store.recordHistory(identity, { revision: plan.revision, snapshotId: snapshot.id, reviewVersion }, history.base, history.head, []);
    const pathKey = this.#pathKey;
    const ledger = this.store.getLedger(identity);
    const raw = linkHistory(plan, history, this.store.ownership(identity, plan.revision), pathKey, {},
      new Set(ledger.filter(entry => entry.conflictResolved).map(entry => entry.sha)));
    const saved = this.store.getReview(identity), keys = choiceKeys(raw, identity);
    const deltas = new Map(history.final.map(file => [JSON.stringify([file.newPath ?? file.oldPath, file.oldPath]), file]));
    let previewBudget = 6 * 1024 * 1024;
    const preview = (value: string | undefined) => {
      if (!value || value.length > previewBudget) return null;
      previewBudget -= value.length; return value;
    };
    const segments = applyChoices(plan, raw, saved.choices, identity).map((segment, index) => {
      const target = plan.items.find(item => item.id === segment.row);
      if (target && segment.row !== raw[index]!.row) {
        const declared = new Set(target.files.flatMap(file => [file.path, ...(file.renamed_from ? [file.renamed_from] : [])]).map(pathKey));
        segment.scope = declared.has(pathKey(segment.path)) ? 'in-scope' : 'out-of-scope';
      }
      const delta = segment.kind === 'file' ? deltas.get(JSON.stringify([segment.path, segment.oldPath])) : undefined;
      const file = delta ? { oldSize: delta.before?.byteSize ?? null, newSize: delta.after?.byteSize ?? null, beforePreview: preview(delta.before?.preview), afterPreview: preview(delta.after?.preview) } : null;
      return { ...segment, file, key: createHash('sha256').update(keys[index]!).digest('hex'), originalRow: raw[index]!.row };
    });
    const states = approvalStates(plan, segments, saved.approvals, identity);
    const mergeAttempt = this.store.getMergeAttempt(identity);
    const replacementReview = !!mergeAttempt && (mergeAttempt.snapshotId !== snapshot.id || mergeAttempt.revision !== plan.revision || mergeAttempt.requiresFreshReview);
    if (replacementReview) for (const item of plan.items) {
      const approval = saved.approvals.find(value => value.item === item.id);
      if (approval && (approval.revision !== plan.revision || approval.snapshotId !== snapshot.id ||
          (mergeAttempt.requiresFreshReview && (approval.reviewVersion === undefined || approval.reviewVersion < mergeAttempt.reviewVersion)))) states[item.id] = 'stale';
    }
    // The execution gate also orders approvals after attribution choices and binds them to the current or executed-prefix
    // snapshots. Reflect that same gate in the review UI so an approval execution would refuse is available to reapprove.
    let executionUnapproved: Set<string>;
    try { executionUnapproved = new Set(this.store.unapprovedExecutionItems(identity, plan.revision)); }
    catch (error) {
      if (!(error instanceof GuardRefusal)) throw error;
      // Keep the review available when checkpoint reconciliation refuses. Surface every saved approval as stale;
      // execution remains fail-closed in Store.unapprovedExecutionItems and resume.
      executionUnapproved = new Set(plan.items.map(item => item.id));
    }
    for (const item of plan.items) if (states[item.id] === 'approved' && executionUnapproved.has(item.id)) states[item.id] = 'stale';
    for (const item of plan.items) {
      if (states[item.id] === 'approved' && (segments.some(segment => segment.row === 'Ambiguous' && segment.owners.includes(item.id)) || item.depends_on.some(id => states[id] === 'stale'))) states[item.id] = 'stale';
    }
    const expected: ReviewState = { revision: plan.revision, snapshotId: snapshot.id, reviewVersion };
    const contextIds = new Map(plan.items.map(item => [item.id,createHash('sha256').update(JSON.stringify(segments.filter(segment=>segment.row===item.id).map(segment=>segment.key))).digest('hex')]));
    const notes = this.store.getReviewNotes(identity).map(note => {const contextId=contextIds.get(note.item)!;return { ...note, contextId, answerOutdated: note.snapshotId!==snapshot.id || note.revision!==plan.revision || (!!note.answer?.contextId && note.answer.contextId!==contextId), outdated: !!note.reference && (note.reference.head !== history.head || note.reference.base !== history.base || !segments.some(segment => segment.key === note.reference!.key && segment.row === note.item)) };});
    if (this.store.reviewVersion(identity) !== reviewVersion || this.store.getPlan(identity).revision !== plan.revision || this.store.getSnapshot(identity).id !== snapshot.id) throw new Error('Stale review state. Reload before writing.');
    // Names each stale item's stale state from every input that decides it, so the page keeps a reviewer's view choice only while that state is unchanged.
    const staleKeys = new Map<string, string | null>();
    // Every field an approval covers, in the approval fingerprint's canonical form, hashed once per segment so a segment shared by many stale items is not serialized once per owner.
    const reviewedDigests = new Map<string, string>();
    const reviewedDigest = (segment: typeof segments[number]) => {
      let digest = reviewedDigests.get(segment.key);
      if (digest === undefined) reviewedDigests.set(segment.key, digest = createHash('sha256').update(stable(reviewedSegment(segment))).digest('hex'));
      return digest;
    };
    const staleKey = (item: PlanItem): string | null => {
      if (staleKeys.has(item.id)) return staleKeys.get(item.id) ?? null;
      staleKeys.set(item.id, null);
      if (states[item.id] !== 'stale') return null;
      const key = createHash('sha256').update(JSON.stringify({
        approval: saved.approvals.find(value => value.item === item.id) ?? null,
        current: fingerprint(item, segments, identity),
        ambiguous: segments.filter(segment => segment.row === 'Ambiguous' && segment.owners.includes(item.id)).map(reviewedDigest),
        dependencies: item.depends_on.map(id => { const dependency = plan.items.find(value => value.id === id); return dependency ? staleKey(dependency) : null; }),
        replacement: replacementReview ? { snapshotId: snapshot.id, revision: plan.revision, requiresFreshReview: mergeAttempt.requiresFreshReview, reviewVersion: mergeAttempt.reviewVersion } : null,
        execution: executionUnapproved.has(item.id) ? { snapshotId: snapshot.id, choices: saved.choices } : null,
      })).digest('hex');
      staleKeys.set(item.id, key);
      return key;
    };
    const items = plan.items.map(item => {
      const owned = segments.filter(segment => segment.row === item.id);
      const ambiguous = segments.filter(segment => segment.row === 'Ambiguous' && segment.owners.includes(item.id)).length;
      const outside = owned.filter(segment => segment.scope === 'out-of-scope').map(segment => segment.path);
      const prior = saved.approvals.find(approval => approval.item === item.id);
      const before = prior ? JSON.parse(prior.fingerprint) : null;
      const reasons: string[] = [];
      if (states[item.id] === 'stale') {
        const approval = saved.approvals.find(value => value.item === item.id);
        if (replacementReview && approval?.snapshotId !== snapshot.id) reasons.push('Pull request snapshot changed after the queue attempt');
        if (replacementReview && approval?.revision !== plan.revision) reasons.push('Plan revision changed after the queue attempt');
        if (mergeAttempt?.requiresFreshReview && approval && (approval.reviewVersion === undefined || approval.reviewVersion < mergeAttempt.reviewVersion)) reasons.push('GitHub requires a fresh review after the queue attempt');
        if (before && !isDeepStrictEqual(before.item.acceptance, item.acceptance)) reasons.push('Acceptance checks changed');
        if (before && owned.some(segment => before.segments.some((old: { path: string; content: string; context: string }) => old.path === segment.path && old.content === segment.content && old.context !== segment.context))) reasons.push('Moved to another function');
        for (const dep of item.depends_on) if (states[dep] === 'stale') reasons.push(`Depends on ${dep}, which changed`);
        if (executionUnapproved.has(item.id)) reasons.push('Execution approval is out of date');
        if (!reasons.length) reasons.push('Code or plan definition changed');
      }
      let tests: string;
      try {
        const commands = item.acceptance.filter(check => check.type === 'cmd').map(check => commandArgv(check.text));
        tests = commands.length
          ? this.store.commandChecksPassed(identity, item.id, snapshot.head, commandDigest(commands)) ? '✓ Passed' : '– Not run'
          : '– No tests defined';
      } catch (error) {
        // Plans imported before exact command spawning rejected malformed Unicode may contain an escaped lone surrogate.
        // Keep the review repairable while making the legacy command visibly and durably non-passing.
        if (!(error instanceof PlanError)) throw error;
        tests = '✕ Invalid command';
      }
      return { ...item, state: states[item.id], count: owned.length, ambiguousCount: ambiguous, reasons, before, staleKey: staleKey(item),
        checks: { attributed: ambiguous ? `! ${ambiguous} ambiguous` : owned.length ? '✓ Attributed' : '– No changes', scope: outside.length ? `✕ ${new Set(outside).size} out of scope` : owned.length ? '✓ In scope' : '– No changes', tests, ai: '– Not run' }, outside: [...new Set(outside)],
      };
    });
    const token = createHash('sha256').update(JSON.stringify({ expected, saved, plan, segments })).digest('hex');
    return { repository: basename(this.config.repository), demo: this.config.demo ?? false, plan, snapshot, expected, token, items, segments, notes, approved: items.filter(item => item.state === 'approved').length };
  }
  /** The trusted plan context for import and Apply, or for a continuation at an audited runner head. */
  planContextAt(head?: string): PlanContext {
    const { identity, repository } = this.config, plan = this.store.getPlan(identity), snapshot = this.store.getSnapshot(identity);
    const pathKey = this.#pathKey;
    // Hardened like every repository Git call (#82, #83): no replace objects, hooks, network or inherited environment.
    const treeHead = head ?? snapshot.base;
    if (head && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head)) throw new Error('Expected a full checkpoint head.');
    const git = (args: string[], maxBuffer?: number) => execFileSync('git', [...HARDENED_GIT_OPTIONS, ...args], {
      cwd: head ? this.reviewRepository().path : repository, env: hardenedGitEnvironment(), encoding: 'utf8', maxBuffer,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (this.#baseEntries?.base !== treeHead) {
      const listing = git(['ls-tree', '-rz', treeHead], 64 * 1024 * 1024);
      const entries: BaseEntry[] = listing.split('\0').filter(Boolean).map(record => {
        const split = record.indexOf('\t'), [mode, , oid] = record.slice(0, split).split(' '), path = record.slice(split + 1);
        if (mode === '160000') return { path, kind: 'gitlink' };
        if (mode === '120000') return { path, kind: 'symlink', target: git(['cat-file', 'blob', oid!], 64 * 1024 * 1024) };
        return { path, kind: 'file' };
      });
      this.#baseEntries = { base: treeHead, entries };
    }
    // Copies: callers own what they are given, and the cached listing stays as Git reported it.
    const baseEntries = this.#baseEntries.entries.map(entry => ({ ...entry }));
    return { identity, issue: plan.issue, baseEntries, pathKey,
      allowedCommands: (this.config.allowedCommands ?? []).map(argv => [...argv]) };
  }
  planContext(): PlanContext { return this.planContextAt(); }
  /** When a checkpoint exists, edits are validated against the audited task head and completed work is excluded. */
  planContextForAmendment(): PlanContext {
    const checkpoint = this.store.latestCheckpoint(this.config.identity);
    if (!checkpoint) return this.planContext();
    const progress = this.store.continuationBasis(this.config.identity);
    if (!progress) throw new Error('The scope checkpoint could not be reconciled.');
    return this.planContextAt(progress.head);
  }
  planningContextForAmendment(): { context: PlanContext; completedItems: string[]; continuation: { checkpointId: string; head: string; completedItems: string[] } | null;
    continuationContext: { checkpointId: string; head: string; completedItems: string[]; ownerItem: string; outOfScopePaths: string[] } | null } {
    const checkpoint = this.store.latestCheckpoint(this.config.identity);
    if (!checkpoint) return { context: this.planContext(), completedItems: [], continuation: null, continuationContext: null };
    const progress = this.store.continuationBasis(this.config.identity);
    if (!progress) throw new Error('The scope checkpoint could not be reconciled.');
    return { context: this.planContextAt(progress.head), completedItems: progress.completed,
      continuation: { checkpointId: checkpoint.id, head: progress.head, completedItems: progress.completed },
      continuationContext: { checkpointId: checkpoint.id, head: progress.head, completedItems: progress.completed, ownerItem: checkpoint.item,
        outOfScopePaths: checkpoint.outOfScopePaths } };
  }
  /** With an actionId (inside Store.userAction), feedback-producing actions record their event in the same transaction. */
  act(input: unknown, actionId?: string) {
    if (!input || typeof input !== 'object') throw new Error('Invalid review command.');
    const command = input as Record<string, unknown>;
    const view = this.load();
    let createdNoteId: string | undefined;
    if (command.token !== view.token) throw new Error('Stale review state. Reload before writing.');
    const { identity } = this.config;
    if (command.action === 'approve' && typeof command.item === 'string') {
      const item = view.items.find(item => item.id === command.item);
      if (item && item.ambiguousCount > 0) throw new Error('Resolve this item’s ambiguous changes before approval.');
      const approval = approveItem(view.plan, view.segments, command.item, identity, command.confirmNoChange === true);
      this.store.saveReview(identity, view.expected, [approval], []);
    } else if ((command.action === 'assign' || command.action === 'accept') && typeof command.key === 'string') {
      const segment = view.segments.find(segment => segment.key === command.key);
      if (!segment || !['Ambiguous', 'Unplanned'].includes(segment.row)) throw new Error('This change cannot be assigned or accepted.');
      const item = command.action === 'assign' && typeof command.item === 'string' ? command.item : null;
      const storedKey = choiceKeys(view.segments, identity)[view.segments.indexOf(segment)]!;
      this.store.saveReview(identity, view.expected, [], [{ key: storedKey, action: command.action, item }]);
      // Choice keys embed segment content and are unbounded; the event's source is a stable fixed-size fingerprint of the key.
      const sourceRef = `choice:${createHash('sha256').update(storedKey).digest('hex')}`;
      if (actionId) this.store.recordFeedback(identity, actionId, command.action === 'assign'
        ? { kind: 'segment-assign', item, sourceRef, supersedeLatest: true }
        : { kind: 'segment-accept', sourceRef, supersedeLatest: true });
    } else if (command.action === 'note' && typeof command.item === 'string' && typeof command.text === 'string' && (command.kind === 'question' || command.kind === 'change')) {
      let reference: SnippetReference | undefined;
      if (command.reference !== undefined) {
        if (!command.reference || typeof command.reference !== 'object') throw new Error('Invalid snippet reference.');
        const input = command.reference as Record<string, unknown>;
        const segment = view.segments.find(s => s.key === input.key && s.row === command.item && s.kind !== 'file');
        const start = input.start as number, end = input.end as number;
        if (!segment || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)) throw new Error('Invalid snippet reference.');
        const first = segment.operation === '+' ? segment.newLine : segment.oldLine;
        const lines = segment.content.split('\n'); if (lines.at(-1) === '') lines.pop();
        if (first === null || start < first || end < start || end >= first + lines.length || end - start >= 200) throw new Error('Select up to 200 lines within one changed block.');
        const text = lines.slice(start-first, end-first+1).join('\n');
        if (text.length > 16000) throw new Error('Selected snippet exceeds 16000 characters.');
        reference = { key: segment.key, path: segment.operation === '-' ? segment.oldPath ?? segment.path : segment.path, side: segment.operation === '+' ? 'new' : 'old', start, end, text, head: view.snapshot.head, base: view.snapshot.base };
      }
      createdNoteId = this.store.addReviewNote(identity, view.expected, command.item, command.kind, command.text, reference).id;
      if (actionId && command.kind === 'change') this.store.recordFeedback(identity, actionId, { kind: 'change-request', item: command.item, text: command.text.trim(), sourceRef: createdNoteId });
    } else throw new Error('Unknown review command.');
    return { ...this.load(), createdNoteId };
  }
}
