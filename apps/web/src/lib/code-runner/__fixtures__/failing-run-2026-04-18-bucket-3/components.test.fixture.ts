import { describe, it, expect } from 'vitest';

describe('Components', () => {
  const idFn = <T,/>(x: T) => x;
  it('returns input', () => {
    expect(idFn(1)).toBe(1);
  });
});
