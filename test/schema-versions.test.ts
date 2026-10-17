import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import registry from '../schema/versions.json' with { type: 'json' };
import planV1 from '../schema/versions/1/plan.schema.json' with { type: 'json' };
import editV1 from '../schema/versions/1/plan-edit.schema.json' with { type: 'json' };
import { CURRENT_SCHEMA_VERSION, loadPlanSchemas, PlanError, retainedSchemaPath, validatePlan, type Plan, type PlanContext,
  type PlanSchemas, type SchemaRegistry, type Validation } from '../core/plan.ts';

// Released snapshots and their semantics are immutable (docs/plan-format.md, "Versions"). A new version adds
// files and digests here; it never edits these.
const RELEASED: Readonly<Record<string, string>> = {
  'versions/1/plan.schema.json': '55b04a7df0f02165460c4ebc5cf40a00ca2a0ca8fa56a3bf8434aacfe8350179',
  'versions/1/plan-edit.schema.json': 'b3c46f36405c4c7c57c9d8d903b6759a5ba0cf9b17ce99e3bba670f6f2ac5473',
  'versions/1/semantics.md': 'dfe68353aebc3ad59e85f0a4d8b057b599fb22775a52b4831cc664acb926d9cc',
};
const BASE = 'https://github.com/codeabovelab/codeboost/schema/';
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

it('pins the bytes of every file a registered version names', () => {
  const named = Object.values(registry.versions).flatMap(entry => [entry.plan, entry.edit, entry.semantics]);
  expect([...named].sort()).toEqual(Object.keys(RELEASED).sort());
  for (const path of named) expect(sha256(readFileSync(new URL('../schema/' + path, import.meta.url))), path).toBe(RELEASED[path]);
});

it('never registers the unversioned CLI copies, which share the current snapshots\' $id', () => {
  const copy = (name: string) => JSON.parse(readFileSync(new URL('../schema/' + name, import.meta.url), 'utf8')) as object;
  const cli = { 'plan.schema.json': copy('plan.schema.json'), 'plan-edit.schema.json': copy('plan-edit.schema.json') };
  expect(cli).toEqual({ 'plan.schema.json': planV1, 'plan-edit.schema.json': editV1 });
  // A loader that compiled every supplied snapshot would reach the copies, whose $id names the versioned path, and throw.
  const schemas = loadPlanSchemas(registry, { ...SNAPSHOTS, ...cli });
  expect([...schemas.versions.keys()]).toEqual([1]);
  expect(schemas.select(plan(1)).paths).toEqual({ plan: 'versions/1/plan.schema.json', edit: 'versions/1/plan-edit.schema.json' });
});

it('loads exactly the registered versions and exposes the current version', () => {
  const schemas = loadPlanSchemas(registry);
  expect([...schemas.versions.keys()]).toEqual(Object.keys(registry.versions).map(Number));
  expect(schemas.current.version).toBe(registry.current);
  expect(CURRENT_SCHEMA_VERSION).toBe(registry.current);
  expect(retainedSchemaPath(1, 'plan')).toBe('versions/1/plan.schema.json');
  expect(retainedSchemaPath(1, 'edit')).toBe('versions/1/plan-edit.schema.json');
  const unregistered = Math.max(...schemas.versions.keys()) + 1;
  expect(() => retainedSchemaPath(unregistered, 'plan')).toThrow('not registered');
});

// A second retained version: v1's snapshots under version-2 IDs, accepting only schema_version 2.
function asVersion2(schema: typeof planV1 | typeof editV1, path: string) {
  const copy = structuredClone(schema) as Record<string, unknown> & { properties: Record<string, unknown> };
  return { ...copy, $id: BASE + path, properties: { ...copy.properties, schema_version: { type: 'integer', enum: [2] } } };
}
const V2 = { plan: 'versions/2/plan.schema.json', edit: 'versions/2/plan-edit.schema.json', semantics: 'versions/2/semantics.md', validator: 'v2' };
const SNAPSHOTS = { 'versions/1/plan.schema.json': planV1, 'versions/1/plan-edit.schema.json': editV1,
  'versions/2/plan.schema.json': asVersion2(planV1, V2.plan), 'versions/2/plan-edit.schema.json': asVersion2(editV1, V2.edit) };
const calls: string[] = [];
const validator = (name: string) => (_value: Plan, _context: PlanContext): Validation => { calls.push(name); return { errors: [], warnings: [] }; };
const VALIDATORS = { v1: { semantics: 'versions/1/semantics.md', validate: validator('v1') },
  v2: { semantics: 'versions/2/semantics.md', validate: validator('v2') } };
const twoVersions = (version2: Partial<typeof V2> = {}, current = 2): SchemaRegistry =>
  ({ current, versions: { '1': registry.versions['1'], '2': { ...V2, ...version2 } } });
const plan = (schemaVersion: number) => ({ schema_version: schemaVersion, issue: 1, revision: 1, summary: 'Example', questions: [],
  items: [{ id: 'P1', title: 'Change', intent: 'Improve', files: [{ path: 'a', kind: 'edit', renamed_from: null, change: 'Change' }],
    acceptance: [{ type: 'check', text: 'Works' }], depends_on: [] }] });

