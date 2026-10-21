import type { Diagnostic } from "langkit";
import { type HostLanguage, type Piece, specifier, unhosted, verbatim } from "langkit/host";
import { binding, call, data, field, type Module, ref } from "langkit/ir";
import { emitModule } from "langkit/javascript";
import type { Output, Query, Shape, Statement } from "./queries.ts";
import {
  type Base,
  fieldValue,
  has,
  isScalar,
  type Model,
  primaryKey,
  scalars,
  type Schema,
  type Value,
} from "./schema-model.ts";
import type { Field, Name } from "./schema-syntax.ts";
import { checkSource, ddl } from "./schema.ts";
import { plan, statement } from "./sql.ts";

const runtime = new URL("./runtime.ts", import.meta.url).href;

const program = (uri: string, ddl: string, queries: readonly Query[]): Module<undefined> => {
  const local = (name: string) => binding(name, undefined);
  const connect = local("connect");
  const statements = local("statements");
  const schema = local("schema");
  const exported = { sql: local("sql"), statements: local("statements"), open: local("open") };
  const plans = Object.fromEntries(queries.map((query) => [query.name.name, plan(query)]));
  return {
    imports: [{ from: specifier(uri, runtime), names: [["connect", connect], ["statements", statements]] }],
    body: {
      declarations: [
        { binding: schema, value: data(undefined, { ddl, plans }) },
        { binding: exported.sql, value: field(undefined, ref(schema), "ddl") },
        { binding: exported.statements, value: call(undefined, ref(statements), ref(schema)) },
        { binding: exported.open, value: call(undefined, ref(connect), ref(schema)) },
      ],
      result: ref(exported.sql),
    },
    exports: Object.entries(exported),
  };
};

const reserved = new Set([
  "Database",
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

const idName = (model: Model): string => `${model.name.name}Id`;

const insertName = (model: Model): string => `New${model.name.name}`;

const cannot = (name: Name, reason: string): Diagnostic => ({
  message: `TypeScript cannot represent ${reason}`,
  context: [],
  span: name.span,
});

const members = new Set(["transaction", "init", "close"]);

const memberClashes = (queries: readonly Query[]): readonly Diagnostic[] =>
  queries.flatMap(({ name }) => (members.has(name.name) ? [cannot(name, `${name.name}, a Database member`)] : []));

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
  value.kind === "scalar" ? scalars[value.name].ts : value.kind === "enum" ? value.name : `${value.model}Id`;

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
    : `${isScalar(key.type.name) ? scalars[key.type.name].ts : key.type.name} & { readonly __brand: "${
      idName(model)
    }" }`;
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

const outputType = (output: Output): readonly Piece[] => {
  switch (output.kind) {
    case "value":
      return [tsValue(output.value)];
    case "object":
      return [...shapeType(output.shape), output.nullable ? " | null" : ""];
    case "list":
      return ["readonly ", ...shapeType(output.shape), "[]"];
  }
};

const shapeType = (shape: Shape): readonly Piece[] =>
  shape.kind === "model"
    ? [shape.model.name.name]
    : [
      "{ ",
      ...shape.columns.flatMap((column): readonly Piece[] => [
        "readonly ",
        verbatim(column.key.name, column.key.span),
        ": ",
        ...outputType(column.output),
        "; ",
      ]),
      "}",
    ];

const resultType = (statement: Statement): readonly Piece[] => {
  if (statement.kind === "read") {
    switch (statement.result.kind) {
      case "rows":
        return ["readonly ", ...shapeType(statement.result.shape), "[]"];
      case "first":
        return [...shapeType(statement.result.shape), " | undefined"];
      case "single":
        return shapeType(statement.result.shape);
      case "count":
        return ["number"];
      case "exists":
        return ["boolean"];
    }
  }
  if (!statement.returning) return ["number"];
  return statement.kind === "insert"
    ? shapeType(statement.returning)
    : ["readonly ", ...shapeType(statement.returning), "[]"];
};

const documentation = (sql: string): string =>
  [
    "  /**",
    "   * ```sql",
    ...sql.replaceAll("*/", "*\\/").split("\n").map((line) => `   * ${line}`),
    "   * ```",
    "   */",
    "",
  ]
    .join("\n");

const method = (query: Query): readonly Piece[] => [
  documentation(statement(query)),
  "  ",
  verbatim(query.name.name, query.name.span),
  "(",
  ...(query.params.length
    ? [
      "params: { ",
      ...query.params.flatMap(({ name, value }): readonly Piece[] => [
        "readonly ",
        verbatim(name.name, name.span),
        `: ${tsValue(value)}; `,
      ]),
      "}",
    ]
    : []),
  "): ",
  ...resultType(query.statement),
  ";\n",
];

const database = (queries: readonly Query[]): readonly Piece[] => [
  "export interface Database {\n",
  ...queries.flatMap(method),
  "  transaction<T>(body: (tx: Database) => T): T;\n",
  "  init(): void;\n",
  "  close(): void;\n",
  "}\n",
  "export declare function open(path: string): Database;\n",
  `export declare const statements: { ${queries.map((query) => `readonly ${query.name.name}: string; `).join("")}};\n`,
];

export const host: HostLanguage = {
  extension: ".schema",
  host: (source, uri) => {
    const checked = checkSource(source);
    if (!checked.success) return unhosted(checked.errors);
    const { schema, queries } = checked.value;
    const diagnostics = [...nameClashes(schema), ...cycles(schema), ...memberClashes(queries)];
    if (diagnostics.length) return unhosted(diagnostics);
    const valueOf = valuesOf(schema);
    return {
      declarations: [
        ...schema.enums.flatMap(enumeration),
        ...schema.models.flatMap((model) => [
          ...identity(model, valueOf),
          ...row(model, valueOf),
          insertion(model, valueOf),
        ]),
        ...database(queries),
        "export declare const sql: string;\nexport default sql;\n",
      ],
      javascript: () => emitModule(program(uri, ddl(schema), queries)),
      diagnostics: [],
    };
  },
};
