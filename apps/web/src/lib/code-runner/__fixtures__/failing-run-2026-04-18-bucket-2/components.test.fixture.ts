// Bucket 2 — one-off shape: `Expected ">" but found "/"` from a
// generic-arrow-function-in-tsx-file collision. Documented as
// un-repairable; the verify gate flags it for human review.
import { describe, it, expect } from 'vitest';

describe('Components', () => {
  const idFn = <T,/>(x: T) => x;
  it('returns input', () => {
    expect(idFn(1)).toBe(1);
  });
});
