import { type HostLanguage, type Piece, specifier, unhosted, verbatim } from "langkit/host";
import { type Binding, binding, call, data, type Json, type Module as Program, ref } from "langkit/ir";
import { emitModule } from "langkit/javascript";
import { type Printer, printer, tables, typeDecl } from "../data/data-host.ts";
import { type DataType, optionalOf, same } from "../data/data-model.ts";
import type { Types } from "../data/decode.ts";
import {
  type Expr,
  type Formula,
  type Machine,
  type Module,
  type Node,
  type Pattern,
  type Ref,
  showInput,
  showSlot,
} from "./reactor-model.ts";
import { checkSource } from "./reactor.ts";
import type {
  CompiledExpr,
  CompiledFormula,
  CompiledMachine,
  CompiledNode,
  CompiledPattern,
  CompiledRef,
} from "./runtime.ts";

const runtime = new URL("./runtime.ts", import.meta.url).href;

const reference = (ref: Ref): CompiledRef =>
  ref.kind === "local" ? { kind: "local", name: ref.local.name.name } : { kind: "slot", name: ref.slot.name.name };

const expression = (expr: Expr): CompiledExpr => {
  switch (expr.kind) {
    case "ref":
      return reference(expr.ref);
    case "field":
      return { kind: "field", record: expression(expr.record), field: expr.field.name.name };
    case "member":
      return { kind: "member", member: expr.member.name.name };
    case "variant":
      return {
        kind: "variant",
        tag: expr.variant.name.name,
        fields: expr.args.map((arg, index) => [expr.variant.fields[index]!.name.name, expression(arg)]),
      };
    case "record":
      return {
        kind: "record",
        fields: expr.fields.map(([field, value]) => [field.name.name, value ? expression(value) : null]),
      };
    case "list":
      return { kind: "list", items: expr.items.map(({ spread, value }) => ({ spread, value: expression(value) })) };
  }
};

const pattern = (value: Pattern): CompiledPattern => {
  switch (value.kind) {
    case "wild":
      return { kind: "wild" };
    case "bind":
      return { kind: "bind", name: value.local.name.name };
    case "equal":
      return { kind: "equal", ref: reference(value.ref) };
    case "member":
      return { kind: "member", member: value.member.name.name };
    case "variant":
      return {
        kind: "variant",
        tag: value.variant.name.name,
        args: value.args?.map((arg, index) => [value.variant.fields[index]!.name.name, pattern(arg)]) ?? null,
      };
    case "record":
      return { kind: "record", fields: value.fields.map(([field, nested]) => [field.name.name, pattern(nested)]) };
    case "tuple":
      return { kind: "tuple", items: value.items.map(pattern) };
    case "spread":
      return {
        kind: "spread",
        head: value.head.map(pattern),
        rest: value.rest.name.name,
        tail: value.tail.map(pattern),
      };
  }
};

const formula = (value: Formula): CompiledFormula => {
  switch (value.kind) {
    case "is":
    case "contains":
      return { kind: value.kind, subject: expression(value.subject), pattern: pattern(value.pattern) };
    case "and":
    case "or":
      return { kind: value.kind, left: formula(value.left), right: formula(value.right) };
    case "not":
      return { kind: "not", operand: formula(value.operand) };
  }
};

const node = (value: Node): CompiledNode => {
  const name = value.slot.name.name;
  if (value.kind === "signal") {
    return {
      kind: "signal",
      name,
      input: value.source.name.name,
      present: value.present.map(({ slot }) => slot.name.name),
      value: expression(value.value),
    };
  }
  const { init } = value;
  if (init.kind === "last") {
    const carried = init.input.carries.findIndex((type) => same(type, init.of));
    return { kind: "last", name, input: init.input.name.name, carried };
  }
  return {
    kind: "value",
    name,
    initial: expression(init.value),
    groups: init.groups.map(({ source, binder, rows }) => ({
      source: source.name.name,
      binder: binder?.name.name ?? null,
      rows: rows.map((row) => ({
        pattern: pattern(row.pattern),
        guard: row.guard ? { sense: row.guard.sense, formula: formula(row.guard.formula) } : null,
        value: expression(row.value),
      })),
    })),
  };
};

