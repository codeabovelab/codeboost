import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSync } from 'vite';
import { parse } from 'yaml';
import { checkLiveProbeReport, LIVE_PROBE_FILES, LIVE_PROBE_MARKER, LIVE_PROBES } from '../scripts/live-probes.ts';
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
    permissions: unknown;
    jobs: Record<string, Record<string, unknown> & { env?: unknown;
    steps: Array<Record<string, unknown> & { name?: string; run?: string; env?: Record<string, string> }> }>;
  };
// The `-t` pattern that selects the titles ending in the marker.
const MARKER_FILTER = `${LIVE_PROBE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
const NODE_VERSION = '26.7.0';
const SETUP = [{ uses: 'actions/checkout@v4' },
  { uses: 'actions/setup-node@v4', with: { 'node-version': NODE_VERSION, cache: 'npm' } }];
const runs = (steps: Array<{ run?: string }>) => steps.flatMap(step => step.run === undefined ? [] : [step.run]);

type Node = { type: string; [key: string]: unknown };
type ProbeFileTest = { name: string | undefined; gated: boolean };
// An enclosing `describe`: its literal title, or why its title is not known.
type Suite = { title: string } | { problem: string };
const PROBE_SWITCH = 'CODEBOOST_RUN_AUTH_PROBES';
const SOURCE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;
const isNode = (value: unknown): value is Node =>
  typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
const FUNCTIONS = ['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'];
const children = (node: Node) => Object.values(node).flatMap(value => Array.isArray(value) ? value : [value]).filter(isNode);
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
// The switch as an identifier, a string literal or a template literal without expressions.
const isSwitchName = (node: Node) => (node.type === 'Identifier' && node.name === PROBE_SWITCH) || literalText(node) === PROBE_SWITCH;
const mentionsSwitch = (node: Node): boolean => isSwitchName(node) || children(node).some(mentionsSwitch);
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
  if (FUNCTIONS.includes(node.type)) return;
  if (['CallExpression', 'NewExpression', 'TaggedTemplateExpression', 'AwaitExpression'].includes(node.type))
    throw new Error(`A gated block runs a ${node.type} outside a test at offset ${String(node.start)}.`);
  children(node).forEach(assertNoCall);
}

// Every test in a probe file with its Vitest full name (describe titles and the test title, joined with spaces), and
// whether CODEBOOST_RUN_AUTH_PROBES enables it. Every `describe` around a gated test must be a plain `describe(...)`
// with a literal title, or this throws: a title with expressions, or `describe.each`, `.for`, `.skip` or any other
// modifier, would make the full name differ from the one this computes. A gate counts only where Vitest always
// registers its tests while it loads the file: as a statement directly in the module body or directly in the body of a
// plain `describe` callback that is itself such a statement. A gate inside any other block or expression, such as
// another `if`, a loop or a helper that is never called, throws. The switch may appear only as the exact condition of an
// `if (...) { ... }` block without `else`, whose statements are each an `it`/`test` call with a literal title or a
// variable declaration without a call, or of `it.runIf(...)`/`test.runIf(...)` with a literal title. Every occurrence of the
// switch's name in the source text, comments and strings included, must be one of these gates, or this throws. A
// variable name built at runtime from pieces, such as `process.env['CODEBOOST_' + 'RUN_AUTH_PROBES']`, is not caught.
function probeFileTests(file: string, source: string): ProbeFileTest[] {
  const { program, errors } = parseSync(file, source);
  if (errors.length) throw new Error(`${file} does not parse: ${errors[0]!.message}`);
  const tests: ProbeFileTest[] = [];
  let gates = 0;
  const record = (describes: Suite[], titleNode: unknown, gated: boolean) => {
    const title = literalText(titleNode);
    if (gated && title === undefined) throw new Error(`Gated test without a literal title in ${file}.`);
    const unknown = describes.find(suite => 'problem' in suite);
    if (gated && unknown) throw new Error(`Gated test in ${file} inside a describe ${unknown.problem}.`);
    const titles = describes.map(suite => 'title' in suite ? suite.title : '?');
    tests.push({ name: title === undefined ? undefined : [...titles, title].join(' '), gated });
  };
  // `loading` is true only for a statement that always runs as Vitest loads the file, and for its expression: a statement
  // directly in the module body or directly in the body of a `describe` callback that is itself such a statement.
  const visit = (node: Node, describes: Suite[], loading: boolean): void => {
    if (FUNCTIONS.includes(node.type)) { children(node).forEach(child => visit(child, describes, false)); return; }
    if (node.type === 'IfStatement' && mentionsSwitch(node.test as Node)) {
      const block = node.consequent as Node;
      if (!loading)
        throw new Error(`A ${PROBE_SWITCH} gate that does not always run as Vitest loads the file at offset ${String(node.start)} in ${file}.`);
      if (!isSwitchOn(node.test) || block.type !== 'BlockStatement' || node.alternate !== null)
        throw new Error(`Unrecognized ${PROBE_SWITCH} condition at offset ${String(node.start)} in ${file}.`);
      gates += 1;
      for (const statement of block.body as Node[]) {
        const call = statement.type === 'ExpressionStatement' ? suiteCall(statement.expression as Node) : undefined;
        if (call && call.kind !== 'describe' && call.methods.length === 0) {
          record(describes, call.args[0], true);
          call.args.slice(1).forEach(arg => visit(arg, describes, false));
        } else if (statement.type === 'VariableDeclaration') {
          assertNoCall(statement);
          visit(statement, describes, false);
        } else throw new Error(`A gated block holds a statement that is not a test at offset ${String(statement.start)} in ${file}.`);
      }
      return;
    }
    const call = suiteCall(node);
    if (call) {
      const gate = call.kind !== 'describe' && call.methods.length === 1 && call.methods[0] === 'runIf'
        && call.innerArgs.length === 1 && call.innerArgs[0]!.length === 1 && isSwitchOn(call.innerArgs[0]![0]);
      if (gate && !loading)
        throw new Error(`A ${PROBE_SWITCH} gate that does not always run as Vitest loads the file at offset ${String(node.start)} in ${file}.`);
      if (gate) gates += 1;
      else call.innerArgs.flat().forEach(arg => visit(arg, describes, false));
      if (call.kind === 'describe') {
        const title = literalText(call.args[0]);
        const suite: Suite = call.methods.length > 0
          ? { problem: `with the modifier .${call.methods.join('.')} at offset ${String(node.start)}` }
          : title === undefined ? { problem: `without a literal title at offset ${String(node.start)}` } : { title };
        const inner = [...describes, suite];
        // Vitest calls a describe callback while it loads the file, so the statements directly in the callback's body keep
        // `loading`. Everything else in the arguments does not.
        for (const arg of call.args) {
          const body = arg.body as Node | undefined;
          if (!FUNCTIONS.includes(arg.type) || body?.type !== 'BlockStatement') { visit(arg, inner, false); continue; }
          (arg.params as Node[]).forEach(param => visit(param, inner, false));
          (body.body as Node[]).forEach(statement => visit(statement, inner, loading));
        }
        return;
      }
      record(describes, call.args[0], gate);
      call.args.forEach(arg => visit(arg, describes, false));
      return;
    }
    if (isSwitchName(node))
      throw new Error(`Unrecognized use of ${PROBE_SWITCH} at offset ${String(node.start)} in ${file}.`);
    // Only the module body and an expression statement pass `loading` on to their direct children.
    const keep = loading && (node.type === 'Program' || node.type === 'ExpressionStatement');
    children(node).forEach(child => visit(child, describes, keep));
  };
  visit(program as unknown as Node, [], true);
  const occurrences = source.split(PROBE_SWITCH).length - 1;
  if (occurrences !== gates)
    throw new Error(`${file} names ${PROBE_SWITCH} ${String(occurrences)} time(s) but has ${String(gates)} recognized gate(s).`);
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
    expect(isolation.jobs['real-docker']!.steps).toEqual(
      [...SETUP, { run: 'npm ci --ignore-scripts' }, { run: 'npm run typecheck' }, { run: 'npm test' }]);
  });

  it('runs exactly the type check, the non-Docker Vitest files and the browser suite in the CI test job', () => {
    expect(workflow('ci.yml').jobs.test!.steps).toEqual([...SETUP, { run: 'npm ci --ignore-scripts' }, { run: 'npm run typecheck' },
      { run: `npm test -- ${DOCKER_TESTS.map(file => `--exclude ${file}`).join(' ')}` },
      { run: 'npx playwright install --with-deps chromium' }, { run: 'npm run test:browser' }]);
  });

  it('keeps the required check names: one job per workflow, with no name and no matrix', () => {
    // A check is named after its job id, or after its `name` when it has one; a matrix adds the matrix values to the
    // name. Either change would leave the required check `test` or `real-docker` never reporting. The test job's
    // timeout is about twice its longest recent run (20 min).
    const ci = workflow('ci.yml').jobs, isolation = workflow('agent-isolation.yml').jobs;
    expect(Object.keys(ci)).toEqual(['test']);
    expect(Object.keys(isolation)).toEqual(['real-docker']);
    expect(ci.test).toMatchObject({ 'runs-on': 'ubuntu-latest', 'timeout-minutes': 45 });
    expect(isolation['real-docker']).toMatchObject({ 'runs-on': 'ubuntu-latest', 'timeout-minutes': 45 });
    for (const job of [ci.test!, isolation['real-docker']!])
      expect(Object.keys(job).toSorted()).toEqual(['runs-on', 'steps', 'timeout-minutes']);
  });

  it('has no workflow keys other than the ones it uses now', () => {
    // A workflow-level `defaults` or `env`, such as `defaults: { run: { shell: 'true {0}' } }`, would change every
    // `run:` step of every job, for example into a no-op that passes.
    const top = (name: string) => Object.keys(parse(readFileSync(join(ROOT, '.github/workflows', name), 'utf8')) as object);
    expect(top('ci.yml')).toEqual(['name', 'on', 'permissions', 'jobs']);
    expect(top('agent-isolation.yml')).toEqual(['name', 'on', 'permissions', 'jobs']);
    expect(top('live-probes.yml')).toEqual(['name', 'on', 'permissions', 'concurrency', 'jobs']);
    for (const name of ['ci.yml', 'agent-isolation.yml', 'live-probes.yml'])
      expect(workflow(name).permissions, name).toEqual({ contents: 'read' });
  });

  it('uses the same Node version in every workflow', () => {
    const versions = ['ci.yml', 'agent-isolation.yml', 'live-probes.yml'].flatMap(name => Object.values(workflow(name).jobs)
      .flatMap(job => job.steps.filter(step => String(step.uses).startsWith('actions/setup-node@'))
        .map(step => (step.with as Record<string, unknown> | undefined)?.['node-version'])));
    expect(versions).toEqual([NODE_VERSION, NODE_VERSION, NODE_VERSION]);
  });

  it('runs only the live Claude probes, by hand or nightly, never on a pull request or push', () => {
    const live = workflow('live-probes.yml');
    expect(Object.keys(live.on).toSorted()).toEqual(['schedule', 'workflow_dispatch']);
    expect(Object.keys(live.jobs)).toEqual(['live-probes']);
    const job = live.jobs['live-probes']!;
    // No `defaults`, `env`, `strategy` or `container`: any of them could change what the steps run.
    expect(Object.keys(job).toSorted()).toEqual(['runs-on', 'steps', 'timeout-minutes']);
    expect(job).toMatchObject({ 'runs-on': 'ubuntu-latest', 'timeout-minutes': 75 });
    const token = { CLAUDE_CODE_OAUTH_TOKEN: '${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}' };
    expect(job.steps.map(step => Object.keys(step).toSorted())).toEqual([['env', 'name', 'run'], ['uses'], ['uses', 'with'],
      ['run'], ['env', 'name', 'run'], ['name', 'run']]);
    expect(job.steps.slice(1, 4)).toEqual([...SETUP, { run: 'npm ci --ignore-scripts' }]);
    expect(job.steps[0]).toMatchObject({ name: 'Require the Claude token', env: token });
    expect(job.steps[4]).toEqual({ name: 'Run the live Claude probes', env: { CODEBOOST_RUN_AUTH_PROBES: '1', ...token },
      run: `npx vitest run --project docker -t '${MARKER_FILTER}' --reporter=default --reporter=json `
        + `--outputFile=live-probes.json ${LIVE_PROBE_FILES.join(' ')}` });
    expect(job.steps[5]).toEqual({ name: 'Check that every probe passed', run: 'node scripts/live-probes.ts check live-probes.json' });
    const vitest = job.steps.filter(step => step.run?.startsWith('npx vitest'));
    expect(vitest).toHaveLength(1);
    const words = vitest[0]!.run!.split(/\s+/);
    // The docker project runs the files one at a time; the filter keeps only titles that end in the marker.
    expect(vitest[0]!.run!.startsWith(`npx vitest run --project docker -t '${MARKER_FILTER}' `)).toBe(true);
    expect(words.filter(word => word.startsWith('test/'))).toEqual(LIVE_PROBE_FILES);
    expect(vitest[0]!.env).toEqual({ CODEBOOST_RUN_AUTH_PROBES: '1',
      CLAUDE_CODE_OAUTH_TOKEN: '${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}' });
    expect(runs(job.steps).at(-1)).toBe('node scripts/live-probes.ts check live-probes.json');
    for (const file of LIVE_PROBE_FILES) expect(DOCKER_TESTS).toContain(file);
  });

  it('never skips or soft-fails a gating job or any of its steps', () => {
    // A condition or continue-on-error on the required checks or on the live probe job could skip a step or let it
    // fail while the job still passes.
    for (const [name, job] of [['ci.yml', 'test'], ['agent-isolation.yml', 'real-docker'], ['live-probes.yml', 'live-probes']] as const) {
      const jobConfig = workflow(name).jobs[job]!;
      for (const part of [jobConfig, ...jobConfig.steps]) {
        expect(Object.keys(part), `${name} ${job}`).not.toContain('if');
        expect(Object.keys(part), `${name} ${job}`).not.toContain('continue-on-error');
      }
    }
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
      for (const name of gated) {
        expect(name.endsWith(` ${LIVE_PROBE_MARKER}`), name).toBe(true);
        expect(name, file).toMatch(new RegExp(MARKER_FILTER));
      }
      expect(tests.filter(test => !test.gated && test.name !== undefined && new RegExp(MARKER_FILTER).test(test.name)), file)
        .toEqual([]);
    }
    // Every JavaScript or TypeScript source file under test/ except this one, helpers and fixtures included, since a
    // probe file could import a gate.
    const named = readdirSync(join(ROOT, 'test'), { recursive: true, encoding: 'utf8' })
      .map(name => `test/${name.split(sep).join('/')}`)
      .filter(file => SOURCE.test(file) && file !== 'test/vitest-config.test.ts')
      .filter(file => readFileSync(join(ROOT, file), 'utf8').includes(PROBE_SWITCH));
    expect(named.toSorted()).toEqual(LIVE_PROBE_FILES.toSorted());
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
