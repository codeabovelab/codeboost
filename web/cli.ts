import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { startServer, type RunnerSetup } from './server.ts';
import { productionPlanning } from './planning.ts';
import { createDemo } from '../scripts/demo.ts';
import { Store, requireSupportedNode } from '../runner/store.ts';
import { acquireRunnerLock, releasePreparation, releaseRebaseProcess } from '../runner/recovery.ts';
import { RUNNER_NEEDS_GITHUB, baseBranch, parseRunnerConfig, recoveryWarnings, setUpRunner } from '../runner/production.ts';
requireSupportedNode();
/** A refusal the person acts on (bad input, a held lock, a blocked recovery): its message and exit 1, not a stack. */
function refuse(error: unknown): never { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }
const checked = <T>(fn: () => T): T => { try { return fn(); } catch (error) { return refuse(error); } };
const { values } = parseArgs({ options: { demo: { type:'boolean' }, directory:{type:'string'}, config:{type:'string'}, port:{type:'string'}, help:{type:'boolean'},
  'release-preparation':{type:'string'}, 'release-rebase-process':{type:'string'} } });
if (values['release-preparation'] !== undefined && values['release-rebase-process'] !== undefined)
  refuse(new Error('Choose only one release operation.'));
const release = values['release-preparation'] !== undefined ? 'preparation' : values['release-rebase-process'] !== undefined ? 'rebase' : undefined;
if (values.help || (!values.demo && !values.config && release === undefined)) {
  console.log('codeboost local review\n\nDemo: npm run demo\nExisting store: npm start -- --config /absolute/path/review.json\nOptions: --port 4318 --directory /path/to/demo\n\nThe configuration binds a trusted repository, database, plan identity, and known path identity. Configure the question agent in Settings; Ask runs it in a Docker container (Claude Code needs CLAUDE_CODE_OAUTH_TOKEN; Codex cannot answer questions yet). A github block enables the guarded merge gate and plan suggestions (Claude Code in a Docker container, like Ask); demos never merge or plan. A runner block (root, committer, optional diagnosticsDir and limits) turns on the runner: it needs Docker, the github block with a baseBranch for its pull requests, and CLAUDE_CODE_OAUTH_TOKEN, and runs startup recovery before the server opens.\n\n--release-preparation <attempt ID>: after startup recovery reports a preparation whose process was never recorded, and you have stopped that process, remove its attempt directory (refused while any process still uses it).\n--release-rebase-process <rebase attempt ID>: after startup recovery reports an unidentified escaped rebase process, stop that process and explicitly release its retained marker (refused while any process still uses its rebase directory).');
} else if (release !== undefined) {
  const attemptId = release === 'preparation' ? values['release-preparation']! : values['release-rebase-process']!;
  checked(() => {
    if (!values.config) throw new Error(`--release-${release === 'preparation' ? 'preparation' : 'rebase-process'} needs --config.`);
    const config = JSON.parse(readFileSync(resolve(values.config), 'utf8'));
    if (config.runner === undefined) throw new Error(`This review has no runner block, so it has no ${release === 'preparation' ? 'preparations' : 'rebases'} to release.`);
    const runnerConfig = parseRunnerConfig(config.runner);
    // Under the runner lock, so no runner of this database is starting or running while the directory is checked.
    const lock = acquireRunnerLock(config.database);
    try {
      const store = new Store(config.database);
      try {
        lock.verify();
        const input = { store, runnerRoot: runnerConfig.root, runnerOwner: store.runnerOwnerToken(lock.file), attemptId };
        if (release === 'preparation') releasePreparation(input); else releaseRebaseProcess(input);
        console.log('Released. Start codeboost again.');
      } finally { store.close(); }
    } finally { lock.release(); }
  });
} else {
  const port = Number(values.port ?? '4318');
  if (!Number.isInteger(port) || port < 0 || port > 65535) refuse(new Error('Invalid port.'));
  const config = checked(() => values.demo ? createDemo(values.directory ?? '.codeboost-local/demo') : JSON.parse(readFileSync(resolve(values.config!), 'utf8')));
  // Checked before the lock, so a malformed block changes nothing. Demos never run the runner, however they were opened.
  const runnerConfig = checked(() => {
    if (config.demo === true || config.runner === undefined) return null;
    // The github block and the PR's base branch too (#103), before the lock: a missing block or base branch must be reported
    // as itself, not as a lock conflict.
    if (!config.github) throw new Error(RUNNER_NEEDS_GITHUB);
    baseBranch(config.github);
    return parseRunnerConfig(config.runner);
  });
  // Decision 1: one runner per database, held as an OS lock keyed by the database file's device and inode.
  const lock = checked(() => acquireRunnerLock(config.database));
  const runnerSetup: RunnerSetup | undefined = runnerConfig ? async (service, capability) => {
    const assembly = await setUpRunner({ service, capability, config: runnerConfig, lock, env: process.env,
      onSlowStart: () => console.log('Building the agent image and recovering what an earlier run left. This can take a few minutes the first time.') });
    const { recovery } = assembly;
    if (recovery.finalized.length) console.log(`Recovered ${recovery.finalized.length} interrupted attempt(s).`);
    if (recovery.requeue.length) console.log(`Interrupted tasks waiting to resume: ${recovery.requeue.length}.`);
    // Left for a person (runner-lifecycle.md): never removed automatically.
    for (const line of recoveryWarnings(recovery)) console.error(line);
    return assembly;
  } : undefined;
  // A first stop during startup waits for startup recovery to finish, so it is not cut off part way. A second one stops at
  // once: that is a crash to recovery, which the next start runs again. A terminal Ctrl+C also reaches an agent image
  // build in progress (it shares the terminal), which then fails and ends startup.
  let stopping = false;
  const duringStartup = () => {
    if (stopping) { console.error('Stopped during startup. The next start recovers what this one left.'); process.exit(130); }
    stopping = true; console.log('Stopping once startup has finished. Press Ctrl+C again to stop now.');
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, duringStartup);
  let app: Awaited<ReturnType<typeof startServer>>;
  // Planning (#117) is on for any non-demo review with a github block; it needs no runner block.
  let planningSetup: ReturnType<typeof productionPlanning>;
  try {
    planningSetup = productionPlanning(config, { verifyLock: () => lock.verify() });
    app = await startServer(config, port, undefined, undefined, undefined, undefined, undefined, planningSetup, runnerSetup);
  }
  catch (error) {
    lock.release();
    // A refused runner or planning startup (no token, a blocked recovery, a lock that no longer names the database) is
    // the person's to act on: its message, not a stack.
    if (!runnerSetup && !planningSetup) throw error;
    console.error(error instanceof Error ? error.message : String(error)); process.exit(1);
  }
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.removeListener(signal, duringStartup);
  // A publish an earlier process owed (#103) starts only under a lock verified to name the database: publishOwed runs the
  // check itself, first, so no order of these lines can start one before it.
  try { if (stopping) lock.verify(); else await app.publishOwed(() => lock.verify()); }
  catch (error) {
    await app.close(); lock.release();
    // The database path changed: a refusal the person acts on, so its message, not a stack.
    refuse(error);
  }
  const stop = () => void app.close().then(() => { lock.release(); process.exit(0); },
    error => { lock.release(); console.error(error instanceof Error ? error.message : error); process.exit(1); });
  // A second Ctrl+C does not skip shutdown (runner-lifecycle.md): agents are still being stopped and awaited.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { if (stopping) { console.log('Still stopping agents…'); return; } stopping = true; stop(); });
  if (stopping) stop();
  else console.log(`Review ready: ${app.url}\nRepository: ${config.repository}\nDatabase: ${config.database}\nSource files are read-only. Press Ctrl+C to stop.`);
}
