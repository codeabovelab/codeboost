import type { Plan, PlanItem } from './plan.ts';
import type { Segment } from './linking.ts';

/** Stable representation ignores object-key order and normalizes CRLF, not whitespace. */
function stable(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value.replace(/\r\n/g, '\n'));
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => `${JSON.stringify(key)}:${stable(val)}`).join(',')}}`;
  return JSON.stringify(value);
}
const contentKey = (s: Segment) => stable({ path: s.path, oldPath: s.oldPath, kind: s.kind, operation: s.operation, content: s.content });
export interface SegmentChoice { key: string; action: 'assign' | 'accept'; item: string | null }
/** Position among identical segments and total copies prevent approval transfer. */
export function choiceKeys(segments: readonly Segment[]): string[] {
  const counts = new Map<string, number>(), seen = new Map<string, number>();
  for (const segment of segments) { const key = contentKey(segment); counts.set(key, (counts.get(key) ?? 0) + 1); }
  return segments.map(segment => {
    const key = contentKey(segment), copy = (seen.get(key) ?? 0) + 1; seen.set(key, copy);
    return stable([key, copy, counts.get(key)]);
  });
}
export function applyChoices(plan: Plan, segments: readonly Segment[], choices: readonly SegmentChoice[]): Segment[] {
  const keys = choiceKeys(segments);
  const byKey = new Map(choices.map(choice => [choice.key, choice]));
  return segments.map((segment, i) => {
    const choice = byKey.get(keys[i]!);
    if (!choice || !['Ambiguous', 'Unplanned'].includes(segment.row)) return { ...segment };
    if (choice.action === 'accept') return { ...segment, row: 'Accepted' };
    if (!plan.items.some(item => item.id === choice.item)) throw new Error('Assigned item does not exist.');
    return { ...segment, row: choice.item! };
  });
}
export interface Approval { item: string; fingerprint: string }
function fingerprint(item: PlanItem, segments: readonly Segment[]): string {
  return stable({ item, segments: segments.filter(s => s.row === item.id).map(s => ({
    path: s.path, oldPath: s.oldPath, kind: s.kind, operation: s.operation,
    content: s.content, context: s.context, owners: [...s.owners].sort(),
  })) });
}
export function approveItem(plan: Plan, segments: readonly Segment[], itemId: string, confirmNoChange = false): Approval {
  const item = plan.items.find(item => item.id === itemId);
  if (!item) throw new Error('Unknown item.');
  if (!segments.some(segment => segment.row === itemId) && !confirmNoChange) throw new Error('Confirm no change needed before approving.');
  return { item: itemId, fingerprint: fingerprint(item, segments) };
}
export function approvalStates(plan: Plan, segments: readonly Segment[], approvals: readonly Approval[]): Record<string, 'unreviewed' | 'approved' | 'stale'> {
  const result: Record<string, 'unreviewed' | 'approved' | 'stale'> = Object.create(null);
  for (const item of plan.items) {
    const approval = approvals.find(approval => approval.item === item.id);
    result[item.id] = !approval ? 'unreviewed' : approval.fingerprint !== fingerprint(item, segments) ||
      item.depends_on.some(dep => result[dep] === 'stale') ? 'stale' : 'approved';
  }
  return result;
}
