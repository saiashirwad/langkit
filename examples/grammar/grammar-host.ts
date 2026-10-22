import { atom, type HostLanguage, type Piece, specifier, unhosted, verbatim } from "langkit/host";
import { binding, call, data, field, type Module as Program, ref } from "langkit/ir";
import { emitModule } from "langkit/javascript";
import { type Checked, type Located, type RuleId, ruleId, type Ty, type Variant, wire } from "./grammar-model.ts";
import { checkSource } from "./grammar.ts";

const runtime = new URL("./runtime.ts", import.meta.url).href;

/** `readonly Name[]`, `string | null`, `readonly [Name, ...Name[]]`. A rule prints as its declared name. */
const show = (grammar: Checked, ty: Ty): string => {
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
const members = (grammar: Checked, id: RuleId, seen = new Set<RuleId>()): readonly string[] => {
  if (seen.has(id)) return [];
  seen.add(id);
  const rule = grammar.rules[id]!;
  return [
    ...rule.variants.map((variant) => variant.iface),
    ...rule.pass.flatMap((ty) => ty.t === "rule" ? members(grammar, ty.id, seen) : [show(grammar, ty)]),
  ];
};

/** An interface named for its rule links to the rule; one named for a tag, `DeclarationState`, links to the tag. */
const interfaceOf = (grammar: Checked, id: RuleId, variant: Variant<Located>): readonly Piece[] => {
  const rule = grammar.rules[id]!;
  return [
    "export interface ",
    variant.iface === rule.name ? verbatim(rule.name, rule.span) : atom(variant.iface, variant.span),
    " {\n",
    `  readonly kind: ${JSON.stringify(variant.kind)};\n`,
    ...variant.fields.flatMap(({ label, ty, span, derived }): readonly Piece[] => [
      "  readonly ",
      derived ? atom(label, span) : verbatim(label, span),
      `: ${show(grammar, ty)};\n`,
    ]),
    "  readonly span: Span;\n}\n",
  ];
};

const rule = (grammar: Checked, id: RuleId): readonly Piece[] => {
  const { name, span, variants, pass, bears } = grammar.rules[id]!;
  if (!bears) return [];
  const own = variants.length === 1 && !pass.length && variants[0]!.iface === name;
  const alias: readonly Piece[] = own
    ? []
    : ["export type ", verbatim(name, span), ` = ${[...new Set(members(grammar, id))].join(" | ")};\n`];
  return [...variants.flatMap((variant) => interfaceOf(grammar, id, variant)), ...alias, "\n"];
};

/** The AST types the grammar derives, with each field at its label and each rule at its name in the `.grammar`. */
export const declarations = (grammar: Checked): readonly Piece[] => {
  const [start] = grammar.rules;
  return [
    "import type { Result, Span } from \"langkit\";\n\n",
    ...grammar.rules.flatMap((_, index) => rule(grammar, ruleId(index))),
    `export declare function parse(source: string): Result<${start?.bears ? start.name : "undefined"}>;\n`,
  ];
};

/** `import { define } from "./runtime.ts"; const grammar = define(<wire>); export const parse = grammar.parse;` */
export const program = (uri: string, grammar: Checked): Program<undefined> => {
  const define = binding("define", undefined);
  const parser = binding("grammar", undefined);
  const parse = binding("parse", undefined);
  return {
    imports: [{ from: specifier(uri, runtime), names: [["define", define]] }],
    body: {
      declarations: [
        { binding: parser, value: call(undefined, ref(define), data(undefined, wire(grammar))) },
        { binding: parse, value: field(undefined, ref(parser), "parse") },
      ],
      result: data(undefined, null),
    },
    exports: [["parse", parse]],
  };
};

export const host: HostLanguage = {
  extension: ".grammar",
  host: (source, uri) => {
    const checked = checkSource(source);
    if (!checked.success) return unhosted(checked.errors);
    return {
      declarations: declarations(checked.value),
      javascript: () => emitModule(program(uri, checked.value)),
      diagnostics: [],
    };
  },
};
