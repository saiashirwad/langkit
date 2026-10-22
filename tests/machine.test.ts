import { project } from "langkit/host";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { audit, finishing, reachable, unhandled } from "../examples/machine/graph.ts";
import { host } from "../examples/machine/machine-host.ts";
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

const hosted = (source: string) => {
  const { declarations, diagnostics, javascript } = host.host(source, "file:///test.machine");
  return { projection: project(declarations), diagnostics, javascript };
};

const gauge = [
  "machine Gauge",
  "event record(samples : [Float?], ok : Bool)",
  "event reset",
  "initial state Idle = { samples : [Float?], ok : Bool } |> on record -> Idle |> on reset -> Done",
  "final state Done",
  "",
].join("\n");

test("host: each state projects to an interface whose methods are the legal events, documented by their transition", () => {
  const { projection, diagnostics } = hosted(checkout);
  assert.deepEqual(diagnostics, []);
  const { text } = projection;
  for (
    const expected of [
      "export type Carrier = \"Post\" | \"Courier\";",
      "  type Final = Delivered | Cancelled;",
      "  interface Cart {\n    readonly state: \"Cart\";\n    readonly items: readonly LineItem[];\n",
      "    /** Cart |> on checkout -> Checkout */\n    checkout(event: { readonly address: Address; }): Checkout;",
      "    /** Paid |> on cancel -> Refunding */\n    cancel(event: { readonly reason: CancelReason; }): Refunding;",
      "    readonly refundId: string | null;",
      "  start(data: { readonly items: readonly LineItem[]; }): Order.Cart;",
      "  parse(snapshot: unknown): Order;",
      "export default Order;",
    ]
  ) assert.ok(text.includes(expected), `${expected}\n---\n${text}`);
  assert.ok(!/interface Delivered \{[^}]*\(/.test(text), "a final state has no methods");
});

test("host: optionals, lists, payload-free events and a machine without data project faithfully", () => {
  const { text } = hosted(gauge).projection;
  assert.ok(text.includes("readonly samples: readonly (number | null)[];"), text);
  assert.ok(text.includes("    reset(): Done;"), text);
  assert.ok(text.includes("  type Final = Done;"), text);
  const { text: bare } = hosted("machine Loop\nevent tick\ninitial state On |> on tick -> On\n").projection;
  assert.ok(bare.includes("  type Final = never;"), bare);
  assert.ok(bare.includes("  start(): Loop.On;"), bare);
});

test("host: names in the projection map back to the guest binders", () => {
  const { projection } = hosted(checkout);
  for (const [virtualStart, virtualLength, originalStart, originalLength] of projection.mappings) {
    assert.equal(
      projection.text.slice(virtualStart, virtualStart + virtualLength),
      checkout.slice(originalStart, originalStart + originalLength),
    );
  }
  const mapped = (text: string, guest: number) =>
    projection.mappings.filter(([start, length]) => projection.text.slice(start, start + length) === text)
      .map(([, , original]) => original)
      .includes(guest);
  assert.ok(mapped("ship", checkout.indexOf("on ship") + 3), "a method maps to its on-clause");
  assert.ok(mapped("Paid", checkout.indexOf("state Paid") + 6), "an interface maps to its state");
  assert.ok(mapped("items", checkout.indexOf("items : [LineItem], address")), "a spread field maps into its record");
  assert.ok(mapped("reason", checkout.indexOf("reason : CancelReason)")), "a payload field maps to the event");
});

test("host: a checked file with errors is not hosted", () => {
  const { diagnostics, javascript, projection } = hosted(edit("-> End", "-> Edn"));
  assert.equal(javascript, undefined);
  assert.equal(projection.text, "");
  assert.deepEqual(diagnostics.map(({ message }) => message), ["Unknown state: Edn"]);
});

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "machine-runtime-")));
after(() => rmSync(scratch, { recursive: true, force: true }));

type Instance = { readonly state: string; readonly [field: string]: unknown; };
type Runtime = {
  readonly start: (data?: unknown) => Instance;
  readonly parse: (snapshot: unknown) => Instance;
};

