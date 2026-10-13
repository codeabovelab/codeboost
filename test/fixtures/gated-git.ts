import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A `git` first on PATH that holds every call whose arguments contain `match` until the test opens it. The n-th held
 * call records its PID, then waits for gate n; other calls run Git at once. The wrapper replaces itself (exec) at every
 * step, so the recorded PID is the Git process itself, and killing it leaves nothing behind.
 *
 * History reads pass only PATH to Git, and a worker thread copies the environment when it starts, so install this
 * (with `vi.stubEnv('PATH', gated.path)`) before the read or worker begins.
 */
export function gatedGit(root: string, match: string) {
  const dir = join(root, 'gated-git'), log = join(dir, 'calls'), gate = join(dir, 'gate-');
  mkdirSync(dir, { recursive: true }); writeFileSync(log, '');
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const wait = `open(my $f, ">>", shift); print $f "$$\\n"; close $f; my $n = () = do { local @ARGV = ($ARGV[0] =~ s/gate-$/calls/r); <> };`
    + ` my $g = shift; select(undef, undef, undef, 0.02) until -e "$g$n"; exec @ARGV`;
  writeFileSync(join(dir, 'git'), `#!/bin/sh
case "$*" in
  *${match}*) exec perl -e ${quote(wait)} ${quote(log)} ${quote(gate)} ${quote(real)} "$@";;
esac
exec ${quote(real)} "$@"
`);
  chmodSync(join(dir, 'git'), 0o755);
  const pids = () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map(Number);
  return {
    path: `${dir}:${process.env.PATH ?? ''}`,
    pids,
    /** Resolves with the PID of the n-th held call (1-based) once it is waiting at its gate. */
    async held(n = 1): Promise<number> {
      for (let i = 0; i < 2_000 && pids().length < n; i++) await new Promise(resolve => setTimeout(resolve, 10));
      const pid = pids()[n - 1];
      if (pid === undefined) throw new Error(`Git call ${n} matching ${match} never started.`);
      return pid;
    },
    open(n = 1) { writeFileSync(`${gate}${n}`, ''); },
    opened: (n = 1) => existsSync(`${gate}${n}`),
  };
}

/** Whether a process with this PID still exists. */
export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
