import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { audit, finishing, reachable, unhandled } from "../examples/machine/graph.ts";
import type { Machine } from "../examples/machine/machine-model.ts";
import { checkSource } from "../examples/machine/machine.ts";

const checkout = readFileSync(new URL("../examples/machine/checkout.machine", import.meta.url), "utf8");

const diagnose = (source: string) => {
  const result = checkSource(source);
  return result.success ? [] : result.errors.map(({ message, span }) => ({
    message,
    at: source.slice(span!.start, span!.end),
    line: source.slice(0, span!.start).split("\n").length,
  }));
};

const machineOf = (source: string): Machine => {
  const result = checkSource(source);
  assert.ok(result.success, result.success ? "" : result.errors.map(({ message }) => message).join("\n"));
  return result.value;
};

const base = [
  "machine M",
  "event go",
  "event done",
  "initial state Start |> on go -> Middle",
  "state Middle |> on done -> End",
  "final state End",
  "",
].join("\n");

const edit = (original: string, replacement: string, source = base) => {
  assert.ok(source.includes(original), `${JSON.stringify(original)} is not in the source`);
  return source.replace(original, replacement);
};

type Case = {
  readonly rule: string;
  readonly source: string;
  readonly message: string;
  readonly at: string;
  readonly line: number;
};

const cases: readonly Case[] = [
  {
    rule: "unknown state",
    source: edit("-> Middle", "-> Midle"),
    message: "Unknown state: Midle",
    at: "Midle",
    line: 4,
  },
  { rule: "unknown event", source: edit("on go", "on gone"), message: "Unknown event: gone", at: "gone", line: 4 },
  {
    rule: "unknown type",
    source: base + "type Box = { size : Strng }\n",
    message: "Unknown type: Strng",
    at: "Strng",
    line: 7,
  },
  {
    rule: "unknown record",
    source: edit("state Middle", "state Middle = { ...Placd }"),
    message: "Unknown record: Placd",
    at: "Placd",
    line: 5,
  },
  {
    rule: "spreading an enum",
    source: edit("state Middle", "state Middle = { ...Mode }", base + "type Mode = Fast | Slow\n"),
    message: "Mode is an enum; only a record spreads",
    at: "Mode",
    line: 5,
  },
  {
    rule: "duplicate declaration",
    source: base + "type Start = Up | Down\n",
    message: "Duplicate declaration: Start",
    at: "Start",
    line: 7,
  },
  {
    rule: "duplicate field",
    source: base + "type Box = { size : Int, size : Int }\n",
    message: "Duplicate field: Box.size",
    at: "size",
    line: 7,
  },
  {
    rule: "duplicate field through a spread",
    source: edit("state Middle", "state Middle = { ...Box, ...Box }", base + "type Box = { size : Int? }\n"),
    message: "Duplicate field: Middle.size",
    at: "Box",
    line: 5,
  },
  { rule: "duplicate event", source: base + "event go\n", message: "Duplicate event: go", at: "go", line: 7 },
  {
    rule: "duplicate enum member",
    source: base + "type Mode = Fast | Fast\n",
    message: "Duplicate member: Mode.Fast",
    at: "Fast",
    line: 7,
  },
  {
    rule: "nondeterminism",
    source: edit("on go -> Middle", "on go -> Middle |> on go -> End"),
    message: "Start already handles go",
    at: "|> on go -> End",
    line: 4,
  },
  {
    rule: "a second machine",
    source: base + "machine Other\n",
    message: "A .machine file declares one machine",
    at: "Other",
    line: 7,
  },
  {
    rule: "no machine",
    source: edit("machine M\n", ""),
    message: "A .machine file declares one machine",
    at: "",
    line: 1,
  },
  {
    rule: "no initial state",
    source: edit("initial ", ""),
    message: "Exactly one initial state",
    at: "M",
    line: 1,
  },
  {
    rule: "a second initial state",
    source: edit("state Middle", "initial state Middle"),
    message: "Exactly one initial state",
    at: "initial",
    line: 5,
  },
  {
    rule: "a final state with a clause",
    source: edit("final state End", "final state End |> on go -> Start"),
    message: "End is final; a final state handles no events",
    at: "|> on go -> Start",
    line: 6,
  },
  {
    rule: "a field neither side provides",
    source: edit("state Middle", "state Middle = { tracking : String }"),
    message: "Middle needs tracking : String; neither Start nor go provides it",
    at: "Middle",
    line: 4,
  },
  {
    rule: "a payload of the wrong type",
    source: edit("state Middle", "state Middle = { note : Int }", edit("event go", "event go(note : String)")),
    message: "Middle.note is Int, but go gives String",
    at: "Middle",
    line: 4,
  },
  {
    rule: "a carried field of the wrong type",
    source: edit(
      "state Middle",
      "state Middle = { note : Int }",
      edit("initial state Start", "initial state Start = { note : String }"),
    ),
    message: "Middle.note is Int, but Start.note is String",
    at: "Middle",
    line: 4,
  },
  {
    rule: "a payload field the target drops",
    source: edit("event go", "event go(note : String)"),
    message: "go gives note, which Middle has no field for",
    at: "go",
    line: 4,
  },
  {
    rule: "an unreachable state",
    source: base + "state Island |> on done -> End\n",
    message: "Unreachable state: Island; no path from Start",
    at: "Island",
    line: 7,
  },
  {
    rule: "a dead end",
    source: edit("final state End", "state End"),
    message: "End is a dead end: it is not final and handles no events",
    at: "End",
    line: 6,
  },
  {
    rule: "a state that cannot finish",
    source: edit("on done -> End", "on done -> End |> on go -> Loop", base + "state Loop |> on go -> Loop\n"),
    message: "Loop can never finish: no path to End",
    at: "Loop",
    line: 7,
  },
  {
    rule: "an unhandled event",
    source: base + "event extra\n",
    message: "No state handles extra",
    at: "extra",
    line: 7,
  },
  {
    rule: "an event TypeScript cannot carry",
    source: base.replaceAll("done", "then"),
    message: "TypeScript cannot represent then, an event name",
    at: "then",
    line: 3,
  },
  {
    rule: "a field named state",
    source: edit("state Middle", "state Middle = { state : Int? }"),
    message: "TypeScript cannot represent state, a field name",
    at: "state",
    line: 5,
  },
  {
    rule: "a state named Final",
    source: base.replaceAll("End", "Final"),
    message: "TypeScript cannot represent Final, a state name",
    at: "Final",
    line: 6,
  },
  {
    rule: "a reserved type name",
    source: base + "type string = Up | Down\n",
    message: "TypeScript cannot represent string, a reserved type name",
    at: "string",
    line: 7,
  },
  {
    rule: "an event that is also a field",
    source: edit("state Middle", "state Middle = { done : Int? }"),
    message: "TypeScript cannot represent done, which Middle has as both a field and an event",
    at: "done",
    line: 5,
  },
  {
    rule: "a doubly optional type",
    source: base + "type Box = { size : Int?? }\n",
    message: "A type is optional at most once",
    at: "Int??",
    line: 7,
  },
];