let modules = 0;
const load = async (source: string): Promise<Runtime> => {
  const file = pathToFileURL(join(scratch, `module-${modules++}.mjs`));
  const { javascript, diagnostics } = host.host(source, file.href);
  assert.deepEqual(diagnostics, []);
  writeFileSync(file, javascript!());
  return ((await import(file.href)) as { readonly default: Runtime; }).default;
};

const fire = (value: Instance, event: string, payload?: unknown): Instance => {
  const method = Reflect.get(value, event);
  if (typeof method !== "function") throw new TypeError(`${value.state} does not handle ${event}`);
  return Reflect.apply(method, value, [payload]);
};

const address = { name: "Sai", line1: "1 Loop Road", city: "Bengaluru", postcode: "560001" };
const keyboard = { sku: "kbd-60", quantity: 1, cents: 12900 };

const shipped = async () => {
  const Order = await load(checkout);
  const cart = fire(Order.start({ items: [] }), "edit", { items: [keyboard] });
  const paid = fire(fire(cart, "checkout", { address }), "pay", { paymentId: "pi_1", paidAt: "2026-10-22T09:00:00Z" });
  return { Order, cart, paid, shipped: fire(paid, "ship", { carrier: "Courier", tracking: "TRK1" }) };
};

test("runtime: events move a value through the table, and each state keeps exactly its own data", async () => {
  const { cart, paid, shipped: value } = await shipped();
  assert.deepEqual(JSON.parse(JSON.stringify(cart)), { state: "Cart", items: [keyboard] });
  assert.deepEqual(Object.keys(paid), ["state", "items", "address", "paymentId", "paidAt"]);
  assert.equal(value.state, "Shipped");
  assert.equal(value.carrier, "Courier");
  assert.deepEqual(value.address, address);
  assert.equal(fire(value, "deliver", { deliveredAt: "2026-10-24T12:00:00Z" }).state, "Delivered");
});

test("runtime: a payload replaces a carried field of the same name, and an unprovided optional is null", async () => {
  const { Order } = await shipped();
  const placed = fire(fire(Order.start({ items: [] }), "checkout", { address }), "edit", { items: [keyboard] });
  assert.deepEqual(placed.items, [keyboard]);
  assert.deepEqual(placed.address, address);
  const cancelled = fire(placed, "cancel", { reason: "OutOfStock" });
  assert.deepEqual(JSON.parse(JSON.stringify(cancelled)), { state: "Cancelled", reason: "OutOfStock", refundId: null });
});

test("runtime: values are deeply frozen and an old value stays valid after a transition", async () => {
  const { cart, paid } = await shipped();
  assert.ok(Object.isFrozen(paid));
  assert.ok(Object.isFrozen(cart.items));
  assert.ok(Object.isFrozen((cart.items as readonly object[])[0]));
  assert.ok(Object.isFrozen(paid.address));
  assert.throws(() => {
    (paid as { state: string; }).state = "Cart";
  }, TypeError);
  const again = fire(fire(cart, "checkout", { address }), "pay", { paymentId: "pi_2", paidAt: "later" });
  assert.equal(again.paymentId, "pi_2");
  assert.equal(paid.paymentId, "pi_1");
  assert.equal(cart.state, "Cart");
});

test("runtime: methods stay off the snapshot and off the awaitable surface", async () => {
  const { paid } = await shipped();
  assert.ok(!("then" in paid));
  assert.equal(await paid, paid);
  assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(paid))), ["state", "items", "address", "paymentId", "paidAt"]);
});

test("runtime: parse round-trips every state's snapshot", async () => {
  const { Order, cart, paid, shipped: value } = await shipped();
  const delivered = fire(value, "deliver", { deliveredAt: "2026-10-24T12:00:00Z" });
  const cancelled = fire(paid, "cancel", { reason: "ChangedMind" });
  for (const original of [cart, paid, value, delivered, cancelled]) {
    const restored = Order.parse(JSON.parse(JSON.stringify(original)));
    assert.deepEqual(restored, original);
    assert.ok(Object.isFrozen(restored));
    assert.equal(JSON.stringify(restored), JSON.stringify(original));
  }
  assert.equal(
    fire(Order.parse(JSON.parse(JSON.stringify(cancelled))), "refund", { refundId: "re_1" }).state,
    "Cancelled",
  );
});

