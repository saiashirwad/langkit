import type { Result } from "langkit";
import type { TokenRule } from "langkit/analysis";
import { readFileSync } from "node:fs";
import type { FieldExpr, TypeDeclaration, TypeExpr } from "../data/data-types.ts";
import { wire } from "../grammar/grammar-model.ts";
import { tokenRules } from "../grammar/grammar-tokens.ts";
import { checkSource } from "../grammar/grammar.ts";
import { define } from "../grammar/runtime.ts";
import type * as G from "./reactor.grammar";

const checked = checkSource(readFileSync(new URL("./reactor.grammar", import.meta.url), "utf8"));
if (!checked.success) throw new Error(`reactor.grammar: ${checked.errors[0].message}`);

export const parse = define(wire(checked.value)).parse as (source: string) => Result<G.File>;

export const tokens: readonly TokenRule[] = tokenRules(checked.value);

export const lowerType = (type: G.DataType): TypeExpr => {
  const { span } = type;
  switch (type.kind) {
    case "named":
      return { kind: "named", name: type.name, span };
    case "list":
      return {
        kind: "list",
        element: lowerType(type.element),
        max: type.bound ? { value: Number(type.bound.max), span: type.bound.span } : undefined,
        span,
      };
    case "postfix":
      return { kind: "optional", inner: lowerType(type.operand), span };
  }
};

const lowerField = ({ name, type }: G.Field): FieldExpr => ({ name, type: lowerType(type) });

/** A member written `Loop()` is a variant with no fields; one written bare is an enum member. */
export const lowerDeclaration = ({ name, body }: G.DeclarationType): TypeDeclaration =>
  body.kind === "record"
    ? { kind: "record", name, fields: body.fields.map(lowerField) }
    : {
      kind: "union",
      name,
      members: body.members.map((member) => ({ name: member.name, fields: member.payload?.fields.map(lowerField) })),
    };
