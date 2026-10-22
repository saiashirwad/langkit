import type { Span } from "langkit";
import {
  type DataType,
  type Enum,
  type EnumMember,
  type Field,
  type Name,
  type Present,
  type Record,
  showType,
  type Tagged,
  type TypeDecl,
  type Universe,
  type Variant,
} from "../data/data-model.ts";

/**
 * `input press : Root | Shape | Feel`, `input bar`. Two or more carried types are enums with pairwise distinct
 * members, so a member name alone says which type a press carried.
 */
export type Input = {
  readonly kind: "input";
  readonly id: symbol;
  readonly name: Name;
  readonly carries: readonly Present[];
};

/**
 * A cell or signal as every other item sees it, resolved before any body is checked. Reads point here, never at
 * the Cell or Signal, so the IR has no cycles and bodies check in any order.
 */
export type Slot = CellSlot | SignalSlot;

type Slotted<K> = { readonly kind: K; readonly id: symbol; readonly name: Name; readonly type: DataType; };

export type CellSlot = Slotted<"cell">;

export type SignalSlot = Slotted<"signal">;

/** A slot named where it is read without being a value, as in an `if` list or after `on`. */
export type Named<S extends Slot> = { readonly slot: S; readonly span: Span; };

/** `last Root` keeps the latest Root its input carried, absent until then. A value cell is rewritten by groups. */
export type Init =
  | { readonly kind: "last"; readonly of: Present; readonly input: Input; }
  | { readonly kind: "value"; readonly value: Expr; readonly groups: readonly Group[]; };

export type Cell = { readonly kind: "cell"; readonly slot: CellSlot; readonly init: Init; };

/** Exists only in the tick its input fires, and only while every `present` cell holds a value. */
export type Signal = {
  readonly kind: "signal";
  readonly slot: SignalSlot;
  readonly source: Input;
  readonly present: readonly Named<CellSlot>[];
  readonly value: Expr;
};

export type Node = Cell | Signal;

export type Source = Input | SignalSlot;

/** `on clip c`: rows match the cell's value, tried in order; `binder` is the firing source's value. */
export type Group = {
  readonly source: Source;
  /** Where the source is named, which is where a cell reads its signal. */
  readonly on: Span;
  readonly binder: Local | undefined;
  readonly rows: readonly Row[];
  readonly span: Span;
};

export type Row = {
  readonly pattern: Pattern;
  readonly guard: Guard | undefined;
  readonly value: Expr;
  readonly span: Span;
};

export type Guard = { readonly sense: "if" | "unless"; readonly formula: Formula; };

/** A name a pattern or group binds. A rest binding's list type is narrowed to the lengths it can hold. */
export type Local = { readonly id: symbol; readonly name: Name; readonly type: DataType; };

export type Ref =
  | { readonly kind: "local"; readonly local: Local; }
  | { readonly kind: "slot"; readonly slot: Slot; };

/**
 * Every expression carries its type. A list's `max` is the longest it can be, so `[..s, x]` with `s : [T; ..2]`
 * is `[T; ..3]`, and a bound check is plain assignability.
 */
export type Expr =
  & { readonly span: Span; readonly type: DataType; }
  & (
    | { readonly kind: "ref"; readonly ref: Ref; }
    | { readonly kind: "field"; readonly record: Expr; readonly field: Field; }
    | { readonly kind: "member"; readonly of: Enum; readonly member: EnumMember; }
    | { readonly kind: "variant"; readonly of: Tagged; readonly variant: Variant; readonly args: readonly Expr[]; }
    /** Every field of `of`, in declared order; an omitted optional field is absent. */
    | {
      readonly kind: "record";
      readonly of: Record;
      readonly fields: readonly (readonly [Field, Expr | undefined])[];
    }
    | { readonly kind: "list"; readonly items: readonly { readonly spread: boolean; readonly value: Expr; }[]; }
  );

/**
 * A name in a pattern became exactly one of: `equal` (already bound), `member` or `variant` (a constructor of the
 * expected type), or `bind` (fresh). `variant.args` is undefined for a tag test, `Loop`.
 */
export type Pattern =
  & { readonly span: Span; readonly type: DataType; }
  & (
    | { readonly kind: "wild"; }
    | { readonly kind: "bind"; readonly local: Local; }
    | { readonly kind: "equal"; readonly ref: Ref; }
    | { readonly kind: "member"; readonly of: Enum; readonly member: EnumMember; }
    | {
      readonly kind: "variant";
      readonly of: Tagged;
      readonly variant: Variant;
      readonly args: readonly Pattern[] | undefined;
    }
    /** Partial: only the fields written. */
    | { readonly kind: "record"; readonly of: Record; readonly fields: readonly (readonly [Field, Pattern])[]; }
    /** `[a, b, _]`: exactly this many. */
    | { readonly kind: "tuple"; readonly items: readonly Pattern[]; }
    /** `[..s, Loop(c)]`: at least head + tail. `rest` is undefined for `.._`. */
    | {
      readonly kind: "spread";
      readonly head: readonly Pattern[];
      readonly rest: Local | undefined;
      readonly tail: readonly Pattern[];
    }
  );

export type Formula =
  & { readonly span: Span; }
  & (
    | { readonly kind: "is" | "contains"; readonly subject: Expr; readonly pattern: Pattern; }
    | { readonly kind: "and" | "or"; readonly left: Formula; readonly right: Formula; }
    | { readonly kind: "not"; readonly operand: Formula; }
  );

/** Over cells only, since a signal is not state. Type checked in phase 1, decided by the model checker later. */
export type Property = {
  readonly id: symbol;
  readonly name: Name;
  readonly claim: { readonly kind: "never" | "possible"; readonly formula: Formula; };
};

export type Machine = {
  readonly id: symbol;
  readonly uri: string;
  readonly name: Name;
  readonly inputs: readonly Input[];
  /** Cells and signals, each after every node it reads in the same tick: the order a tick evaluates them in. */
  readonly nodes: readonly Node[];
  readonly properties: readonly Property[];
};

export type Module = {
  readonly uri: string;
  readonly types: readonly TypeDecl[];
  readonly machines: readonly Machine[];
  readonly universe: Universe;
};

export const showInput = ({ name, carries }: Input): string =>
  carries.length ? `input ${name.name} : ${carries.map(showType).join(" | ")}` : `input ${name.name}`;

export const showSlot = ({ kind, name, type }: Slot): string => `${kind} ${name.name} : ${showType(type)}`;

export const showLocal = ({ name, type }: Local): string => `${name.name} : ${showType(type)}`;
