// Record GitHub's real answers to the merge inspection's reads for test/merge-recorded.test.ts.
//
//   node scripts/record-merge-gh.ts <name> <pull request> [owner/repo]
//
// The production GhMergeGateway runs one fresh inspection of the pull request through the real `gh`, signed in as you.
// Every `gh` call it makes (the pull request, the ruleset, the branch and its classic protection) is saved with its exit
// status, stdout and stderr, as runWithInput reports them (trimmed on a failure), to test/fixtures/gh/<name>.json. The
// already-fixed check is replaced by a stub, so its reads are not recorded. A branch read keeps only `name` and
// `protected` (the gateway reads only `protected`), dropping the commit and its authors' emails. Use a public
// repository: the saved answers are committed. Read the file before committing it.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GhMergeGateway, MERGE_KILL_GRACE_MS, MERGE_PIPE_GRACE_MS } from '../github/merge.ts';
import { ghEnvironment } from '../github/gh-env.ts';
import { CommandFailed, runWithInput } from '../github/run-with-input.ts';
import type { RecordedGh } from '../test/fixtures/gh/recorded.ts';

const [name, number, repository = 'codeabovelab/codeboost'] = process.argv.slice(2);
if (!name || !/^[a-z0-9-]+$/.test(name) || !number || !/^\d+$/.test(number)) {
  console.error('Usage: node scripts/record-merge-gh.ts <name> <pull request> [owner/repo]');
  process.exit(2);
}
const calls: RecordedGh['calls'] = [];
const branchRead = (args: readonly string[]) => args.length === 2 && args[0] === 'api' && /\/branches\/[^/]+$/.test(args[1]!);
const keepProtected = (stdout: string) => {
  const branch = JSON.parse(stdout) as { name: unknown; protected: unknown };
  return JSON.stringify({ name: branch.name, protected: branch.protected });
};
const gateway = new GhMergeGateway({ repository, pullRequest: Number(number), issue: 1 }, async (args, options) => {
  // The same options as the gateway's own runner.
  try {
    const stdout = await runWithInput('gh', args, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024, signal: options?.signal,
      env: ghEnvironment(), killGraceMs: MERGE_KILL_GRACE_MS, pipeGraceMs: MERGE_PIPE_GRACE_MS });
    calls.push({ args: [...args], exitCode: 0, stdout: branchRead(args) ? keepProtected(stdout) : stdout, stderr: '' });
    return stdout;
  } catch (error) {
    const exit = error instanceof CommandFailed ? /\(exit (\d+)\)/.exec(error.message) : null;
    if (!(error instanceof CommandFailed) || !exit) throw error;
    calls.push({ args: [...args], exitCode: Number(exit[1]), stdout: error.stdout, stderr: error.stderr });
    throw error;
  }
}, { repository, check: async () => ({ outcome: 'clear', baseHead: '0'.repeat(40) }) });
const state = await gateway.inspect({ fresh: true });
const recording: RecordedGh = {
  gh: execFileSync('gh', ['--version'], { encoding: 'utf8' }).split('\n', 1)[0]!,
  repository, pullRequest: Number(number), recordedAt: new Date().toISOString(),
  calls: calls.sort((a, b) => a.args.join(' ').localeCompare(b.args.join(' '))),
};
const directory = fileURLToPath(new URL('../test/fixtures/gh/', import.meta.url));
mkdirSync(directory, { recursive: true });
writeFileSync(`${directory}${name}.json`, `${JSON.stringify(recording, null, 2)}\n`);
console.log(`Saved ${calls.length} gh calls to test/fixtures/gh/${name}.json`);
console.log(JSON.stringify({ base: state.base, head: state.head, rulesKnown: state.rulesKnown, requiredChecks: state.requiredChecks }, null, 2));
