// Record real Claude review-agent output for test/review-recorded.test.ts (#201).
//
//   CODEBOOST_RUN_AUTH_PROBES=1 CLAUDE_CODE_OAUTH_TOKEN=... node scripts/record-review.ts
//
// Each round runs as a read-only lane D invocation in the review phase, with vendor-only egress and the review answer
// schema as `--json-schema`. The output is saved exactly as D extracted it (Claude's `structured_output`), before any
// validation, so a recording shows what the vendor returned. Validation runs afterwards and only prints its result.
// Codex is refused in every phase (#93), so only Claude is recorded. Needs Docker.
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
import { credentialEnvironment, measureGitRepository, RetainedStorage, runReadOnlyAgent, type ContainerDependencies } from '../runner/question-container.ts';
import { REVIEW_FEATURE, reviewRun } from '../runner/review-agent.ts';
import { buildReviewRecordingRepository, prepareReviewRecording, REVIEW_RECORDING_KIND, REVIEW_RECORDING_NAMES, reviewCommandSha256,
  reviewRecordingFilesSha256, sha256, type ReviewRecording } from '../test/fixtures/review/recording-inputs.ts';

if (process.env.CODEBOOST_RUN_AUTH_PROBES !== '1') {
  console.error('Set CODEBOOST_RUN_AUTH_PROBES=1 to call the real vendors. See the header of this file.');
  process.exit(2);
}
const outputDirectory = fileURLToPath(new URL('../test/fixtures/review/recorded/', import.meta.url));
const env = credentialEnvironment(process.env);
// Lane D's Docker and Git calls inherit this process's environment. The token reaches Claude only through the
// adapter's secret channel, so it is removed here.
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
const deps: Omit<ContainerDependencies, 'recover'> = {
  buildImage: buildAgentImage, createClone: createTaskClone, prepareFilesystems: prepareTaskFilesystems,
  removeFilesystems: removeTaskFilesystems, measureRepository: measureGitRepository,
  capture: input => captureInvocation(input), startClaude: startClaudeInvocation, env,
};

// Look the token up before any Docker work, so a missing sign-in fails fast. It must never reach a recording.
const token = REVIEW_FEATURE.credential('claude', env);
const scrub = (text: string) => text.replaceAll(token, '[CLAUDE_CODE_OAUTH_TOKEN]');


const root = mkdtempSync(join(tmpdir(), 'codeboost-recording-'));
const retained = new RetainedStorage({ removePath: REVIEW_FEATURE.removeRoot, paths: paths => `Delete ${paths.join(', ')}.`,
  untracked: () => 'Setup or cleanup failed and was not confirmed.', retained: count => `${count} storage allocation(s) were not removed.` });
const runnerOwner = randomBytes(16).toString('hex');
let failed = false;
try {
  const repository = join(root, 'repository'), commits = await buildReviewRecordingRepository(repository), { head } = commits;
  const image = {};
  mkdirSync(outputDirectory, { recursive: true });

  for (const name of REVIEW_RECORDING_NAMES) {
    const attemptId = randomUUID(), prepared = prepareReviewRecording(name, commits, attemptId);
    process.stdout.write(`${name}: invoking Claude (up to ten minutes)... `);
    let output: string;
    try {
      output = await runReadOnlyAgent(REVIEW_FEATURE, { ...reviewRun(prepared.request,
        { vendor: 'claude', repository, snapshotId: `recording-${head}` }, Date.now() + 10 * 60_000), runnerOwner },
      deps, AbortSignal.timeout(11 * 60_000), image, retained);
    } catch (error) {
      failed = true;
      console.log(`failed, nothing recorded.\n  ${scrub(error instanceof Error ? error.message : String(error))}`);
      continue;
    }
    if (output.includes(token)) {
      failed = true;
      console.log('refused: the output contains a credential. Nothing was written.');
      continue;
    }
    const recording: ReviewRecording = { kind: REVIEW_RECORDING_KIND, version: 1, vendor: 'claude', name,
      recordedAt: new Date().toISOString(),
      provenance: { image: AGENT_IMAGE, cliVersion: CLAUDE_VERSION,
        model: 'claude CLI default (the adapter passes no model flag)', phase: 'review' },
      request: { attemptId, round: prepared.request.round, revision: prepared.request.revision, head, base: commits.base,
        promptSha256: sha256(prepared.request.prompt), schemaSha256: sha256(prepared.request.schemaText),
        filesSha256: reviewRecordingFilesSha256(),
        commandSha256: reviewCommandSha256(prepared.request.prompt, prepared.request.schemaText) },
      output };
    // Write through a temporary file, so an interrupted run never leaves half a recording; a failed write deletes it.
    const target = join(outputDirectory, `${name}.json`), temporary = `${target}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(recording, null, 2)}\n`, { flag: 'wx' });
      renameSync(temporary, target);
    } catch (error) { rmSync(temporary, { force: true }); throw error; }
    // Validation only reports. The recording above is kept either way: a rejected output is a finding.
    try {
      const problems = prepared.validate(output);
      console.log(`recorded; valid, ${problems.length} problem(s)${problems.length ? `: ${problems.map(problem => problem.item).join(', ')}` : ''}.`);
    } catch (error) {
      failed = true;
      console.log(`recorded; REJECTED by validation: ${scrub(error instanceof Error ? error.message : String(error))}`);
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
