import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSync } from 'vite';
import { parse } from 'yaml';
import { checkLiveProbeReport, LIVE_PROBE_FILES, LIVE_PROBES } from '../scripts/live-probes.ts';
import config from '../vitest.config.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const DOCKER_TESTS = [
  'test/agent-container.test.ts',
  'test/agent-gate.test.ts',
  'test/agent-network.test.ts',
  'test/agent-planning.test.ts',
  'test/agent-question.test.ts',
  'test/agent-supervisor.test.ts',
  'test/runner-workspace.test.ts',
];

describe('Vitest scheduling', () => {
  it('finishes ordinary tests before running Docker-backed files one at a time', () => {
    const projects = (config as { test?: { projects?: Array<{ test?: Record<string, unknown> }> } }).test?.projects;
    expect(projects).toHaveLength(2);
    expect(projects?.[0]?.test).toMatchObject({
      name: 'parallel',
      include: ['test/*.test.ts'],
      exclude: DOCKER_TESTS,
      sequence: { groupOrder: 0 },
    });
    expect(projects?.[1]?.test).toMatchObject({
      name: 'docker',
      include: DOCKER_TESTS,
      fileParallelism: false,
      sequence: { groupOrder: 1 },
    });
  });
});

const workflow = (name: string) =>
  parse(readFileSync(join(ROOT, '.github/workflows', name), 'utf8')) as {
    on: Record<string, unknown>;
    jobs: Record<string, { env?: unknown; steps: Array<{ name?: string; run?: string; env?: Record<string, string> }> }>;
  };
const runs = (steps: Array<{ run?: string }>) => steps.flatMap(step => step.run === undefined ? [] : [step.run]);

type Node = { type: string; [key: string]: unknown };
type ProbeFileTest = { name: string | undefined; gated: boolean };
const PROBE_SWITCH = 'CODEBOOST_RUN_AUTH_PROBES';
const isNode = (value: unknown): value is Node =>
  typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
const children = (node: Node) => Object.values(node).flatMap(value => Array.isArray(value) ? value : [value]).filter(isNode);
const mentionsSwitch = (node: Node): boolean => (node.type === 'Identifier' && node.name === PROBE_SWITCH)
  || (node.type === 'Literal' && node.value === PROBE_SWITCH) || children(node).some(mentionsSwitch);
const isIdentifier = (node: unknown, name: string) => isNode(node) && node.type === 'Identifier' && node.name === name;
const isMember = (node: unknown, object: (node: unknown) => boolean, property: string): boolean =>
  isNode(node) && node.type === 'MemberExpression' && node.computed === false && object(node.object)
  && isIdentifier(node.property, property);
// Exactly `process.env.CODEBOOST_RUN_AUTH_PROBES === '1'`.
const isSwitchOn = (node: unknown) => isNode(node) && node.type === 'BinaryExpression' && node.operator === '==='
  && isMember(node.left, env => isMember(env, process => isIdentifier(process, 'process'), 'env'), PROBE_SWITCH)
  && isNode(node.right) && node.right.type === 'Literal' && node.right.value === '1';
const literalText = (node: unknown) => !isNode(node) ? undefined
  : node.type === 'Literal' && typeof node.value === 'string' ? node.value
  : node.type === 'TemplateLiteral' && (node.expressions as unknown[]).length === 0
    ? (node.quasis as Array<{ value: { cooked: string } }>)[0]!.value.cooked : undefined;
// A call whose callee chain starts at `it`, `test` or `describe`, such as `it.runIf(...)('title', ...)`: the kind, the
// methods and arguments of the inner calls, and the outer call's arguments.
function suiteCall(node: Node) {
  if (node.type !== 'CallExpression') return undefined;
  const methods: string[] = [], innerArgs: Node[][] = [];
  let callee = node.callee as Node;
  for (;;) {
    if (callee.type === 'CallExpression') { innerArgs.unshift((callee.arguments as Node[])); callee = callee.callee as Node; }
    else if (callee.type === 'MemberExpression' && callee.computed === false && isNode(callee.property)
      && callee.property.type === 'Identifier') { methods.unshift(callee.property.name as string); callee = callee.object as Node; }
    else break;
  }
  if (callee.type !== 'Identifier' || !['it', 'test', 'describe'].includes(callee.name as string)) return undefined;
  return { kind: callee.name as string, methods, innerArgs, args: node.arguments as Node[] };
}
// Throws unless the node has no call outside a function body: a gated block may declare helpers for its tests, but
// any call at block level could register a test that this check does not see.
function assertNoCall(node: Node) {
  if (['ArrowFunctionExpression', 'FunctionExpression'].includes(node.type)) return;
  if (['CallExpression', 'NewExpression', 'TaggedTemplateExpression', 'AwaitExpression'].includes(node.type))
    throw new Error(`A gated block runs a ${node.type} outside a test at offset ${String(node.start)}.`);
  children(node).forEach(assertNoCall);
}

