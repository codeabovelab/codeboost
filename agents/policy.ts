import type { InvocationInput, Phase } from './contract.ts';
import { assertCapturedInvocation, permitsCommand } from './contract.ts';

export type AgentTool = 'read' | 'list' | 'search' | 'write' | 'edit' | 'runner-command';
export interface PhasePolicy {
  readonly phase: Phase;
  readonly worktree: 'read-only' | 'read-write';
  readonly tools: readonly AgentTool[];
  readonly web: false;
  readonly mcp: false;
}
export interface AgentCommand { readonly argv: readonly string[] }
interface PolicyIdentity { readonly invocation: InvocationInput }
const identities = new WeakMap<PhasePolicy, PolicyIdentity>();
const commands = new WeakMap<AgentCommand, { readonly policy: PhasePolicy; readonly vendor: InvocationInput['vendor'] }>();

const command = (policy: PhasePolicy, argv: readonly string[]): AgentCommand => {
  assertPhasePolicy(policy);
  const value = Object.freeze({ argv: Object.freeze([...argv]) });
  commands.set(value, Object.freeze({ policy, vendor: assertPhasePolicy(policy).vendor }));
  return value;
};

export function assertAgentCommand(value: AgentCommand, policy: PhasePolicy,
  vendor?: InvocationInput['vendor']): readonly string[] {
  const identity = commands.get(value);
  if (identity?.policy !== policy || (vendor && identity.vendor !== vendor))
    throw new Error('Container command was not generated for this phase policy and vendor.');
  return value.argv;
}

export function createPhasePolicy(invocation: InvocationInput): PhasePolicy {
  // Tools and the command allowlist come from the phase, so only a captured request may define them.
  assertCapturedInvocation(invocation);
  const writable = invocation.phase === 'execute' || invocation.phase === 'fix';
  const tools: AgentTool[] = ['read', 'list', 'search'];
  if (invocation.phase === 'review' || writable) tools.push('runner-command');
  if (writable) tools.push('write', 'edit');
  const policy = Object.freeze({ phase: invocation.phase, worktree: writable ? 'read-write' : 'read-only',
    tools: Object.freeze(tools), web: false as const, mcp: false as const });
  identities.set(policy, Object.freeze({ invocation }));
  return policy;
}

export function assertPhasePolicy(policy: PhasePolicy, invocation?: InvocationInput): InvocationInput {
  const identity = identities.get(policy);
  if (!identity) throw new Error('Phase policy was not created by the trusted policy builder.');
  if (invocation && identity.invocation !== invocation) throw new Error('Phase policy does not belong to this invocation.');
  return identity.invocation;
}

export function assertAgentTool(policy: PhasePolicy, tool: AgentTool): void {
  assertPhasePolicy(policy);
  if (!policy.tools.includes(tool)) throw new Error(`${tool} is forbidden during ${policy.phase}.`);
}

export function dispatchApprovedCommand<T>(policy: PhasePolicy, argv: readonly string[],
  execute: (argv: readonly string[]) => T): T {
  const invocation = assertPhasePolicy(policy);
  assertAgentTool(policy, 'runner-command');
  if (!permitsCommand(invocation, argv)) throw new Error('Command argv was not approved exactly for this invocation.');
  return execute(Object.freeze([...argv]));
}

export function createClaudeCommand(policy: PhasePolicy, prompt: string): AgentCommand {
  if (!prompt || prompt.includes('\0')) throw new Error('Claude prompt must be nonempty and contain no NUL.');
  if (assertPhasePolicy(policy).vendor !== 'claude') throw new Error('Claude command requires a Claude invocation policy.');
  const writable = policy.worktree === 'read-write';
  const allowed = writable ? 'Read,Glob,Grep,Edit,Write' : 'Read,Glob,Grep';
  // `--` ends option parsing, so a prompt beginning with `-` stays prompt data.
  return command(policy, ['claude', '--print', '--output-format', 'json', '--restricted', '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands', '--no-chrome', '--permission-prompts', 'none',
    '--permission-mode', writable ? 'acceptEdits' : 'plan', '--tools', allowed, '--allowedTools', allowed,
    '--disallowedTools', 'Bash,WebFetch,WebSearch,NotebookEdit', '--add-dir', '/run/codeboost-input', '--', prompt]);
}

export function codexBaseArguments(policy: PhasePolicy): readonly string[] {
  if (assertPhasePolicy(policy).vendor !== 'codex') throw new Error('Codex command requires a Codex invocation policy.');
  return Object.freeze(['codex', '--strict-config', '--config', 'web_search="disabled"',
    '--config', 'mcp_servers={}', '--config', 'features.shell_tool=false', '--ask-for-approval', 'never']);
}

