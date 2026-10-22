import type { Span } from "langkit";

export type Name = { readonly name: string; readonly span: Span; };

export type Scalar = "String" | "Int" | "Float" | "Bool";

declare const typeKeyBrand: unique symbol;
/**
 * `file:///…/commerce.domain#Address`. Names repeat across files, so identity is the declaring file plus the
 * name; v1 compared printed names, which stops being sound once two files may both say `Address`.
 */
export type TypeKey = string & { readonly [typeKeyBrand]: true; };

export const typeKey = (uri: string, name: string): TypeKey => `${uri}#${name}` as TypeKey;

export type DataType =
  | { readonly kind: "scalar"; readonly name: Scalar; }
  /** A declared type, by key so a record may contain itself through a list. `name` is for printing. */
  | { readonly kind: "named"; readonly key: TypeKey; readonly name: string; }
  /** `[Step; ..3]`; `[Step]` has an infinite `max`, so no reader can forget a list may be bounded. */
  | { readonly kind: "list"; readonly element: DataType; readonly max: number; }
  | { readonly kind: "optional"; readonly inner: Present; };

/** `String??` would project to `string | null | null`, so an optional never wraps an optional. */
export type Present = Exclude<DataType, { readonly kind: "optional"; }>;

/**
 * One binder: record fields, state data, and event payload all use it. `id` is its LSP identity, and `uri` the
 * file it is written in, which a spread can carry into another file's states.
 */
export type Field = { readonly id: symbol; readonly uri: string; readonly name: Name; readonly type: DataType; };

type Declared = { readonly id: symbol; readonly key: TypeKey; readonly uri: string; readonly name: Name; };

/**
 * `brand OrderId = String`. Nominal over a scalar: a String does not fill an OrderId field, and an OrderId does
 * not fill a PaymentId one. At run time it is the scalar.
 */
export type Brand = Declared & { readonly kind: "brand"; readonly underlying: Scalar; };

/** `id` is the member's LSP identity, which a reactor pattern like `Half` references. */
export type EnumMember = { readonly id: symbol; readonly name: Name; };

export type Enum = Declared & { readonly kind: "enum"; readonly members: readonly EnumMember[]; };

export type Variant = { readonly id: symbol; readonly name: Name; readonly fields: readonly Field[]; };

/** A union with any payload member. Projected as a `{ tag }` union; a bare member is a variant with no fields. */
export type Tagged = Declared & { readonly kind: "tagged"; readonly variants: readonly Variant[]; };

export type Record = Declared & { readonly kind: "record"; readonly fields: readonly Field[]; };

export type TypeDecl = Brand | Enum | Tagged | Record;

/** Every type a module can mention, its own and every import's, transitively. */
export type Universe = ReadonlyMap<TypeKey, TypeDecl>;

export const scalars: Readonly<{ [K in Scalar]: { readonly ts: string; }; }> = {
  String: { ts: "string" },
  Int: { ts: "number" },
  Float: { ts: "number" },
  Bool: { ts: "boolean" },
};

export const isScalar = (name: string): name is Scalar => Object.hasOwn(scalars, name);

/** Guest syntax, for hover and messages: `[LineItem]`, `String?`, `[Step; ..3]`. */
export const showType = (type: DataType): string => {
  switch (type.kind) {
    case "scalar":
    case "named":
      return type.name;
    case "list":
      return `[${showType(type.element)}${type.max === Infinity ? "" : `; ..${type.max}`}]`;
    case "optional":
      return `${showType(type.inner)}?`;
  }
};

/** How a variant writes its payload: `Card { last4 : String }` or `Loop(clip : Clip)`. */
export type VariantStyle = "braces" | "parens";

export const showFields = (fields: readonly Field[]): string =>
  fields.map(({ name, type }) => `${name.name} : ${showType(type)}`).join(", ");

export const showTypeDecl = (type: TypeDecl, style: VariantStyle): string => {
  const payload = (fields: readonly Field[]) =>
    style === "braces" ? ` { ${showFields(fields)} }` : `(${showFields(fields)})`;
  switch (type.kind) {
    case "brand":
      return `brand ${type.name.name} = ${type.underlying}`;
    case "enum":
      return `type ${type.name.name} = ${type.members.map(({ name }) => name.name).join(" | ")}`;
    case "tagged":
      return `type ${type.name.name} = ${
        type.variants.map(({ name, fields }) => fields.length ? `${name.name}${payload(fields)}` : name.name)
          .join(" | ")
      }`;
    case "record":
      return `type ${type.name.name} = { ${showFields(type.fields)} }`;
  }
};

export const same = (a: DataType, b: DataType): boolean => {
  switch (a.kind) {
    case "scalar":
      return b.kind === "scalar" && a.name === b.name;
    case "named":
      return b.kind === "named" && a.key === b.key;
    case "list":
      return b.kind === "list" && a.max === b.max && same(a.element, b.element);
    case "optional":
      return b.kind === "optional" && same(a.inner, b.inner);
  }
};

/**
 * Target accepts a value of source type: equal; `T` or `T?` into `T?`; `[T; ..n]` into `[T; ..m]` when n <= m.
 * Lists are invariant in their element.
 */
export const assignable = (from: DataType, to: DataType): boolean => {
  if (to.kind === "optional") return assignable(from.kind === "optional" ? from.inner : from, to.inner);
  if (from.kind === "list" && to.kind === "list") return from.max <= to.max && same(from.element, to.element);
  return same(from, to);
};

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
