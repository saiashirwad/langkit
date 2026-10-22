import { type Check, fail, pure, type Span } from "langkit";
import { create } from "langkit/analysis";
import type { Machine, TypeKey, Universe } from "./domain-model.ts";
import type { Name } from "./domain-syntax.ts";

/** Hover text. Guest syntax, as in v1. */
export type Type = string;

export const show = (type: Type): string => type;

/** The one facts sink every elaborator writes to. */
export const facts = create<Type>();

/** A top-level name, bound before anything it names is elaborated, so declaration order never matters. */
export type Binder = {
  readonly kind: "type" | "machine" | "system";
  readonly id: symbol;
  readonly key: TypeKey;
  readonly uri: string;
  readonly name: Name;
};

/**
 * What a file's declarations can name: its own top-level declarations, in one namespace, and every type and
 * machine elaborated so far. A state name may not repeat a type's name, because inside the projected
 * `namespace Order` it would shadow the type.
 */
export type Scope = {
  readonly uri: string;
  readonly top: ReadonlyMap<string, Binder>;
  readonly universe: Universe;
  readonly machines: ReadonlyMap<TypeKey, Machine>;
};

export const error = (at: { readonly span: Span; }, message: string): Check<never> => fail(message).at(at.span);

export const attempt = <A>(body: Check<A>): Check<A | undefined> => body.recover(pure(undefined));

/**
 * Names TypeScript or the runtime value cannot carry. Checked here, not in the host, so the guest LSP shows them:
 * a .domain file exists to be imported, so "TypeScript cannot represent X" is a language rule.
 */
export const reserved = {
  /** `then` makes every value a thenable `await` hangs on; `toJSON` would replace the snapshot. */
  event: new Set(["then", "toJSON", "constructor", "toString", "valueOf", "__proto__"]),
  /** `state` is the discriminant; `__proto__` would reset the value's prototype in Object.assign. */
  field: new Set(["state", "__proto__"]),
  /** Members of the projected namespace besides the states. */
  state: new Set(["Final"]),
  type: new Set([
    "any",
    "bigint",
    "boolean",
    "class",
    "const",
    "delete",
    "enum",
    "export",
    "function",
    "import",
    "interface",
    "never",
    "new",
    "null",
    "number",
    "object",
    "package",
    "private",
    "protected",
    "public",
    "static",
    "string",
    "symbol",
    "undefined",
    "unknown",
    "void",
    "yield",
  ]),
} as const;