export function createCodexCommand(policy: PhasePolicy, prompt: string): AgentCommand {
  if (!prompt || prompt.includes('\0')) throw new Error('Codex prompt must be nonempty and contain no NUL.');
  const sandbox = policy.worktree === 'read-write' ? 'workspace-write' : 'read-only';
  // `--` ends option parsing, so a prompt beginning with `-` stays prompt data.
  return command(policy, [...codexBaseArguments(policy), 'exec', '--sandbox', sandbox, '--skip-git-repo-check',
    '--output-last-message', '/run/codeboost-output/final.txt', '--', prompt]);
}

export type IsolationProbe = 'noop' | 'phase-worktree' | 'read-only-isolation' | 'persist-write'
  | 'persist-read' | 'capacity' | 'metadata' | 'must-not-run' | 'input-marker' | 'finite-output'
  | 'infinite-stdout' | 'infinite-stderr' | 'infinite-mixed' | 'ignore-term' | 'symlink-output'
  | 'oversized-output' | 'fifo-output' | 'invalid-utf8-output' | 'invalid-utf8-stderr' | 'truncated-utf8-stderr'
  | 'replace-output-directory'
  | 'nonzero-output' | 'duplicate-protocol' | 'newline-free-deferred-output' | 'scratch-capacity' | 'metadata-alias'
  | 'hostile-repo';

// `set -e` ignores a failing `! command`, so a negated check could never fail a probe. `deny` exits instead when a
// forbidden action succeeds, and names the breach. Both streams of the attempted command are discarded, so a breach
// that succeeds (such as reading a host file) cannot copy its data into the invocation output.
const deny = 'deny() { if "$@" >/dev/null 2>&1; then echo "isolation breach: $*" >&2; exit 1; fi; }; ';
// Fill a scratch directory past its byte and inode limits. Each fill must stop early, and must have written first, so
// an unwritable or missing directory fails the probe instead of passing it vacuously.
const scratchBounded = (directory: string, megabytes: number, files: number) =>
  `deny dd if=/dev/zero of="${directory}/overflow" bs=1M count=${megabytes}; test -s "${directory}/overflow"; `
  + `rm -f "${directory}/overflow"; mkdir "${directory}/many"; i=0; `
  + `while touch "${directory}/many/$i" 2>/dev/null; do i=$((i+1)); test "$i" -lt ${files}; done; `
  + `test "$i" -gt 0; test "$i" -lt ${files}; rm -rf "${directory}/many"; `;

