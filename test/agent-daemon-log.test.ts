import { describe, expect, it } from 'vitest';
import { keepsNoDaemonLog } from '../agents/container/run.ts';

// The validator's rule for an agent container's daemon log (#165), for configurations the CLI cannot make: it refuses
// `--log-opt` with driver `none`, but the API stores any option, and a daemon copies its `cache-*` log options into
// every container (moby v27.4.0). The created container itself is checked against real Docker in agent-container.
describe('keepsNoDaemonLog', () => {
  it('accepts only driver none, with no option but cache ones', () => {
    expect(keepsNoDaemonLog({ Type: 'none', Config: {} })).toBe(true);
    expect(keepsNoDaemonLog({ Type: 'none', Config: null })).toBe(true);
    expect(keepsNoDaemonLog({ Type: 'none', Config: { 'cache-disabled': 'true', 'cache-max-size': '1m' } })).toBe(true);
    for (const config of [undefined, null, {}, { Type: 'json-file', Config: {} }, { Type: 'NONE', Config: {} },
      { Type: 'local', Config: { 'max-size': '1m', 'max-file': '1' } }, { Type: 'none', Config: { mode: 'non-blocking' } },
      { Type: 'none', Config: { 'max-size': '1m' } }, { Type: 'none', Config: { 'cache-disabled': 'true', mode: 'non-blocking' } },
    ] as Parameters<typeof keepsNoDaemonLog>[0][]) expect(keepsNoDaemonLog(config)).toBe(false);
  });
});
