import type { Scalar } from "./data-model.ts";

export type Shape =
  | { readonly kind: Scalar; }
  /** A key into the module's `Types`. */
  | { readonly kind: "named"; readonly key: string; }
  | { readonly kind: "list"; readonly element: Shape; }
  | { readonly kind: "optional"; readonly inner: Shape; };

export type Fields = readonly (readonly [name: string, shape: Shape])[];

export type Named =
  & { readonly name: string; }
  & (
    | { readonly kind: "brand"; readonly scalar: Scalar; }
    | { readonly kind: "enum"; readonly members: readonly string[]; }
    /** `{ tag: "Card", last4: "4242" }`: the tag picks the variant, then its fields decode as a record's do. */
    | { readonly kind: "tagged"; readonly variants: readonly (readonly [tag: string, fields: Fields])[]; }
    | { readonly kind: "record"; readonly fields: Fields; }
  );

export type Types = Readonly<Record<string, Named>>;

export type Data = Readonly<Record<string, unknown>>;

export const isObject = (input: unknown): input is Data =>
  typeof input === "object" && input !== null && !Array.isArray(input);

export const found = (input: unknown): string =>
  input === undefined
    ? "nothing"
    : Array.isArray(input)
    ? "an array"
    : typeof input === "object" && input !== null
    ? "an object"
    : typeof input === "string"
    ? JSON.stringify(input)
    : String(input);

export const describe = (types: Types, shape: Shape): string => {
  switch (shape.kind) {
    case "named": {
      const named = types[shape.key]!;
      return named.kind === "enum" ? named.members.map((member) => JSON.stringify(member)).join(" | ") : named.name;
    }
    case "list":
      return `[${describe(types, shape.element)}]`;
    case "optional":
      return `${describe(types, shape.inner)}?`;
    default:
      return shape.kind;
  }
};

const reject = (types: Types, shape: Shape, input: unknown, path: string): never => {
  throw new TypeError(`${path}: expected ${describe(types, shape)}, found ${found(input)}`);
};

/**
 * Validates `input` against `shape` and returns a deeply frozen copy. Throws a TypeError naming the path:
 * `snapshot.items[0].quantity: expected Int, found "3"`. An optional accepts null or a missing key.
 * Int is a safe integer; Float is any finite number.
 */
export const decode = (types: Types, shape: Shape, input: unknown, path: string): unknown => {
  switch (shape.kind) {
    case "String":
      return typeof input === "string" ? input : reject(types, shape, input, path);
    case "Int":
      return Number.isSafeInteger(input) ? input : reject(types, shape, input, path);
    case "Float":
      return typeof input === "number" && Number.isFinite(input) ? input : reject(types, shape, input, path);
    case "Bool":
      return typeof input === "boolean" ? input : reject(types, shape, input, path);
    case "named": {
      const named = types[shape.key]!;
      switch (named.kind) {
        case "brand":
          return decode(types, { kind: named.scalar }, input, path);
        case "enum":
          return typeof input === "string" && named.members.includes(input) ? input : reject(types, shape, input, path);
        case "tagged": {
          if (!isObject(input)) return reject(types, shape, input, path);
          const { tag, ...rest } = input;
          const variant = named.variants.find(([name]) => name === tag);
          if (!variant) {
            const tags = named.variants.map(([name]) => JSON.stringify(name)).join(" | ");
            throw new TypeError(`${path}.tag: expected ${tags}, found ${found(tag)}`);
          }
          return Object.freeze({ tag: variant[0], ...decodeFields(types, variant[1], rest, path) });
        }
        case "record":
          return isObject(input) ? decodeFields(types, named.fields, input, path) : reject(types, shape, input, path);
      }
    }
    case "list":
      return Array.isArray(input)
        ? Object.freeze(input.map((item, index) => decode(types, shape.element, item, `${path}[${index}]`)))
        : reject(types, shape, input, path);
    case "optional":
      return input === null || input === undefined ? null : decode(types, shape.inner, input, path);
  }
};

/** Exactly these keys (missing allowed for optionals, extras rejected), each decoded. */
export const decodeFields = (types: Types, fields: Fields, input: unknown, path: string): Data => {
  if (!isObject(input)) {
    throw new TypeError(`${path}: expected an object, found ${found(input)}`);
  }
  for (const key of Object.keys(input)) {
    if (!fields.some(([name]) => name === key)) throw new TypeError(`${path}: unexpected field ${key}`);
  }
  return Object.freeze(Object.fromEntries(
    fields.map(([name, shape]) => [
      name,
      decode(types, shape, Object.hasOwn(input, name) ? input[name] : undefined, `${path}.${name}`),
    ]),
  ));
};

/** `LineItem.parse(json)`, for request bodies: `LineItem.quantity: expected Int, found "3"`. */
export const named = (types: Types) => (key: string): { readonly parse: (input: unknown) => unknown; } => ({
  parse: (input) => decode(types, { kind: "named", key }, input, types[key]!.name),
});
