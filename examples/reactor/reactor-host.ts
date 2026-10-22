import { specifier } from "langkit/host";
import { type Binding, binding, call, data, type Json, type Module as Program, ref } from "langkit/ir";
import { tables } from "../data/data-host.ts";
import { type DataType, optionalOf, same } from "../data/data-model.ts";
import type { Types } from "../data/decode.ts";
import type { Expr, Formula, Machine, Module, Node, Pattern, Ref } from "./reactor-model.ts";
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
export const declared = ({ nodes }: Machine): readonly Node[] => {
  const written = nodes.toSorted((a, b) => a.slot.name.span.start - b.slot.name.span.start);
  return [...written.filter(({ kind }) => kind === "cell"), ...written.filter(({ kind }) => kind === "signal")];
};

/** A signal is absent in every tick it does not fire. */
export const held = ({ slot }: Node): DataType => slot.kind === "signal" ? optionalOf(slot.type) : slot.type;

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
