import type { Diagnostic, Span } from "langkit";
import { error } from "./grammar-elaborate.ts";
import {
  type Assoc,
  type Checked,
  type Expr,
  type Field,
  type Item,
  type Located,
  type Rule,
  type RuleId,
  ruleId,
  type Seq,
  type Ty,
  type Variant,
} from "./grammar-model.ts";

const reservedLabels = new Set(["kind", "span", "__proto__"]);
const reservedTypes = new Set([
  "Result",
  "Span",
  "parse",
  "any",
  "bigint",
  "boolean",
  "never",
  "null",
  "number",
  "object",
  "string",
  "symbol",
  "undefined",
  "unknown",
  "void",
]);

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

const isDiscard = (item: Item<Located>): boolean => item.label?.name === "_";
const isLabeled = (item: Item<Located>): boolean => item.label !== undefined && !isDiscard(item);
const buildsNode = (seq: Seq<Located>): boolean => seq.tag !== undefined || seq.items.some(isLabeled);

/** Does `e` yield a value when nothing asks for a literal? `bears` says which rules do. */
const valueBearing = (e: Expr<Located>, bears: readonly boolean[]): boolean => {
  switch (e.t) {
    case "re":
    case "ident":
      return true;
    case "lit":
    case "cut":
    case "and":
    case "not":
      return false;
    case "ref":
      return bears[e.rule]!;
    case "star":
    case "plus":
    case "opt":
      return valueBearing(e.e, bears);
    case "sep":
      return valueBearing(e.item, bears);
    case "alt":
      return e.alts.some((alt) => valueBearing(alt, bears));
    case "seq":
      return e.items.some((item) => valueBearing(item.expr, bears));
  }
};

/** Which rules produce a value at all: a least fixpoint, since rules refer to each other. */
const bearingRules = (rules: readonly Rule<Located>[]): readonly boolean[] => {
  const bears = rules.map(() => false);
  for (let changed = true; changed;) {
    changed = false;
    rules.forEach((rule, id) => {
      if (bears[id]) return;
      bears[id] = rule.pratt !== undefined
        || rule.body.alts.some((alt) => buildsNode(alt) || valueBearing(alt, bears));
      changed ||= bears[id]!;
    });
  }
  return bears;
};

export const union = (members: readonly (Ty | undefined)[]): Ty | undefined => {
  const flat = members.flatMap((member) => member?.t === "union" ? member.of : member ? [member] : []);
  const text = flat.some((member) => member.t === "text");
  const lits = [...new Set(flat.flatMap((member) => member.t === "lits" ? member.of : []))];
  const rest = flat.filter((member) => member.t !== "lits" && member.t !== "text");
  const seen = new Set<string>();
  const out: Ty[] = [];
  const own: readonly Ty[] = text ? [{ t: "text" }] : lits.length ? [{ t: "lits", of: lits }] : [];
  for (const member of [...own, ...rest]) {
    const key = JSON.stringify(member);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(member);
  }
  return out.length > 1 ? { t: "union", of: out } : out[0];
};

type Shaped<E> = { readonly expr: E; readonly ty: Ty | undefined; };

/**
 * Assigns nodes and kept items, and computes the type each construct captures. Everything the d.ts printer and
 * the runtime builder need is annotated here once, so the two cannot disagree on shape.
 */
class Shaper {
  readonly #bears: readonly boolean[];
  readonly #report: (message: string, span: Span) => void;

  constructor(bears: readonly boolean[], report: (message: string, span: Span) => void) {
    this.#bears = bears;
    this.#report = report;
  }

