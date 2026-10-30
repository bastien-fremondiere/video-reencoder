import { describe, it, expect } from 'vitest';
import { createWritableStream } from './streamSaver';

describe('StreamSaver API', () => {
  it('exports createWritableStream function', () => {
    expect(typeof createWritableStream).toBe('function');
  });
});
