import type { Span } from "langkit";

export type RuleId = number & { readonly __rule: unique symbol; };
export const ruleId = (index: number): RuleId => index as RuleId;

/**
 * What a sequence contributes to its node or its parent. A construct that captures nothing is `undefined` where a
 * type is optional, never a member, so a field can never have an empty type.
 */
export type Ty =
  | { readonly t: "text"; }
  | { readonly t: "lits"; readonly of: readonly string[]; }
  | { readonly t: "rule"; readonly id: RuleId; }
  | { readonly t: "list"; readonly of: Ty; readonly nonEmpty: boolean; }
  | { readonly t: "maybe"; readonly of: Ty; }
  | { readonly t: "union"; readonly of: readonly Ty[]; };

/** `A` is `{}` on the wire and `{ span }` in the checker, so one definition serves the checker and the runtime. */
export type Named<A> = A & { readonly name: string; };

export type Item<A> = {
  readonly label?: Named<A>;
  /** The one value this item passes through when its sequence builds no node. */
  readonly keep: boolean;
  readonly expr: Expr<A>;
};

export type Seq<A> = A & {
  readonly t: "seq";
  readonly items: readonly Item<A>[];
  readonly tag?: Named<A>;
  /** Present when the sequence builds a record node of this `kind`. */
  readonly node?: string;
};

export type Expr<A> =
  | A & { readonly t: "lit"; readonly text: string; readonly kw: boolean; }
  | A & { readonly t: "re"; readonly source: string; readonly name?: string; }
  | A & { readonly t: "ident"; }
  | A & { readonly t: "ref"; readonly rule: RuleId; }
  | A & { readonly t: "cut"; }
  | A & { readonly t: "alt"; readonly alts: readonly Seq<A>[]; }
  | A & { readonly t: "star" | "plus" | "and" | "not"; readonly e: Expr<A>; }
  /** `empty` is set when the operand is a list, so an absent match is `[]` rather than `null`. */
  | A & { readonly t: "opt"; readonly e: Expr<A>; readonly empty: boolean; }
  | A & {
    readonly t: "sep";
    readonly item: Expr<A>;
    readonly sep: Expr<A>;
    readonly min: 0 | 1;
    readonly trailing: boolean;
  }
  | Seq<A>;

export type Operator<A> = A & { readonly text: string; readonly kw: boolean; };
export type Assoc = "left" | "right" | "none" | "prefix" | "postfix";
export type Level<A> = { readonly assoc: Assoc; readonly ops: readonly Operator<A>[]; };

/** `derived` marks the fields a precedence rule adds, which have no label in the grammar to point at. */
export type Field<A> = A & { readonly label: string; readonly ty: Ty; readonly derived?: true; };
export type Variant<A> = A & {
  readonly iface: string;
  readonly kind: string;
  readonly fields: readonly Field<A>[];
};

export type Rule<A> = A & {
  readonly name: string;
  /** For a precedence rule, the atoms. */
  readonly body: Extract<Expr<A>, { readonly t: "alt"; }>;
  readonly pratt?: readonly Level<A>[];
  readonly variants: readonly Variant<A>[];
  readonly pass: readonly Ty[];
  readonly bears: boolean;
};

export type Token<A> = A & { readonly name: string; readonly source: string; };

export type Grammar<A> = {
  readonly name: Named<A>;
  readonly skip: readonly string[];
  readonly word: string;
  readonly keywords: readonly string[];
  readonly tokens: readonly Token<A>[];
  readonly rules: readonly Rule<A>[];
};

export type Located = { readonly span: Span; };
export type Checked = Grammar<Located>;
export type Wire = Grammar<object>;

/** Drops spans: the table the emitted module carries. */
export const wire = (grammar: Checked): Wire =>
  JSON.parse(JSON.stringify(grammar, (key, value: unknown) => key === "span" ? undefined : value)) as Wire;

const children = <A>(e: Expr<A>): readonly Expr<A>[] => {
  switch (e.t) {
    case "seq":
      return e.items.map((item) => item.expr);
    case "alt":
      return e.alts;
    case "star":
    case "plus":
    case "opt":
    case "and":
    case "not":
      return [e.e];
    case "sep":
      return [e.item, e.sep];
    case "lit":
    case "re":
    case "ident":
    case "ref":
    case "cut":
      return [];
  }
};

export const walk = <A>(e: Expr<A>, visit: (e: Expr<A>) => void): void => {
  visit(e);
  for (const child of children(e)) walk(child, visit);
};

/** Every literal and operator that is not a keyword: what the lexer matches by maximal munch. */
export const symbolsOf = <A>(grammar: Grammar<A>): ReadonlySet<string> => {
  const symbols = new Set<string>();
  for (const rule of grammar.rules) {
    walk(rule.body, (e) => e.t === "lit" && !e.kw && symbols.add(e.text));
    for (const level of rule.pratt ?? []) for (const op of level.ops) if (!op.kw) symbols.add(op.text);
  }
  return symbols;
};
