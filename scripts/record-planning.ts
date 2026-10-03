// Record real Claude planning output for test/planning-recorded.test.ts.
//
//   CODEBOOST_RUN_AUTH_PROBES=1 CLAUDE_CODE_OAUTH_TOKEN=... node scripts/record-planning.ts
//
// Each request runs through the production planning provider: lane D's container, read-only planning phase and
// vendor-only egress. The output is saved exactly as D extracted it (Claude's `structured_output`), before any
// validation, so a recording shows what the vendor returned. Validation runs afterwards and only prints its result.
// Codex is refused in every phase (#93), so only Claude is recorded. Needs Docker.
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startClaudeInvocation } from '../agents/adapters/claude.ts';
import { captureInvocation } from '../agents/contract.ts';
import { AGENT_IMAGE, buildAgentImage, CLAUDE_VERSION } from '../agents/container/image.ts';
import { prepareTaskFilesystems, removeTaskFilesystems } from '../agents/container/run.ts';
import { createTaskClone } from '../git/clone.ts';
import { createPlanningProvider, planningCredential, planningLeftovers, type PlanningDependencies } from '../runner/planning-provider.ts';
import { credentialEnvironment, measureGitRepository } from '../runner/question-container.ts';
import { planningCommandSha256, prepareRecording, RECORDING_FILES, RECORDING_KIND, recordingFilesSha256, sha256,
  type PlanningRecording } from '../test/fixtures/planning/recording-inputs.ts';

if (process.env.CODEBOOST_RUN_AUTH_PROBES !== '1') {
  console.error('Set CODEBOOST_RUN_AUTH_PROBES=1 to call the real vendors. See the header of this file.');
  process.exit(2);
}
const outputDirectory = fileURLToPath(new URL('../test/fixtures/planning/recorded/', import.meta.url));
const env = credentialEnvironment(process.env);
// Lane D's Docker and Git calls inherit this process's environment. The token reaches Claude only through the
// adapter's secret channel, so it is removed here, as Ask's worker never receives it.
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
const deps: PlanningDependencies = {
  buildImage: buildAgentImage, createClone: createTaskClone, prepareFilesystems: prepareTaskFilesystems,
  removeFilesystems: removeTaskFilesystems, measureRepository: measureGitRepository,
  capture: input => captureInvocation(input), startClaude: startClaudeInvocation, env,
};

// Look the token up before any Docker work, so a missing sign-in fails fast. It must never reach a recording.
const token = planningCredential('claude', env);
const scrub = (text: string) => text.replaceAll(token, '[CLAUDE_CODE_OAUTH_TOKEN]');

// A fixed author, committer and date give the same commit, and so the same prompt, on every run.
const gitEnv = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'codeboost', GIT_AUTHOR_EMAIL: 'recording@codeboost.invalid', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_NAME: 'codeboost', GIT_COMMITTER_EMAIL: 'recording@codeboost.invalid', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args],
  { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const root = mkdtempSync(join(tmpdir(), 'codeboost-recording-'));
const retained = planningLeftovers(), runnerOwner = randomBytes(16).toString('hex');
let failed = false;
try {
  const repository = join(root, 'repository');
  for (const [path, text] of Object.entries(RECORDING_FILES)) {
    mkdirSync(dirname(join(repository, path)), { recursive: true });
    writeFileSync(join(repository, path), text);
  }
  git(repository, 'init', '--quiet', '--initial-branch=main');
  git(repository, 'add', '.');
  git(repository, 'commit', '--quiet', '-m', 'Recording baseline');
  const head = git(repository, 'rev-parse', 'HEAD');
  const image = {};
  mkdirSync(outputDirectory, { recursive: true });

  const provider = createPlanningProvider({ vendor: 'claude', repository, head, snapshotId: `recording-${head}`,
    runnerOwner, deps, image, retained });
  for (const mode of ['draft', 'suggest'] as const) {
    const name = `claude-${mode}`, requestId = randomUUID();
    const prepared = prepareRecording(mode, head, requestId);
    process.stdout.write(`${name}: invoking Claude (up to ten minutes)... `);
    let output: string;
    try { output = await provider.invoke(prepared.request, AbortSignal.timeout(11 * 60_000)); }
    catch (error) {
      failed = true;
      console.log(`failed, nothing recorded.\n  ${scrub(error instanceof Error ? error.message : String(error))}`);
      continue;
    }
    if (output.includes(token)) {
      failed = true;
      console.log('refused: the output contains a credential. Nothing was written.');
      continue;
    }
    const recording: PlanningRecording = { kind: RECORDING_KIND, version: 1, vendor: 'claude', mode,
      recordedAt: new Date().toISOString(),
      provenance: { image: AGENT_IMAGE, cliVersion: CLAUDE_VERSION,
        model: 'claude CLI default (the adapter passes no model flag)', phase: 'planning' },
      request: { requestId, revision: prepared.request.revision, issue: prepared.request.issue, baseSha: head,
        promptSha256: sha256(prepared.request.prompt), schemaSha256: sha256(prepared.request.schemaText),
        filesSha256: recordingFilesSha256(),
        commandSha256: planningCommandSha256(prepared.request.prompt, prepared.request.schemaText) },
      output };
    // Write through a temporary file, so an interrupted run never leaves half a recording.
    const target = join(outputDirectory, `${name}.json`), temporary = `${target}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(recording, null, 2)}\n`, { flag: 'wx' });
    renameSync(temporary, target);
    // Validation only reports. The recording above is kept either way: a rejected output is a finding.
    try {
      const { warnings } = prepared.validate(output);
      console.log(`recorded; valid${warnings.length ? ` with ${warnings.length} warning(s): ${warnings.map(w => w.code).join(', ')}` : ''}.`);
    } catch (error) {
      failed = true;
      console.log(`recorded; REJECTED by E2 validation: ${scrub(error instanceof Error ? error.message : String(error))}`);
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
  // Nothing recovers a recording run's leftovers on its own; name them so a person can remove them.
  if (retained.size || retained.untracked || retained.paths().length) {
    failed = true;
    console.log(`Docker resources may be left behind. Remove those labelled io.codeboost.runner=${runnerOwner}`
      + `${retained.paths().length ? `, and delete ${retained.paths().join(', ')}` : ''}.`);
  }
}
console.log(`Recordings are in ${outputDirectory}. Read each one before committing it.`);
process.exit(failed ? 1 : 0);
