// The interpreter the emitted module calls. It knows nothing of the guest syntax.
//
// Invariants:
// 1. Every live value conforms to its state's data. Values come only from start, a transition, or parse, and each
//    decodes its input against a Shape, so JS callers that skip the types still cannot build a bad value.
// 2. Values are deeply frozen. A transition returns a new value and never touches the old one, so a stale value
//    stays valid (and typed) forever. Firing the same event on the same value twice gives equal results.
// 3. `JSON.stringify(value)` is the snapshot: `state` then the data fields, in declared order. Event methods live
//    on one frozen prototype per state, so they never serialize. `parse(JSON.parse(JSON.stringify(v)))` deep-equals v.
// 4. The table is the whole program: a transition reads `fill` and copies. No lookup by guest name at run time
//    other than the record table, no guards, no effects.

export type Shape =
  | { readonly kind: "String" | "Int" | "Float" | "Bool"; }
  | { readonly kind: "enum"; readonly members: readonly string[]; }
  | { readonly kind: "record"; readonly name: string; }
  | { readonly kind: "list"; readonly element: Shape; }
  | { readonly kind: "optional"; readonly inner: Shape; };

export type Fields = readonly (readonly [name: string, shape: Shape])[];

/** The decided data flow for one target field; mirrors machine-model's Source. */
export type Fill = readonly [field: string, source: "payload" | "carry" | "null"];

export type Edge = { readonly event: string; readonly to: string; readonly fill: readonly Fill[]; };

export type CompiledState = { readonly name: string; readonly data: Fields; readonly on: readonly Edge[]; };

/** The JSON the host embeds with `data(...)`. Built from the IR by machine-host's `compiled`. */
export type Compiled = {
  readonly name: string;
  readonly initial: string;
  readonly records: Readonly<Record<string, Fields>>;
  readonly events: Readonly<Record<string, Fields>>;
  readonly states: readonly CompiledState[];
};

export type Value = { readonly state: string; readonly [field: string]: unknown; };

export type Machine = {
  readonly start: (data?: unknown) => Value;
  readonly parse: (snapshot: unknown) => Value;
};

type Data = Readonly<Record<string, unknown>>;

const isObject = (input: unknown): input is Data =>
  typeof input === "object" && input !== null && !Array.isArray(input);

const found = (input: unknown): string =>
  input === undefined
    ? "nothing"
    : Array.isArray(input)
    ? "an array"
    : typeof input === "object" && input !== null
    ? "an object"
    : typeof input === "string"
    ? JSON.stringify(input)
    : String(input);

const describe = (shape: Shape): string => {
  switch (shape.kind) {
    case "enum":
      return shape.members.map((member) => JSON.stringify(member)).join(" | ");
    case "record":
      return shape.name;
    case "list":
      return `[${describe(shape.element)}]`;
    case "optional":
      return `${describe(shape.inner)}?`;
    default:
      return shape.kind;
  }
};

const reject = (shape: Shape, input: unknown, path: string): never => {
  throw new TypeError(`${path}: expected ${describe(shape)}, found ${found(input)}`);
};

/**
 * Validates `input` against `shape` and returns a deeply frozen copy. Throws a TypeError naming the path:
 * `snapshot.items[0].quantity: expected Int, found "3"`. An optional accepts null or a missing key.
 * Int is a safe integer; Float is any finite number.
 */
const decode = (compiled: Compiled, shape: Shape, input: unknown, path: string): unknown => {
  switch (shape.kind) {
    case "String":
      return typeof input === "string" ? input : reject(shape, input, path);
    case "Int":
      return Number.isSafeInteger(input) ? input : reject(shape, input, path);
    case "Float":
      return typeof input === "number" && Number.isFinite(input) ? input : reject(shape, input, path);
    case "Bool":
      return typeof input === "boolean" ? input : reject(shape, input, path);
    case "enum":
      return typeof input === "string" && shape.members.includes(input) ? input : reject(shape, input, path);
    case "record":
      return isObject(input)
        ? decodeFields(compiled, compiled.records[shape.name]!, input, path)
        : reject(shape, input, path);
    case "list":
      return Array.isArray(input)
        ? Object.freeze(input.map((item, index) => decode(compiled, shape.element, item, `${path}[${index}]`)))
        : reject(shape, input, path);
    case "optional":
      return input === null || input === undefined ? null : decode(compiled, shape.inner, input, path);
  }
};

/** Exactly these keys (missing allowed for optionals, extras rejected), each decoded. */
const decodeFields = (compiled: Compiled, fields: Fields, input: unknown, path: string): Data => {
  if (!isObject(input)) {
    throw new TypeError(`${path}: expected an object, found ${found(input)}`);
  }
  for (const key of Object.keys(input)) {
    if (!fields.some(([name]) => name === key)) throw new TypeError(`${path}: unexpected field ${key}`);
  }
  return Object.freeze(Object.fromEntries(
    fields.map(([name, shape]) => [
      name,
      decode(compiled, shape, Object.hasOwn(input, name) ? input[name] : undefined, `${path}.${name}`),
    ]),
  ));
};

/**
 * Builds one frozen prototype per state up front. Each edge becomes a method that decodes its payload, then
 * copies each target field from where `fill` says. Methods read `this`, so a detached `const { pay } = checkout`
 * throws; the projection declares them as methods.
 */
export const define = (compiled: Compiled): Machine => {
  const prototypes = new Map<string, object>();
  const make = (state: string, data: Data): Value =>
    Object.freeze(Object.assign(Object.create(prototypes.get(state)!), { state }, data));
  for (const { name, on } of compiled.states) {
    const methods = on.map(({ event, to, fill }) => {
      const method = function(this: Value, payload: unknown = {}): Value {
        const given = decodeFields(compiled, compiled.events[event]!, payload, `${compiled.name}.${name}.${event}`);
        return make(
          to,
          Object.fromEntries(fill.map(([field, source]) => [
            field,
            source === "payload" ? given[field] : source === "carry" ? this[field] : null,
          ])),
        );
      };
      return [event, method] as const;
    });
    prototypes.set(name, Object.freeze(Object.fromEntries(methods)));
  }
  const states = new Map(compiled.states.map((state) => [state.name, state]));
  return {
    start: (data = {}) =>
      make(
        compiled.initial,
        decodeFields(compiled, states.get(compiled.initial)!.data, data, `${compiled.name}.start`),
      ),
    parse: (snapshot) => {
      if (!isObject(snapshot)) throw new TypeError(`snapshot: expected an object, found ${found(snapshot)}`);
      const { state, ...rest } = snapshot;
      const target = typeof state === "string" ? states.get(state) : undefined;
      if (!target) {
        const members = compiled.states.map(({ name }) => JSON.stringify(name)).join(" | ");
        throw new TypeError(`snapshot.state: expected ${members}, found ${found(state)}`);
      }
      return make(target.name, decodeFields(compiled, target.data, rest, "snapshot"));
    },
  };
};
