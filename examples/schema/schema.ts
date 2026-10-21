import { type Check, check, fail, render, type Result, run } from "langkit";
import { type Analysis, create as createAnalysis, highlight } from "langkit/analysis";
import { readFileSync } from "node:fs";
import {
  type Declaration,
  type Default,
  type Field,
  type ModelExpr,
  type ModelOp,
  type Name,
  parse,
  tokens,
} from "./schema-syntax.ts";

export type Type = string;

export const show = (type: Type): string => type;

export type Model = {
  readonly name: Name;
  readonly fields: readonly Field[];
  readonly constraints: readonly Extract<ModelOp, { kind: "index" | "unique"; }>[];
  readonly links: readonly Extract<ModelOp, { kind: "many" | "one"; }>[];
};

export type Arity = "one" | "optional" | "many";

/** A traversable edge: rows of `target` whose `inner` column equals the owner's `outer` column. */
export type Relation = {
  readonly id: symbol;
  readonly name: Name;
  readonly target: string;
  readonly outer: string;
  readonly inner: string;
  readonly arity: Arity;
};

export type Schema = {
  readonly models: readonly Model[];
  readonly enums: readonly Extract<Declaration, { kind: "enum"; }>[];
  readonly relations: ReadonlyMap<string, ReadonlyMap<string, Relation>>;
};

export type Scalar = "Int" | "Float" | "String" | "Bool" | "DateTime";

export type Base =
  | { readonly kind: "scalar"; readonly name: Scalar; }
  | { readonly kind: "enum"; readonly name: string; }
  | { readonly kind: "key"; readonly model: string; };

export type Value = { readonly base: Base; readonly nullable: boolean; };

export type Compiled = { readonly schema: Schema; readonly sql: string; };

type Binding = { readonly id: symbol; readonly name: string; readonly type: Type; };

const facts = createAnalysis<Type>();

const scalars = new Map<string, string>([
  ["Int", "INTEGER"],
  ["Float", "REAL"],
  ["String", "TEXT"],
  ["Bool", "INTEGER"],
  ["DateTime", "TEXT"],
]);

const operations = new Set([
  "extend",
  "index",
  "unique",
  "primaryKey",
  "autoIncrement",
  "default",
  "references",
  "many",
  "one",
  "now",
]);

const has = (field: Field, kind: Field["ops"][number]["kind"]): boolean => field.ops.some((op) => op.kind === kind);

const fieldType = (field: Field): string => field.type.name + (field.optional ? "?" : "");

const key = (name: string): string => name.toLowerCase();

export const isScalar = (name: string): name is Scalar => scalars.has(name);

export const unique = (model: Model, field: Field): boolean =>
  has(field, "primaryKey") || has(field, "unique")
  || model.constraints.some((c) =>
    c.kind === "unique" && c.fields.length === 1 && c.fields[0]!.name === field.name.name
  );

/** The value a field holds: a reference takes the value of the key it references. Undefined on a reference cycle. */
export const fieldValue = (
  models: ReadonlyMap<string, Model>,
  model: Model,
  field: Field,
): Value | undefined => {
  const resolve = (model: Model, field: Field, visiting: readonly Field[]): Base | undefined => {
    if (visiting.includes(field)) return undefined;
    const reference = field.ops.find((op) => op.kind === "references");
    if (reference) {
      const target = models.get(reference.model.name);
      const targetField = target?.fields.find((candidate) => candidate.name.name === reference.field.name);
      return target && targetField ? resolve(target, targetField, [...visiting, field]) : undefined;
    }
    if (has(field, "primaryKey")) return { kind: "key", model: model.name.name };
    return isScalar(field.type.name)
      ? { kind: "scalar", name: field.type.name }
      : { kind: "enum", name: field.type.name };
  };
  const base = resolve(model, field, []);
  return base && { base, nullable: field.optional };
};

const binding = (name: Name, type: Type): Binding => ({
  id: Symbol(name.name),
  name: name.name,
  type,
});

const error = (name: Name, message: string): Check<never> => fail(message).at(name.span);

const reference = (target: { readonly id: symbol; readonly type: Type; }, name: Name): Check<void> =>
  check(function*() {
    yield* facts.reference(target, name.span);
    yield* facts.typed(target.type, name.span);
  });

