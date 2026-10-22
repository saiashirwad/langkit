import { type Check, check, fail, pure, type Span } from "langkit";
import { create } from "langkit/analysis";
import {
  type DataType,
  type Enum,
  type EnumMember,
  type Field,
  isScalar,
  type Name,
  scalars,
  showType,
  showTypeDecl,
  type Tagged,
  type TypeDecl,
  type TypeKey,
  type Universe,
  type Variant,
  type VariantStyle,
} from "./data-model.ts";

/** `String`, `[LineItem]`, `[Step; ..3]`, `Address?`. A name resolves to a scalar or a declared type. */
export type TypeExpr =
  & { readonly span: Span; }
  & (
    | { readonly kind: "named"; readonly name: Name; }
    /** `max` keeps where the bound was written, so `..0` is reported at the digits. */
    | {
      readonly kind: "list";
      readonly element: TypeExpr;
      readonly max: { readonly value: number; readonly span: Span; } | undefined;
    }
    | { readonly kind: "optional"; readonly inner: TypeExpr; }
  );

export type FieldExpr = { readonly name: Name; readonly type: TypeExpr; };

/** A field, or `...Placed` splicing a record's fields in place. */
export type Entry =
  | { readonly kind: "field"; readonly field: FieldExpr; }
  | { readonly kind: "spread"; readonly record: Name; };

/** A union member; `fields` is undefined when it is written bare. */
export type Member = { readonly name: Name; readonly fields: readonly FieldExpr[] | undefined; };

export type TypeDeclaration =
  /** `brand OrderId = String`; `underlying` must name a scalar, which the checker decides. */
  | { readonly kind: "brand"; readonly name: Name; readonly underlying: Name; }
  /** `Post | Courier`, or with payloads, `Card { last4 : String } | Transfer { reference : String }`. */
  | { readonly kind: "union"; readonly name: Name; readonly members: readonly Member[]; }
  | { readonly kind: "record"; readonly name: Name; readonly fields: readonly FieldExpr[]; };

/** Hover text. Guest syntax, as in v1. */
export type Type = string;

export const show = (type: Type): string => type;

/** The one facts sink every elaborator writes to. */
export const facts = create<Type>();

/** A top-level name, bound before anything it names is elaborated, so declaration order never matters. */
export type Binder<K extends string = string> = {
  readonly kind: "type" | K;
  readonly id: symbol;
  readonly key: TypeKey;
  readonly uri: string;
  readonly name: Name;
};

/** Names TypeScript or the runtime value cannot carry. Checked here, not in the host, so the guest LSP shows them. */
export type Reserved = { readonly type: ReadonlySet<string>; readonly field: ReadonlySet<string>; };

export type Dialect = { readonly reserved: Reserved; readonly variants: VariantStyle; };

/**
 * What a file's declarations can name: its own top-level declarations, in one namespace, and every type
 * elaborated so far. A state name may not repeat a type's name, because inside the projected
 * `namespace Order` it would shadow the type.
 */
export type Scope<K extends string = string> = {
  readonly uri: string;
  readonly top: ReadonlyMap<string, Binder<K>>;
  readonly universe: Universe;
  readonly dialect: Dialect;
};

export const error = (at: { readonly span: Span; }, message: string): Check<never> => fail(message).at(at.span);

export const attempt = <A>(body: Check<A>): Check<A | undefined> => body.recover(pure(undefined));

/** `__proto__` would reset the value's prototype in Object.assign. */
export const typescript: Reserved = {
  type: new Set([
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
  ]),
  field: new Set(["__proto__"]),
};

/** What each declaration becomes in TypeScript, for semantic tokens. */
export const definitionKind = { brand: "type", enum: "enum", tagged: "enum", record: "interface" } as const;

export const article = (kind: string): string => {
  switch (kind) {
    case "tagged":
      return "a tagged union";
    default:
      return `${/^[aeiou]/.test(kind) ? "an" : "a"} ${kind}`;
  }
};

/** A top-level name may not be a reserved type name, a scalar, or a repeat. */
export const claim = (scope: Pick<Scope, "top" | "dialect">, name: Name): Check<void> =>
  check(function*() {
    if (scope.dialect.reserved.type.has(name.name)) {
      yield* attempt(error(name, `TypeScript cannot represent ${name.name}, a reserved type name`));
    }
    if (scope.top.has(name.name) || Object.hasOwn(scalars, name.name)) {
      return yield* error(name, `Duplicate declaration: ${name.name}`);
    }
  });

/** `Missing` -> `Unknown type: Missing`; `String??` -> `A type is optional at most once`. References the name. */
export const resolveType = (scope: Scope, type: TypeExpr): Check<DataType> =>
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
      case "list": {
        const element = yield* resolveType(scope, type.element);
        if (type.max === undefined) return { kind: "list", element, max: Infinity };
        if (type.max.value < 1) return yield* error(type.max, "A bounded list holds at least one element");
        return { kind: "list", element, max: type.max.value };
      }
      case "optional": {
        const inner = yield* resolveType(scope, type.inner);
        if (inner.kind === "optional") return yield* error(type, "A type is optional at most once");
        return { kind: "optional", inner };
      }
    }
  });

export const asEntries = (fields: readonly FieldExpr[]): readonly Entry[] =>
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
        if (scope.dialect.reserved.field.has(name.name)) {
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
    const enumMembers: EnumMember[] = [];
    for (const { name } of members) {
      const member: EnumMember = { id: Symbol(name.name), name };
      yield* facts.define({ id: member.id, name: name.name, type: declared.name.name }, name.span, "enumMember");
      enumMembers.push(member);
    }
    return { kind: "enum", ...declared, members: enumMembers };
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
      if (scope.dialect.reserved.type.has(name.name)) {
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
        { id, name: name.name, type: showTypeDecl(type, scope.dialect.variants) },
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
