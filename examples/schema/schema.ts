import { type Check, check, render, type Result, run } from "langkit";
import { type Analysis, create as createAnalysis, highlight, unanalyzed } from "langkit/analysis";
import { readFileSync } from "node:fs";
import { checkQueries, type HelperKind, isFilter, isStage, type Query } from "./queries.ts";
import {
  type Binding,
  error,
  has,
  isScalar,
  type Model,
  referencing,
  type Relation,
  relationType,
  scalars,
  type Schema,
  unique,
} from "./schema-model.ts";
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
import { quote, sqlLiteral, text } from "./sql.ts";

export type Type = string;

export const show = (type: Type): string => type;

export type Checked = { readonly schema: Schema; readonly queries: readonly Query[]; };
export type Compiled = Checked & { readonly sql: string; };

const facts = createAnalysis<Type>();

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
  "where",
  "orderBy",
  "offset",
  "limit",
  "select",
  "returning",
  "insert",
  "update",
  "first",
  "count",
  "exists",
  "delete",
]);

const fieldType = (field: Field): string => field.type.name + (field.optional ? "?" : "");

const key = (name: string): string => name.toLowerCase();

const binding = (name: Name, type: Type): Binding => ({
  id: Symbol(name.name),
  name: name.name,
  type,
});

const reference = referencing(facts);

const elaborate = (
  declarations: readonly Declaration[],
): Check<{ readonly schema: Schema; readonly queries: readonly Query[]; }> =>
  check(function*() {
    const names = new Map<string, Declaration>();
    const bindings = new Map<Declaration, Binding>();
    const helpers = new Map<string, Extract<Declaration, { kind: "helper"; }>>();
    const enums = new Map<string, Extract<Declaration, { kind: "enum"; }>>();
    const members = new Map<Name, Binding>();
    const tableNames = new Set<string>();
    for (const declaration of declarations) {
      const name = declaration.name;
      if (names.has(name.name) || isScalar(name.name) || operations.has(name.name)) {
        return yield* error(name, `Duplicate or reserved declaration: ${name.name}`);
      }
      names.set(name.name, declaration);
      const value = binding(
        name,
        declaration.kind === "helper" ? "helper" : `${declaration.kind} ${name.name}`,
      );
      bindings.set(declaration, value);
      yield* facts.define(
        value,
        name.span,
        declaration.kind === "helper" || declaration.kind === "query"
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

    // Helpers are deliberately total transformations of a model or a query, not general-purpose code.
    // Check the call graph even for unused helpers, before expanding any models.
    const kinds = new Map<string, HelperKind>();

    const visit = (
      helper: Extract<Declaration, { kind: "helper"; }>,
      stack: readonly string[],
    ): Check<void> =>
      check(function*() {
        if (kinds.has(helper.name.name)) return;
        if (stack.includes(helper.name.name)) {
          return yield* error(
            helper.name,
            `Recursive helpers: ${[...stack, helper.name.name].join(" -> ")}`,
          );
        }
        const base = helper.body.base;
        if (base.kind !== "name" || base.name.name !== helper.param.name) {
          return yield* error(
            helper.param,
            `A helper must start from its parameter ${helper.param.name}`,
          );
        }
        const param = binding(helper.param, "Model");
        yield* facts.define(param, helper.param.span, "parameter");
        yield* reference(param, base.name);
        let kind: HelperKind | undefined;
        for (const op of helper.body.ops) {
          let opKind: HelperKind;
          if (op.kind === "helper") {
            const target = helpers.get(op.name.name);
            if (!target) return yield* error(op.name, `Unknown helper: ${op.name.name}`);
            yield* reference(bindings.get(target)!, op.name);
            yield* visit(target, [...stack, helper.name.name]);
            opKind = kinds.get(op.name.name)!;
          } else if (isFilter(op)) opKind = "query";
          else if (isStage(op)) {
            return yield* error(
              op.name,
              `A query helper only filters, orders and pages; ${op.kind} belongs in a query`,
            );
          } else opKind = "model";
          if (kind && kind !== opKind) {
            return yield* error(helper.name, `${helper.name.name} mixes model and query operations`);
          }
          kind = opKind;
        }
        kinds.set(helper.name.name, kind ?? "model");
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
              if (kinds.get(op.name.name) === "query") {
                return yield* error(
                  op.name,
                  `${op.name.name} is a query helper; it cannot apply to model ${model.name.name}`,
                );
              }
              model = yield* apply(model, helper.body.ops);
              break;
            }
            case "many":
            case "one":
              model = { ...model, links: [...model.links, op] };
              break;
            case "index":
            case "unique":
              model = { ...model, constraints: [...model.constraints, op] };
              break;
            default:
              return yield* error(op.name, `${op.kind} is a query stage; it cannot apply to model ${model.name.name}`);
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
        if (!isScalar(field.type.name) && !enumeration) {
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
    const declared = (name: string): Binding => bindings.get(names.get(name)!)!;
    const relations = yield* relate(models, declared);
    const queries = yield* checkQueries({
      facts,
      models,
      relations,
      enums,
      helpers,
      kinds,
      declared,
      field: (model, name) => fieldBindings.get(model)!.get(name)!,
      member: (member) => members.get(member)!,
    }, declarations);
    return { schema: { models: [...models.values()], enums: [...enums.values()], relations }, queries };
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
    // Reverse links resolve against the snapshot of field-declared relations, so a reverse
    // link cannot name another reverse link.
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

const literal = (value: Default): string =>
  value.kind === "now"
    ? "CURRENT_TIMESTAMP"
    : value.kind === "enum"
    ? text(value.member.name)
    : sqlLiteral(value.value);

/** Emit a fresh SQLite schema, never migrations or database side effects. */

export const ddl = (schema: Schema): string => {
  const enums = new Map(schema.enums.map((value) => [value.name.name, value]));
  const statements = ["PRAGMA foreign_keys = ON;"];
  const usedNames = new Set(schema.models.map((model) => key(model.name.name)));
  let nextIndex = 0;
  for (const model of schema.models) {
    const columns = model.fields.map((field) => {
      const name = quote(field.name.name);
      let column = `${name} ${isScalar(field.type.name) ? scalars[field.type.name].sql : "TEXT"}`;
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
        column += ` CHECK (${name} IN (${enumeration.members.map((member) => text(member.name)).join(", ")}))`;
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

export const checkSource = (source: string): Result<Checked> => {
  const parsed = parse(source);
  if (!parsed.success) return parsed;
  return run(elaborate(parsed.value));
};

export const compile = (source: string): Result<Compiled> => {
  const checked = checkSource(source);
  return checked.success ? { success: true, value: { ...checked.value, sql: ddl(checked.value.schema) } } : checked;
};

export const analyze = (source: string): Analysis<Type> => {
  const lexical = highlight(source, tokens);
  const parsed = parse(source);
  if (!parsed.success) {
    return unanalyzed(parsed.errors, lexical);
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