const elaborate = (declarations: readonly Declaration[]): Check<Schema> =>
  check(function*() {
    const names = new Map<string, Declaration>();
    const bindings = new Map<Declaration, Binding>();
    const helpers = new Map<string, Extract<Declaration, { kind: "helper"; }>>();
    const enums = new Map<string, Extract<Declaration, { kind: "enum"; }>>();
    const members = new Map<Name, Binding>();
    const tableNames = new Set<string>();
    for (const declaration of declarations) {
      const name = declaration.name;
      if (names.has(name.name) || scalars.has(name.name) || operations.has(name.name)) {
        return yield* error(name, `Duplicate or reserved declaration: ${name.name}`);
      }
      names.set(name.name, declaration);
      const value = binding(
        name,
        declaration.kind === "helper" ? "Model -> Model" : `${declaration.kind} ${name.name}`,
      );
      bindings.set(declaration, value);
      yield* facts.define(
        value,
        name.span,
        declaration.kind === "helper"
          ? "function"
          : declaration.kind === "model"
          ? "model"
          : "enum",
      );
      if (declaration.kind === "helper") helpers.set(name.name, declaration);
      if (declaration.kind === "model") {
        if (tableNames.has(key(name.name))) {
          return yield* error(name, `SQLite table names are case-insensitive: ${name.name}`);
        }
        if (key(name.name).startsWith("sqlite_")) {
          return yield* error(name, "SQLite reserves table names starting with sqlite_");
        }
        tableNames.add(key(name.name));
      }
      if (declaration.kind === "enum") {
        enums.set(name.name, declaration);
        const seen = new Set<string>();
        for (const member of declaration.members) {
          if (seen.has(member.name)) {
            return yield* error(member, `Duplicate enum member: ${member.name}`);
          }
          seen.add(member.name);
          const value = binding(member, name.name);
          members.set(member, value);
          yield* facts.define(value, member.span, "enumMember");
        }
      }
    }

    // Helpers are deliberately total model transformations, not general-purpose code.
    // Check the call graph even for unused helpers, before expanding any models.
    const visited = new Set<string>();

    const visit = (
      helper: Extract<Declaration, { kind: "helper"; }>,
      stack: readonly string[],
    ): Check<void> =>
      check(function*() {
        if (visited.has(helper.name.name)) return;
        if (stack.includes(helper.name.name)) {
          return yield* error(
            helper.name,
            `Recursive model helpers: ${[...stack, helper.name.name].join(" -> ")}`,
          );
        }
        const base = helper.body.base;
        if (base.kind !== "name" || base.name.name !== helper.param.name) {
          return yield* error(
            helper.param,
            `A model helper must start from its parameter ${helper.param.name}`,
          );
        }
        const param = binding(helper.param, "Model");
        yield* facts.define(param, helper.param.span, "parameter");
        yield* reference(param, base.name);
        for (const op of helper.body.ops) {
          if (op.kind !== "helper") continue;
          const target = helpers.get(op.name.name);
          if (!target) return yield* error(op.name, `Unknown model helper: ${op.name.name}`);
          yield* reference(bindings.get(target)!, op.name);
          yield* visit(target, [...stack, helper.name.name]);
        }
        visited.add(helper.name.name);
      });

    for (const helper of helpers.values()) yield* visit(helper, []);

    const extend = (model: Model, fields: readonly Field[]): Check<Model> =>
      check(function*() {
        const seen = new Set(model.fields.map((field) => key(field.name.name)));
        for (const field of fields) {
          if (seen.has(key(field.name.name))) {
            return yield* error(
              field.name,
              `Duplicate field: ${model.name.name}.${field.name.name}; extend never replaces fields`,
            );
          }
          seen.add(key(field.name.name));
        }
        return { ...model, fields: [...model.fields, ...fields] };
      });

    const apply = (initial: Model, ops: ModelExpr["ops"]): Check<Model> =>
      check(function*() {
        let model = initial;
        for (const op of ops) {
          switch (op.kind) {
            case "extend":
              model = yield* extend(model, op.fields);
              break;
            case "helper": {
              const helper = helpers.get(op.name.name);
              if (!helper) return yield* error(op.name, `Unknown model helper: ${op.name.name}`);
              yield* reference(bindings.get(helper)!, op.name);
              model = yield* apply(model, helper.body.ops);
              break;
            }
            case "many":
            case "one":
              model = { ...model, links: [...model.links, op] };
              break;
            default:
              model = { ...model, constraints: [...model.constraints, op] };
          }
        }
        return model;
      });

    const models = new Map<string, Model>();
    const fieldBindings = new Map<Model, Map<string, Binding>>();
    for (const declaration of declarations) {
      if (declaration.kind !== "model") continue;
      if (declaration.body.base.kind !== "fields") {
        return yield* error(declaration.body.base.name, "A model must start with a field block");
      }
      const base = yield* extend(
        { name: declaration.name, fields: [], constraints: [], links: [] },
        declaration.body.base.fields,
      );
      const model = yield* apply(base, declaration.body.ops).context(
        `model ${declaration.name.name}`,
      );
      if (!model.fields.length) return yield* error(model.name, "A model needs at least one field");
      models.set(model.name.name, model);
      const fields = new Map<string, Binding>();
      fieldBindings.set(model, fields);
      for (const field of model.fields) {
        const value = binding(field.name, fieldType(field));
        fields.set(field.name.name, value);
        yield* facts.define(value, field.name.span, "field");
      }
    }

    const validateField = (field: Field): Check<void> =>
      check(function*() {
        yield* facts.typed(fieldType(field), field.name.span);
        const enumeration = enums.get(field.type.name);
        if (!scalars.has(field.type.name) && !enumeration) {
          return yield* error(field.type, `Unknown field type: ${field.type.name}`);
        }
        if (enumeration) yield* reference(bindings.get(enumeration)!, field.type);
        else yield* facts.typed(field.type.name, field.type.span);
        const seen = new Set<string>();
        for (const op of field.ops) {
          if (seen.has(op.kind)) {
            return yield* error(op.name, `Duplicate field operation: ${op.kind}`);
          }
          seen.add(op.kind);
          if (op.kind === "default") {
            const value = op.value;
            let valid = false;
            if (value.kind === "now") valid = field.type.name === "DateTime";
            else if (value.kind === "enum") {
              const target = enums.get(value.type.name);
              const member = target?.members.find((member) => member.name === value.member.name);
              if (!target || !member) {
                return yield* error(
                  value.member,
                  `Unknown enum value: ${value.type.name}.${value.member.name}`,
                );
              }
              yield* reference(bindings.get(target)!, value.type);
              yield* reference(members.get(member)!, value.member);
              valid = target === enumeration;
            } else {
              switch (field.type.name) {
                case "Int":
                  valid = typeof value.value === "number" && Number.isSafeInteger(value.value);
                  break;
                case "Float":
                  valid = typeof value.value === "number" && Number.isFinite(value.value);
                  break;
                case "String":
                  valid = typeof value.value === "string";
                  break;
                case "Bool":
                  valid = typeof value.value === "boolean";
                  break;
              }
            }
            if (!valid) return yield* error(op.name, `Invalid default for ${field.type.name}`);
          }
          if (op.kind === "references") {
            const target = models.get(op.model.name);
            if (!target) return yield* error(op.model, `Unknown model: ${op.model.name}`);
            const targetField = target.fields.find((field) => field.name.name === op.field.name);
            if (!targetField) {
              return yield* error(op.field, `Unknown field: ${op.model.name}.${op.field.name}`);
            }
            yield* reference(bindings.get(names.get(op.model.name)!)!, op.model);
            yield* reference(fieldBindings.get(target)!.get(op.field.name)!, op.field);
            if (targetField.type.name !== field.type.name) {
              return yield* error(
                op.field,
                `Foreign key types differ: ${field.type.name} and ${targetField.type.name}`,
              );
            }
            if (!unique(target, targetField)) {
              return yield* error(
                op.field,
                "A foreign key must reference a primary key or unique field",
              );
            }
          }
        }
        if (has(field, "primaryKey") && field.optional) {
          return yield* error(field.name, "A primary key cannot be optional");
        }
        if (has(field, "autoIncrement") && (field.type.name !== "Int" || !has(field, "primaryKey"))) {
          return yield* error(field.name, "autoIncrement requires an Int primary key");
        }
        if (has(field, "autoIncrement") && has(field, "default")) {
          return yield* error(field.name, "autoIncrement cannot have a default");
        }
      });

    for (const model of models.values()) {
      let primaryKeys = 0;
      for (const field of model.fields) {
        yield* validateField(field).context(`model ${model.name.name}`).recover();
        if (has(field, "primaryKey") && ++primaryKeys > 1) {
          yield* error(field.name, "A model can have only one primary key")
            .context(`model ${model.name.name}`).recover();
        }
      }
      const constraints = new Set<string>();
      for (const constraint of model.constraints) {
        const signature = `${constraint.kind}:${constraint.fields.map((field) => field.name).join(",")}`;
        if (constraints.has(signature)) {
          yield* error(constraint.name, `Duplicate model operation: ${constraint.kind}`)
            .context(`model ${model.name.name}`).recover();
        }
        constraints.add(signature);
        const selected = new Set<string>();
        for (const name of constraint.fields) {
          const value = fieldBindings.get(model)!.get(name.name);
          if (!value) {
            yield* error(name, `Unknown field: ${model.name.name}.${name.name}`)
              .context(`model ${model.name.name}`).recover();
            continue;
          }
          if (selected.has(name.name)) {
            yield* error(name, `Repeated field in ${constraint.kind}: ${name.name}`)
              .context(`model ${model.name.name}`).recover();
            continue;
          }
          selected.add(name.name);
          yield* reference(value, name).context(`model ${model.name.name}`).recover();
        }
      }
    }

    // Even unused extensions must contain valid field types, defaults and references.
    for (const helper of helpers.values()) {
      for (const op of helper.body.ops) {
        if (op.kind === "extend") {
          for (const field of op.fields) {
            yield* validateField(field).context(`helper ${helper.name.name}`).recover();
          }
        }
      }
    }
    const relations = yield* relate(models, (declaration) => bindings.get(names.get(declaration)!)!);
    return { models: [...models.values()], enums: [...enums.values()], relations };
  });

