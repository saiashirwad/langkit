import { type HostLanguage, type Piece, specifier, unhosted, verbatim } from "langkit/host";
import { type Binding, binding, call, data, type Json, type Module as Program, ref } from "langkit/ir";
import { emitModule } from "langkit/javascript";
import {
  type DataType,
  type Field,
  type Machine,
  type Module,
  scalars,
  type State,
  type Transition,
  type TypeDecl,
} from "./domain-model.ts";
import { checkSource } from "./domain.ts";
import type { CompiledMachine, Fields, Named, Shape, Types } from "./runtime.ts";
import { closure } from "./types.ts";

const runtime = new URL("./runtime.ts", import.meta.url).href;

/** `readonly LineItem[]`, `string | null`. Declared types print as their exported names. */
const ts = (type: DataType): string => {
  switch (type.kind) {
    case "scalar":
      return scalars[type.name].ts;
    case "named":
      return type.name;
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

/** `$` cannot appear in a guest name, so the brand's symbol never collides with one. */
const typeOnly = (type: TypeDecl): readonly Piece[] => {
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
          verbatim(member.name, member.span),
          "\"",
        ]),
        ";\n",
      ];
    case "record":
      return [
        "export interface ",
        verbatim(type.name.name, type.name.span),
        " {\n",
        ...type.fields.flatMap(({ name, type }): readonly Piece[] => [
          "  readonly ",
          verbatim(name.name, name.span),
          `: ${ts(type)};\n`,
        ]),
        "}\n",
      ];
  }
};

/** Every named type is also a value of the same name, the boundary parser for that type. */
const typeDecl = (type: TypeDecl): readonly Piece[] => [
  ...typeOnly(type),
  `export declare const ${type.name.name}: {\n`,
  `  /** Parses a ${type.name.name} from JSON. Throws a TypeError naming the first bad path. */\n`,
  `  parse(input: unknown): ${type.name.name};\n`,
  "};\n",
];

/** `{ readonly paymentId: string; readonly paidAt: string; }`, each name verbatim at its declaration. */
const object = (fields: readonly Field[]): readonly Piece[] => [
  "{ ",
  ...fields.flatMap(({ name, type }): readonly Piece[] => [
    "readonly ",
    verbatim(name.name, name.span),
    `: ${ts(type)}; `,
  ]),
  "}",
];

/**
 * `ship(event: {...}): Shipped`, named at its `on ship` clause so go-to-definition from `paid.ship(...)` lands on
 * the line that allows it. A payload-free event projects as `deliver(): Delivered`.
 */
const method = (states: readonly State[], { clause, event, from, to }: Transition): readonly Piece[] => [
  `    /** ${states[from]!.name.name} |> on ${event.name.name} -> ${states[to]!.name.name} */\n`,
  "    ",
  verbatim(clause.event.name, clause.event.span),
  "(",
  ...(event.payload.length ? ["event: ", ...object(event.payload)] : []),
  `): ${states[to]!.name.name};\n`,
];

const state = (states: readonly State[], { name, data, on }: State): readonly Piece[] => [
  "  interface ",
  verbatim(name.name, name.span),
  " {\n    readonly state: \"",
  verbatim(name.name, name.span),
  "\";\n",
  ...data.flatMap(({ name, type }): readonly Piece[] => [
    "    readonly ",
    verbatim(name.name, name.span),
    `: ${ts(type)};\n`,
  ]),
  ...on.flatMap((transition) => method(states, transition)),
  "  }\n",
];

/** One identifier carries the union type, the state namespace and the value. `Final` is `never` without finals. */
const machine = ({ name, states, initial }: Machine): readonly Piece[] => {
  const finals = states.filter(({ final }) => final).map((value) => value.name.name);
  const start = states[initial]!;
  return [
    "export type ",
    verbatim(name.name, name.span),
    ` =\n${states.map((value) => `  | ${name.name}.${value.name.name}`).join("\n")};\n`,
    `export declare namespace ${name.name} {\n`,
    `  type Final = ${finals.join(" | ") || "never"};\n`,
    ...states.flatMap((value) => state(states, value)),
    "}\n",
    `export declare const ${name.name}: {\n`,
    `  /** Starts a new ${name.name} in its initial state, ${start.name.name}. */\n`,
    "  start(",
    ...(start.data.length ? ["data: ", ...object(start.data)] : []),
    `): ${name.name}.${start.name.name};\n`,
    `  /** Parses a stored snapshot, the JSON of any ${name.name} value. Throws a TypeError naming the first bad path. */\n`,
    `  parse(snapshot: unknown): ${name.name};\n`,
    "};\n",
  ];
};

