import { performance } from "node:perf_hooks";
import { componentId } from "../examples/domain/domain-model.ts";
import { explore, first } from "../examples/domain/explore.ts";
import { leadsTo } from "../examples/domain/liveness.ts";
import type { Action, Code, Product, Test } from "../examples/domain/product.ts";

let seed = 7;
const random = (n: number) => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed % n;
};

/**
 * k machines of n states, the worst case for a product: each has a `next` event round its states, so every product
 * state is reachable, plus two random local events, and neighbouring machines sync one pair of edges.
 */
const synthetic = (k: number, n: number): Product => {
  const radix = Array.from({ length: k }, () => n);
  const stride = radix.map((_, index) => n ** index);
  const table = (edges: readonly (readonly [number, number])[]) => {
    const next = new Int16Array(n).fill(-1);
    for (const [from, to] of edges) next[from] = to;
    return next;
  };
  const local = (c: number, edges: readonly (readonly [number, number])[]): Action => ({
    origin: { kind: "event", component: componentId(c), event: 0 },
    moves: [{ component: componentId(c), next: table(edges) }],
  });
  const actions: Action[] = [];
  for (let c = 0; c < k; c++) {
    actions.push(local(c, Array.from({ length: n }, (_, s) => [s, (s + 1) % n] as const)));
    for (let e = 0; e < 2; e++) {
      actions.push(local(c, Array.from({ length: n }, (_, s) => [s, random(n)] as const).filter(() => random(2))));
    }
  }
  for (let c = 0; c + 1 < k; c += 2) {
    actions.push({
      origin: { kind: "event", component: componentId(c), event: 1 },
      moves: [
        { component: componentId(c), next: table([[random(n), random(n)]]) },
        { component: componentId(c + 1), next: table([[random(n), random(n)]]) },
      ],
    });
  }
  return { radix, stride, initial: 0 as Code, actions, fair: [componentId(0), componentId(1)], obligations: [] };
};

const is = (component: number, states: readonly number[], n: number): Test => ({
  kind: "is",
  component: componentId(component),
  holds: Uint8Array.from({ length: n }, (_, state) => (states.includes(state) ? 1 : 0)),
});

const and = (left: Test, right: Test): Test => ({ kind: "and", left, right });

const time = <A>(work: () => A): readonly [A, number] => {
  const started = performance.now();
  const value = work();
  return [value, performance.now() - started];
};

console.log("| Reachable states | Transitions | Explore | One never that holds | One ~> | Heap |");
console.log("| --- | --- | --- | --- | --- | --- |");
for (const [k, n] of [[3, 8], [4, 10], [5, 10], [6, 8], [6, 10]] as const) {
  const product = synthetic(k, n);
  globalThis.gc?.();
  const heap = process.memoryUsage().heapUsed;
  const [space, explored] = time(() => explore(product, Infinity)!);
  const grown = (process.memoryUsage().heapUsed - heap) / 1e6;
  // A never that holds scans every state; one that fails stops at its first hit.
  const [, safety] = time(() => first(product, space, and(is(0, [], n), is(1, [2], n))));
  const [, liveness] = time(() => leadsTo(product, space, is(0, [1], n), is(0, [0], n)));
  console.log(
    `| ${space.codes.length} | ${space.targets.length} | ${explored.toFixed(1)}ms | ${safety.toFixed(1)}ms | ${
      liveness.toFixed(1)
    }ms | +${grown.toFixed(0)}MB |`,
  );
}
