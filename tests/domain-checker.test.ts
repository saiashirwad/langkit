import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { componentId, type System } from "../examples/domain/domain-model.ts";
import { checkSource } from "../examples/domain/domain.ts";
import { type Ending, explore, type Outcome, outcome, type StateSpace, type Step } from "../examples/domain/explore.ts";
import { leadsTo } from "../examples/domain/liveness.ts";
import {
  type Action,
  type ActionId,
  type Code,
  digit,
  fire,
  key,
  lower,
  type Move,
  type Product,
  satisfies,
  type Test,
} from "../examples/domain/product.ts";

const file = (name: string) => new URL(`../examples/domain/${name}`, import.meta.url);
const shop = readFileSync(file("shop.domain"), "utf8");

const systemOf = (source: string, name = "shop.domain"): System => {
  const checked = checkSource(source, { uri: file(name).href });
  assert.ok(checked.success, checked.success ? "" : checked.errors.map(({ message }) => message).join("\n"));
  return checked.value.systems[0]!;
};

const edit = (source: string, original: string, replacement: string) => {
  assert.ok(source.includes(original), `${JSON.stringify(original)} is not in the source`);
  return source.replace(original, replacement);
};

const fixed = edit(shop, "  |> fair order", "  |> sync order.ship = warehouse.dispatch\n  |> fair order");

/** A step as guest names: `sync pay` or `order.cancel`. */
const named = (system: System, product: Product) => ({ action }: Step): string => {
  const { origin } = product.actions[action]!;
  if (origin.kind === "sync") return `sync ${system.syncs[origin.sync]!.name.name}`;
  const component = system.components[origin.component]!;
  return `${component.name.name}.${component.machine.events[origin.event]!.name.name}`;
};

/** A code as guest names: `order Cart, payment Pending, warehouse Waiting`. */
const shown = (system: System, product: Product, code: Code): string =>
  system.components.map(({ id, name, machine }) =>
    `${name.name} ${machine.states[digit(product, code, id)]!.name.name}`
  )
    .join(", ");

const explored = (result: Outcome) => {
  assert.equal(result.kind, "explored");
  return result.kind === "explored" ? result : undefined!;
};

test("checker: the shop reaches 23 states, and refunding a paid order lets the warehouse still ship it", () => {
  const system = systemOf(shop);
  const product = lower(system);
  const result = explored(outcome(product, Infinity));
  assert.equal(result.states, 23);
  assert.equal(result.transitions, 36);
  assert.equal(result.findings.length, 1);
  const [finding] = result.findings;
  assert.equal(finding?.kind, "reaches");
  if (finding?.kind !== "reaches") return;
  assert.equal(system.properties[finding.property]!.name.name, "refundsNeverShip");
  assert.deepEqual(finding.steps.map(named(system, product)), [
    "sync checkout",
    "sync pay",
    "order.cancel",
    "sync refund",
    "warehouse.dispatch",
  ]);
  assert.equal(
    shown(system, product, finding.steps.at(-1)!.to),
    "order Cancelled, payment Refunded, warehouse Dispatched",
  );
});

test("checker: syncing ship with dispatch closes the race, and every property holds in 16 states", () => {
  const result = explored(outcome(lower(systemOf(fixed)), Infinity));
  assert.equal(result.states, 16);
  assert.deepEqual(result.findings, []);
});

test("checker: the checkout example's never, possible and leads-to properties all hold", () => {
  const checkout = readFileSync(file("checkout.domain"), "utf8");
  const system = systemOf(checkout, "checkout.domain");
  assert.deepEqual(system.properties.map(({ claim }) => claim.kind), ["never", "leadsTo", "possible"]);
  assert.deepEqual(explored(outcome(lower(system), Infinity)).findings, []);
});

test("checker: without fairness an order may stay paid forever, a run that simply stops", () => {
  const system = systemOf(edit(shop, "  |> fair order\n", ""));
  const product = lower(system);
  const [finding] = explored(outcome(product, Infinity)).findings.filter(({ kind }) => kind === "unsettled");
  assert.equal(finding?.kind, "unsettled");
  if (finding?.kind !== "unsettled") return;
  assert.equal(system.properties[finding.property]!.name.name, "settles");
  assert.equal(finding.trigger, 2);
  assert.deepEqual(finding.steps.map(named(system, product)), ["sync checkout", "sync pay"]);
  assert.deepEqual(finding.ending, { kind: "stays" });
});

