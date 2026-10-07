import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('refuses malformed Unicode before spawning an approved command', () => {
  const root = mkdtempSync(join(tmpdir(), 'codeboost-command-check-'));
  try {
    const input = join(root, 'commands.json');
    writeFileSync(input, '[["node","\\ud800"]]');
    const script = fileURLToPath(new URL('../agents/container/command-check.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script, input]);
    expect({ status: result.status, signal: result.signal }).toEqual({ status: 78, signal: null });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