/** Fixed startup probes validate the sandbox itself without granting an agent a process tool. */
export function createIsolationProbeCommand(policy: PhasePolicy, probe: IsolationProbe): AgentCommand {
  assertPhasePolicy(policy);
  const phase = policy.phase;
  const scripts: Record<Exclude<IsolationProbe, 'noop'>, string> = {
    'phase-worktree': policy.worktree === 'read-write'
      ? `set -eu; printf ${phase} > /work/${phase}.txt; test -f /work/${phase}.txt`
      : `${deny}set -eu; deny touch /work/${phase}.txt; test ! -e /work/${phase}.txt`,
    'read-only-isolation': `${deny}set -eu; test "$(id -u)" = 10001; test "$(git status --porcelain)" = ""; `
      + 'test -z "${HOST_SECRET_SENTINEL:-}"; deny touch /work/forbidden; deny touch /usr/bin/forbidden; '
      + 'touch /tmp/allowed "$HOME/allowed"; printf isolated',
    'persist-write': 'set -eu; printf generated > /work/generated.txt; touch /tmp/old "$HOME/old"; printf first',
    'persist-read': 'set -eu; test -f /work/generated.txt; test ! -e /tmp/old; test ! -e "$HOME/old"; git status --porcelain',
    capacity: `${deny}set -eu; deny dd if=/dev/zero of=/work/overflow bs=1M count=32; rm -f /work/overflow; `
      + 'mkdir /work/many; i=0; while touch "/work/many/$i" 2>/dev/null; do i=$((i+1)); test "$i" -lt 2000; done; '
      + 'test "$i" -lt 2000; test "$(find /work/many -type f | wc -l)" -eq "$i"; rm -rf /work/many; printf bounded',
    metadata: `${deny}set -eu; deny touch /work/.git/forbidden; deny ln /work/.git/HEAD /work/metadata-link; `
      + 'deny mv /work/.git /work/replaced; git status --porcelain; printf metadata-safe',
    'must-not-run': 'touch /tmp/command-ran',
    'input-marker': 'set -eu; grep -q codeboost-schema-marker /run/codeboost-input/schema.json; '
      + 'test ! -e /run/codeboost-input/extra.json',
    'finite-output': 'printf stdout-marker; printf stderr-marker >&2',
    'invalid-utf8-stderr': "printf 'bad-\\377\\377-stderr' >&2",
    'truncated-utf8-stderr': "printf 'cut-\\342' >&2",
    'infinite-stdout': "while :; do head -c 4096 /dev/zero | tr '\\0' x; done",
    'infinite-stderr': "while :; do head -c 4096 /dev/zero | tr '\\0' x >&2; done",
    'infinite-mixed': "while :; do head -c 4096 /dev/zero | tr '\\0' x; head -c 4096 /dev/zero | tr '\\0' y >&2; done",
    'ignore-term': "trap '' TERM; while :; do sleep 1; done",
    'symlink-output': 'ln -s /etc/passwd /run/codeboost-output/final.txt',
    'oversized-output': 'head -c 131072 /dev/zero > /run/codeboost-output/final.txt',
    'fifo-output': 'mkfifo /run/codeboost-output/final.txt',
    'invalid-utf8-output': "printf '\\377' > /run/codeboost-output/final.txt",
    'replace-output-directory': 'rm -rf /run/codeboost-output; ln -s /etc /run/codeboost-output',
    'nonzero-output': 'printf encoded-output; exit 7',
    'duplicate-protocol': "printf '\\036CODEBOOST_START:00000000-0000-0000-0000-000000000000\\036\\n' >&2",
    'newline-free-deferred-output': "printf captured > /run/codeboost-output/final.txt; printf trailing-diagnostic >&2",
    // Every agent-writable scratch area enforces both its byte and inode ceilings; the control area is not writable.
    'scratch-capacity': `${deny}set -eu; ${scratchBounded('/tmp', 64, 10000)}${scratchBounded('$HOME', 4, 1000)}`
      + 'if [ "${CODEBOOST_VENDOR:-}" = codex ]; then test -n "${CODEX_HOME:-}"; '
      + `${scratchBounded('$CODEX_HOME', 16, 2000)}${scratchBounded('/run/codeboost-output', 64, 1000)}fi; `
      + 'if [ -d /run/codeboost-control ]; then deny touch /run/codeboost-control/forged; fi; printf scratch-bounded',
    // Hard links, symlink aliases, truncation and replacement all fail, and the metadata digest is unchanged.
    'metadata-alias': `${deny}set -eu; `
      + 'digest() { (cd /work/.git && find . -type f -exec sha256sum {} + | sort | sha256sum); }; before=$(digest); '
      + 'object=$(find /work/.git/objects -type f | head -n 1); test -n "$object"; '
      + 'for target in /work /tmp "$HOME"; do deny ln /work/.git/config "$target/config-link"; '
      + 'deny ln "$object" "$target/object-link"; done; '
      + 'ln -s /work/.git/config /tmp/config-alias; ln -s "$object" /tmp/object-alias; '
      + "deny sh -c 'printf x >> /tmp/config-alias'; deny sh -c 'printf x >> /tmp/object-alias'; "
      + "deny sh -c ': > /work/.git/config'; deny truncate -s 0 /work/.git/config; "
      + 'deny rm -rf /work/.git; deny mv /work/.git /work/replaced; deny mv /work/.git /tmp/replaced; '
      + 'test "$(digest)" = "$before"; git status --porcelain > /dev/null; printf metadata-unchanged',
    // Every repository link in the checkout is relative and resolves inside it, and no host secret is reachable. The
    // search does not follow links, so a link loop cannot make it walk the whole container.
    'hostile-repo': `${deny}set -eu; test "$(git status --porcelain)" = ""; `
      + 'find /work -path /work/.git -prune -o -type l -exec sh -c \'for link; do target=$(readlink "$link"); '
      + 'case "$target" in /*) echo "isolation breach: absolute link $link" >&2; exit 1;; esac; '
      + 'case "$(realpath -m "$link")" in /work|/work/*) ;; '
      + '*) echo "isolation breach: link leaves the checkout $link" >&2; exit 1;; esac; done\' sh {} +; '
      + 'deny grep -rqs codeboost-host-secret /work /tmp "$HOME"; printf hostile-repo-contained',
  };
  return command(policy, probe === 'noop' ? ['true'] : ['sh', '-c', scripts[probe]]);
}