// Every test in a probe file with its Vitest full name (describe titles and the test title, joined with spaces), and
// whether CODEBOOST_RUN_AUTH_PROBES enables it. The switch may appear only as the exact condition of an
// `if (...) { ... }` block without `else`, whose statements are each an `it`/`test` call with a literal title or a
// declaration without a call, or of `it.runIf(...)`/`test.runIf(...)` with a literal title. Any other use throws, so
// no gate can hide a test from this check.
function probeFileTests(file: string, source: string): ProbeFileTest[] {
  const { program, errors } = parseSync(file, source);
  if (errors.length) throw new Error(`${file} does not parse: ${errors[0]!.message}`);
  const tests: ProbeFileTest[] = [];
  const record = (describes: string[], titleNode: unknown, gated: boolean) => {
    const title = literalText(titleNode);
    if (gated && title === undefined) throw new Error(`Gated test without a literal title in ${file}.`);
    tests.push({ name: title === undefined ? undefined : [...describes, title].join(' '), gated });
  };
  const visit = (node: Node, describes: string[]): void => {
    if (node.type === 'IfStatement' && mentionsSwitch(node.test as Node)) {
      const block = node.consequent as Node;
      if (!isSwitchOn(node.test) || block.type !== 'BlockStatement' || node.alternate !== null)
        throw new Error(`Unrecognized ${PROBE_SWITCH} condition at offset ${String(node.start)} in ${file}.`);
      for (const statement of block.body as Node[]) {
        const call = statement.type === 'ExpressionStatement' ? suiteCall(statement.expression as Node) : undefined;
        if (call && call.kind !== 'describe' && call.methods.length === 0) {
          record(describes, call.args[0], true);
          call.args.slice(1).forEach(arg => visit(arg, describes));
        } else if (statement.type === 'VariableDeclaration') {
          assertNoCall(statement);
          visit(statement, describes);
        } else throw new Error(`A gated block holds a statement that is not a test at offset ${String(statement.start)} in ${file}.`);
      }
      return;
    }
    const call = suiteCall(node);
    if (call) {
      const gate = call.kind !== 'describe' && call.methods.length === 1 && call.methods[0] === 'runIf'
        && call.innerArgs.length === 1 && call.innerArgs[0]!.length === 1 && isSwitchOn(call.innerArgs[0]![0]);
      if (!gate) call.innerArgs.flat().forEach(arg => visit(arg, describes));
      if (call.kind === 'describe') {
        const title = literalText(call.args[0]);
        call.args.forEach(arg => visit(arg, title === undefined ? describes : [...describes, title]));
        return;
      }
      record(describes, call.args[0], gate);
      call.args.forEach(arg => visit(arg, describes));
      return;
    }
    if ((node.type === 'Identifier' && node.name === PROBE_SWITCH) || (node.type === 'Literal' && node.value === PROBE_SWITCH))
      throw new Error(`Unrecognized use of ${PROBE_SWITCH} at offset ${String(node.start)} in ${file}.`);
    children(node).forEach(child => visit(child, describes));
  };
  visit(program as unknown as Node, []);
  return tests;
}

