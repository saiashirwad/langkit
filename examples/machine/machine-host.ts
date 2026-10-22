import { type HostLanguage, type Piece, specifier, unhosted, verbatim } from "langkit/host";
import { binding, call, data, type Module, ref } from "langkit/ir";
import { emitModule } from "langkit/javascript";
import {
  type DataType,
  type Enum,
  type Field,
  type Machine,
  type Record as Shape,
  scalars,
  type State,
  type Transition,
} from "./machine-model.ts";
import { checkSource } from "./machine.ts";
import type { Compiled, Fields, Shape as Wire } from "./runtime.ts";

const runtime = new URL("./runtime.ts", import.meta.url).href;

/** The runtime table. Fills come straight from Transition.fill; nothing is re-derived. */
export const compiled = (machine: Machine): Compiled => {
  const members = new Map(machine.enums.map(({ name, members }) => [name.name, members.map((member) => member.name)]));
  const wire = (type: DataType): Wire => {
    switch (type.kind) {
      case "scalar":
        return { kind: type.name };
      case "enum":
        return { kind: "enum", members: members.get(type.name)! };
      case "record":
        return { kind: "record", name: type.name };
      case "list":
        return { kind: "list", element: wire(type.element) };
      case "optional":
        return { kind: "optional", inner: wire(type.inner) };
    }
  };
  const fields = (list: readonly Field[]): Fields => list.map(({ name, type }) => [name.name, wire(type)]);
  return {
    name: machine.name.name,
    initial: machine.states[machine.initial]!.name.name,
    records: Object.fromEntries(machine.records.map((record) => [record.name.name, fields(record.fields)])),
    events: Object.fromEntries(machine.events.map((event) => [event.name.name, fields(event.payload)])),
    states: machine.states.map(({ name, data, on }) => ({
      name: name.name,
      data: fields(data),
      on: on.map(({ event, to, fill }) => ({
        event: event.name.name,
        to: machine.states[to]!.name.name,
        fill: fill.map(({ field, source }) => [field.name.name, source.kind]),
      })),
    })),
  };
};

/** `readonly LineItem[]`, `string | null`. Enum and record names print as their exported type names. */
const ts = (type: DataType): string => {
  switch (type.kind) {
    case "scalar":
      return scalars[type.name].ts;
    case "enum":
    case "record":
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

const enumeration = ({ name, members }: Enum): readonly Piece[] => [
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

const record = ({ name, fields }: Shape): readonly Piece[] => [
  "export interface ",
  verbatim(name.name, name.span),
  " {\n",
  ...fields.flatMap(({ name, type }): readonly Piece[] => [
    "  readonly ",
    verbatim(name.name, name.span),
    `: ${ts(type)};\n`,
  ]),
  "}\n",
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

/**
 * One identifier carries the union type, the state namespace and the value, so `import Order from` and
 * `import { Order } from` both give all three. `Final` is `never` without final states.
 */
const declarations = ({ name, enums, records, states, initial }: Machine): readonly Piece[] => {
  const finals = states.filter(({ final }) => final).map((value) => value.name.name);
  const start = states[initial]!;
  return [
    ...enums.flatMap(enumeration),
    ...records.flatMap(record),
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
    `export default ${name.name};\n`,
  ];
};

/** `import { define } from "./runtime.ts"; const compiled = {...}; const Order = define(compiled);` */
const program = (uri: string, machine: Machine): Module<undefined> => {
  const local = (name: string) => binding(name, undefined);
  const define = local("define");
  const table = local("compiled");
  const exported = local(machine.name.name);
  return {
    imports: [{ from: specifier(uri, runtime), names: [["define", define]] }],
    body: {
      declarations: [
        { binding: table, value: data(undefined, compiled(machine)) },
        { binding: exported, value: call(undefined, ref(define), ref(table)) },
      ],
      result: ref(exported),
    },
    exports: [[machine.name.name, exported]],
  };
};

/** No host-only diagnostics: representability is a language rule, checked in machine.ts. */
export const host: HostLanguage = {
  extension: ".machine",
  host: (source, uri) => {
    const checked = checkSource(source);
    if (!checked.success) return unhosted(checked.errors);
    return {
      declarations: declarations(checked.value),
      javascript: () => emitModule(program(uri, checked.value)),
      diagnostics: [],
    };
  },
};
