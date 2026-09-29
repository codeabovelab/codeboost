import type { Plan } from './plan.ts';

/** GitHub refuses a PR description longer than 65,536 characters; stay below it with room for the frame. */
export const MAX_BODY = 60_000;
export const MAX_TITLE = 200;
const MAX_PROBLEMS = 20, MAX_PROBLEM = 2000;

/**
 * Plan text and open problems go inside fenced code blocks. GitHub does not act on closing keywords ("Fixes #12") or
 * @-mentions inside code, so text from the plan or from agent output cannot close other issues or notify people.
 * The fence is longer than any backtick run in the text, so the text cannot end the block.
 */
export function fenced(text: string): string {
  // A loop, not Math.max(...runs): plan text is not length-bounded, and spreading every run can overflow the stack.
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text.replace(/\r\n?/g, '\n')}\n${fence}`;
}

function planText(plan: Plan, full: boolean): string {
  return plan.items.map(item => {
    const lines = [`${item.id}: ${item.title}`];
    if (full) {
      lines.push(`  Intent: ${item.intent}`);
      for (const file of item.files) lines.push(`  ${file.kind} ${file.renamed_from ? `${file.renamed_from} -> ` : ''}${file.path}: ${file.change}`);
      for (const check of item.acceptance) lines.push(`  ${check.type}: ${check.text}`);
      if (item.depends_on.length) lines.push(`  After: ${item.depends_on.join(', ')}`);
    }
    return lines.join('\n');
  }).join('\n\n');
}

/** Single line, no control characters, bounded. */
export function pullRequestTitle(plan: Plan): string {
  const summary = plan.summary.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  const suffix = ` (#${plan.issue})`;
  return (summary.length + suffix.length > MAX_TITLE ? `${summary.slice(0, MAX_TITLE - suffix.length - 1)}…` : summary) + suffix;
}

/**
 * The PR description: the marker that lets codeboost find the PR again, the issue link, and the plan. A needs-human
 * draft also lists its open problems. When the full plan is too long, only item IDs and titles are listed.
 */
export function pullRequestBody(input: { plan: Plan; marker: string; problems?: readonly string[] }): string {
  const { plan, marker } = input;
  // The full problems stay in codeboost; the description shows a bounded summary of them.
  const all = input.problems ?? [], shown = all.slice(0, MAX_PROBLEMS).map(problem => problem.length > MAX_PROBLEM ? `${problem.slice(0, MAX_PROBLEM)}…` : problem);
  const problems = all.length > shown.length ? [...shown, `(${all.length - shown.length} more in codeboost)`] : shown;
  const build = (full: boolean) => [
    marker,
    `Fixes #${plan.issue}`,
    '',
    `Opened by codeboost from plan revision r${plan.revision}. Review it one plan item at a time in codeboost.`,
    ...(problems.length ? ['', '**Needs human.** These problems are still open:', '', fenced(problems.join('\n\n'))] : []),
    '',
    full ? '**Plan**' : '**Plan** (items only; the full plan is too long for this description)',
    '',
    fenced(planText(plan, full)),
  ].join('\n');
  const body = build(true);
  if (body.length <= MAX_BODY) return body;
  const short = build(false);
  if (short.length <= MAX_BODY) return short;
  throw new Error('The plan and its open problems are too long for a pull request description.');
}
