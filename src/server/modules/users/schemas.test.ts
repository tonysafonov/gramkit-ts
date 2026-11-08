/** Validation of the user-writable `SeenFeaturesPatch` body (key grammar, bounds, depth). Pure zod: no database. */
import { describe, expect, it } from 'vitest';
import { SeenFeaturesPatch } from './schemas';

describe('SeenFeaturesPatch validation', () => {
  it('accepts valid', () => {
    const patch = SeenFeaturesPatch.parse({ 'reveal.profile_tab': true, 'whatsnew.dashboard': { v: 3 } });
    expect(patch['reveal.profile_tab']).toBe(true);
    expect(patch['whatsnew.dashboard']).toEqual({ v: 3 });
  });

  it('rejects empty', () => {
    expect(SeenFeaturesPatch.safeParse({}).success).toBe(false);
  });

  it.each(['Reveal.ProfileTab', 'reveal cat', '1reveal', 'reveal..x', '.reveal', 'reveal-name'])(
    'rejects bad key %s',
    (badKey) => {
      expect(SeenFeaturesPatch.safeParse({ [badKey]: true }).success).toBe(false);
    },
  );

  it('rejects too many keys', () => {
    const tooMany = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`reveal.k${i}`, true]));
    expect(SeenFeaturesPatch.safeParse(tooMany).success).toBe(false);
    const max = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`reveal.k${i}`, true]));
    expect(SeenFeaturesPatch.safeParse(max).success).toBe(true);
  });

  it('rejects a nested record', () => {
    // Values are at most one level deep: a record may hold scalars only.
    expect(SeenFeaturesPatch.safeParse({ 'nudge.x': { a: { b: 1 } } }).success).toBe(false);
  });
});
