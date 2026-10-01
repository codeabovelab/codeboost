import type { Plan } from './plan.ts';
import { cutText as cut } from './text.ts';

/** GitHub refuses a PR description longer than 65,536 characters; stay below it with room for the frame. */
export const MAX_BODY = 60_000;
export const MAX_TITLE = 200;
const MAX_PROBLEMS = 20, MAX_PROBLEM = 2000;

/**
 * Plan text and open problems go inside fenced code blocks. GitHub does not act on closing keywords ("Fixes #12") or
 * @-mentions inside code, so text from the plan or from agent output cannot close other issues or notify people.
 * The fence is longer than any backtick run in the text, so the text cannot end the block. Control characters other
 * than newline and tab (a NUL from agent output, say), and lone UTF-16 surrogates, become U+FFFD: GitHub may refuse
 * them, and a refusal would repeat on every publish.
 */
export function fenced(text: string): string {
  // A loop, not Math.max(...runs): plan text is not length-bounded, and spreading every run can overflow the stack.
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text.toWellFormed().replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '\ufffd')}\n${fence}`;
}

/**
 * GitHub also reads closing keywords ("Fixes #7") in commit messages on the default branch, fenced or not, and a squash
 * or merge commit can carry the PR title and description. So every issue reference in plan text and problems is
 * neutralised: `#7` becomes `＃7`, `GH-7` becomes `GH‑7` (non-breaking hyphen), and `/issues/7` or `/pull/7` in a URL gets a
 * division slash. The text stays readable, and no merge method can close another issue through it.
 */
export function neutralizeReferences(text: string): string {
  return text.replace(/#(?=\d)/g, '＃').replace(/\b(GH)-(?=\d)/gi, '$1‑').replace(/\/(issues|pull)\/(?=\d)/gi, '/$1∕');
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
const planTextSafe = (plan: Plan, full: boolean) => neutralizeReferences(planText(plan, full));

/** A title is not fenced, so an @-mention in it would notify: `@name` becomes `＠name`. */
export function neutralizeMentions(text: string): string {
  return text.replace(/@(?=[A-Za-z0-9])/g, '＠');
}

/** Single line, no control characters, no issue references except its own, no mentions, bounded in UTF-16 units. */
export function pullRequestTitle(plan: Plan): string {
  const summary = neutralizeMentions(neutralizeReferences(plan.summary.toWellFormed().replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim())) || 'codeboost plan';
  const suffix = ` (#${plan.issue})`;
  return cut(summary, MAX_TITLE - suffix.length) + suffix;
}

/**
 * The PR description: the marker that lets codeboost find the PR again, the issue link, and the plan. A needs-human
 * draft also lists its open problems. When the full plan is too long, only item IDs and titles are listed.
 */
export function pullRequestBody(input: { plan: Plan; marker: string; problems?: readonly string[] }): string {
  const { plan, marker } = input;
  // The full problems stay in codeboost; the description shows a bounded summary of them.
  const all = input.problems ?? [], shown = all.slice(0, MAX_PROBLEMS).map(problem => neutralizeReferences(cut(problem, MAX_PROBLEM)));
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
    fenced(planTextSafe(plan, full)),
  ].join('\n');
  const body = build(true);
  if (body.length <= MAX_BODY) return body;
  const short = build(false);
  if (short.length <= MAX_BODY) return short;
  throw new Error('The plan and its open problems are too long for a pull request description.');
}