const snapshot = (overrides: Readonly<Record<string, unknown>>, drop: readonly string[] = []) => {
  const full: Record<string, unknown> = {
    state: "Shipped",
    items: [keyboard],
    address,
    paymentId: "pi_1",
    carrier: "Courier",
    tracking: "TRK1",
    ...overrides,
  };
  for (const key of drop) delete full[key];
  return full;
};

const rejections: readonly (readonly [string, unknown, string])[] = [
  [
    "a nested wrong type",
    snapshot({ items: [{ ...keyboard, quantity: "3" }] }),
    "snapshot.items[0].quantity: expected Int, found \"3\"",
  ],
  [
    "a fractional Int",
    snapshot({ items: [{ ...keyboard, quantity: 1.5 }] }),
    "snapshot.items[0].quantity: expected Int, found 1.5",
  ],
  [
    "an unknown state",
    snapshot({ state: "Lost" }),
    "snapshot.state: expected \"Cart\" | \"Checkout\" | \"Paid\" | \"Shipped\" | \"Refunding\" | \"Delivered\" | \"Cancelled\", found \"Lost\"",
  ],
  ["a missing record", snapshot({}, ["address"]), "snapshot.address: expected Address, found nothing"],
  ["a missing required field", snapshot({}, ["tracking"]), "snapshot.tracking: expected String, found nothing"],
  [
    "an enum value outside the enum",
    snapshot({ carrier: "Rocket" }),
    "snapshot.carrier: expected \"Post\" | \"Courier\", found \"Rocket\"",
  ],
  ["an extra field", snapshot({ note: "hi" }), "snapshot: unexpected field note"],
  ["a non-object", 3, "snapshot: expected an object, found 3"],
  ["an array", [], "snapshot: expected an object, found an array"],
];

for (const [claim, input, message] of rejections) {
  test(`runtime: parse rejects ${claim} and names the path`, async () => {
    const Order = await load(checkout);
    assert.throws(() => Order.parse(input), (error) => error instanceof TypeError && error.message === message);
  });
}

test("runtime: an optional field may be missing from a snapshot", async () => {
  const Order = await load(checkout);
  const restored = Order.parse({ state: "Cancelled", reason: "OutOfStock" });
  assert.equal(restored.refundId, null);
});

test("runtime: JS callers cannot forge a value the types would refuse", async () => {
  const { Order, paid } = await shipped();
  assert.throws(
    () => fire(paid, "ship", { carrier: "Courier" }),
    (error) =>
      error instanceof TypeError && error.message === "Order.Paid.ship.tracking: expected String, found nothing",
  );
  assert.throws(
    () => fire(paid, "ship", { carrier: "Courier", tracking: "T", extra: 1 }),
    (error) => error instanceof TypeError && error.message === "Order.Paid.ship: unexpected field extra",
  );
  assert.throws(() => Order.start({}), /Order\.start\.items: expected \[LineItem\], found nothing/);
  assert.equal(paid.pay, undefined);
});

test("runtime: Float, Bool, optional lists and payload-free events behave", async () => {
  const Gauge = await load(gauge);
  const idle = Gauge.start({ samples: [1.5, null], ok: true });
  const next = fire(idle, "record", { samples: [2], ok: false });
  assert.deepEqual(JSON.parse(JSON.stringify(next)), { state: "Idle", samples: [2], ok: false });
  assert.equal(fire(next, "reset").state, "Done");
  assert.throws(
    () => fire(idle, "record", { samples: [Number.NaN], ok: true }),
    /Gauge\.Idle\.record\.samples\[0\]: expected Float, found NaN/,
  );
  assert.throws(() => fire(idle, "record", { samples: [], ok: "yes" }), /ok: expected Bool, found "yes"/);
  assert.throws(() => fire(idle, "reset", { stray: 1 }), /Gauge\.Idle\.reset: unexpected field stray/);
});
