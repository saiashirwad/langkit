import type { Definition, DefinitionKind, Reference, Typed } from "langkit/analysis";
import { type Checked, type Expr, type Located, ruleId, walk } from "./grammar-model.ts";
import { ruleType, show } from "./grammar-types.ts";

export type Type = string;

export type Facts = {
  readonly types: readonly Typed<Type>[];
  readonly definitions: readonly Definition<Type>[];
  readonly references: readonly Reference[];
};

/**
 * Editor facts read off the checked IR: a rule is a class, a token a constant, a label a property and a tag an enum
 * member. A rule or label shows the TypeScript it projects to, and every use of a rule or token links to its
 * declaration.
 */
export const facts = (grammar: Checked): Facts => {
  const types: Typed<Type>[] = [];
  const definitions: Definition<Type>[] = [];
  const references: Reference[] = [];
  const define = (name: string, span: Located["span"], kind: DefinitionKind, type: Type): symbol => {
    const id = Symbol(name);
    definitions.push({ id, name, span, kind, type });
    types.push({ span, type });
    return id;
  };

  const ruleIds = grammar.rules.map((rule, index) =>
    define(rule.name, rule.span, "class", rule.bears ? ruleType(grammar, ruleId(index)) : "captures nothing")
  );
  const tokenIds = new Map(
    grammar.tokens.map((token) => [token.name, define(token.name, token.span, "constant", "string")]),
  );
  const link = (id: symbol, e: Expr<Located>, type: Type) => {
    references.push({ id, span: e.span });
    types.push({ span: e.span, type });
  };

  grammar.rules.forEach((rule) => {
    const fields = new Map(
      rule.variants.flatMap((variant) => variant.fields.filter((field) => !field.derived)).map((
        field,
      ) => [field.span.start, show(grammar, field.ty)]),
    );
    walk(rule.body, (e) => {
      if (e.t === "ref") {
        link(ruleIds[e.rule]!, e, grammar.rules[e.rule]!.bears ? ruleType(grammar, e.rule) : "captures nothing");
      }
      if (e.t === "re" && e.name) link(tokenIds.get(e.name)!, e, "string");
      if (e.t !== "seq") return;
      if (e.tag) define(e.tag.name, e.tag.span, "enumMember", e.node ? `${rule.name}: ${e.node}` : e.tag.name);
      for (const { label } of e.items) {
        const type = label && fields.get(label.span.start);
        if (label && type) define(label.name, label.span, "property", type);
      }
    });
  });
  return { types, definitions, references };
};
