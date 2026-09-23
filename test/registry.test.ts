import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import registry from '../schema/versions.json' with { type: 'json' };
it('registers retained schemas once and keeps CLI copies identical to the current version', () => {
 const ajv = new Ajv2020({ strict: true });
 for (const [version, entry] of Object.entries(registry.versions)) {
  expect(entry.validator).toBe('v'+version);
  expect(readFileSync(new URL('../schema/'+entry.semantics, import.meta.url), 'utf8')).toContain('## Deterministic input parsing');
  for (const kind of ['plan', 'edit'] as const) {
   const text = readFileSync(new URL('../schema/'+entry[kind], import.meta.url), 'utf8');
   const schema = JSON.parse(text); ajv.addSchema(schema);
   expect(schema.$id).toBe('https://github.com/codeabovelab/codeboost/schema/'+entry[kind]);
   const cli = kind === 'plan' ? 'plan' : 'plan-edit';
   if (+version === registry.current) expect(text).toBe(readFileSync(new URL('../schema/'+cli+'.schema.json', import.meta.url), 'utf8'));
   expect(ajv.getSchema(schema.$id)).toBeDefined();
  }
 }
});
