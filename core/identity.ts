/** Stable IDs from trusted application storage, never model output or UI selection. */
export interface PlanIdentity { repositoryId: string; taskId: string; planId: string }
export function identityKey(identity: PlanIdentity): string {
  const values = [identity?.repositoryId, identity?.taskId, identity?.planId];
  if (!values.every(v => typeof v === 'string' && v.length > 0)) throw new Error('Stable repository/task/plan identity is required.');
  return JSON.stringify(values);
}
