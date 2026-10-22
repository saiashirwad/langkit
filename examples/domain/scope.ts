import type { TypeKey } from "../data/data-model.ts";
import type { Binder as DataBinder, Dialect, Scope as DataScope } from "../data/data-types.ts";
import { typescript } from "../data/data-types.ts";
import type { Machine } from "./domain-model.ts";

export type Binder = DataBinder<"machine" | "system">;

/** The data scope plus every machine elaborated so far, which a system's parts resolve against. */
export type Scope = DataScope<"machine" | "system"> & {
  readonly machines: ReadonlyMap<TypeKey, Machine>;
};

/**
 * Names a domain value cannot carry, beyond TypeScript's. `state` is the snapshot discriminant, so no record
 * field may take it either: a record spreads into state data.
 */
export const reserved = {
  /** `then` makes every value a thenable `await` hangs on; `toJSON` would replace the snapshot. */
  event: new Set(["then", "toJSON", "constructor", "toString", "valueOf", "__proto__"]),
  /** Members of the projected namespace besides the states. */
  state: new Set(["Final"]),
} as const;

export const dialect: Dialect = {
  reserved: { type: typescript.type, field: new Set([...typescript.field, "state"]) },
  variants: "braces",
};