test("checker: a fair component that keeps acting without progress is a loop", () => {
  const source = [
    "machine A {",
    "event go",
    "event back",
    "event stop",
    "initial state Idle |> on go -> Busy",
    "state Busy |> on back -> Idle |> on stop -> Done",
    "final state Done",
    "}",
    "system S = { a : A }",
    "  |> fair a",
    "  |> property finishes = a is Busy ~> a is Done",
    "",
  ].join("\n");
  const system = systemOf(source, "loop.domain");
  const product = lower(system);
  const [finding] = explored(outcome(product, Infinity)).findings;
  assert.equal(finding?.kind, "unsettled");
  if (finding?.kind !== "unsettled") return;
  assert.deepEqual(finding.steps.map(named(system, product)), ["a.go"]);
  assert.equal(finding.ending.kind, "loops");
  if (finding.ending.kind === "loops") {
    assert.deepEqual(finding.ending.cycle.map(named(system, product)), ["a.back", "a.go"]);
  }
});

test("checker: possible fails when no reachable state has its formula, and a sync no state enables is dead", () => {
  const source = edit(
    edit(shop, "  |> fair order", "  |> sync order.deliver = payment.expire\n  |> fair order"),
    "possible (order is Delivered)",
    "possible (payment is Refunded and order is Delivered)",
  );
  const system = systemOf(source);
  const findings = explored(outcome(lower(system), Infinity)).findings;
  assert.deepEqual(findings.map(({ kind }) => kind), ["reaches", "unreachable", "unsettled", "dead sync"]);
  const dead = findings.at(-1);
  assert.equal(dead?.kind === "dead sync" && system.syncs[dead.sync]!.name.name, "deliver");
});

test("checker: past the budget the outcome is too large, never a silent pass", () => {
  assert.deepEqual(outcome(lower(systemOf(shop)), 10), { kind: "too large", limit: 10 });
  assert.equal(explored(outcome(lower(systemOf(shop)), 23)).states, 23);
});

test("checker: the product key ignores names and spans and changes with behavior", () => {
  const base = key(lower(systemOf(shop)));
  assert.equal(key(lower(systemOf(edit(shop, "refundsNeverShip", "neverShipsRefunds")))), base);
  assert.equal(key(lower(systemOf(`// a comment\n${shop}`))), base);
  assert.notEqual(key(lower(systemOf(fixed))), base);
});

/** mulberry32: a small seeded generator, so a failing sample can be replayed by its seed. */
const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const sample = (seed: number) => {
  const next = random(seed);
  const pick = (n: number) => Math.floor(next() * n);
  const radix = Array.from({ length: 1 + pick(3) }, () => 2 + pick(2));
  const stride = radix.map((_, index) => radix.slice(0, index).reduce((a, b) => a * b, 1));
  const actions = Array.from({ length: 2 + pick(4) }, (_, index): Action => {
    const involved = radix.map((_, c) => c).filter(() => next() < 0.5);
    const chosen = involved.length ? involved : [pick(radix.length)];
    const moves = chosen.map((c): Move => ({
      component: componentId(c),
      next: Int16Array.from({ length: radix[c]! }, () => (next() < 0.35 ? -1 : pick(radix[c]!))),
    }));
    return {
      origin: { kind: "event", component: componentId(chosen[0]!), event: index },
      moves: [moves[0]!, ...moves.slice(1)],
    };
  });
  const atom = (): Test => {
    const c = pick(radix.length);
    return { kind: "is", component: componentId(c), holds: Uint8Array.from({ length: radix[c]! }, () => pick(2)) };
  };
  const product: Product = {
    radix,
    stride,
    initial: 0 as Code,
    actions,
    fair: radix.map((_, c) => componentId(c)).filter(() => next() < 0.5),
    obligations: [],
  };
  return { product, from: atom(), to: atom() };
};

type Edge = { readonly from: number; readonly to: number; readonly action: number; };