  /** `labeled` means a label asked for the value, which also captures a literal. */
  expr(e: Expr<Located>, labeled: boolean): Shaped<Expr<Located>> {
    switch (e.t) {
      case "lit":
        return { expr: e, ty: labeled ? { t: "lits", of: [e.text] } : undefined };
      case "re":
      case "ident":
        return { expr: e, ty: { t: "text" } };
      case "ref":
        return { expr: e, ty: this.#bears[e.rule] ? { t: "rule", id: e.rule } : undefined };
      case "cut":
        return { expr: e, ty: undefined };
      case "and":
      case "not":
        return { expr: { ...e, e: this.expr(e.e, false).expr }, ty: undefined };
      case "star":
      case "plus": {
        const inner = this.expr(e.e, labeled);
        return {
          expr: { ...e, e: inner.expr },
          ty: inner.ty && { t: "list", of: inner.ty, nonEmpty: e.t === "plus" },
        };
      }
      case "opt": {
        const inner = this.expr(e.e, labeled);
        const empty = inner.ty?.t === "list";
        return {
          expr: { ...e, e: inner.expr, empty },
          ty: inner.ty && (inner.ty.t === "list" ? { ...inner.ty, nonEmpty: false } : { t: "maybe", of: inner.ty }),
        };
      }
      case "sep": {
        const item = this.expr(e.item, labeled);
        return {
          expr: { ...e, item: item.expr, sep: this.expr(e.sep, false).expr },
          ty: item.ty && { t: "list", of: item.ty, nonEmpty: e.min === 1 },
        };
      }
      case "alt": {
        const alts = e.alts.map((alt) => this.passing(alt, labeled, true));
        const tys = alts.map(({ ty }) => ty);
        const bearing = tys.filter((ty) => ty !== undefined);
        if (bearing.length && bearing.length < tys.length) {
          this.#report("Every alternative of a captured group must capture", e.span);
        }
        return { expr: { ...e, alts: alts.map(({ expr }) => expr) }, ty: union(bearing) };
      }
      case "seq":
        return this.passing(e, labeled, false);
    }
  }

  /** A sequence that builds no node yields its one value-bearing item, or a lone literal when a label asked. */
  passing(seq: Seq<Located>, labeled: boolean, inGroup: boolean): Shaped<Seq<Located>> {
    if (inGroup) {
      if (seq.tag) this.#report("Tags go on the alternatives of a rule", seq.tag.span);
      for (const item of seq.items) {
        if (item.label) {
          this.#report("A labeled group needs a rule of its own: move it out and name it", item.label.span);
        }
      }
    }
    const bearing = seq.items.filter((item) => valueBearing(item.expr, this.#bears));
    const literals = seq.items.filter((item) => item.expr.t === "lit");
    if (bearing.length > 1) {
      this.#report(`${bearing.length} captures in one sequence; label them in a rule alternative`, seq.span);
    }
    const kept = bearing.length === 1
      ? bearing[0]
      : labeled && !bearing.length && literals.length === 1
      ? literals[0]
      : undefined;
    let ty: Ty | undefined;
    const items = seq.items.map((item): Item<Located> => {
      const shaped = this.expr(item.expr, item === kept && labeled);
      if (item === kept) ty = shaped.ty;
      return { ...item, keep: item === kept, expr: shaped.expr };
    });
    return { expr: { ...seq, items }, ty: bearing.length > 1 ? undefined : ty };
  }

  /** A sequence with a tag or any label builds a record node of `kind`. */
  node(seq: Seq<Located>, kind: string, iface: string, span: Span): {
    readonly expr: Seq<Located>;
    readonly variant: Variant<Located>;
  } {
    const fields: Field<Located>[] = [];
    const items = seq.items.map((item): Item<Located> => {
      const labeled = isLabeled(item);
      const shaped = this.expr(item.expr, labeled);
      const label = item.label?.name;
      if (!labeled) {
        if (shaped.ty && !isDiscard(item)) this.#report("Label this capture, or discard it with _:", item.expr.span);
      } else if (!shaped.ty) {
        this.#report(`${label} captures nothing`, item.label!.span);
      } else if (reservedLabels.has(label!)) {
        this.#report(`${label} is reserved`, item.label!.span);
      } else if (fields.some((field) => field.label === label)) {
        this.#report(`Duplicate label: ${label}`, item.label!.span);
      } else {
        fields.push({ label: label!, ty: shaped.ty, span: item.label!.span });
      }
      return { ...item, keep: false, expr: shaped.expr };
    });
    return {
      expr: { ...seq, items, node: kind },
      variant: { iface, kind, fields, span },
    };
  }
}

/** Resolves the type of every rule: its interfaces, its pass-through members and whether it bears a value. */
export const derive = (grammar: Checked): { readonly grammar: Checked; readonly errors: readonly Diagnostic[]; } => {
  const errors: Diagnostic[] = [];
  const report = (message: string, span: Span) => void errors.push(error(message, span));
  const bears = bearingRules(grammar.rules);
  const shaper = new Shaper(bears, report);

  const rules = grammar.rules.map((rule, index): Rule<Located> => {
    const alts = rule.body.alts;
    const kinds = new Set<string>();
    const variants: Variant<Located>[] = [];
    const pass: Ty[] = [];
    const shaped = alts.map((alt): Seq<Located> => {
      if (!buildsNode(alt)) {
        const result = shaper.passing(alt, false, false);
        if (result.ty) pass.push(result.ty);
        if (rule.pratt && result.ty?.t !== "rule") report(`An atom of ${rule.name} must be a node`, alt.span);
        return result.expr;
      }
      if (!alt.tag && (alts.length > 1 || rule.pratt)) report("Tag each alternative: #name", alt.span);
      const kind = alt.tag?.name ?? rule.name;
      if (alt.tag && kinds.has(kind)) report(`Duplicate tag: ${kind}`, alt.tag.span);
      kinds.add(kind);
      const single = alts.length === 1 && !alt.tag && !rule.pratt;
      const result = shaper.node(
        alt,
        kind,
        single ? rule.name : rule.name + capitalize(kind),
        alt.tag?.span ?? rule.span,
      );
      variants.push(result.variant);
      return result.expr;
    });
    if (rule.pratt) {
      for (const variant of operatorVariants(rule, ruleId(index))) {
        if (kinds.has(variant.kind)) report(`Duplicate tag: ${variant.kind}`, rule.span);
        kinds.add(variant.kind);
        variants.push(variant);
      }
    }
    return { ...rule, body: { ...rule.body, alts: shaped }, variants, pass, bears: bears[index]! };
  });

  if (!errors.length) collisions(rules, report);
  return { grammar: { ...grammar, rules }, errors };
};

/** A precedence rule builds `Binary`, `Prefix` and `Postfix` nodes over itself, one interface each kind of operator. */
const operatorVariants = (rule: Rule<Located>, id: RuleId): readonly Variant<Located>[] => {
  const self: Ty = { t: "rule", id };
  const field = (label: string, ty: Ty): Field<Located> => ({ label, ty, derived: true, span: rule.span });
  const variant = (kind: string, assocs: readonly Assoc[], operands: readonly Field<Located>[]) => {
    const operators = rule.pratt!.filter((level) => assocs.includes(level.assoc)).flatMap((level) =>
      level.ops.map((op) => op.text)
    );
    return operators.length
      ? [{
        iface: rule.name + capitalize(kind),
        kind,
        fields: [field("operator", { t: "lits", of: operators }), ...operands],
        span: rule.span,
      }]
      : [];
  };
  return [
    ...variant("binary", ["left", "right", "none"], [field("left", self), field("right", self)]),
    ...variant("prefix", ["prefix"], [field("operand", self)]),
    ...variant("postfix", ["postfix"], [field("operand", self)]),
  ];
};

/** Every emitted name is one TypeScript declaration, so two rules cannot share one and none may shadow an import. */
const collisions = (rules: readonly Rule<Located>[], report: (message: string, span: Span) => void): void => {
  const seen = new Set<string>();
  const claim = (name: string, span: Span) => {
    if (reservedTypes.has(name)) report(`TypeScript cannot represent ${name}, a name the projection reserves`, span);
    else if (seen.has(name)) report(`${name} is already the TypeScript name of another declaration`, span);
    seen.add(name);
  };
  for (const rule of rules) {
    if (!rule.bears) continue;
    claim(rule.name, rule.span);
    for (const variant of rule.variants) if (variant.iface !== rule.name) claim(variant.iface, variant.span);
  }
};
