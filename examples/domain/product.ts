import { type ComponentId, type Formula, type StateId, type System, transitionsOf } from "./domain-model.ts";

declare const codeBrand: unique symbol;
/**
 * One control state per component, mixed-radix: `Σ state[c] · stride[c]`, `stride[c] = Π radix[<c]`. A plain
 * number, so a visited set is a Map<number, …> and a successor is arithmetic, not an array copy.
 */
export type Code = number & { readonly [codeBrand]: true; };

declare const actionBrand: unique symbol;
/** An index into `Product.actions`. */
export type ActionId = number & { readonly [actionBrand]: true; };

declare const propertyBrand: unique symbol;
/** An index into `System.properties`. Outcomes hold indices, never IR nodes, so a cached outcome survives edits. */
export type PropertyIndex = number & { readonly [propertyBrand]: true; };

declare const syncBrand: unique symbol;
/** An index into `System.syncs`. */
export type SyncIndex = number & { readonly [syncBrand]: true; };

/** One component's part in an action: `next[from]` is the target state, or -1 when `from` does not handle it. */
export type Move = { readonly component: ComponentId; readonly next: Int16Array; };

/**
 * The ways the product moves. Every event of every component is in exactly one action: its sync's, or its own.
 * Enabled iff every move's `next[digit] >= 0`; the successor adds `(next - digit) · stride` per move.
 */
export type Action = {
  readonly origin:
    | { readonly kind: "event"; readonly component: ComponentId; readonly event: number; }
    | { readonly kind: "sync"; readonly sync: SyncIndex; };
  readonly moves: readonly [Move, ...Move[]];
};

/** A formula compiled to a test on codes: per `is` atom, which of the component's states satisfy it. */
export type Test =
  | { readonly kind: "is"; readonly component: ComponentId; readonly holds: Uint8Array; }
  | { readonly kind: "and" | "or"; readonly left: Test; readonly right: Test; };

/** A property, as the checker needs it: in `System.properties` order. */
export type Obligation =
  | { readonly kind: "never" | "possible"; readonly test: Test; }
  | { readonly kind: "leadsTo"; readonly from: Test; readonly to: Test; };

/** Span-free and name-free: tables and tests only, so equal behavior means equal products. */
export type Product = {
  readonly radix: readonly number[];
  readonly stride: readonly number[];
  readonly initial: Code;
  readonly actions: readonly Action[];
  /** Components under `fair`, in written order. */
  readonly fair: readonly ComponentId[];
  readonly obligations: readonly Obligation[];
};

const test = (formula: Formula): Test => {
  switch (formula.kind) {
    case "is": {
      const { component, negated, states } = formula;
      const holds = new Uint8Array(component.machine.states.length).fill(negated ? 1 : 0);
      for (const state of states) holds[state] = negated ? 0 : 1;
      return { kind: "is", component: component.id, holds };
    }
    case "and":
    case "or":
      return { kind: formula.kind, left: test(formula.left), right: test(formula.right) };
  }
};

/**
 * Lowers the IR to tables. Exact, not an abstraction: there are no guards, so data never decides whether an
 * event is enabled, and the control-state product has exactly the runs the real system has.
 */
export const lower = (system: System): Product => {
  const radix = system.components.map(({ machine }) => machine.states.length);
  const stride = radix.map((_, index) => radix.slice(0, index).reduce((product, size) => product * size, 1));
  const initial = system.components.reduce((code, { id, machine }) => code + machine.initial * stride[id]!, 0) as Code;
  const move = (component: ComponentId, edges: readonly { readonly from: StateId; readonly to: StateId; }[]): Move => {
    const next = new Int16Array(radix[component]!).fill(-1);
    for (const { from, to } of edges) next[from] = to;
    return { component, next };
  };
  const synced = new Set(system.syncs.flatMap(({ ports }) => ports.map(({ event }) => event)));
  const actions: Action[] = [
    ...system.syncs.map(({ ports }, index): Action => {
      const [first, ...rest] = ports.map(({ component, event }) =>
        move(component.id, transitionsOf(component.machine, event))
      );
      return { origin: { kind: "sync", sync: index as SyncIndex }, moves: [first!, ...rest] };
    }),
    ...system.components.flatMap(({ id, machine }) =>
      machine.events.flatMap((event, index): readonly Action[] =>
        synced.has(event)
          ? []
          : [{
            origin: { kind: "event", component: id, event: index },
            moves: [move(id, transitionsOf(machine, event))],
          }]
      )
    ),
  ];
  return {
    radix,
    stride,
    initial,
    actions,
    fair: system.fair.map(({ id }) => id),
    obligations: system.properties.map(({ claim }): Obligation =>
      claim.kind === "leadsTo"
        ? { kind: "leadsTo", from: test(claim.from), to: test(claim.to) }
        : { kind: claim.kind, test: test(claim.formula) }
    ),
  };
};

/** Π radix; past 2^53 a code is no longer exact, so such a product is too large to check. */
export const size = (product: Product): number => product.radix.reduce((total, radix) => total * radix, 1);

export const digit = (product: Product, code: Code, component: ComponentId): StateId =>
  (Math.floor(code / product.stride[component]!) % product.radix[component]!) as StateId;

export const fire = (product: Product, code: Code, action: ActionId): Code | undefined => {
  let next: number = code;
  for (const { component, next: table } of product.actions[action]!.moves) {
    const from = digit(product, code, component);
    const to = table[from]!;
    if (to < 0) return undefined;
    next += (to - from) * product.stride[component]!;
  }
  return next as Code;
};

export const satisfies = (product: Product, test: Test, code: Code): boolean => {
  switch (test.kind) {
    case "is":
      return test.holds[digit(product, code, test.component)] === 1;
    case "and":
      return satisfies(product, test.left, code) && satisfies(product, test.right, code);
    case "or":
      return satisfies(product, test.left, code) || satisfies(product, test.right, code);
  }
};

/**
 * The structural identity of a product: radices, move tables, fairness and tests. Two products with one key have
 * one outcome, so the editor re-explores only after an edit that changes behavior; renaming a field or adding a
 * comment reuses the last outcome.
 */
export const key = (product: Product): string =>
  JSON.stringify(product, (_, value: unknown) => ArrayBuffer.isView(value) ? Array.from(value as Uint8Array) : value);