const relate = (
  models: ReadonlyMap<string, Model>,
  declared: (model: string) => Binding,
): Check<Schema["relations"]> =>
  check(function*() {
    const relations = new Map<string, Map<string, Relation>>();
    const add = (model: Model, relation: Relation): Check<void> =>
      check(function*() {
        const owned = relations.get(model.name.name) ?? new Map<string, Relation>();
        relations.set(model.name.name, owned);
        const name = relation.name.name;
        if (owned.has(name) || model.fields.some((field) => field.name.name === name)) {
          return yield* error(relation.name, `Duplicate field or relation: ${model.name.name}.${name}`);
        }
        owned.set(name, relation);
        yield* facts.define(
          { id: relation.id, name, type: relationType(relation) },
          relation.name.span,
          "field",
        );
      });
    for (const model of models.values()) {
      for (const field of model.fields) {
        for (const op of field.ops) {
          if (op.kind !== "references" || !op.relation || !models.has(op.model.name)) continue;
          yield* add(model, {
            id: Symbol(op.relation.name),
            name: op.relation,
            target: op.model.name,
            outer: field.name.name,
            inner: op.field.name,
            arity: field.optional ? "optional" : "one",
          }).context(`model ${model.name.name}`).recover();
        }
      }
    }
    const forward = new Map([...relations].map(([model, owned]) => [model, new Map(owned)]));
    for (const model of models.values()) {
      for (const link of model.links) {
        const linked = check(function*() {
          const target = models.get(link.model.name);
          if (!target) return yield* error(link.model, `Unknown model: ${link.model.name}`);
          yield* reference(declared(link.model.name), link.model);
          const inverse = forward.get(target.name.name)?.get(link.inverse.name);
          if (!inverse) return yield* error(link.inverse, `Unknown relation: ${target.name.name}.${link.inverse.name}`);
          yield* reference({ id: inverse.id, type: relationType(inverse) }, link.inverse);
          if (inverse.target !== model.name.name) {
            return yield* error(
              link.inverse,
              `${target.name.name}.${link.inverse.name} points at ${inverse.target}, not ${model.name.name}`,
            );
          }
          const key = target.fields.find((field) => field.name.name === inverse.outer)!;
          if (link.kind === "one" && !unique(target, key)) {
            return yield* error(link.name, `${target.name.name}.${inverse.outer} is not unique; use many`);
          }
          yield* add(model, {
            id: Symbol(link.relation.name),
            name: link.relation,
            target: target.name.name,
            outer: inverse.inner,
            inner: inverse.outer,
            arity: link.kind === "one" ? "optional" : "many",
          });
        });
        yield* linked.context(`model ${model.name.name}`).recover();
      }
    }
    return relations;
  });

