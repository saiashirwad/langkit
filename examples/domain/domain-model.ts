import type { Span } from "langkit";
import { type Field, type Name, showFields, type TypeDecl, type Universe } from "../data/data-model.ts";
import type { On } from "./domain-syntax.ts";

/** `syncOnly` for a `sync event`: its machine's values have no method for it, so only a system fires it. */
export type Event = {
  readonly id: symbol;
  readonly name: Name;
  readonly syncOnly: boolean;
  readonly payload: readonly Field[];
};

declare const stateBrand: unique symbol;
/** An index into `Machine.states`. Branded so a loop counter cannot stand in for a state. */
export type StateId = number & { readonly [stateBrand]: true; };

export const stateId = (index: number): StateId => index as StateId;

/**
 * Where one field of the target state comes from. Payload wins over carry: an event that names a field
 * replaces it, so `edit(items)` from Checkout keeps the address and swaps the items.
 */
export type Source =
  | { readonly kind: "payload"; readonly param: Field; }
  | { readonly kind: "carry"; readonly field: Field; }
  /** Only for an optional target field that neither side provides. */
  | { readonly kind: "null"; };

export type Fill = { readonly field: Field; readonly source: Source; };

/**
 * One edge. The data flow is decided here, once, so the projection, the runtime table and hover all read the
 * same `fill` and never re-derive it.
 */
export type Transition = {
  readonly clause: On;
  readonly event: Event;
  readonly from: StateId;
  readonly to: StateId;
  /** In target field order; covers every target field exactly once. */
  readonly fill: readonly Fill[];
};

export type State = {
  readonly id: StateId;
  readonly symbol: symbol;
  readonly name: Name;
  readonly final: boolean;
  /** Spreads already expanded, in written order; names unique and disjoint from the events in `on`. */
  readonly data: readonly Field[];
  /** At most one per event, so (state, event) determines the target. Empty when `final`. */
  readonly on: readonly Transition[];
};

export type Machine = {
  readonly id: symbol;
  readonly uri: string;
  readonly name: Name;
  readonly events: readonly Event[];
  readonly states: readonly State[];
  readonly initial: StateId;
};

declare const componentBrand: unique symbol;
/** An index into `System.components`; also the digit position in a product state's encoding. */
export type ComponentId = number & { readonly [componentBrand]: true; };

export const componentId = (index: number): ComponentId => index as ComponentId;

export type Component = {
  readonly id: ComponentId;
  readonly symbol: symbol;
  readonly name: Name;
  readonly machine: Machine;
};

/** `order.pay` resolved; `span` is in the system's file. */
export type Port = { readonly component: Component; readonly event: Event; readonly span: Span; };

/**
 * `sync order.pay = payment.capture = warehouse.reserve`: all fire together, only when all can. Each event is in
 * at most one sync, so a system's actions partition its components' events.
 */
export type Sync = {
  readonly id: symbol;
  /** The clause, where a trace step through this sync points. */
  readonly span: Span;
  /** The first port's event: the method on the projected system value. Unique among syncs and properties. */
  readonly name: Name;
  readonly ports: readonly [Port, Port, ...Port[]];
  /**
   * Every port's payload merged by name, first appearance first. A name two ports share has one type, so one
   * value feeds both; each port takes its own fields back out at run time.
   */
  readonly payload: readonly Field[];
};

/** Control states only, never data: that is what keeps the search finite and exact. */
export type Formula =
  & { readonly span: Span; }
  & (
    | {
      readonly kind: "is";
      readonly component: Component;
      readonly negated: boolean;
      /** Distinct, in written order. */
      readonly states: readonly [StateId, ...StateId[]];
    }
    | { readonly kind: "and" | "or"; readonly left: Formula; readonly right: Formula; }
  );

/**
 * `never P` is safety, `possible P` says some reachable state has P (so a `never` cannot pass vacuously), and
 * `P ~> Q` says every fair run that reaches P later reaches Q.
 */
