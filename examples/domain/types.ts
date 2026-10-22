import { type Check, check, pure } from "langkit";
import {
  type DataType,
  type Enum,
  type Field,
  isScalar,
  showType,
  showTypeDecl,
  type Tagged,
  type TypeDecl,
  type TypeKey,
  type Universe,
  type Variant,
} from "./domain-model.ts";
import type { Declaration, Entry, Field as Written, Member, Name, TypeExpr } from "./domain-syntax.ts";
import { attempt, type Binder, error, facts, reserved, type Scope } from "./scope.ts";

export type TypeDeclaration = Extract<Declaration, { readonly kind: "brand" | "union" | "record"; }>;

/** What each declaration becomes in TypeScript, for semantic tokens. */
export const definitionKind = { brand: "type", enum: "enum", tagged: "enum", record: "interface" } as const;

export const article = (kind: Binder["kind"] | TypeDecl["kind"]): string => {
  switch (kind) {
    case "type":
      return "a type";
    case "machine":
      return "a machine";
    case "system":
      return "a system";
    case "brand":
      return "a brand";
    case "enum":
      return "an enum";
    case "tagged":
      return "a tagged union";
    case "record":
      return "a record";
  }
};

/** `Missing` -> `Unknown type: Missing`; `String??` -> `A type is optional at most once`. References the name. */
const resolveType = (scope: Scope, type: TypeExpr): Check<DataType> =>
  check<DataType>(function*() {
    switch (type.kind) {
      case "named": {
        const { name } = type.name;
        if (isScalar(name)) return { kind: "scalar", name };
        const binder = scope.top.get(name);
        if (!binder) return yield* error(type.name, `Unknown type: ${name}`);
        if (binder.kind !== "type") return yield* error(type.name, `${name} is ${article(binder.kind)}, not a type`);
        yield* facts.reference(binder, type.name.span);
        return { kind: "named", key: binder.key, name };
      }
      case "list":
        return { kind: "list", element: yield* resolveType(scope, type.element) };
      case "optional": {
        const inner = yield* resolveType(scope, type.inner);
        if (inner.kind === "optional") return yield* error(type, "A type is optional at most once");
        return { kind: "optional", inner };
      }
    }
  });

export const asEntries = (fields: readonly Written[]): readonly Entry[] =>
  fields.map((field): Entry => ({ kind: "field", field }));

/**
 * Resolves one field list: record fields, event payload, or state data. Each entry recovers on its own, so a bad
 * field is dropped and reported without hiding its siblings. `...Placed` splices a record's fields in place, as
 * the record's own `Field`s, so hover and definition on `items` reach `type Placed`.
 */
export const collect = (
  scope: Scope,
  owner: Name,
  entries: readonly Entry[],
  kind: "property" | "parameter",
): Check<readonly Field[]> =>
  check<readonly Field[]>(function*() {
    const fields: Field[] = [];
    const claim = (at: Name, name: string): Check<void> =>
      fields.some((field) => field.name.name === name)
        ? error(at, `Duplicate field: ${owner.name}.${name}`)
        : pure(undefined);
    for (const entry of entries) {
      yield* attempt(check(function*() {
        if (entry.kind === "spread") {
          const { name } = entry.record;
          const binder = scope.top.get(name);
          const shape = binder && scope.universe.get(binder.key);
          if (!binder) return yield* error(entry.record, `Unknown record: ${name}`);
          if (shape?.kind !== "record") {
            return yield* error(
              entry.record,
              `${name} is ${article(shape?.kind ?? binder.kind)}; only a record spreads`,
            );
          }
          yield* facts.reference(binder, entry.record.span);
          for (const field of shape.fields) {
            yield* attempt(check(function*() {
              yield* claim(entry.record, field.name.name);
              fields.push(field);
            }));
          }
          return;
        }
        const { name, type } = entry.field;
        if (reserved.field.has(name.name)) {
          yield* attempt(error(name, `TypeScript cannot represent ${name.name}, a field name`));
        }
        yield* claim(name, name.name);
        const field: Field = { id: Symbol(name.name), uri: scope.uri, name, type: yield* resolveType(scope, type) };
        yield* facts.define({ id: field.id, name: name.name, type: showType(field.type) }, name.span, kind);
        fields.push(field);
      }));
    }
    return fields;
  });

