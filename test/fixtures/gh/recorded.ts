import { readFileSync } from 'node:fs';
import { CommandFailed } from '../../../github/run-with-input.ts';
import type { RunGh } from '../../../github/merge.ts';

/** What `scripts/record-merge-gh.ts` saves: every `gh` call of one real merge inspection, as gh answered it. */
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
export function replayGh(...recordings: RecordedGh[]): RunGh & { calls: string[][] } {
  const calls: string[][] = [];
  const run = async (args: readonly string[]) => {
    calls.push([...args]);
    const joined = JSON.stringify(args);
    const answer = recordings.flatMap(recording => recording.calls).find(call => JSON.stringify(call.args) === joined);
    if (!answer) throw new Error(`No recorded answer for gh ${args.join(' ')}`);
    if (answer.exitCode === 0) return answer.stdout;
    throw new CommandFailed(`gh failed (exit ${answer.exitCode}): ${answer.stderr.slice(0, 2000)}${answer.stdout ? `\n${answer.stdout.slice(0, 2000)}` : ''}`,
      answer.stderr, answer.stdout);
  };
  return Object.assign(run, { calls });
}