/** The definition, by enumeration: some fair recurrent set is reachable, through not-Q states, from a P state. */
const bruteForce = (product: Product, space: StateSpace, from: Test, to: Test): boolean | undefined => {
  const n = space.codes.length;
  const inside = space.codes.map((code) => !satisfies(product, to, code));
  const edges: Edge[] = [];
  for (let state = 0; state < n; state++) {
    for (let edge = space.offsets[state]!; edge < space.offsets[state + 1]!; edge++) {
      if (inside[state] && inside[space.targets[edge]!]) {
        edges.push({ from: state, to: space.targets[edge]!, action: space.actions[edge]! });
      }
    }
  }
  if (edges.length > 12) return undefined;
  const touches = (action: number, f: number) =>
    product.actions[action]!.moves.some(({ component }) => component === product.fair[f]);
  const enabled = (state: number, f: number) => {
    for (let edge = space.offsets[state]!; edge < space.offsets[state + 1]!; edge++) {
      if (touches(space.actions[edge]!, f)) return true;
    }
    return false;
  };
  const reached = new Set<number>();
  const queue = [...Array(n).keys()].filter((state) => inside[state] && satisfies(product, from, space.codes[state]!));
  for (const state of queue) reached.add(state);
  for (let index = 0; index < queue.length; index++) {
    for (const edge of edges) {
      if (edge.from === queue[index] && !reached.has(edge.to)) {
        reached.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  const fairOn = (states: readonly number[], chosen: readonly Edge[]) =>
    product.fair.every((_, f) =>
      states.some((state) => !enabled(state, f)) || chosen.some(({ action }) => touches(action, f))
    );
  for (const state of reached) if (fairOn([state], [])) return true;
  for (let mask = 1; mask < 1 << edges.length; mask++) {
    const chosen = edges.filter((_, index) => mask & (1 << index));
    const states = [...new Set(chosen.flatMap(({ from, to }) => [from, to]))];
    if (!states.some((state) => reached.has(state))) continue;
    const spans = (forward: boolean) => {
      const seen = new Set([states[0]!]);
      for (let grew = true; grew;) {
        grew = false;
        for (const { from, to } of chosen) {
          const [a, b] = forward ? [from, to] : [to, from];
          if (seen.has(a) && !seen.has(b)) {
            seen.add(b);
            grew = true;
          }
        }
      }
      return seen.size === states.length;
    };
    if (spans(true) && spans(false) && fairOn(states, chosen)) return true;
  }
  return false;
};

/** A reported lasso must be a real run that triggers P, never meets Q, and is fair. */
const validate = (
  product: Product,
  found: { readonly steps: readonly Step[]; readonly trigger: number; readonly ending: Ending; },
  from: Test,
  to: Test,
) => {
  let at = product.initial;
  for (const step of found.steps) {
    assert.equal(step.from, at);
    assert.equal(fire(product, step.from, step.action), step.to);
    at = step.to;
  }
  const triggered = found.trigger === 0 ? product.initial : found.steps[found.trigger - 1]!.to;
  assert.ok(satisfies(product, from, triggered), "P holds at the trigger");
  for (const step of found.steps.slice(found.trigger)) assert.ok(!satisfies(product, to, step.to), "Q stays false");
  const disabled = (code: Code, f: number) =>
    product.actions.every(({ moves }, action) =>
      !moves.some(({ component }) => component === product.fair[f])
      || fire(product, code, action as ActionId) === undefined
    );
  if (found.ending.kind === "stays") {
    product.fair.forEach((_, f) => assert.ok(disabled(at, f), "a run stops only where no fair component can act"));
    return;
  }
  const { cycle } = found.ending;
  for (const step of cycle) {
    assert.equal(step.from, at);
    assert.equal(fire(product, step.from, step.action), step.to);
    assert.ok(!satisfies(product, to, step.to), "Q stays false around the loop");
    at = step.to;
  }
  assert.equal(at, cycle[0].from, "the loop closes");
  product.fair.forEach((_, f) => {
    const acts = cycle.some(({ action }) =>
      product.actions[action]!.moves.some(({ component }) => component === product.fair[f])
    );
    assert.ok(
      acts || cycle.some(({ from }) => disabled(from, f)),
      "each fair component acts or is disabled on the loop",
    );
  });
};

test("checker: leads-to agrees with a brute-force search for fair lassos on random small products", () => {
  const verdicts = { holds: 0, fails: 0 };
  for (let seed = 1; seed <= 600; seed++) {
    const { product, from, to } = sample(seed);
    const space = explore(product, Infinity)!;
    const expected = bruteForce(product, space, from, to);
    if (expected === undefined) continue;
    const found = leadsTo(product, space, from, to);
    assert.equal(found !== undefined, expected, `seed ${seed}`);
    if (found) validate(product, found, from, to);
    verdicts[expected ? "fails" : "holds"]++;
  }
  assert.ok(verdicts.holds > 50 && verdicts.fails > 50, JSON.stringify(verdicts));
});
