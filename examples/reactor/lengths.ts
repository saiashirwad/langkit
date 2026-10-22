type Interval = readonly [min: number, max: number];

/**
 * A set of list lengths as sorted, disjoint intervals; `max` may be Infinity. Intervals rather than a set of
 * numbers, so narrowing `[T; ..1000000]` costs what `[T; ..3]` does.
 */
export type Lengths = readonly Interval[];

export const upTo = (max: number): Lengths => [[0, max]];

export const exactly = (length: number): Lengths => [[length, length]];

export const atLeast = (length: number): Lengths => [[length, Infinity]];

export const isEmpty = (lengths: Lengths): boolean => lengths.length === 0;

/** The longest length in the set, or undefined for the empty set. */
export const longest = (lengths: Lengths): number | undefined => lengths.at(-1)?.[1];

export const intersect = (a: Lengths, b: Lengths): Lengths =>
  a.flatMap(([lo, hi]) =>
    b.flatMap(([otherLo, otherHi]): Interval[] => {
      const min = Math.max(lo, otherLo);
      const max = Math.min(hi, otherHi);
      return min <= max ? [[min, max]] : [];
    })
  );

export const minus = (a: Lengths, b: Lengths): Lengths =>
  b.reduce<Lengths>(
    (kept, [otherLo, otherHi]) =>
      kept.flatMap(([lo, hi]): Interval[] =>
        [
          [lo, Math.min(hi, otherLo - 1)] as const,
          [Math.max(lo, otherHi + 1), hi] as const,
        ].filter(([min, max]) => min <= max && min !== Infinity)
      ),
    a,
  );

/** What a rest binding can hold once `fixed` items around it are taken off each length. */
export const rest = (lengths: Lengths, fixed: number): Lengths =>
  intersect(lengths, atLeast(fixed)).map(([lo, hi]) => [lo - fixed, hi - fixed] as const);
