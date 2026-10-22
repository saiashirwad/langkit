import type { Ending, StateIndex, StateSpace, Step } from "./explore.ts";
import { pathTo } from "./explore.ts";
import { type ActionId, type Product, satisfies, type Test } from "./product.ts";

/**
 * Strongly connected components of the subgraph `inside` induces, by an iterative Tarjan, so deep graphs do not
 * overflow the stack. `of[state]` is -1 for states outside.
 */
export const components = (
  space: StateSpace,
  inside: Uint8Array,
): { readonly of: Int32Array; readonly count: number; } => {
  const n = space.codes.length;
  const of = new Int32Array(n).fill(-1);
  const order = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const cursor = new Int32Array(n);
  const stack: number[] = [];
  const work: number[] = [];
  let counter = 0;
  let count = 0;
  const open = (state: number) => {
    order[state] = low[state] = counter++;
    cursor[state] = space.offsets[state]!;
    stack.push(state);
    onStack[state] = 1;
    work.push(state);
  };
  for (let root = 0; root < n; root++) {
    if (!inside[root] || order[root]! >= 0) continue;
    open(root);
    while (work.length) {
      const state = work.at(-1)!;
      if (cursor[state]! < space.offsets[state + 1]!) {
        const target = space.targets[cursor[state]!]!;
        cursor[state]!++;
        if (!inside[target]) continue;
        if (order[target]! < 0) open(target);
        else if (onStack[target]) low[state] = Math.min(low[state]!, order[target]!);
        continue;
      }
      work.pop();
      if (work.length) low[work.at(-1)!] = Math.min(low[work.at(-1)!]!, low[state]!);
      if (low[state] !== order[state]) continue;
      for (let member = -1; member !== state;) {
        member = stack.pop()!;
        onStack[member] = 0;
        of[member] = count;
      }
      count++;
    }
  }
  return { of, count };
};

const none = -1;

/**
 * `P ~> Q` under weak fairness on `product.fair`, stuttering allowed: nothing forces an event to fire unless a
 * fair component is continuously able to fire one. So a counterexample is a reachable P-and-not-Q state followed
 * by a fair run that never meets Q.
 *
 * 1. H = reachable states where Q is false, with the edges between them. Every state may also stutter.
 * 2. Tarjan's SCCs of H.
 * 3. An SCC C admits a fair run iff, for each fair component f, f is disabled at some state of C or some edge
 *    inside C involves f. Exact for weak fairness: one cycle through all of C visits every witness. A single
 *    state with no edge inside qualifies iff every fair component is disabled there, the run that stops.
 * 4. Reverse BFS inside H from fair SCCs. The P-state of least BFS index in that set starts the prefix.
 * 5. The trace: the BFS-tree path to that state, a BFS path inside H to the nearest fair SCC, then a cycle
 *    through one witness per fair component that is enabled where the cycle starts, or `stays` when none is.
 *
 * O(V + E) per property, plus one BFS inside the SCC per witness.
 */
