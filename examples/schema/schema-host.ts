import type { Diagnostic } from "langkit";
import { type HostLanguage, type Piece, verbatim } from "langkit/host";
import { type Base, fieldValue, type Model, type Schema, type Value } from "./schema-model.ts";
import type { Field, Name } from "./schema-syntax.ts";
import { compile } from "./schema.ts";

const scalars: Readonly<Record<string, string>> = {
  Int: "number",
  Float: "number",
  String: "string",
  Bool: "boolean",
  DateTime: "string",
};

const reserved = new Set([
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
]);

const has = (field: Field, kind: Field["ops"][number]["kind"]): boolean => field.ops.some((op) => op.kind === kind);

const primaryKey = (model: Model): Field | undefined => model.fields.find((field) => has(field, "primaryKey"));

const idName = (model: Model): string => `${model.name.name}Id`;

const insertName = (model: Model): string => `New${model.name.name}`;

const cannot = (name: Name, reason: string): Diagnostic => ({
  message: `TypeScript cannot represent ${reason}`,
  context: [],
  span: name.span,
});

const nameClashes = ({ models, enums }: Schema): readonly Diagnostic[] => {
  const taken = new Map<string, Name>();
  const diagnostics: Diagnostic[] = [];
  const claim = (emitted: string, owner: Name) => {
    const holder = taken.get(emitted);
    if (reserved.has(emitted)) diagnostics.push(cannot(owner, `${emitted}, a reserved type name`));
    else if (holder) {
      diagnostics.push(cannot(owner, `${emitted}, which collides with a name derived from ${holder.name}`));
    } else taken.set(emitted, owner);
  };
  for (const { name } of enums) claim(name.name, name);
  for (const model of models) {
    claim(model.name.name, model.name);
    claim(insertName(model), model.name);
    if (primaryKey(model)) claim(idName(model), model.name);
  }
  return diagnostics;
};

type ValueOf = (model: Model, field: Field) => Value;

const cycles = ({ models }: Schema): readonly Diagnostic[] => {
  const byName = new Map(models.map((model) => [model.name.name, model]));
  return models.flatMap((model) =>
    model.fields.flatMap((field) =>
      fieldValue(byName, model, field)
        ? []
        : [cannot(field.name, `${model.name.name}.${field.name.name}, whose references form a cycle`)]
    )
  );
};

const valuesOf = ({ models }: Schema): ValueOf => {
  const byName = new Map(models.map((model) => [model.name.name, model]));
  return (model, field) => fieldValue(byName, model, field)!;
};

const base = (value: Base): string =>
  value.kind === "scalar" ? scalars[value.name]! : value.kind === "enum" ? value.name : `${value.model}Id`;

const tsValue = ({ base: type, nullable }: Value): string => (nullable ? `${base(type)} | null` : base(type));

const enumeration = ({ name, members }: Schema["enums"][number]): readonly Piece[] => [
  "export type ",
  verbatim(name.name, name.span),
  " = ",
  ...members.flatMap((member, index): readonly Piece[] => [
    index ? " | " : "",
    "\"",
    verbatim(member.name, member.span),
    "\"",
  ]),
  ";\n",
];

const identity = (model: Model, valueOf: ValueOf): readonly Piece[] => {
  const key = primaryKey(model);
  if (!key) return [];
  const type = has(key, "references")
    ? tsValue(valueOf(model, key))
    : `${scalars[key.type.name] ?? key.type.name} & { readonly __brand: "${idName(model)}" }`;
  return [`export type ${idName(model)} = ${type};\n`];
};

const row = (model: Model, valueOf: ValueOf): readonly Piece[] => [
  "export interface ",
  verbatim(model.name.name, model.name.span),
  " {\n",
  ...model.fields.flatMap((field): readonly Piece[] => [
    "  readonly ",
    verbatim(field.name.name, field.name.span),
    `: ${tsValue(valueOf(model, field))};\n`,
  ]),
  "}\n",
];

const insertion = (model: Model, valueOf: ValueOf): string => {
  const columns = model.fields
    .filter((field) => !has(field, "autoIncrement"))
    .map((field) => {
      const optional = field.optional || has(field, "default") ? "?" : "";
      return `  readonly ${field.name.name}${optional}: ${tsValue(valueOf(model, field))};\n`;
    });
  return `export interface ${insertName(model)} {\n${columns.join("")}}\n`;
};

export const host: HostLanguage = {
  extension: ".schema",
  host: (source) => {
    const compiled = compile(source);
    if (!compiled.success) return { declarations: [], javascript: undefined, diagnostics: compiled.errors };
    const { schema, sql } = compiled.value;
    const diagnostics = [...nameClashes(schema), ...cycles(schema)];
    if (diagnostics.length) return { declarations: [], javascript: undefined, diagnostics };
    const valueOf = valuesOf(schema);
    return {
      declarations: [
        ...schema.enums.flatMap(enumeration),
        ...schema.models.flatMap((model) => [
          ...identity(model, valueOf),
          ...row(model, valueOf),
          insertion(model, valueOf),
        ]),
        "export declare const sql: string;\nexport default sql;\n",
      ],
      javascript: `const sql = ${JSON.stringify(sql)};\nexport { sql };\nexport default sql;\n`,
      diagnostics: [],
    };
  },
};