export const declarations = (module: Module): readonly Piece[] => [
  ...module.types.flatMap(typeDecl),
  ...module.machines.flatMap(machine),
];

/**
 * The runtime tables, closed over every type the module decodes, own or imported, so a module's JavaScript
 * imports only runtime.ts. Local keys are the type names, suffixed `#2`, `#3` when two closed-over types share one.
 */
export const compiled = (module: Module): {
  readonly types: Types;
  /** The local key of each of the module's own types, in written order. */
  readonly own: readonly string[];
  readonly machines: readonly CompiledMachine[];
} => {
  const roots = [
    ...module.types.map((type): DataType => ({ kind: "named", key: type.key, name: type.name.name })),
    ...module.machines.flatMap(({ events, states }) =>
      [...events.flatMap(({ payload }) => payload), ...states.flatMap(({ data }) => data)].map(({ type }) => type)
    ),
  ];
  const reached = closure(module.universe, roots);
  const local = new Map<string, string>();
  const taken = new Set<string>();
  for (const { key, name } of reached) {
    let candidate = name.name;
    for (let n = 2; taken.has(candidate); n++) candidate = `${name.name}#${n}`;
    taken.add(candidate);
    local.set(key, candidate);
  }
  const shape = (type: DataType): Shape => {
    switch (type.kind) {
      case "scalar":
        return { kind: type.name };
      case "named":
        return { kind: "named", key: local.get(type.key)! };
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
        return { kind: "enum", name: type.name.name, members: type.members.map((member) => member.name) };
      case "record":
        return { kind: "record", name: type.name.name, fields: fields(type.fields) };
    }
  };
  return {
    own: module.types.map(({ key }) => local.get(key)!),
    types: Object.fromEntries(reached.map((type) => [
      local.get(type.key)!,
      named(type),
    ])),
    machines: module.machines.map(({ name, initial, events, states }) => ({
      name: name.name,
      initial: states[initial]!.name.name,
      events: Object.fromEntries(events.map((event) => [event.name.name, fields(event.payload)])),
      states: states.map(({ name, data, on }) => ({
        name: name.name,
        data: fields(data),
        on: on.map(({ event, to, fill }) => ({
          event: event.name.name,
          to: states[to]!.name.name,
          fill: fill.map(({ field, source }) => [field.name.name, source.kind]),
        })),
      })),
    })),
  };
};

/**
 * `import { machine, named } from "./runtime.ts"; const types = {...};` then one export per declaration:
 * `const LineItem = named(types)("LineItem"); const Order = machine(types)({...});`.
 */
export const program = (uri: string, module: Module): Program<undefined> => {
  const local = (name: string) => binding(name, undefined);
  const runtimeNamed = local("named");
  const runtimeMachine = local("machine");
  const types = local("types");
  const tables = compiled(module);
  const over = (definer: Binding<undefined>, table: Json) =>
    call(undefined, call(undefined, ref(definer), ref(types)), data(undefined, table));
  const exported = [
    ...module.types.map(({ name }, index) => [name.name, over(runtimeNamed, tables.own[index]!)] as const),
    ...tables.machines.map((table) => [table.name, over(runtimeMachine, table)] as const),
  ].map(([name, value]) => ({ name, binding: local(name), value }));
  return {
    imports: [{ from: specifier(uri, runtime), names: [["named", runtimeNamed], ["machine", runtimeMachine]] }],
    body: {
      declarations: [
        { binding: types, value: data(undefined, tables.types) },
        ...exported.map(({ binding, value }) => ({ binding, value })),
      ],
      result: data(undefined, null),
    },
    exports: exported.map(({ name, binding }) => [name, binding] as const),
  };
};

/** The compile path only; no host-only diagnostics, since representability is a language rule. */
export const host: HostLanguage = {
  extension: ".domain",
  host: (source, uri) => {
    const checked = checkSource(source, { uri });
    if (!checked.success) return unhosted(checked.errors);
    return {
      declarations: declarations(checked.value),
      javascript: () => emitModule(program(uri, checked.value)),
      diagnostics: [],
    };
  },
};
