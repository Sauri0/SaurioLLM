import { describe, it, expect } from 'vitest';
import { RingBuffer } from './ringBuffer.js';

describe('RingBuffer', () => {
  it('conserva el orden mientras no se llena', () => {
    const buf = new RingBuffer<number>(5);
    buf.push(1); buf.push(2); buf.push(3);
    expect(buf.toArray()).toEqual([1, 2, 3]);
    expect(buf.size).toBe(3);
  });

  it('descarta lo más antiguo al superar la capacidad', () => {
    const buf = new RingBuffer<number>(3);
    [1, 2, 3, 4, 5].forEach((n) => buf.push(n));
    expect(buf.toArray()).toEqual([3, 4, 5]);
    expect(buf.size).toBe(3);
  });

  it('clear vacía el buffer', () => {
    const buf = new RingBuffer<number>(3);
    buf.push(1);
    buf.clear();
    expect(buf.toArray()).toEqual([]);
    expect(buf.size).toBe(0);
  });

  it('rechaza capacity <= 0', () => {
    expect(() => new RingBuffer<number>(0)).toThrow();
  });
});
