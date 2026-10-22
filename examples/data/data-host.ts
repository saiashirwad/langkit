import { type Piece, verbatim } from "langkit/host";
import {
  closure,
  type DataType,
  type Field,
  scalars,
  type TypeDecl,
  type TypeKey,
  type Universe,
} from "./data-model.ts";
import type { Fields, Named, Shape, Types } from "./decode.ts";

/** A declared type as a projection names it. */
export type Declared = { readonly key: TypeKey; readonly name: string; };

/** One file's projection: where it is, how it prints a type, and the local name of anything declared elsewhere. */
export type Printer = {
  readonly uri: string;
  readonly ts: (type: DataType) => string;
  readonly local: (declared: Declared) => string;
};

/** `readonly LineItem[]`, `string | null`. A declared type prints as its local name in this projection. */
export const printer = (uri: string, locals: ReadonlyMap<TypeKey, string>): Printer => {
  const local = ({ key, name }: Declared) => locals.get(key) ?? name;
  const ts = (type: DataType): string => {
    switch (type.kind) {
      case "scalar":
        return scalars[type.name].ts;
      case "named":
        return local(type);
      case "list": {
        const element = ts(type.element);
        return `readonly ${
          type.element.kind === "list" || type.element.kind === "optional" ? `(${element})` : element
        }[]`;
      }
      case "optional":
        return `${ts(type.inner)} | null`;
    }
  };
  return { uri, ts, local };
};

/** A field spread in from another file has no span here, so its name projects as plain text. */
export const fieldName = ({ uri }: Printer, field: Field): Piece =>
  field.uri === uri ? verbatim(field.name.name, field.name.span) : field.name.name;

/** `$` cannot appear in a guest name, so the brand's symbol never collides with one. */
const typeOnly = (printer: Printer, type: TypeDecl): readonly Piece[] => {
  switch (type.kind) {
    case "brand":
      return [
        `declare const ${type.name.name}$: unique symbol;\n`,
        `/** brand ${type.name.name} = ${type.underlying} */\n`,
        "export type ",
        verbatim(type.name.name, type.name.span),
        ` = ${scalars[type.underlying].ts} & { readonly [${type.name.name}$]: true; };\n`,
      ];
    case "enum":
      return [
        "export type ",
        verbatim(type.name.name, type.name.span),
        " = ",
        ...type.members.flatMap((member, index): readonly Piece[] => [
          index ? " | " : "",
          "\"",
          verbatim(member.name.name, member.name.span),
          "\"",
        ]),
        ";\n",
      ];
    case "tagged":
      return [
        "export type ",
        verbatim(type.name.name, type.name.span),
        ` = ${type.variants.map((variant) => `${type.name.name}.${variant.name.name}`).join(" | ")};\n`,
        `export declare namespace ${type.name.name} {\n`,
        ...type.variants.flatMap(({ name, fields }): readonly Piece[] => [
          "  interface ",
          verbatim(name.name, name.span),
          " {\n    readonly tag: \"",
          verbatim(name.name, name.span),
          "\";\n",
          ...fields.flatMap(({ name, type }): readonly Piece[] => [
            "    readonly ",
            verbatim(name.name, name.span),
            `: ${printer.ts(type)};\n`,
          ]),
          "  }\n",
        ]),
        "}\n",
      ];
    case "record":
      return [
        "export interface ",
        verbatim(type.name.name, type.name.span),
        " {\n",
        ...type.fields.flatMap(({ name, type }): readonly Piece[] => [
          "  readonly ",
          verbatim(name.name, name.span),
          `: ${printer.ts(type)};\n`,
        ]),
        "}\n",
      ];
  }
};

/** Every named type is also a value of the same name, the boundary parser for that type. */
export const typeDecl = (printer: Printer, type: TypeDecl): readonly Piece[] => [
  ...typeOnly(printer, type),
  `export declare const ${type.name.name}: {\n`,
  `  /** Parses a ${type.name.name} from JSON. Throws a TypeError naming the first bad path. */\n`,
  `  parse(input: unknown): ${type.name.name};\n`,
  "};\n",
];

export const namedIn = (type: DataType): readonly Extract<DataType, { readonly kind: "named"; }>[] => {
  switch (type.kind) {
    case "scalar":
      return [];
    case "named":
      return [type];
    case "list":
      return namedIn(type.element);
    case "optional":
      return namedIn(type.inner);
  }
};

/** The decode tables over every declaration `roots` reach, and how a module's tables name what they decode. */
export type Tables = {
  readonly types: Types;
  /** A declaration's key in `types`: its name, suffixed `#2`, `#3` when two reached types share one. */
  readonly local: (key: TypeKey) => string;
  readonly shape: (type: DataType) => Shape;
  readonly fields: (fields: readonly Field[]) => Fields;
};

export const tables = (universe: Universe, roots: readonly DataType[]): Tables => {
  const reached = closure(universe, roots);
  const locals = new Map<TypeKey, string>();
  const taken = new Set<string>();
  for (const { key, name } of reached) {
    let candidate = name.name;
    for (let n = 2; taken.has(candidate); n++) candidate = `${name.name}#${n}`;
    taken.add(candidate);
    locals.set(key, candidate);
  }
  const local = (key: TypeKey) => locals.get(key)!;
  const shape = (type: DataType): Shape => {
    switch (type.kind) {
      case "scalar":
        return { kind: type.name };
      case "named":
        return { kind: "named", key: local(type.key) };
      case "list":
        return { kind: "list", element: shape(type.element) };
      case "optional":
        return { kind: "optional", inner: shape(type.inner) };
    }
  };
  const fields = (list: readonly Field[]): Fields => list.map(({ name, type }) => [name.name, shape(type)]);
  const named = (type: TypeDecl): Named => {
    switch (type.kind) {
      case "brand":
        return { kind: "brand", name: type.name.name, scalar: type.underlying };
      case "enum":
        return { kind: "enum", name: type.name.name, members: type.members.map(({ name }) => name.name) };
      case "tagged":
        return {
          kind: "tagged",
          name: type.name.name,
          variants: type.variants.map((variant) => [variant.name.name, fields(variant.fields)]),
        };
      case "record":
        return { kind: "record", name: type.name.name, fields: fields(type.fields) };
    }
  };
  return { types: Object.fromEntries(reached.map((type) => [local(type.key), named(type)])), local, shape, fields };
};
