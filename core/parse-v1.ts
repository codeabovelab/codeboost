import { isAlias, isMap, isScalar, isSeq, parseDocument } from 'yaml';

const MAX_BYTES = 1024 * 1024;
const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/u;
function reject(message: string): never { throw new Error(message); }
function numeric(text: string): number {
  if (!number.test(text)) reject('Non-JSON numeric scalar.');
  const n = Number(text);
  if (!Number.isFinite(n) || (Number.isInteger(n) && !Number.isSafeInteger(n))) reject('Number is outside the safe range.');
  if (Number.isInteger(n)) {
    const [mantissa, exponentText = '0'] = text.toLowerCase().split('e');
    const fractionLength = mantissa!.split('.')[1]?.length ?? 0;
    let digits = mantissa!.replace(/[-.]/gu, '').replace(/^0+/u, '');
    let exponent = Number(exponentText) - fractionLength;
    while (digits.endsWith('0')) { digits = digits.slice(0, -1); exponent++; }
    if (digits && (exponent < 0 || exponent > 16 || digits.length + exponent > 16 ||
        Number((text.startsWith('-') ? '-' : '') + digits + '0'.repeat(exponent)) !== n))
      reject('Integer is not exactly representable.');
  }
  return n;
}
/** Frozen v1 syntax contract. No runtime I/O or alias/object construction. */
export function parseV1(input: string | Uint8Array, format: 'json' | 'yaml'): unknown {
  if (typeof input === 'string' && input.length > MAX_BYTES) reject('Input size exceeds 1 MiB.');
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  if (bytes.byteLength > MAX_BYTES) reject('Input size exceeds 1 MiB.');
  const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  if (typeof input === 'string' && input !== source) reject('Invalid UTF-8 source string.');
  if (format === 'json') return parseJson(source);
  if (format !== 'yaml') reject('Unknown input format.');
  const doc = parseDocument(source, { uniqueKeys: false, version: '1.2', strict: true });
  if (doc.directives?.yaml.version !== '1.2') reject('Only YAML 1.2 is supported.');
  if (doc.errors.length || doc.warnings.length) reject([...doc.errors, ...doc.warnings].map(e => e.message).join('; '));
  function convert(node: unknown, depth: number): unknown {
    if (isAlias(node)) reject('Alias resolution is disabled.');
    if (!isScalar(node) && !isSeq(node) && !isMap(node)) reject('Empty or unsupported YAML scalar.');
    if (node.anchor || node.tag) reject('Anchors and explicit tags are prohibited.');
    if (isScalar(node)) {
      const raw = node.source ?? '';
      if (node.type !== 'PLAIN') {
        if (typeof node.value !== 'string') reject('Quoted scalar must be a string.');
        return node.value;
      }
      if (!raw) reject('Empty implicit YAML scalar.');
      if (raw === 'null') return null;
      if (raw === 'true' || raw === 'false') return raw === 'true';
      if (typeof node.value === 'number') return numeric(raw);
      if (typeof node.value !== 'string') reject('Only exact JSON literal scalars are permitted.');
      if (/^[+-]?0[bBoOxX][0-9a-fA-F_]+$/u.test(raw)) reject('Non-JSON numeric scalar.');
      // YAML implementations differ on numeric separators; v1 explicitly forbids them.
      if (/^[+-]?(?:[0-9][0-9_]*(?:\.[0-9_]*)?|\.[0-9_]+)(?:[eE][+-]?[0-9_]+)?$/u.test(raw) && raw.includes('_')) reject('Non-JSON numeric scalar.');
      return node.value;
    }
    if (depth >= 50) reject('Container depth exceeds 50.');
    if (isSeq(node)) return node.items.map(child => convert(child, depth + 1));
    const result: Record<string, unknown> = Object.create(null);
    for (const pair of node.items) {
      if (!isScalar(pair.key)) reject('Mapping keys must be strings.');
      const key = convert(pair.key, depth + 1);
      if (typeof key !== 'string') reject('Mapping keys must be strings.');
      if (key === '<<') reject('Merge keys are prohibited.');
      if (Object.hasOwn(result, key)) reject(`Duplicate key: ${key}`);
      result[key] = convert(pair.value, depth + 1);
    }
    return result;
  }
  return convert(doc.contents, 0);
}

/** Recursive descent detects decoded duplicate keys before object creation. */
function parseJson(source: string): unknown {
  let i = 0;
  const whitespace = () => { while (i < source.length && /[ \t\r\n]/u.test(source[i]!)) i++; };
  const string = (): string => {
    const start = i++;
    while (i < source.length) {
      const c = source[i++];
      if (c === '"') return JSON.parse(source.slice(start, i)) as string;
      if (c === '\\') i++;
    }
    return reject('Unterminated JSON string.');
  };
  function value(depth: number): unknown {
    whitespace();
    const c = source[i];
    if (c === '"') return string();
    if (c === '{' || c === '[') {
      if (depth >= 50) reject('Container depth exceeds 50.');
      i++; whitespace();
      const object = c === '{', close = object ? '}' : ']';
      const entries: Record<string, unknown> = Object.create(null), items: unknown[] = [];
      if (source[i] === close) { i++; return object ? entries : items; }
      while (true) {
        whitespace();
        if (object) {
          if (source[i] !== '"') reject('JSON object key must be a string.');
          const key = string(); whitespace();
          if (source[i++] !== ':') reject('Expected JSON colon.');
          if (Object.hasOwn(entries, key)) reject(`Duplicate key: ${key}`);
          entries[key] = value(depth + 1);
        } else items.push(value(depth + 1));
        whitespace();
        if (source[i] === close) { i++; return object ? entries : items; }
        if (source[i++] !== ',') reject('Expected JSON comma.');
      }
    }
    for (const [literal, parsed] of [['true', true], ['false', false], ['null', null]] as const) {
      if (source.startsWith(literal, i)) { i += literal.length; return parsed; }
    }
    const token = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(source.slice(i));
    if (!token) reject('Invalid JSON value.');
    i += token[0].length;
    return numeric(token[0]);
  }
  const result = value(0); whitespace();
  if (i !== source.length) reject('Unexpected trailing JSON input.');
  return result;
}
