import { readFileSync } from 'node:fs';
import { CommandFailed } from '../../../github/run-with-input.ts';
import type { RunGh } from '../../../github/merge.ts';

/**
 * What `scripts/record-merge-gh.ts` saves: every `gh` call of one real merge inspection, as gh answered it and
 * `runWithInput` (github/run-with-input.ts) reports it to the gateway: stdout in full on exit 0, where stderr is not kept
 * and is saved as ''; on another exit, stderr and stdout with surrounding whitespace trimmed, as runWithInput keeps them.
 * One part is left out: a branch read (`api repos/<repo>/branches/<branch>`) keeps only `name` and `protected` of
 * GitHub's answer, since the gateway reads only `protected`.
 */
export interface RecordedGh {
  gh: string;
  repository: string;
  pullRequest: number;
  recordedAt: string;
  calls: { args: string[]; exitCode: number; stdout: string; stderr: string }[];
}

export function loadRecording(name: string): RecordedGh {
  return JSON.parse(readFileSync(new URL(`./${name}.json`, import.meta.url), 'utf8')) as RecordedGh;
}

/**
 * A `gh` that answers each call from the recordings, as `runWithInput` reports the real one: stdout on exit 0, else a
 * CommandFailed with the same message, stderr and stdout. A call no recording holds fails the test: the gateway now asks
 * GitHub something that was not recorded. When several recordings hold one call, the first listed answers.
 */
export function replayGh(...recordings: RecordedGh[]): RunGh & { calls: string[][]; unrecorded: string[][] } {
  const calls: string[][] = [], unrecorded: string[][] = [];
  const run = async (args: readonly string[]) => {
    calls.push([...args]);
    const joined = JSON.stringify(args);
    const answer = recordings.flatMap(recording => recording.calls).find(call => JSON.stringify(call.args) === joined);
    // The gateway may turn this failure into unknown rules, so callers also assert `unrecorded` is empty.
    if (!answer) { unrecorded.push([...args]); throw new Error(`No recorded answer for gh ${args.join(' ')}`); }
    if (answer.exitCode === 0) return answer.stdout;
    throw new CommandFailed(`gh failed (exit ${answer.exitCode}): ${answer.stderr.slice(0, 2000)}${answer.stdout ? `\n${answer.stdout.slice(0, 2000)}` : ''}`,
      answer.stderr, answer.stdout);
  };
  return Object.assign(run, { calls, unrecorded });
}
