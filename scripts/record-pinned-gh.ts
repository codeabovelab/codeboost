// Record GitHub's real answers for the pinned-check tests in test/merge-recorded.test.ts (#176).
//
//   node scripts/record-pinned-gh.ts
//
// Remakes three files in test/fixtures/gh/ through the real `gh`, signed in as you. Every call is read-only, against
// public repositories. Each file holds a RecordedGh with these calls, as runWithInput reports them (stdout in full,
// stderr ''; a call that fails stops the script):
// - pinned-rerun.json and pinned-large-suite.json: the production GhMergeGateway runs one fresh inspection of a public
//   commit whose own rules pin nothing. Its pull request, ruleset, branch and classic protection reads are faked, as in
//   `inspectPinned` in the test, so the ruleset pins one check to an app; only the pinned-check read goes to gh and is
//   saved. Then one REST read, filtered with `--jq`, shows what makes the commit a case: a re-run inside one suite, or
//   a suite with more than 100 runs.
// - private-app-suites.json: no gateway call. Two reads of the same commit's check suites, through REST and through
//   GraphQL, show that GraphQL gives a private app's suite `app: null` while REST names the app.
// Read the files before committing them.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GhMergeGateway, MERGE_KILL_GRACE_MS, MERGE_PIPE_GRACE_MS } from '../github/merge.ts';
import { ghEnvironment } from '../github/gh-env.ts';
import { CommandFailed, runWithInput } from '../github/run-with-input.ts';
import type { RecordedGh } from '../test/fixtures/gh/recorded.ts';

const directory = fileURLToPath(new URL('../test/fixtures/gh/', import.meta.url));
const gh = execFileSync('gh', ['--version'], { encoding: 'utf8' }).split('\n', 1)[0]!;
type Call = RecordedGh['calls'][number];
const real = async (args: readonly string[], signal?: AbortSignal): Promise<Call> => {
  const stdout = await runWithInput('gh', args, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024, signal, env: ghEnvironment(),
    killGraceMs: MERGE_KILL_GRACE_MS, pipeGraceMs: MERGE_PIPE_GRACE_MS });
  return { args: [...args], exitCode: 0, stdout, stderr: '' };
};
const save = (name: string, repository: string, pullRequest: number, calls: Call[]) => {
  const recording: RecordedGh = { gh, repository, pullRequest, recordedAt: new Date().toISOString(), calls };
  writeFileSync(`${directory}${name}.json`, `${JSON.stringify(recording, null, 2)}\n`);
  console.log(`Saved ${calls.length} gh calls to test/fixtures/gh/${name}.json`);
};

/** The gateway's pinned-check read for `context` pinned to `appId` on `head`, with every other read faked. */
async function pinnedRead(repository: string, pullRequest: number, head: string, context: string, appId: number): Promise<Call> {
  const calls: Call[] = [];
  const notProtected = '{"message":"Branch not protected","documentation_url":"https://docs.github.com/rest/branches/branch-protection#get-branch-protection","status":"404"}';
  const gateway = new GhMergeGateway({ repository, pullRequest, issue: 1 }, async (args, options) => {
    const joined = args.join(' ');
    if (joined.startsWith('pr view')) return JSON.stringify({ baseRefName: 'main', baseRefOid: '0'.repeat(40), headRefName: 'x', headRefOid: head, isDraft: false, mergeable: 'MERGEABLE', number: pullRequest, state: 'OPEN', statusCheckRollup: [] });
    if (joined.includes('/rules/branches/')) return JSON.stringify([[{ type: 'required_status_checks', parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context, integration_id: appId }] } }]]);
    if (/branches\/main$/.test(joined)) return JSON.stringify({ name: 'main', protected: false, protection: { enabled: false, required_status_checks: { enforcement_level: 'off', contexts: [], checks: [] } } });
    if (joined.endsWith('/protection')) throw new CommandFailed(`gh failed (exit 1): gh: Branch not protected (HTTP 404)\n${notProtected}`, 'gh: Branch not protected (HTTP 404)', notProtected);
    if (args[0] !== 'api' || args[1] !== 'graphql') throw new Error(`Unexpected gh call: ${joined}`);
    const call = await real(args, options?.signal);
    calls.push(call);
    return call.stdout;
  }, { repository, check: async () => ({ outcome: 'clear', baseHead: '0'.repeat(40) }) });
  const state = await gateway.inspect({ fresh: true });
  if (calls.length !== 1) throw new Error(`Expected one pinned-check read, got ${calls.length}.`);
  console.log(JSON.stringify(state.requiredChecks));
  return calls[0]!;
}

const rerunHead = 'e3697dd532643de0f831b678856b2d677338231d';
save('pinned-rerun', 'codeabovelab/codeboost', 151, [
  await pinnedRead('codeabovelab/codeboost', 151, rerunHead, 'test', 15368),
  await real(['api', `repos/codeabovelab/codeboost/commits/${rerunHead}/check-runs?filter=all&per_page=100`,
    '--jq', '[.check_runs[] | {name, status, conclusion, started_at, completed_at, check_suite: {id: .check_suite.id}, app: {id: .app.id}}]']),
]);

save('pinned-large-suite', 'microsoft/vscode', 343099, [
  await pinnedRead('microsoft/vscode', 343099, 'b3aa5cb6d1d0267f1b60cbb0bffaba898c83ad3f', 'Detect Changes', 15368),
  await real(['api', 'repos/microsoft/vscode/check-suites/107124344927/check-runs?per_page=1',
    '--jq', '{total_count, check_suite: {id: .check_runs[0].check_suite.id, head_sha: .check_runs[0].head_sha}, app: {id: .check_runs[0].app.id}}']),
]);

const svelteHead = '111cc6411c9c647f691a159862da2b74212791e3';
save('private-app-suites', 'sveltejs/svelte', 19050, [
  await real(['api', `repos/sveltejs/svelte/commits/${svelteHead}/check-suites`, '--jq', '[.check_suites[] | {id, app: {id: .app.id, slug: .app.slug}}]']),
  await real(['api', 'graphql', '-f', 'query=query($owner:String!,$repo:String!,$oid:GitObjectID!){repository(owner:$owner,name:$repo){object(oid:$oid){... on Commit{checkSuites(first:100){nodes{databaseId app{databaseId slug}}}}}}}',
    '-f', 'owner=sveltejs', '-f', 'repo=svelte', '-f', `oid=${svelteHead}`]),
]);
