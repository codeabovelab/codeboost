// The live Claude startup probes, and the check that the Live probes workflow ran all of them.
//
//   node scripts/live-probes.ts check <vitest-json-report>
//
// The probes call the real Claude service, so they run only when CODEBOOST_RUN_AUTH_PROBES=1 and
// CLAUDE_CODE_OAUTH_TOKEN are set. Without those, Vitest skips them and still exits 0. This check reads the
// Vitest JSON report and exits 1 unless every probe below passed and nothing else ran. A renamed, removed or
// skipped probe therefore fails the workflow instead of passing it silently.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Every probe title ends with a space and this suffix. The workflow's `-t` filter is this text escaped as a regular
// expression and anchored at the end; test/vitest-config.test.ts fails if the two differ.
export const LIVE_PROBE_MARKER = '(live Claude)';

export const LIVE_PROBES = [
  { file: 'test/agent-container.test.ts',
    name: 'real Docker agent isolation runs the authenticated Claude startup path with only its OAuth token (live Claude)' },
  { file: 'test/agent-question.test.ts',
    name: 'Ask in the agent container answers from a file it can only read in /work (live Claude)' },
  { file: 'test/agent-supervisor.test.ts',
    name: 'container invocation supervisor runs the production Claude adapter and parses its bounded envelope (live Claude)' },
  { file: 'test/agent-supervisor.test.ts',
    name: 'container invocation supervisor returns a schema-constrained Claude planning answer as bare JSON from the '
      + 'mounted schema (live Claude)' },
] as const;

export const LIVE_PROBE_FILES = [...new Set(LIVE_PROBES.map(probe => probe.file))];

type Report = {
  success?: unknown; numFailedTests?: unknown;
  testResults?: Array<{ name?: unknown; assertionResults?: Array<{ fullName?: unknown; status?: unknown }> }>;
};

// Returns one line per problem; an empty list means every probe passed and nothing else ran.
export function checkLiveProbeReport(report: Report, root = process.cwd()): string[] {
  const problems: string[] = [];
  if (report.success !== true) problems.push('Vitest did not report success.');
  if (report.numFailedTests !== 0) problems.push(`Vitest reported ${String(report.numFailedTests)} failed test(s).`);
  const passed = new Set<string>();
  for (const file of report.testResults ?? []) {
    const name = typeof file.name === 'string' ? file.name : '';
    for (const test of file.assertionResults ?? []) {
      if (test.status !== 'passed') continue;
      const key = `${name} > ${String(test.fullName)}`;
      passed.add(key);
      if (!LIVE_PROBES.some(probe => `${resolve(root, probe.file)} > ${probe.name}` === key))
        problems.push(`A test that is not a live probe ran: ${key}`);
    }
  }
  for (const probe of LIVE_PROBES)
    if (!passed.has(`${resolve(root, probe.file)} > ${probe.name}`))
      problems.push(`Live probe did not pass: ${probe.file} > ${probe.name}`);
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, path] = process.argv.slice(2);
  if (command !== 'check' || !path) {
    console.error('Usage: node scripts/live-probes.ts check <vitest-json-report>');
    process.exit(2);
  }
  const problems = checkLiveProbeReport(JSON.parse(readFileSync(path, 'utf8')) as Report);
  for (const problem of problems) console.error(problem);
  if (problems.length) process.exit(1);
  console.log(`All ${LIVE_PROBES.length} live Claude probes passed.`);
}
