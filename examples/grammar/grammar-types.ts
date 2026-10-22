import type { Checked, RuleId, Ty } from "./grammar-model.ts";

/** `readonly Name[]`, `string | null`, `readonly [Name, ...Name[]]`. A rule prints as its declared name. */
export const show = (grammar: Checked, ty: Ty): string => {
  const element = (inner: Ty): string => {
    const text = show(grammar, inner);
    const compound = inner.t === "union" || inner.t === "maybe" || inner.t === "list"
      || inner.t === "lits" && inner.of.length > 1;
    return compound ? `(${text})` : text;
  };
  switch (ty.t) {
    case "text":
      return "string";
    case "lits":
      return ty.of.map((text) => JSON.stringify(text)).join(" | ");
    case "rule":
      return grammar.rules[ty.id]!.name;
    case "list":
      return ty.nonEmpty
        ? `readonly [${show(grammar, ty.of)}, ...${element(ty.of)}[]]`
        : `readonly ${element(ty.of)}[]`;
    case "maybe":
      return `${show(grammar, ty.of)} | null`;
    case "union":
      return ty.of.map((member) => show(grammar, member)).join(" | ");
  }
};

/**
 * What a rule's type is made of: its interfaces, and the leaves of every rule it passes through, so
 * `Expr = ... | "(" Expr ")"` never prints a circular alias.
 */
export const members = (grammar: Checked, id: RuleId, seen = new Set<RuleId>()): readonly string[] => {
  if (seen.has(id)) return [];
  seen.add(id);
  const rule = grammar.rules[id]!;
  return [
    ...rule.variants.map((variant) => variant.iface),
    ...rule.pass.flatMap((ty) => ty.t === "rule" ? members(grammar, ty.id, seen) : [show(grammar, ty)]),
  ];
};

/** The TypeScript a rule's name stands for: its interfaces and the leaves of what it passes through. */
export const ruleType = (grammar: Checked, id: RuleId): string => [...new Set(members(grammar, id))].join(" | ");
