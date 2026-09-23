import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Store, type ReviewState } from './store.ts';
import type { PlanIdentity } from '../core/identity.ts';
import { readHistory } from '../git/history.ts';
import { linkHistory } from '../core/linking.ts';
import { applyChoices, approvalStates, approveItem, choiceKeys } from '../core/approvals.ts';

export interface ReviewConfig { database: string; repository: string; identity: PlanIdentity; pathIdentity: { caseSensitive: boolean; unicodeNormalization: 'none' | 'NFC' }; demo?: boolean }
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
    for (const item of plan.items) {
      if (states[item.id] === 'approved' && (segments.some(segment => segment.row === 'Ambiguous' && segment.owners.includes(item.id)) || item.depends_on.some(id => states[id] === 'stale'))) states[item.id] = 'stale';
    }
    const expected: ReviewState = { revision: plan.revision, snapshotId: snapshot.id, reviewVersion };
    const notes = this.store.getReviewNotes(identity);
    if (this.store.reviewVersion(identity) !== reviewVersion || this.store.getPlan(identity).revision !== plan.revision || this.store.getSnapshot(identity).id !== snapshot.id) throw new Error('Stale review state. Reload before writing.');
    const items = plan.items.map(item => {
      const owned = segments.filter(segment => segment.row === item.id);
      const ambiguous = segments.filter(segment => segment.row === 'Ambiguous' && segment.owners.includes(item.id)).length;
      const outside = owned.filter(segment => segment.scope === 'out-of-scope').map(segment => segment.path);
      const prior = saved.approvals.find(approval => approval.item === item.id);
      const before = prior ? JSON.parse(prior.fingerprint) : null;
      const reasons: string[] = [];
      if (states[item.id] === 'stale') {
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
  act(input: unknown) {
    if (!input || typeof input !== 'object') throw new Error('Invalid review command.');
    const command = input as Record<string, unknown>;
    const view = this.load();
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
    } else if (command.action === 'note' && typeof command.item === 'string' && typeof command.text === 'string' && (command.kind === 'question' || command.kind === 'change')) {
      this.store.addReviewNote(identity, view.expected, command.item, command.kind, command.text);
    } else throw new Error('Unknown review command.');
    return this.load();
  }
}
