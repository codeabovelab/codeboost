import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Store, type ReviewState, type SnippetReference } from './store.ts';
import type { PlanIdentity } from '../core/identity.ts';
import { readHistory } from '../git/history.ts';
import { execFileSync } from 'node:child_process';
import { isolatedGitEnvironment } from '../scripts/git-environment.ts';
import type { BaseEntry, PlanContext } from '../core/plan.ts';
import { linkHistory } from '../core/linking.ts';
import { applyChoices, approvalStates, approveItem, choiceKeys } from '../core/approvals.ts';
import type { GhMergeConfig } from '../github/merge.ts';

export interface ReviewConfig { database: string; repository: string; identity: PlanIdentity; pathIdentity: { caseSensitive: boolean; unicodeNormalization: 'none' | 'NFC' }; demo?: boolean; github?: GhMergeConfig }
export class ReviewService {
  store: Store;
  config: ReviewConfig;
  constructor(config: ReviewConfig) {
    if (typeof config.pathIdentity?.caseSensitive !== 'boolean' || !['none', 'NFC'].includes(config.pathIdentity.unicodeNormalization)) throw new Error('Known checkout path identity is required.');
    this.config = config; this.store = new Store(config.database);
  }
  close() { this.store.close(); }
  load() {
    const { identity, repository, pathIdentity } = this.config;
    const reviewVersion = this.store.reviewVersion(identity);
    const plan = this.store.getPlan(identity);
    let snapshot = this.store.getSnapshot(identity);
    // HEAD changes are observed; no Git mutation is performed by the review service.
    const history = readHistory(repository, snapshot.base, 'HEAD');
    if (history.head !== snapshot.head) snapshot = this.store.recordHistory(identity, { revision: plan.revision, snapshotId: snapshot.id, reviewVersion }, history.base, history.head, []);
    const pathKey = (path: string) => {
      if (!pathIdentity.caseSensitive && /[^\x20-\x7e]/.test(path)) throw new Error('Non-ASCII case-insensitive paths require a filesystem-specific identity adapter.');
      const normalized = pathIdentity.unicodeNormalization === 'NFC' ? path.normalize('NFC') : path;
      return pathIdentity.caseSensitive ? normalized : normalized.toLowerCase();
    };
    const raw = linkHistory(plan, history, this.store.ownership(identity, plan.revision), pathKey);
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
    for (const item of plan.items) {
      if (states[item.id] === 'approved' && (segments.some(segment => segment.row === 'Ambiguous' && segment.owners.includes(item.id)) || item.depends_on.some(id => states[id] === 'stale'))) states[item.id] = 'stale';
    }
    const expected: ReviewState = { revision: plan.revision, snapshotId: snapshot.id, reviewVersion };
    const contextIds = new Map(plan.items.map(item => [item.id,createHash('sha256').update(JSON.stringify(segments.filter(segment=>segment.row===item.id).map(segment=>segment.key))).digest('hex')]));
    const notes = this.store.getReviewNotes(identity).map(note => {const contextId=contextIds.get(note.item)!;return { ...note, contextId, answerOutdated: note.snapshotId!==snapshot.id || note.revision!==plan.revision || (!!note.answer?.contextId && note.answer.contextId!==contextId), outdated: !!note.reference && (note.reference.head !== history.head || note.reference.base !== history.base || !segments.some(segment => segment.key === note.reference!.key && segment.row === note.item)) };});
    if (this.store.reviewVersion(identity) !== reviewVersion || this.store.getPlan(identity).revision !== plan.revision || this.store.getSnapshot(identity).id !== snapshot.id) throw new Error('Stale review state. Reload before writing.');
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
        if (!reasons.length) reasons.push('Code or plan definition changed');
      }
      return { ...item, state: states[item.id], count: owned.length, ambiguousCount: ambiguous, reasons, before,
        checks: { attributed: ambiguous ? `! ${ambiguous} ambiguous` : owned.length ? '✓ Attributed' : '– No changes', scope: outside.length ? `✕ ${new Set(outside).size} out of scope` : owned.length ? '✓ In scope' : '– No changes', tests: item.acceptance.some(check => check.type === 'cmd') ? '– Not run' : '– No tests defined', ai: '– Not run' }, outside: [...new Set(outside)],
      };
    });
    const token = createHash('sha256').update(JSON.stringify({ expected, saved, plan, segments })).digest('hex');
    return { repository: basename(repository), demo: this.config.demo ?? false, plan, snapshot, expected, token, items, segments, notes, approved: items.filter(item => item.state === 'approved').length };
  }
  /** The trusted plan context for import and Apply: base entries from the snapshot's base tree, and the configured path identity. */
  planContext(): PlanContext {
    const { identity, repository, pathIdentity } = this.config, plan = this.store.getPlan(identity), snapshot = this.store.getSnapshot(identity);
    const pathKey = (path: string) => {
      if (!pathIdentity.caseSensitive && /[^\x20-\x7e]/.test(path)) throw new Error('Non-ASCII case-insensitive paths require a filesystem-specific identity adapter.');
      const normalized = pathIdentity.unicodeNormalization === 'NFC' ? path.normalize('NFC') : path;
      return pathIdentity.caseSensitive ? normalized : normalized.toLowerCase();
    };
    const listing = execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'ls-tree', '-rz', snapshot.base], { cwd: repository, env: isolatedGitEnvironment(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const baseEntries: BaseEntry[] = listing.split('\0').filter(Boolean).map(record => {
      const split = record.indexOf('\t'), [mode, , oid] = record.slice(0, split).split(' '), path = record.slice(split + 1);
      if (mode === '160000') return { path, kind: 'gitlink' };
      if (mode === '120000') return { path, kind: 'symlink', target: execFileSync('git', ['cat-file', 'blob', oid!], { cwd: repository, env: isolatedGitEnvironment(), encoding: 'utf8' }) };
      return { path, kind: 'file' };
    });
    return { identity, issue: plan.issue, baseEntries, pathKey, allowedCommands: [] };
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
