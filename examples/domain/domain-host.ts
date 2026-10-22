import { type HostLanguage, type Piece, specifier, unhosted, verbatim } from "langkit/host";
import { type Binding, binding, call, data, type Json, type Module as Program, ref } from "langkit/ir";
import { emitModule } from "langkit/javascript";
import {
  closure,
  type DataType,
  type Field,
  fieldsOf,
  scalars,
  type TypeDecl,
  type TypeKey,
  typeKey,
} from "../data/data-model.ts";
import {
  type Component,
  type Formula,
  type Machine,
  type Module,
  type Port,
  type Property,
  showFormula,
  showSync,
  type State,
  type StateId,
  type Sync,
  type System,
  type Transition,
  transitionsOf,
} from "./domain-model.ts";
import { checkSource } from "./domain.ts";
import type { CompiledFormula, CompiledMachine, CompiledSystem, Fields, Named, Shape, Types } from "./runtime.ts";

const runtime = new URL("./runtime.ts", import.meta.url).href;

/** One file's projection: where it is, how it prints a type, and the local name of anything declared elsewhere. */
type Printer = {
  readonly uri: string;
  readonly ts: (type: DataType) => string;
  readonly local: (declared: Pick<Mentioned, "key" | "name">) => string;
};

/** `readonly LineItem[]`, `string | null`. A declared type prints as its local name in this projection. */
const printer = (uri: string, locals: ReadonlyMap<TypeKey, string>): Printer => {
  const local = ({ key, name }: Pick<Mentioned, "key" | "name">) => locals.get(key) ?? name;
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
const fieldName = ({ uri }: Printer, field: Field): Piece =>
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
const typeDecl = (printer: Printer, type: TypeDecl): readonly Piece[] => [
  ...typeOnly(printer, type),
  `export declare const ${type.name.name}: {\n`,
  `  /** Parses a ${type.name.name} from JSON. Throws a TypeError naming the first bad path. */\n`,
  `  parse(input: unknown): ${type.name.name};\n`,
  "};\n",
];

/** `{ readonly paymentId: string; readonly paidAt: string; }`, each name verbatim at its declaration. */
const object = (printer: Printer, fields: readonly Field[]): readonly Piece[] => [
  "{ ",
  ...fields.flatMap((field): readonly Piece[] => [
    "readonly ",
    fieldName(printer, field),
    `: ${printer.ts(field.type)}; `,
  ]),
  "}",
];

/**
 * `ship(event: {...}): Shipped`, named at its `on ship` clause so go-to-definition from `paid.ship(...)` lands on
 * the line that allows it. A payload-free event projects as `deliver(): Delivered`.
 */
const method = (
  printer: Printer,
  states: readonly State[],
  { clause, event, from, to }: Transition,
): readonly Piece[] => [
  `    /** ${states[from]!.name.name} |> on ${event.name.name} -> ${states[to]!.name.name} */\n`,
  "    ",
  verbatim(clause.event.name, clause.event.span),
  "(",
  ...(event.payload.length ? ["event: ", ...object(printer, event.payload)] : []),
  `): ${states[to]!.name.name};\n`,
];

const state = (printer: Printer, states: readonly State[], { name, data, on }: State): readonly Piece[] => [
  "  interface ",
  verbatim(name.name, name.span),
  " {\n    readonly state: \"",
  verbatim(name.name, name.span),
  "\";\n",
  ...data.flatMap((field): readonly Piece[] => [
    "    readonly ",
    fieldName(printer, field),
    `: ${printer.ts(field.type)};\n`,
  ]),
  ...on.filter(({ event }) => !event.syncOnly).flatMap((transition) => method(printer, states, transition)),
  "  }\n",
];

/** One identifier carries the union type, the state namespace and the value. `Final` is `never` without finals. */
const machine = (printer: Printer, { name, states, initial }: Machine): readonly Piece[] => {
  const finals = states.filter(({ final }) => final).map((value) => value.name.name);
  const start = states[initial]!;
  return [
    "export type ",
    verbatim(name.name, name.span),
    ` =\n${states.map((value) => `  | ${name.name}.${value.name.name}`).join("\n")};\n`,
    `export declare namespace ${name.name} {\n`,
    `  type Final = ${finals.join(" | ") || "never"};\n`,
    ...states.flatMap((value) => state(printer, states, value)),
    "}\n",
    `export declare const ${name.name}: {\n`,
    `  /** Starts a new ${name.name} in its initial state, ${start.name.name}. */\n`,
    "  start(",
    ...(start.data.length ? ["data: ", ...object(printer, start.data)] : []),
    `): ${name.name}.${start.name.name};\n`,
    `  /** Parses a stored snapshot, the JSON of any ${name.name} value. Throws a TypeError naming the first bad path. */\n`,
    `  parse(snapshot: unknown): ${name.name};\n`,
    "};\n",
  ];
};

const machineName = (printer: Printer, { machine }: Component): string =>
  printer.local({ key: typeKey(machine.uri, machine.name.name), name: machine.name.name });

/** `order` inside the `order.pay` port, which is where a parts key maps. */
const componentAt = ({ component, span }: Port): Piece =>
  verbatim(component.name.name, { start: span.start, end: span.start + component.name.name.length });

/**
 * `|> sync order.pay = payment.capture = warehouse.reserve` projects as
 * `pay<$order extends Order.Checkout, ...>(parts: { readonly order: $order; ... }): { readonly order: ... }`.
 * Each constraint is the union of states that handle the port's event, so a part held as a union of handling
 * states is accepted and its result is the union of targets; an unnarrowed `Order` is refused. The method name is
 * verbatim at `pay` in `order.pay`, so go-to-definition from TypeScript lands on the sync clause.
 */
const syncMethod = (printer: Printer, sync: Sync): readonly Piece[] => {
  const ports = sync.ports.map((port) => {
    const owner = machineName(printer, port.component);
    const edges = transitionsOf(port.component.machine, port.event);
    const state = (id: StateId) => `${owner}.${port.component.machine.states[id]!.name.name}`;
    const parameter = `$${port.component.name.name}`;
    const result = edges.reduceRight(
      (otherwise, { from, to }) => `${parameter} extends ${state(from)} ? ${state(to)} : ${otherwise}`,
      "never",
    );
    return { port, parameter, accepts: edges.map(({ from }) => state(from)).join(" | "), result };
  });
  return [
    `  /** ${showSync(sync)} */\n  `,
    verbatim(sync.name.name, sync.name.span),
    `<${ports.map(({ parameter, accepts }) => `${parameter} extends ${accepts}`).join(", ")}>(\n    parts: { `,
    ...ports.flatMap(({ port, parameter }): readonly Piece[] => ["readonly ", componentAt(port), `: ${parameter}; `]),
    "},\n",
    ...(sync.payload.length ? ["    event: ", ...object(printer, sync.payload), ",\n"] : []),
    "  ): { ",
    ...ports.flatMap(({ port, result }): readonly Piece[] => ["readonly ", componentAt(port), `: ${result}; `]),
    "};\n",
  ];
};

const components = (formula: Formula): readonly Component[] =>
  formula.kind === "is" ? [formula.component] : [...components(formula.left), ...components(formula.right)];

/** A `never` property is a predicate over just the parts its formula names, so an audit can pass two rows. */
const predicate = (printer: Printer, system: System, property: Property): readonly Piece[] => {
  if (property.claim.kind !== "never") return [];
  const named = new Set(components(property.claim.formula));
  return [
    `  /** False when ${showFormula(property.claim.formula)}. */\n  `,
    verbatim(property.name.name, property.name.span),
    "(parts: { ",
    ...system.components.filter((component) => named.has(component)).flatMap((component): readonly Piece[] => [
      "readonly ",
      verbatim(component.name.name, component.name.span),
      `: ${machineName(printer, component)}; `,
    ]),
    "}): boolean;\n",
  ];
};

/**
 * `Shop.Parts` names every component; the value has one method per sync and one predicate per `never`. A `~>` or
 * `possible` property is about runs, and a stored row has no run to test, so it projects nothing.
 */
const system = (printer: Printer, value: System): readonly Piece[] => [
  `export declare namespace ${value.name.name} {\n  interface Parts {\n`,
  ...value.components.flatMap((component): readonly Piece[] => [
    "    readonly ",
    verbatim(component.name.name, component.name.span),
    `: ${machineName(printer, component)};\n`,
  ]),
  "  }\n}\n",
  "export declare const ",
  verbatim(value.name.name, value.name.span),
  ": {\n",
  ...value.syncs.flatMap((sync) => syncMethod(printer, sync)),
  ...value.properties.flatMap((property) => predicate(printer, value, property)),
  "};\n",
];

/** A declaration another file owns, which the projection names and so must import. */
type Mentioned = { readonly key: TypeKey; readonly uri: string; readonly name: string; };

/** Every type the runtime decodes: a system's parts decode their own payloads. */
const decoded = (module: Module): readonly DataType[] => [
  ...module.types.flatMap((type) => fieldsOf(type).map(({ type }) => type)),
  ...module.machines.flatMap(({ events, states }) =>
    [...events.flatMap(({ payload }) => payload), ...states.flatMap(({ data }) => data)].map(({ type }) => type)
  ),
];

/** Every type the projection prints, so every one it must import. */
const printed = (module: Module): readonly DataType[] => [
  ...decoded(module),
  ...module.systems.flatMap(({ syncs }) => syncs.flatMap(({ payload }) => payload.map(({ type }) => type))),
];

const namedIn = (type: DataType): readonly Extract<DataType, { readonly kind: "named"; }>[] => {
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

/**
 * Types from other files print under a local name, imported with `import type` so TypeScript sees one `Address`,
 * never per-file copies. A name the file already uses, as a declaration or a state or variant inside a namespace,
 * is suffixed `$2`, `$3`; `$` cannot appear in a guest name.
 */
const imports = (
  module: Module,
): { readonly local: ReadonlyMap<TypeKey, string>; readonly lines: readonly string[]; } => {
  const taken = new Set([
    ...module.types.map(({ name }) => name.name),
    ...module.systems.map(({ name }) => name.name),
    ...module.machines.flatMap(({ name, states }) => [name.name, ...states.map((state) => state.name.name)]),
    ...module.types.flatMap((type) => type.kind === "tagged" ? type.variants.map(({ name }) => name.name) : []),
  ]);
  const local = new Map<TypeKey, string>();
  const from = new Map<string, string[]>();
  const mentioned: readonly Mentioned[] = [
    ...printed(module).flatMap(namedIn).map(({ key }) => {
      const { uri, name } = module.universe.get(key)!;
      return { key, uri, name: name.name };
    }),
    ...module.systems.flatMap(({ components }) =>
      components.map(({ machine: { uri, name } }) => ({ key: typeKey(uri, name.name), uri, name: name.name }))
    ),
  ];
  for (const { key, uri, name } of mentioned) {
    if (uri === module.uri || local.has(key)) continue;
    let chosen = name;
    for (let n = 2; taken.has(chosen); n++) chosen = `${name}$${n}`;
    taken.add(chosen);
    local.set(key, chosen);
    from.set(uri, [...(from.get(uri) ?? []), chosen === name ? name : `${name} as ${chosen}`]);
  }
  const lines = [...from].map(([uri, names]) =>
    `import type { ${names.sort().join(", ")} } from "${specifier(module.uri, uri)}";\n`
  );
  return { local, lines };
};

export const declarations = (module: Module): readonly Piece[] => {
  const { local, lines } = imports(module);
  const printing = printer(module.uri, local);
  return [
    ...lines,
    ...module.types.flatMap((type) => typeDecl(printing, type)),
    ...module.machines.flatMap((value) => machine(printing, value)),
    ...module.systems.flatMap((value) => system(printing, value)),
  ];
};

/**
 * The runtime tables, closed over every type the module decodes, own or imported, so a module's JavaScript
 * imports only runtime.ts. Local keys are the type names, suffixed `#2`, `#3` when two closed-over types share one.
 */
export const compiled = (module: Module): {
  readonly types: Types;
  /** The local key of each of the module's own types, in written order. */
  readonly own: readonly string[];
  readonly machines: readonly CompiledMachine[];
  readonly systems: readonly CompiledSystem[];
} => {
  const roots = [
    ...module.types.map((type): DataType => ({ kind: "named", key: type.key, name: type.name.name })),
    ...decoded(module),
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
      syncOnly: events.filter(({ syncOnly }) => syncOnly).map(({ name }) => name.name),
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
    systems: module.systems.map(({ name, syncs, properties }) => ({
      name: name.name,
      syncs: syncs.map((sync) => ({
        name: sync.name.name,
        ports: sync.ports.map(({ component: { name, machine }, event }) => ({
          component: name.name,
          event: event.name.name,
          handles: transitionsOf(machine, event).map(({ from }) => machine.states[from]!.name.name),
          fields: event.payload.map((field) => field.name.name),
        })),
      })),
      predicates: properties.flatMap(({ name, claim }) =>
        claim.kind === "never" ? [{ name: name.name, bad: formula(claim.formula) }] : []
      ),
    })),
  };
};

const formula = (value: Formula): CompiledFormula => {
  switch (value.kind) {
    case "is":
      return {
        kind: "is",
        component: value.component.name.name,
        negated: value.negated,
        states: value.states.map((id) => value.component.machine.states[id]!.name.name),
      };
    case "and":
    case "or":
      return { kind: value.kind, left: formula(value.left), right: formula(value.right) };
  }
};

/**
 * `import { machine, named, system } from "./runtime.ts"; const types = {...};` then one export per declaration:
 * `const LineItem = named(types)("LineItem"); const Order = machine(types)({...}); const Shop = system({...});`.
 */
export const program = (uri: string, module: Module): Program<undefined> => {
  const local = (name: string) => binding(name, undefined);
  const runtimeNamed = local("named");
  const runtimeMachine = local("machine");
  const runtimeSystem = local("system");
  const types = local("types");
  const tables = compiled(module);
  const over = (definer: Binding<undefined>, table: Json) =>
    call(undefined, call(undefined, ref(definer), ref(types)), data(undefined, table));
  const exported = [
    ...module.types.map(({ name }, index) => [name.name, over(runtimeNamed, tables.own[index]!)] as const),
    ...tables.machines.map((table) => [table.name, over(runtimeMachine, table)] as const),
    ...tables.systems.map((table) =>
      [table.name, call(undefined, ref(runtimeSystem), data(undefined, table))] as const
    ),
  ].map(([name, value]) => ({ name, binding: local(name), value }));
  return {
    imports: [{
      from: specifier(uri, runtime),
      names: [["named", runtimeNamed], ["machine", runtimeMachine], ["system", runtimeSystem]],
    }],
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