export type Claim =
  | { readonly kind: "never" | "possible"; readonly formula: Formula; }
  | { readonly kind: "leadsTo"; readonly from: Formula; readonly to: Formula; };

export type Property = { readonly id: symbol; readonly name: Name; readonly span: Span; readonly claim: Claim; };

/**
 * A closed world of components. Events no sync names are the environment's: they fire on their own, interleaved.
 * `fair` lists the components assumed to act eventually whenever they continuously can (weak fairness); every
 * other component may stop forever.
 */
export type System = {
  readonly id: symbol;
  readonly uri: string;
  readonly name: Name;
  readonly parts: Span;
  readonly components: readonly Component[];
  readonly syncs: readonly Sync[];
  readonly fair: readonly Component[];
  readonly properties: readonly Property[];
};

/** One checked `.domain` file: its own declarations in written order, and every type they can reach. */
export type Module = {
  readonly uri: string;
  readonly types: readonly TypeDecl[];
  readonly machines: readonly Machine[];
  readonly systems: readonly System[];
  readonly universe: Universe;
};

/** Every edge `event` labels, one per state that handles it. */
export const transitionsOf = (machine: Machine, event: Event): readonly Transition[] =>
  machine.states.flatMap(({ on }) => on.filter((transition) => transition.event === event));

/** `event pay(paymentId : String, paidAt : String)`. */
export const showEvent = ({ name, syncOnly, payload }: Event): string =>
  `${syncOnly ? "sync " : ""}event ${name.name}${payload.length ? `(${showFields(payload)})` : ""}`;

/** `state Paid = { items : [LineItem], address : Address, paymentId : String }`, spreads expanded. */
export const showState = ({ name, final, data }: Pick<State, "name" | "final" | "data">): string =>
  `${final ? "final " : ""}state ${name.name}${data.length ? ` = { ${showFields(data)} }` : ""}`;

/**
 * Hover on `on pay`: the edge and its data flow.
 * `Checkout -> Paid: carries items, address; pay gives paymentId, paidAt`.
 */
export const showTransition = (states: readonly State[], { event, from, to, fill }: Transition): string => {
  const named = (kind: Source["kind"]) =>
    fill.filter(({ source }) => source.kind === kind).map(({ field }) => field.name.name).join(", ");
  const parts = [
    named("carry") && `carries ${named("carry")}`,
    named("payload") && `${event.name.name} gives ${named("payload")}`,
    named("null") && `${named("null")} starts null`,
  ].filter(Boolean);
  return `${states[from]!.name.name} -> ${states[to]!.name.name}: ${parts.join("; ") || "carries nothing"}`;
};

/** `warehouse is Dispatched and payment is Refunded`. */
export const showFormula = (formula: Formula): string => {
  switch (formula.kind) {
    case "is": {
      const { component, negated, states } = formula;
      const names = states.map((id) => component.machine.states[id]!.name.name).join(" | ");
      return `${component.name.name} is ${negated ? "not " : ""}${names}`;
    }
    case "and":
    case "or": {
      const side = (operand: Formula) =>
        formula.kind === "and" && operand.kind === "or" ? `(${showFormula(operand)})` : showFormula(operand);
      return `${side(formula.left)} ${formula.kind} ${side(formula.right)}`;
    }
  }
};

/** `never (warehouse is Dispatched and payment is Refunded)`, `order is Paid ~> order is Delivered | Cancelled`. */
export const showClaim = (claim: Claim): string => {
  switch (claim.kind) {
    case "never":
    case "possible":
      return `${claim.kind} (${showFormula(claim.formula)})`;
    case "leadsTo":
      return `${showFormula(claim.from)} ~> ${showFormula(claim.to)}`;
  }
};

/** `sync order.pay = payment.capture = warehouse.reserve`. */
export const showSync = ({ ports }: Sync): string =>
  `sync ${ports.map(({ component, event }) => `${component.name.name}.${event.name.name}`).join(" = ")}`;
