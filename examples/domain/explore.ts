import { leadsTo } from "./liveness.ts";
import {
  type ActionId,
  type Code,
  fire,
  type Product,
  type PropertyIndex,
  satisfies,
  size,
  type SyncIndex,
  type Test,
} from "./product.ts";

declare const indexBrand: unique symbol;
/** Discovery order in the BFS. A state's index never exceeds that of any state farther from the start. */
export type StateIndex = number & { readonly [indexBrand]: true; };

/**
 * The reachable graph. BFS expands states in index order and appends each state's edges together, so the edge
 * arrays are already compressed-row: state i's edges are `offsets[i] .. offsets[i + 1]`. Parent pointers form the
 * BFS tree, so walking `parent` from any state gives a shortest path from the start.
 */
export type StateSpace = {
  readonly codes: readonly Code[];
  readonly parent: Int32Array;
  /** The action of the tree edge into each state; -1 at the start. */
  readonly via: Int32Array;
  readonly offsets: Int32Array;
  readonly targets: Int32Array;
  readonly actions: Int32Array;
};

export type Step = { readonly action: ActionId; readonly from: Code; readonly to: Code; };

/** After the steps, a fair run of the system either does nothing more, or repeats `cycle` forever. */
export type Ending =
  | { readonly kind: "stays"; }
  | { readonly kind: "loops"; readonly cycle: readonly [Step, ...Step[]]; };

/** What the checker found, in indices only, so it can be cached and diagnosed against the current IR. */
export type Finding =
  /** `never P`: the steps end in a P state, by the shortest path there. */
  | { readonly kind: "reaches"; readonly property: PropertyIndex; readonly steps: readonly Step[]; }
  /** `possible P`: no reachable state has P. */
  | { readonly kind: "unreachable"; readonly property: PropertyIndex; }
  /** `P ~> Q`: P holds after `trigger` steps, and from there the fair run never meets Q. */
  | {
    readonly kind: "unsettled";
    readonly property: PropertyIndex;
    readonly steps: readonly Step[];
    readonly trigger: number;
    readonly ending: Ending;
  }
  /** No reachable state enables every port at once: the sync is dead code. */
  | { readonly kind: "dead sync"; readonly sync: SyncIndex; };

export type Outcome =
  | {
    readonly kind: "explored";
    readonly states: number;
    readonly transitions: number;
    readonly findings: readonly Finding[];
  }
  | { readonly kind: "too large"; readonly limit: number; };

/** BFS from `product.initial`; undefined once more than `budget` states are discovered. */
export const explore = (product: Product, budget: number): StateSpace | undefined => {
  const codes: Code[] = [product.initial];
  const index = new Map<number, number>([[product.initial, 0]]);
  const parent = [-1];
  const via = [-1];
  const offsets = [0];
  const targets: number[] = [];
  const actions: number[] = [];
  for (let state = 0; state < codes.length; state++) {
    const code = codes[state]!;
    for (let action = 0; action < product.actions.length; action++) {
      const next = fire(product, code, action as ActionId);
      if (next === undefined) continue;
      let target = index.get(next);
      if (target === undefined) {
        if (codes.length >= budget) return undefined;
        target = codes.length;
        index.set(next, target);
        codes.push(next);
        parent.push(state);
        via.push(action);
      }
      targets.push(target);
      actions.push(action);
    }
    offsets.push(targets.length);
  }
  return {
    codes,
    parent: Int32Array.from(parent),
    via: Int32Array.from(via),
    offsets: Int32Array.from(offsets),
    targets: Int32Array.from(targets),
    actions: Int32Array.from(actions),
  };
};

/** The BFS-tree path from the start to `state`, a shortest one. */
export const pathTo = (space: StateSpace, state: StateIndex): readonly Step[] => {
  const steps: Step[] = [];
  for (let at: number = state; space.parent[at]! >= 0; at = space.parent[at]!) {
    steps.push({ action: space.via[at]! as ActionId, from: space.codes[space.parent[at]!]!, to: space.codes[at]! });
  }
  return steps.reverse();
};

/** The first state, in BFS order, that passes `test`: a shortest way there. */
export const first = (product: Product, space: StateSpace, test: Test): StateIndex | undefined => {
  const found = space.codes.findIndex((code) => satisfies(product, test, code));
  return found < 0 ? undefined : (found as StateIndex);
};

/** Syncs whose action labels no edge. */
const deadSyncs = (product: Product, space: StateSpace): readonly SyncIndex[] => {
  const fired = new Set(space.actions);
  return product.actions.flatMap(({ origin }, action) =>
    origin.kind === "sync" && !fired.has(action) ? [origin.sync] : []
  );
};

/**
 * Everything the checker says about one product, properties in order, then dead syncs. Pure; the caller
 * memoizes by `key(product)`. `budget` caps reachable states, and so memory: a JS Map stops at 2^24 entries.
 */
export const outcome = (product: Product, budget: number): Outcome => {
  const space = Number.isSafeInteger(size(product)) ? explore(product, budget) : undefined;
  if (!space) return { kind: "too large", limit: budget };
  const findings = product.obligations.flatMap((obligation, index): readonly Finding[] => {
    const property = index as PropertyIndex;
    switch (obligation.kind) {
      case "never": {
        const bad = first(product, space, obligation.test);
        return bad === undefined ? [] : [{ kind: "reaches", property, steps: pathTo(space, bad) }];
      }
      case "possible":
        return first(product, space, obligation.test) === undefined ? [{ kind: "unreachable", property }] : [];
      case "leadsTo": {
        const found = leadsTo(product, space, obligation.from, obligation.to);
        return found ? [{ kind: "unsettled", property, ...found }] : [];
      }
    }
  });
  return {
    kind: "explored",
    states: space.codes.length,
    transitions: space.targets.length,
    findings: [...findings, ...deadSyncs(product, space).map((sync): Finding => ({ kind: "dead sync", sync }))],
  };
};