it('compiles retained versions side by side and selects each value\'s own schema and validator', () => {
  const schemas = loadPlanSchemas(twoVersions(), SNAPSHOTS, VALIDATORS);
  const v1 = schemas.versions.get(1)!, v2 = schemas.versions.get(2)!;
  expect(schemas.current).toBe(v2);
  expect(schemas.select(plan(1))).toBe(v1);
  expect(schemas.select(plan(2))).toBe(v2);
  // Each snapshot accepts only its own version; neither is applied to the other's documents.
  expect(v1.plan(plan(1))).toBe(true); expect(v1.plan(plan(2))).toBe(false);
  expect(v2.plan(plan(2))).toBe(true); expect(v2.plan(plan(1))).toBe(false);
  calls.length = 0;
  v1.validate!(plan(1) as Plan, {} as PlanContext); v2.validate!(plan(2) as Plan, {} as PlanContext);
  expect(calls).toEqual(['v1', 'v2']);
  // Anything without a registered version gets the current schema, which then reports the bad field.
  for (const value of [plan(3), { ...plan(1), schema_version: '1' }, {}, null, [], Object.create({ schema_version: 1 })])
    expect(schemas.select(value)).toBe(v2);
});

it('refuses a registry entry that the retained snapshots and validators do not match', () => {
  expect(() => loadPlanSchemas(twoVersions({ plan: 'versions/2/missing.schema.json' }), SNAPSHOTS, VALIDATORS))
    .toThrow('versions/2/missing.schema.json, which is not a retained snapshot');
  // A path is looked up as an own key only.
  expect(() => loadPlanSchemas(twoVersions({ edit: 'constructor' }), SNAPSHOTS, VALIDATORS)).toThrow('not a retained snapshot');
  // Each version has its own snapshots: sharing one would apply a schema to another version's documents.
  expect(() => loadPlanSchemas(twoVersions({ plan: 'versions/1/plan.schema.json' }), SNAPSHOTS, VALIDATORS))
    .toThrow('versions/1/plan.schema.json, which is already named in the registry');
  expect(() => loadPlanSchemas(twoVersions({ edit: V2.plan }), SNAPSHOTS, VALIDATORS)).toThrow('already named in the registry');
  expect(() => loadPlanSchemas(twoVersions({ plan: V2.edit, edit: V2.plan }), SNAPSHOTS, VALIDATORS))
    .toThrow('Schema version 2 names versions/2/plan-edit.schema.json as its plan schema, which it is not');
  const planShaped = 'versions/2/plan-copy.schema.json';
  expect(() => loadPlanSchemas(twoVersions({ edit: planShaped }), { ...SNAPSHOTS, [planShaped]: asVersion2(planV1, planShaped) }, VALIDATORS))
    .toThrow(`Schema version 2 names ${planShaped} as its edit schema, which it is not`);
  // A snapshot that requires both items and edits fits neither role.
  const both = { ...SNAPSHOTS['versions/2/plan-edit.schema.json'], required: [...editV1.required, 'items'] };
  expect(() => loadPlanSchemas(twoVersions(), { ...SNAPSHOTS, 'versions/2/plan-edit.schema.json': both }, VALIDATORS))
    .toThrow('Schema version 2 names versions/2/plan-edit.schema.json as its edit schema, which it is not');
  expect(() => loadPlanSchemas(twoVersions({ validator: 'v9', semantics: 'versions/1/semantics.md' }), SNAPSHOTS, VALIDATORS))
    .toThrow('versions/1/semantics.md, which is already named in the registry');
  expect(() => loadPlanSchemas(twoVersions(), { ...SNAPSHOTS, 'versions/2/plan.schema.json': planV1 }, VALIDATORS))
    .toThrow('versions/2/plan.schema.json has a different $id');
  // A snapshot must accept its own version only, or selection could send another version's documents to it.
  const accepting = (schema: object, enumeration: unknown) =>
    ({ ...schema, properties: { ...(schema as { properties: object }).properties, schema_version: { type: 'integer', enum: enumeration } } });
  for (const enumeration of [[2, 3], [1], [], undefined])
    expect(() => loadPlanSchemas(twoVersions(), { ...SNAPSHOTS, 'versions/2/plan-edit.schema.json': accepting(SNAPSHOTS['versions/2/plan-edit.schema.json'], enumeration) },
      VALIDATORS)).toThrow('versions/2/plan-edit.schema.json must require schema_version and accept only 2');
  const optional = { ...SNAPSHOTS['versions/2/plan.schema.json'], required: planV1.required.filter(name => name !== 'schema_version') };
  expect(() => loadPlanSchemas(twoVersions(), { ...SNAPSHOTS, 'versions/2/plan.schema.json': optional }, VALIDATORS))
    .toThrow('versions/2/plan.schema.json must require schema_version and accept only 2');
  expect(() => loadPlanSchemas(twoVersions({ semantics: 'versions/9/semantics.md' }), SNAPSHOTS, VALIDATORS))
    .toThrow('pairs validator v2 with versions/9/semantics.md, but it implements versions/2/semantics.md');
  expect(() => loadPlanSchemas(twoVersions({}, 3), SNAPSHOTS, VALIDATORS)).toThrow('current schema version 3 is not registered');
  // Each version has a dedicated validator, even when it would share the semantics document.
  expect(() => loadPlanSchemas(twoVersions({ validator: 'v1', semantics: 'versions/1/semantics.md' }), SNAPSHOTS, VALIDATORS))
    .toThrow('Schema version 2 reuses validator v1');
  expect(() => loadPlanSchemas(twoVersions(), SNAPSHOTS, { ...VALIDATORS, v2: { ...VALIDATORS.v2, validate: VALIDATORS.v1.validate } }))
    .toThrow('Schema version 2 reuses another version\'s validator implementation');
  // 2^53 + 1 matches the digit pattern but is not a safe integer, so it would load under a rounded number.
  for (const key of ['02', '0', '1.0', 'x', '9007199254740993'])
    expect(() => loadPlanSchemas({ current: 1, versions: { '1': registry.versions['1'], [key]: V2 } }, SNAPSHOTS, VALIDATORS))
      .toThrow(`Schema version ${key} is not a version number`);
});