const enumeration = (declared: Omit<Enum, "kind" | "members">, members: readonly Member[]): Check<Enum> =>
  check(function*() {
    for (const member of members) {
      yield* facts.define(
        { id: Symbol(member.name.name), name: member.name.name, type: declared.name.name },
        member.name.span,
        "enumMember",
      );
    }
    return { kind: "enum", ...declared, members: members.map((member) => member.name) };
  });

/**
 * Each variant becomes an interface inside `namespace PayMethod`, so its name follows the state rules, and `tag`
 * is the discriminant, so no variant may have a field of that name.
 */
const tagged = (scope: Scope, declared: Omit<Tagged, "kind" | "variants">, members: readonly Member[]): Check<Tagged> =>
  check(function*() {
    const variants: Variant[] = [];
    for (const member of members) {
      const { name } = member;
      if (reserved.type.has(name.name)) {
        yield* attempt(error(name, `TypeScript cannot represent ${name.name}, a reserved type name`));
      }
      if (scope.top.get(name.name)?.kind === "type") yield* attempt(error(name, `Duplicate declaration: ${name.name}`));
      const fields = yield* collect(scope, name, asEntries(member.fields ?? []), "property");
      for (const field of fields.filter((field) => field.name.name === "tag")) {
        yield* attempt(error(field.name, "TypeScript cannot represent tag, a variant field name"));
      }
      const variant: Variant = { id: Symbol(name.name), name, fields };
      yield* facts.define(
        { id: variant.id, name: name.name, type: `${declared.name.name}.${name.name}` },
        name.span,
        "enumMember",
      );
      variants.push(variant);
    }
    return { kind: "tagged", ...declared, variants };
  });

/**
 * Brands, enums and records of one file. Records resolve after every name in the file is bound. A brand wraps a
 * scalar: over a record it would add nothing a record does not already have.
 */
export const elaborateTypes = (
  scope: Scope,
  declarations: readonly (readonly [TypeDeclaration, Binder])[],
): Check<readonly TypeDecl[]> =>
  check(function*() {
    const types: TypeDecl[] = [];
    for (const [declaration, { id, key, uri, name }] of declarations) {
      let type: TypeDecl;
      switch (declaration.kind) {
        case "brand": {
          const { underlying } = declaration;
          if (!isScalar(underlying.name)) {
            yield* attempt(error(underlying, `A brand wraps String, Int, Float or Bool, not ${underlying.name}`));
            continue;
          }
          type = { kind: "brand", id, key, uri, name, underlying: underlying.name };
          break;
        }
        case "union": {
          const members: Member[] = [];
          for (const member of declaration.members) {
            if (members.some((seen) => seen.name.name === member.name.name)) {
              yield* attempt(error(member.name, `Duplicate member: ${name.name}.${member.name.name}`));
              continue;
            }
            members.push(member);
          }
          type = members.every(({ fields }) => fields === undefined)
            ? yield* enumeration({ id, key, uri, name }, members)
            : yield* tagged(scope, { id, key, uri, name }, members);
          break;
        }
        case "record": {
          const fields = yield* collect(scope, name, asEntries(declaration.fields), "property");
          type = { kind: "record", id, key, uri, name, fields };
          break;
        }
      }
      yield* facts.define(
        { id, name: name.name, type: showTypeDecl(type) },
        name.span,
        definitionKind[type.kind],
      );
      types.push(type);
    }
    return types;
  });

/** Named types in written order, for hover: a type name shows its definition. */
export const typeNames = (type: TypeExpr): readonly Name[] =>
  type.kind === "named" ? [type.name] : typeNames(type.kind === "list" ? type.element : type.inner);

/** The fields a value of this type carries, across every variant. */
export const fieldsOf = (type: TypeDecl): readonly Field[] => {
  switch (type.kind) {
    case "brand":
    case "enum":
      return [];
    case "tagged":
      return type.variants.flatMap(({ fields }) => fields);
    case "record":
      return type.fields;
  }
};

/** Every declaration `roots` mention, transitively, in discovery order: the runtime's decode tables. */
export const closure = (universe: Universe, roots: readonly DataType[]): readonly TypeDecl[] => {
  const found = new Map<TypeKey, TypeDecl>();
  const visit = (type: DataType): void => {
    switch (type.kind) {
      case "scalar":
        return;
      case "named": {
        if (found.has(type.key)) return;
        const declaration = universe.get(type.key)!;
        found.set(type.key, declaration);
        for (const field of fieldsOf(declaration)) visit(field.type);
        return;
      }
      case "list":
        return visit(type.element);
      case "optional":
        return visit(type.inner);
    }
  };
  for (const root of roots) visit(root);
  return [...found.values()];
};
