import { describe, expect, it } from 'vitest';
import { ByteCollector } from '../agents/adapters/supervisor.ts';

describe('captured output storage', () => {
  it('keeps storage proportional to bytes, not to the number of writes', () => {
    const collector = new ByteCollector();
    for (let i = 0; i < 100_000; i++) collector.push(Buffer.from([i % 256]));
    expect(collector.blockCount).toBeLessThanOrEqual(2);
    const output = collector.toBuffer();
    expect(output.length).toBe(100_000);
    expect(output.every((byte, index) => byte === index % 256)).toBe(true);
  });

  it('splits a large write across blocks without losing or reordering bytes', () => {
    const collector = new ByteCollector(), large = Buffer.alloc(3 * ByteCollector.BLOCK_BYTES + 17, 7);
    collector.push(Buffer.from('head'));
    collector.push(large);
    expect(collector.blockCount).toBe(4);
    expect(collector.toBuffer()).toEqual(Buffer.concat([Buffer.from('head'), large]));
    expect(new ByteCollector().toBuffer().length).toBe(0);
  });
});