describe('CI workflows', () => {
  it('excludes exactly the Docker-backed files from the CI test job', () => {
    const ci = workflow('ci.yml');
    const commands = runs(ci.jobs.test!.steps).filter(run => run.startsWith('npm test'));
    expect(commands).toHaveLength(1);
    // `npm test --` and then only `--exclude <file>` pairs: any other argument, such as a file filter, would narrow
    // the job.
    const [npm, test, separator, ...rest] = commands[0]!.trim().split(/\s+/);
    expect([npm, test, separator]).toEqual(['npm', 'test', '--']);
    expect(rest.length % 2).toBe(0);
    expect(rest.filter((_, index) => index % 2 === 0).every(word => word === '--exclude')).toBe(true);
    expect(rest.filter((_, index) => index % 2 === 1).toSorted()).toEqual(DOCKER_TESTS);
  });

  it('runs the complete Vitest suite in real-docker on every pull request and on the CI push branches', () => {
    const ci = workflow('ci.yml'), isolation = workflow('agent-isolation.yml');
    expect(Object.keys(isolation.on).toSorted()).toEqual(['pull_request', 'push']);
    // No path filter: a required check that a filter skips never reports, and the pull request cannot merge.
    expect(isolation.on.pull_request).toBeNull();
    expect(ci.on.pull_request).toBeNull();
    expect(isolation.on.push).toEqual(ci.on.push);
    expect(isolation.on.push).toEqual({ branches: ['main', 'codex/**'] });
    expect(runs(isolation.jobs['real-docker']!.steps)).toEqual(['npm ci --ignore-scripts', 'npm run typecheck', 'npm test']);
  });

  it('runs only the live Claude probes, by hand or nightly, never on a pull request or push', () => {
    const live = workflow('live-probes.yml');
    expect(Object.keys(live.on).toSorted()).toEqual(['schedule', 'workflow_dispatch']);
    const job = live.jobs['live-probes']!;
    expect(job.env).toBeUndefined();
    const vitest = job.steps.filter(step => step.run?.startsWith('npx vitest'));
    expect(vitest).toHaveLength(1);
    const words = vitest[0]!.run!.split(/\s+/);
    // The docker project runs the files one at a time; the filter keeps only titles that end in "(live Claude)".
    expect(vitest[0]!.run!.startsWith("npx vitest run --project docker -t '\\(live Claude\\)$' ")).toBe(true);
    expect(words.filter(word => word.startsWith('test/'))).toEqual(LIVE_PROBE_FILES);
    expect(vitest[0]!.env).toEqual({ CODEBOOST_RUN_AUTH_PROBES: '1',
      CLAUDE_CODE_OAUTH_TOKEN: '${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}' });
    expect(runs(job.steps).at(-1)).toBe('node scripts/live-probes.ts check live-probes.json');
    for (const file of LIVE_PROBE_FILES) expect(DOCKER_TESTS).toContain(file);
  });

  it('fails the live probe job at once when the token secret is empty', () => {
    const guard = workflow('live-probes.yml').jobs['live-probes']!.steps[0]!;
    expect(guard.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: '${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}' });
    const run = (token: string | undefined) => spawnSync('bash', ['-e', '-c', guard.run!], { encoding: 'utf8',
      env: { PATH: process.env.PATH, ...(token === undefined ? {} : { CLAUDE_CODE_OAUTH_TOKEN: token }) } });
    for (const token of [undefined, '']) {
      const result = run(token);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('::error::The repository secret CLAUDE_CODE_OAUTH_TOKEN is not set');
    }
    expect(run('placeholder').status).toBe(0);
  });

  it('names every live probe exactly as its test file titles it', () => {
    // The tests that the probe switch enables are exactly the listed probes, by Vitest full name, and every one ends in
    // the suffix the workflow's -t filter selects. No other test in the file carries the suffix.
    for (const file of LIVE_PROBE_FILES) {
      const tests = probeFileTests(file, readFileSync(join(ROOT, file), 'utf8'));
      const gated = tests.filter(test => test.gated).map(test => test.name!);
      expect(gated.toSorted(), file).toEqual(LIVE_PROBES.filter(probe => probe.file === file).map(probe => probe.name).toSorted());
      for (const name of gated) expect(name, file).toMatch(/ \(live Claude\)$/);
      expect(tests.filter(test => !test.gated && test.name?.endsWith('(live Claude)')), file).toEqual([]);
    }
    const gated = readdirSync(join(ROOT, 'test')).filter(name => name.endsWith('.test.ts') && name !== 'vitest-config.test.ts')
      .filter(name => readFileSync(join(ROOT, 'test', name), 'utf8').includes('CODEBOOST_RUN_AUTH_PROBES'))
      .map(name => `test/${name}`);
    expect(gated).toEqual(LIVE_PROBE_FILES);
  });
});

describe('live probe report check', () => {
  const report = (tests: Array<[string, string, string]>, failed = 0) => ({
    success: failed === 0, numFailedTests: failed,
    testResults: [...new Set(tests.map(([file]) => file))].map(file => ({ name: join(ROOT, file),
      assertionResults: tests.filter(([testFile]) => testFile === file).map(([, fullName, status]) => ({ fullName, status })) })),
  });
  const all = LIVE_PROBES.map(probe => [probe.file, probe.name, 'passed'] as [string, string, string]);

  it('accepts a report in which every probe passed and nothing else ran', () => {
    expect(checkLiveProbeReport(report([...all, [LIVE_PROBES[0].file, 'other test', 'skipped']]), ROOT)).toEqual([]);
  });

  it('refuses a report in which the probes were skipped, as when the probe switch is off', () => {
    const skipped = all.map(([file, name]) => [file, name, 'skipped'] as [string, string, string]);
    expect(checkLiveProbeReport(report(skipped), ROOT)).toHaveLength(LIVE_PROBES.length);
    expect(checkLiveProbeReport({}, ROOT).length).toBeGreaterThan(LIVE_PROBES.length);
  });

  it('refuses a missing probe, a failure or a test that is not a probe', () => {
    expect(checkLiveProbeReport(report(all.slice(1)), ROOT)).toEqual(
      [`Live probe did not pass: ${LIVE_PROBES[0].file} > ${LIVE_PROBES[0].name}`]);
    expect(checkLiveProbeReport(report(all, 1), ROOT)).toEqual(
      ['Vitest did not report success.', 'Vitest reported 1 failed test(s).']);
    expect(checkLiveProbeReport(report([...all, [LIVE_PROBES[0].file, 'other test', 'passed']]), ROOT)).toEqual(
      [`A test that is not a live probe ran: ${join(ROOT, LIVE_PROBES[0].file)} > other test`]);
  });
});