for (const { rule, source, message, at, line } of cases) {
  test(`machine: ${rule} reports "${message}" at the guest text`, () => {
    assert.deepEqual(diagnose(source), [{ message, at, line }]);
  });
}

test("machine: a typo in one clause is one diagnostic, not a cascade of unreachable states", () => {
  assert.equal(diagnose(edit("-> End", "-> Edn")).length, 1);
});

test("machine: the checkout example and the base fixture are clean", () => {
  assert.deepEqual(diagnose(checkout), []);
  assert.deepEqual(diagnose(base), []);
});

test("machine: a transition decides each target field once, and the payload wins over a carry", () => {
  const { states } = machineOf(checkout);
  const fills = (state: string, event: string) =>
    states.find((value) => value.name.name === state)!.on.find((edge) => edge.event.name.name === event)!.fill
      .map(({ field, source }) => `${field.name.name}:${source.kind}`);
  assert.deepEqual(fills("Checkout", "pay"), ["items:carry", "address:carry", "paymentId:payload", "paidAt:payload"]);
  assert.deepEqual(fills("Checkout", "edit"), ["items:payload", "address:carry"]);
  assert.deepEqual(fills("Cart", "cancel"), ["reason:payload", "refundId:null"]);
});

test("machine: a spread field is the record's own field, so one binder serves every state", () => {
  const { records, states } = machineOf(checkout);
  const placed = records.find((record) => record.name.name === "Placed")!;
  const paid = states.find((state) => state.name.name === "Paid")!;
  assert.deepEqual(paid.data.slice(0, 2), placed.fields);
});

const described = (machine: Machine) =>
  audit(machine).map((found) =>
    `${found.kind}: ${found.kind === "unhandled" ? found.event.name.name : found.state.name.name}`
  );

test("graph: moving the initial state strands the states before it", () => {
  const machine = machineOf(checkout);
  const paid = machine.states.find((state) => state.name.name === "Paid")!.id;
  const names = (ids: ReadonlySet<number>) =>
    machine.states.filter(({ id }) => ids.has(id)).map(({ name }) => name.name);
  assert.deepEqual(names(reachable(machine)), [
    "Cart",
    "Checkout",
    "Paid",
    "Shipped",
    "Refunding",
    "Delivered",
    "Cancelled",
  ]);
  const moved = { ...machine, initial: paid };
  assert.deepEqual(names(reachable(moved)), ["Paid", "Shipped", "Refunding", "Delivered", "Cancelled"]);
  assert.deepEqual(described(moved), ["unreachable: Cart", "unreachable: Checkout"]);
});

test("graph: finishing walks edges backwards from every final state", () => {
  const machine = machineOf(checkout);
  assert.equal(finishing(machine).size, machine.states.length);
  const severed = {
    ...machine,
    states: machine.states.map((state) => state.name.name === "Shipped" ? { ...state, on: [] } : state),
  };
  const names = [...finishing(severed)].map((id) => severed.states[id]!.name.name).sort();
  assert.deepEqual(names, ["Cancelled", "Cart", "Checkout", "Delivered", "Paid", "Refunding"]);
  assert.deepEqual(described(severed), ["dead end: Shipped", "unreachable: Delivered", "unhandled: deliver"]);
  assert.deepEqual(unhandled(severed).map(({ name }) => name.name), ["deliver"]);
});