export const leadsTo = (
  product: Product,
  space: StateSpace,
  from: Test,
  to: Test,
): { readonly steps: readonly Step[]; readonly trigger: number; readonly ending: Ending; } | undefined => {
  const n = space.codes.length;
  const { offsets, targets, actions } = space;
  const fair = product.fair;
  const touches = product.actions.map(({ moves }) => fair.map((f) => moves.some(({ component }) => component === f)));
  const enabled = new Uint8Array(n * fair.length);
  for (let state = 0; state < n; state++) {
    for (let edge = offsets[state]!; edge < offsets[state + 1]!; edge++) {
      touches[actions[edge]!]!.forEach((involved, f) => {
        if (involved) enabled[state * fair.length + f] = 1;
      });
    }
  }
  const inside = Uint8Array.from(space.codes, (code) => (satisfies(product, to, code) ? 0 : 1));
  const { of, count } = components(space, inside);

  const disabledAt = new Int32Array(count * fair.length).fill(none);
  const actsOn = new Int32Array(count * fair.length).fill(none);
  const actsFrom = new Int32Array(count * fair.length).fill(none);
  for (let state = 0; state < n; state++) {
    const scc = of[state]!;
    if (scc < 0) continue;
    for (let f = 0; f < fair.length; f++) {
      if (!enabled[state * fair.length + f] && disabledAt[scc * fair.length + f] === none) {
        disabledAt[scc * fair.length + f] = state;
      }
    }
    for (let edge = offsets[state]!; edge < offsets[state + 1]!; edge++) {
      if (of[targets[edge]!] !== scc) continue;
      touches[actions[edge]!]!.forEach((involved, f) => {
        if (involved && actsOn[scc * fair.length + f] === none) {
          actsOn[scc * fair.length + f] = edge;
          actsFrom[scc * fair.length + f] = state;
        }
      });
    }
  }
  const admits = new Uint8Array(count);
  for (let scc = 0; scc < count; scc++) {
    admits[scc] = fair.every((_, f) =>
        disabledAt[scc * fair.length + f] !== none || actsOn[scc * fair.length + f] !== none
      )
      ? 1
      : 0;
  }

  const into: number[][] = Array.from({ length: n }, () => []);
  for (let state = 0; state < n; state++) {
    if (!inside[state]) continue;
    for (let edge = offsets[state]!; edge < offsets[state + 1]!; edge++) {
      if (inside[targets[edge]!]) into[targets[edge]!]!.push(state);
    }
  }
  const doomed = new Uint8Array(n);
  const queue: number[] = [];
  for (let state = 0; state < n; state++) {
    if (of[state]! >= 0 && admits[of[state]!]) {
      doomed[state] = 1;
      queue.push(state);
    }
  }
  for (const state of queue) {
    for (const source of into[state]!) {
      if (!doomed[source]) {
        doomed[source] = 1;
        queue.push(source);
      }
    }
  }
  let start = none;
  for (let state = 0; state < n && start === none; state++) {
    if (doomed[state] && satisfies(product, from, space.codes[state]!)) start = state;
  }
  if (start === none) return undefined;

  const step = (edge: number, source: number): Step => ({
    action: actions[edge]! as ActionId,
    from: space.codes[source]!,
    to: space.codes[targets[edge]!]!,
  });
  /** A shortest path from `source` to the first state `goal` accepts, along edges `allowed` keeps. */
  const search = (source: number, goal: (state: number) => boolean, allowed: (target: number) => boolean) => {
    const previous = new Map<number, number>([[source, none]]);
    const sources = new Map<number, number>();
    const frontier = [source];
    let found = goal(source) ? source : none;
    for (let index = 0; index < frontier.length && found === none; index++) {
      const state = frontier[index]!;
      for (let edge = offsets[state]!; edge < offsets[state + 1]! && found === none; edge++) {
        const target = targets[edge]!;
        if (!allowed(target) || previous.has(target)) continue;
        previous.set(target, edge);
        sources.set(target, state);
        frontier.push(target);
        if (goal(target)) found = target;
      }
    }
    const path: Step[] = [];
    for (let state = found; previous.get(state) !== none; state = sources.get(state)!) {
      path.push(step(previous.get(state)!, sources.get(state)!));
    }
    return { end: found, path: path.reverse() };
  };

  const prefix = pathTo(space, start as StateIndex);
  const middle = search(start, (state) => admits[of[state]!] === 1, (target) => inside[target] === 1);
  const entry = middle.end;
  const scc = of[entry]!;
  const within = (target: number) => of[target] === scc;
  const steps = [...prefix, ...middle.path];
  if (fair.every((_, f) => !enabled[entry * fair.length + f])) {
    return { steps, trigger: prefix.length, ending: { kind: "stays" } };
  }
  const cycle: Step[] = [];
  let at = entry;
  for (let f = 0; f < fair.length; f++) {
    if (!enabled[entry * fair.length + f]) continue;
    const disabled = disabledAt[scc * fair.length + f]!;
    if (disabled !== none) {
      const leg = search(at, (state) => state === disabled, within);
      cycle.push(...leg.path);
      at = disabled;
      continue;
    }
    const edge = actsOn[scc * fair.length + f]!;
    const source = actsFrom[scc * fair.length + f]!;
    const leg = search(at, (state) => state === source, within);
    cycle.push(...leg.path, step(edge, source));
    at = targets[edge]!;
  }
  cycle.push(...search(at, (state) => state === entry, within).path);
  const [head, ...tail] = cycle;
  return { steps, trigger: prefix.length, ending: { kind: "loops", cycle: [head!, ...tail] } };
};