/** Cells, then signals, each in the order they are written: the snapshot's fields and the projection's members. */
const declared = ({ nodes }: Machine): readonly Node[] => {
  const written = nodes.toSorted((a, b) => a.slot.name.span.start - b.slot.name.span.start);
  return [...written.filter(({ kind }) => kind === "cell"), ...written.filter(({ kind }) => kind === "signal")];
};

/** A signal is absent in every tick it does not fire. */
const held = ({ slot }: Node): DataType => slot.kind === "signal" ? optionalOf(slot.type) : slot.type;

const member = (printer: Printer, node: Node): readonly Piece[] => {
  const { slot } = node;
  const absent = slot.kind === "signal" ? "; null in a tick it does not fire" : "";
  return [
    `  /** ${showSlot(slot)}${absent} */\n  readonly `,
    verbatim(slot.name.name, slot.name.span),
    `: ${printer.ts(held(node))};\n`,
  ];
};

/**
 * `export interface Player { readonly steps: ...; press(value: Root | Shape | Feel): Player; }`, and a value of
 * the same name that starts and parses one. Each member is verbatim at its declaration, so go-to-definition from
 * `player.steps` lands on the cell.
 */
const machine = (printer: Printer, value: Machine): readonly Piece[] => {
  const { name } = value.name;
  return [
    "export interface ",
    verbatim(name, value.name.span),
    " {\n",
    ...declared(value).flatMap((node) => member(printer, node)),
    ...value.inputs.flatMap((input): readonly Piece[] => [
      `  /** ${showInput(input)} */\n  `,
      verbatim(input.name.name, input.name.span),
      `(${input.carries.length ? `value: ${input.carries.map(printer.ts).join(" | ")}` : ""}): ${name};\n`,
    ]),
    "}\n",
    `export declare const ${name}: {\n`,
    `  /** Starts a new ${name}: every cell at its initial value, and no signal fired. */\n`,
    `  start(): ${name};\n`,
    `  /** Parses a stored snapshot, the JSON of any ${name} value. Throws a TypeError naming the first bad path. */\n`,
    `  parse(snapshot: unknown): ${name};\n`,
    "};\n",
  ];
};

/** A reactor file names only its own types, so the projection imports nothing. */
export const declarations = (module: Module): readonly Piece[] => {
  const printing = printer(module.uri, new Map());
  return [
    ...module.types.flatMap((type) => typeDecl(printing, type)),
    ...module.machines.flatMap((value) => machine(printing, value)),
  ];
};

/** The runtime tables, closed over every type the module decodes, so its JavaScript imports only runtime.ts. */
export const compiled = (module: Module): {
  readonly types: Types;
  /** The local key of each of the module's own types, in written order. */
  readonly own: readonly string[];
  readonly machines: readonly CompiledMachine[];
} => {
  const roots = [
    ...module.types.map((type): DataType => ({ kind: "named", key: type.key, name: type.name.name })),
    ...module.machines.flatMap(({ inputs, nodes }) => [
      ...inputs.flatMap(({ carries }) => carries),
      ...nodes.map(held),
    ]),
  ];
  const { types, local, shape } = tables(module.universe, roots);
  return {
    types,
    own: module.types.map(({ key }) => local(key)),
    machines: module.machines.map((machine) => ({
      name: machine.name.name,
      inputs: machine.inputs.map(({ name, carries }) => ({ name: name.name, carries: carries.map(shape) })),
      fields: declared(machine).map((value) => [value.slot.name.name, shape(held(value))]),
      nodes: machine.nodes.map(node),
    })),
  };
};

/**
 * `import { machine, named } from "./runtime.ts"; const types = {...};` then one export per declaration:
 * `const Clip = named(types)("Clip"); const Player = machine(types)({...});`.
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
  extension: ".reactor",
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