const relationType = (relation: Relation): Type =>
  relation.arity === "many"
    ? `${relation.target}[]`
    : relation.arity === "optional"
    ? `${relation.target}?`
    : relation.target;

const quote = (name: string): string => `"${name.replaceAll("\"", "\"\"")}"`;

const string = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const literal = (value: Default): string => {
  if (value.kind === "now") return "CURRENT_TIMESTAMP";
  if (value.kind === "enum") return string(value.member.name);
  if (typeof value.value === "boolean") return value.value ? "1" : "0";
  // SQLite SQL text cannot contain a literal NUL. Hex preserves all UTF-8 text.
  if (typeof value.value === "string") {
    return value.value.includes("\0")
      ? `(CAST(X'${Buffer.from(value.value).toString("hex")}' AS TEXT))`
      : string(value.value);
  }
  return String(value.value);
};

/** Emit a fresh SQLite schema, never migrations or database side effects. */

export const emit = (schema: Schema): string => {
  const enums = new Map(schema.enums.map((value) => [value.name.name, value]));
  const statements = ["PRAGMA foreign_keys = ON;"];
  const usedNames = new Set(schema.models.map((model) => key(model.name.name)));
  let nextIndex = 0;
  for (const model of schema.models) {
    const columns = model.fields.map((field) => {
      const name = quote(field.name.name);
      let column = `${name} ${scalars.get(field.type.name) ?? "TEXT"}`;
      if (has(field, "primaryKey")) column += " PRIMARY KEY";
      if (has(field, "autoIncrement")) column += " AUTOINCREMENT";
      if (!field.optional) column += " NOT NULL";
      if (has(field, "unique")) column += " UNIQUE";
      for (const op of field.ops) {
        if (op.kind === "default") column += ` DEFAULT ${literal(op.value)}`;
        if (op.kind === "references") {
          column += ` REFERENCES ${quote(op.model.name)} (${quote(op.field.name)})`;
        }
      }
      if (field.type.name === "Bool") column += ` CHECK (${name} IN (0, 1))`;
      const enumeration = enums.get(field.type.name);
      if (enumeration) {
        column += ` CHECK (${name} IN (${enumeration.members.map((member) => string(member.name)).join(", ")}))`;
      }
      return column;
    });
    for (const constraint of model.constraints) {
      if (constraint.kind === "unique") {
        columns.push(`UNIQUE (${constraint.fields.map((field) => quote(field.name)).join(", ")})`);
      }
    }
    statements.push(
      `CREATE TABLE ${quote(model.name.name)} (\n  ${columns.join(",\n  ")}\n) STRICT;`,
    );
    for (const constraint of model.constraints) {
      if (constraint.kind !== "index") continue;
      let name: string;
      do {
        name = `__schema_index_${nextIndex++}`;
      } while (usedNames.has(key(name)));
      usedNames.add(key(name));
      statements.push(
        `CREATE INDEX ${quote(name)} ON ${quote(model.name.name)} (${
          constraint.fields.map((field) => quote(field.name)).join(", ")
        });`,
      );
    }
  }
  return statements.join("\n\n") + "\n";
};

export const compile = (source: string): Result<Compiled> => {
  const parsed = parse(source);
  if (!parsed.success) return parsed;
  const result = run(elaborate(parsed.value));
  return result.success
    ? { success: true, value: { schema: result.value, sql: emit(result.value) } }
    : result;
};

export const analyze = (source: string): Analysis<Type> => {
  const lexical = highlight(source, tokens);
  const parsed = parse(source);
  if (!parsed.success) {
    return {
      diagnostics: [...parsed.errors],
      types: [],
      definitions: [],
      references: [],
      tokens: lexical,
    };
  }
  return facts.collect(elaborate(parsed.value), lexical).analysis;
};

if (import.meta.main) {
  const source = readFileSync(process.argv[2] ?? new URL("./main.schema", import.meta.url), "utf8");
  const result = compile(source);
  if (result.success) process.stdout.write(result.value.sql);
  else {
    for (const error of result.errors) console.error(render(error, source));
    process.exitCode = 1;
  }
}