it.each(['v9', 'constructor'])('loads a version whose validator key %s has no implementation and validates it as unsupported', key => {
  const schemas = loadPlanSchemas(twoVersions({ validator: key }), SNAPSHOTS, VALIDATORS);
  expect(schemas.versions.get(2)!.validate).toBeNull();
  expect(schemas.versions.get(1)!.validate).toBe(VALIDATORS.v1.validate);
  calls.length = 0;
  expect(schemas.validate(plan(2), {} as PlanContext))
    .toEqual({ errors: [{ code: 'version', message: 'Schema version 2 is not supported: codeboost has no semantic validator for it.' }], warnings: [] });
  expect(schemas.validate(plan(1), {} as PlanContext)).toEqual({ errors: [], warnings: [] });
  expect(calls).toEqual(['v1']);
});

it('refuses a version with no validator implementation where only the shape is asserted', () => {
  const schemas: PlanSchemas = loadPlanSchemas(twoVersions({ validator: 'v9' }), SNAPSHOTS, VALIDATORS);
  expect(() => schemas.assertPlan(plan(1))).not.toThrow();
  const refusal = (value: unknown) => { try { schemas.assertPlan(value); } catch (error) { return (error as PlanError).diagnostics; } return null; };
  expect(refusal(plan(2))).toEqual([{ code: 'version', message: 'Schema version 2 is not supported: codeboost has no semantic validator for it.' }]);
  // The shape is checked first, against the version the value declares.
  expect(refusal({ ...plan(2), summary: 3 })).toEqual([expect.objectContaining({ code: 'schema', message: '/summary must be string' })]);
  expect(refusal(plan(3))).toEqual([expect.objectContaining({ code: 'schema' })]);
  // Edit replies get the same refusal, after their own version's edit schema.
  const reply = (version: number) => ({ schema_version: version, base_revision: 1, reply: 'r', edits: [] });
  const replyRefusal = (value: unknown) => { try { schemas.assertEditReply(value); } catch (error) { return (error as PlanError).diagnostics; } return null; };
  expect(replyRefusal(reply(1))).toBeNull();
  expect(replyRefusal(reply(2))).toEqual([{ code: 'version', message: 'Schema version 2 is not supported: codeboost has no semantic validator for it.' }]);
  expect(replyRefusal({ ...reply(2), reply: 3 })).toEqual([expect.objectContaining({ code: 'edit-schema', message: '/reply must be string' })]);
});

it('validates shape and semantics with the one version the value declares', () => {
  const schemas = loadPlanSchemas(twoVersions(), SNAPSHOTS, VALIDATORS);
  calls.length = 0;
  expect(schemas.validate(plan(2), {} as PlanContext).errors).toEqual([]);
  expect(schemas.validate(plan(1), {} as PlanContext).errors).toEqual([]);
  expect(calls).toEqual(['v2', 'v1']);
  // A shape failure stops before any semantic validator runs.
  expect(schemas.validate({ ...plan(2), summary: 3 }, {} as PlanContext).errors)
    .toEqual([expect.objectContaining({ code: 'schema', message: '/summary must be string' })]);
  expect(schemas.validate(plan(3), {} as PlanContext).errors).toEqual([expect.objectContaining({ code: 'schema' })]);
  expect(calls).toEqual(['v2', 'v1']);
});

it('reports an unregistered version through the current schema', () => {
  const context: PlanContext = { identity: { repositoryId: 'r', taskId: 't', planId: 'p' }, issue: 1,
    baseEntries: [{ path: 'a', kind: 'file' }], pathKey: path => path, allowedCommands: [] };
  expect(validatePlan(plan(1), context).errors).toEqual([]);
  expect(validatePlan(plan(2), context).errors).toEqual([expect.objectContaining({ code: 'schema', message: expect.stringContaining('/schema_version') })]);
});
