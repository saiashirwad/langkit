import type { Name, On } from "./machine-syntax.ts";

export type Scalar = "String" | "Int" | "Float" | "Bool";

/** Records are referenced by name so a record may contain itself through a list. */
export type DataType =
  | { readonly kind: "scalar"; readonly name: Scalar; }
  | { readonly kind: "enum"; readonly name: string; }
  | { readonly kind: "record"; readonly name: string; }
  | { readonly kind: "list"; readonly element: DataType; }
  | { readonly kind: "optional"; readonly inner: Present; };

/** `String??` would project to `string | null | null`, so an optional never wraps an optional. */
export type Present = Exclude<DataType, { readonly kind: "optional"; }>;

/** One binder: record fields, state data, and event payload all use it. `id` is its LSP identity. */
export type Field = { readonly id: symbol; readonly name: Name; readonly type: DataType; };

export type Enum = { readonly id: symbol; readonly name: Name; readonly members: readonly Name[]; };

export type Record = { readonly id: symbol; readonly name: Name; readonly fields: readonly Field[]; };

export type Event = { readonly id: symbol; readonly name: Name; readonly payload: readonly Field[]; };

declare const state: unique symbol;
/** An index into `Machine.states`. Branded so a loop counter cannot stand in for a state. */
export type StateId = number & { readonly [state]: true; };

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

/** A checked `.machine` file. Exactly one machine per file; its name is the TypeScript export. */
export type Machine = {
  readonly id: symbol;
  readonly name: Name;
  readonly enums: readonly Enum[];
  readonly records: readonly Record[];
  readonly events: readonly Event[];
  readonly states: readonly State[];
  readonly initial: StateId;
};

export const scalars: Readonly<{ [K in Scalar]: { readonly ts: string; }; }> = {
  String: { ts: "string" },
  Int: { ts: "number" },
  Float: { ts: "number" },
  Bool: { ts: "boolean" },
};

export const isScalar = (name: string): name is Scalar => Object.hasOwn(scalars, name);

/** Guest syntax, for hover and messages: `[LineItem]`, `String?`. */
export const showType = (type: DataType): string => {
  switch (type.kind) {
    case "scalar":
    case "enum":
    case "record":
      return type.name;
    case "list":
      return `[${showType(type.element)}]`;
    case "optional":
      return `${showType(type.inner)}?`;
  }
};

const showFields = (fields: readonly Field[]): string =>
  fields.map(({ name, type }) => `${name.name} : ${showType(type)}`).join(", ");

export const showEnum = ({ name, members }: Enum): string =>
  `type ${name.name} = ${members.map((member) => member.name).join(" | ")}`;

export const showRecord = ({ name, fields }: Record): string => `type ${name.name} = { ${showFields(fields)} }`;

/** `event pay(paymentId : String, paidAt : String)`. */
export const showEvent = ({ name, payload }: Event): string =>
  `event ${name.name}${payload.length ? `(${showFields(payload)})` : ""}`;

/** `state Paid = { items : [LineItem], address : Address, paymentId : String, paidAt : String }`, spreads expanded. */
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

/** Names are unique across kinds, so the printed form is a faithful key for equality. */
export const same = (a: DataType, b: DataType): boolean => showType(a) === showType(b);

/** Target field accepts a value of source type: equal, or `T` into `T?`. Lists are invariant. */
export const assignable = (from: DataType, to: DataType): boolean =>
  same(from, to) || (to.kind === "optional" && same(from, to.inner));
