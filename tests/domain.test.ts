import { definitionAt, semanticTokens, typeAt } from "langkit/analysis";
import { project } from "langkit/host";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { host } from "../examples/domain/domain-host.ts";
import type { Machine, Module } from "../examples/domain/domain-model.ts";
import { analyze, checkSource } from "../examples/domain/domain.ts";
import { audit, finishing, reachable, unhandled } from "../examples/domain/graph.ts";

const checkout = readFileSync(new URL("../examples/domain/checkout.domain", import.meta.url), "utf8");

const diagnose = (source: string) => {
  const result = checkSource(source);
  return result.success ? [] : result.errors.map(({ message, span }) => ({
    message,
    at: source.slice(span!.start, span!.end),
    line: source.slice(0, span!.start).split("\n").length,
  }));
};

const moduleOf = (source: string): Module => {
  const result = checkSource(source);
  assert.ok(result.success, result.success ? "" : result.errors.map(({ message }) => message).join("\n"));
  return result.value;
};

const machineOf = (source: string): Machine => moduleOf(source).machines[0]!;

const base = [
  "machine M {",
  "event go",
  "event done",
  "initial state Start |> on go -> Middle",
  "state Middle |> on done -> End",
  "final state End",
  "}",
  "",
].join("\n");

/** Appends an item to the machine's body. */
const inside = (item: string, source = base) => source.replace(/}\n$/, `${item}\n}\n`);

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
    line: 8,
  },
  {
    rule: "a machine used as a type",
    source: base + "type Box = { m : M }\n",
    message: "M is a machine, not a type",
    at: "M",
    line: 8,
  },
  {
    rule: "a brand over a record",
    source: base + "type Box = { size : Int }\nbrand Crate = Box\n",
    message: "A brand wraps String, Int, Float or Bool, not Box",
    at: "Box",
    line: 9,
  },
  {
    rule: "a scalar where a brand is expected",
    source: edit(
      "state Middle",
      "state Middle = { note : Note }",
      edit("event go", "event go(note : String)", base + "brand Note = String\n"),
    ),
    message: "Middle.note is Note, but go gives String",
    at: "Middle",
    line: 4,
  },
  {
    rule: "one brand where another is expected",
    source: edit(
      "state Middle",
      "state Middle = { note : Note }",
      edit("event go", "event go(note : Memo)", base + "brand Note = String\nbrand Memo = String\n"),
    ),
    message: "Middle.note is Note, but go gives Memo",
    at: "Middle",
    line: 4,
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
    rule: "a state named like a top-level type",
    source: base + "type Start = Up | Down\n",
    message: "Duplicate declaration: Start",
    at: "Start",
    line: 4,
  },
  {
    rule: "a second declaration of a name",
    source: base + "machine M { initial state Other }\n",
    message: "Duplicate declaration: M",
    at: "M",
    line: 8,
  },
  {
    rule: "duplicate field",
    source: base + "type Box = { size : Int, size : Int }\n",
    message: "Duplicate field: Box.size",
    at: "size",
    line: 8,
  },
  {
    rule: "duplicate field through a spread",
    source: edit("state Middle", "state Middle = { ...Box, ...Box }", base + "type Box = { size : Int? }\n"),
    message: "Duplicate field: Middle.size",
    at: "Box",
    line: 5,
  },
  { rule: "duplicate event", source: inside("event go"), message: "Duplicate event: go", at: "go", line: 7 },
  {
    rule: "duplicate enum member",
    source: base + "type Mode = Fast | Fast\n",
    message: "Duplicate member: Mode.Fast",
    at: "Fast",
    line: 8,
  },
  {
    rule: "a duplicate variant",
    source: base + "type Pay = Card { last4 : String } | Card\n",
    message: "Duplicate member: Pay.Card",
    at: "Card",
    line: 8,
  },
  {
    rule: "a variant field named tag",
    source: base + "type Pay = Card { tag : String } | Cash\n",
    message: "TypeScript cannot represent tag, a variant field name",
    at: "tag",
    line: 8,
  },
  {
    rule: "a variant named like a top-level type",
    source: base + "type Note = { text : String }\ntype Pay = Note { text : String } | Cash\n",
    message: "Duplicate declaration: Note",
    at: "Note",
    line: 9,
  },
  {
    rule: "nondeterminism",
    source: edit("on go -> Middle", "on go -> Middle |> on go -> End"),
    message: "Start already handles go",
    at: "|> on go -> End",
    line: 4,
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
    source: inside("state Island |> on done -> End"),
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
    source: edit("on done -> End", "on done -> End |> on go -> Loop", inside("state Loop |> on go -> Loop")),
    message: "Loop can never finish: no path to End",
    at: "Loop",
    line: 7,
  },
  {
    rule: "an unhandled event",
    source: inside("event extra"),
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
    line: 8,
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
    line: 8,
  },
];

for (const { rule, source, message, at, line } of cases) {
  test(`domain: ${rule} reports "${message}" at the guest text`, () => {
    assert.deepEqual(diagnose(source), [{ message, at, line }]);
  });
}

test("domain: a typo in one clause is one diagnostic, not a cascade of unreachable states", () => {
  assert.equal(diagnose(edit("-> End", "-> Edn")).length, 1);
});

test("domain: the checkout example and the base fixture are clean", () => {
  assert.deepEqual(diagnose(checkout), []);
  assert.deepEqual(diagnose(base), []);
});

test("domain: a transition decides each target field once, and the payload wins over a carry", () => {
  const { states } = machineOf(checkout);
  const fills = (state: string, event: string) =>
    states.find((value) => value.name.name === state)!.on.find((edge) => edge.event.name.name === event)!.fill
      .map(({ field, source }) => `${field.name.name}:${source.kind}`);
  assert.deepEqual(fills("Checkout", "pay"), ["items:carry", "address:carry", "paymentId:payload", "paidAt:payload"]);
  assert.deepEqual(fills("Checkout", "edit"), ["items:payload", "address:carry"]);
  assert.deepEqual(fills("Cart", "cancel"), ["reason:payload", "refundId:null"]);
});

test("domain: a spread field is the record's own field, so one binder serves every state", () => {
  const { types, machines } = moduleOf(checkout);
  const placed = types.find((type) => type.name.name === "Placed");
  const paid = machines[0]!.states.find((state) => state.name.name === "Paid")!;
  assert.equal(placed?.kind, "record");
  if (placed?.kind === "record") assert.deepEqual(paid.data.slice(0, 2), placed.fields);
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
  const { declarations, diagnostics, javascript } = host.host(source, "file:///test.domain");
  return { projection: project(declarations), diagnostics, javascript };
};

const gauge = [
  "machine Gauge {",
  "event record(samples : [Float?], ok : Bool)",
  "event reset",
  "initial state Idle = { samples : [Float?], ok : Bool } |> on record -> Idle |> on reset -> Done",
  "final state Done",
  "}",
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
    ]
  ) assert.ok(text.includes(expected), `${expected}\n---\n${text}`);
  assert.ok(!/interface Delivered \{[^}]*\(/.test(text), "a final state has no methods");
});

test("host: optionals, lists, payload-free events and a machine without data project faithfully", () => {
  const { text } = hosted(gauge).projection;
  assert.ok(text.includes("readonly samples: readonly (number | null)[];"), text);
  assert.ok(text.includes("    reset(): Done;"), text);
  assert.ok(text.includes("  type Final = Done;"), text);
  const { text: bare } = hosted("machine Loop { event tick initial state On |> on tick -> On }\n").projection;
  assert.ok(bare.includes("  type Final = never;"), bare);
  assert.ok(bare.includes("  start(): Loop.On;"), bare);
});

test("host: a brand is nominal over its scalar, and every named type is also its parser", () => {
  const { text } = hosted(checkout).projection;
  for (
    const expected of [
      "declare const PaymentId$: unique symbol;\n/** brand PaymentId = String */\n"
      + "export type PaymentId = string & { readonly [PaymentId$]: true; };\n",
      "export declare const PaymentId: {\n",
      "  parse(input: unknown): PaymentId;\n",
      "  parse(input: unknown): Carrier;\n",
      "  parse(input: unknown): LineItem;\n",
      "    readonly paymentId: PaymentId;\n",
    ]
  ) assert.ok(text.includes(expected), `${expected}\n---\n${text}`);
});

const payments = base + "type Pay = Card { last4 : String, saved : Bool? } | Transfer { reference : String } | Cash\n";

test("host: a union with a payload member projects as a tagged union, and a bare member has only its tag", () => {
  const { text } = hosted(payments).projection;
  for (
    const expected of [
      "export type Pay = Pay.Card | Pay.Transfer | Pay.Cash;\n",
      "  interface Card {\n    readonly tag: \"Card\";\n    readonly last4: string;\n    readonly saved: boolean | null;\n  }\n",
      "  interface Cash {\n    readonly tag: \"Cash\";\n  }\n",
      "  parse(input: unknown): Pay;\n",
    ]
  ) assert.ok(text.includes(expected), `${expected}\n---\n${text}`);
  assert.equal(
    typeAt(analyze(payments), payments.indexOf("type Pay") + 5)?.type,
    "type Pay = Card { last4 : String, saved : Bool? } | Transfer { reference : String } | Cash",
  );
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

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "domain-runtime-")));
after(() => rmSync(scratch, { recursive: true, force: true }));

type Instance = { readonly state: string; readonly [field: string]: unknown; };
type Runtime = {
  readonly start: (data?: unknown) => Instance;
  readonly parse: (snapshot: unknown) => Instance;
};

let modules = 0;
const load = async (source: string, name = "Order"): Promise<Runtime> => {
  const file = pathToFileURL(join(scratch, `module-${modules++}.mjs`));
  const { javascript, diagnostics } = host.host(source, file.href);
  assert.deepEqual(diagnostics, []);
  writeFileSync(file, javascript!());
  return ((await import(file.href)) as Readonly<Record<string, Runtime>>)[name]!;
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

test("runtime: a named type parses a request body and names the bad path", async () => {
  const LineItem = await load(checkout, "LineItem");
  const PaymentId = await load(checkout, "PaymentId");
  assert.deepEqual(LineItem.parse(keyboard), keyboard);
  assert.ok(Object.isFrozen(LineItem.parse(keyboard)));
  assert.equal(PaymentId.parse("pi_1"), "pi_1");
  assert.throws(
    () => LineItem.parse({ ...keyboard, quantity: "3" }),
    (error) => error instanceof TypeError && error.message === "LineItem.quantity: expected Int, found \"3\"",
  );
  assert.throws(
    () => PaymentId.parse(3),
    (error) => error instanceof TypeError && error.message === "PaymentId: expected String, found 3",
  );
});

test("runtime: a tagged union decodes the variant its tag names", async () => {
  const Pay = await load(payments, "Pay");
  assert.deepEqual(Pay.parse({ tag: "Card", last4: "4242" }), { tag: "Card", last4: "4242", saved: null });
  assert.deepEqual(Pay.parse({ tag: "Cash" }), { tag: "Cash" });
  assert.ok(Object.isFrozen(Pay.parse({ tag: "Transfer", reference: "r1" })));
  const rejects = (input: unknown, message: string) =>
    assert.throws(() => Pay.parse(input), (error) => error instanceof TypeError && error.message === message);
  rejects({ tag: "Cheque" }, "Pay.tag: expected \"Card\" | \"Transfer\" | \"Cash\", found \"Cheque\"");
  rejects({ tag: "Card" }, "Pay.last4: expected String, found nothing");
  rejects({ tag: "Cash", last4: "4242" }, "Pay: unexpected field last4");
  rejects("Cash", "Pay: expected Pay, found \"Cash\"");
});

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
  const Gauge = await load(gauge, "Gauge");
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

const analysis = analyze(checkout);
const at = (text: string, nth = 0) => {
  let index = -1;
  for (let seen = 0; seen <= nth; seen++) index = checkout.indexOf(text, index + 1);
  assert.notEqual(index, -1, `${text} is not in checkout.domain`);
  return index;
};

test("lsp: every declaration kind is a definition of the kind it becomes in TypeScript", () => {
  const kinds = (name: string) =>
    analysis.definitions.filter((definition) => definition.name === name).map(({ kind }) => kind);
  assert.deepEqual(analysis.diagnostics, []);
  assert.deepEqual(
    [
      ...["Order", "Carrier", "Post", "LineItem", "sku", "pay", "Paid"].map(kinds),
      [...new Set(kinds("paymentId"))],
    ].flat(),
    ["namespace", "enum", "enumMember", "interface", "property", "method", "class", "parameter", "property"],
  );
});

test("lsp: go to definition follows clauses, targets, spreads and type names", () => {
  const definition = (offset: number) => {
    const found = definitionAt(analysis, offset)!;
    return `${found.kind} ${checkout.slice(found.span.start, found.span.end)} at ${found.span.start}`;
  };
  assert.equal(definition(at("on ship") + 3), `method ship at ${at("event ship") + 6}`);
  assert.equal(definition(at("-> Paid") + 3), `class Paid at ${at("state Paid") + 6}`);
  assert.equal(definition(at("...Placed") + 3), `interface Placed at ${at("type Placed") + 5}`);
  assert.equal(definition(at("[LineItem]") + 1), `interface LineItem at ${at("type LineItem") + 5}`);
  assert.equal(definition(at("carrier : Carrier") + 10), `enum Carrier at ${at("type Carrier") + 5}`);
});

test("lsp: hover shows the data flow on a clause and the definition on a name", () => {
  const hover = (offset: number) => typeAt(analysis, offset)?.type;
  assert.equal(hover(at("on pay") + 3), "Checkout -> Paid: carries items, address; pay gives paymentId, paidAt");
  assert.equal(hover(at("on cancel -> Cancelled") + 3), "Cart -> Cancelled: cancel gives reason; refundId starts null");
  assert.equal(
    hover(at("-> Paid") + 3),
    "state Paid = { items : [LineItem], address : Address, paymentId : PaymentId, paidAt : String }",
  );
  assert.equal(hover(at("event pay") + 6), "event pay(paymentId : PaymentId, paidAt : String)");
  assert.equal(hover(at("[LineItem]") + 1), "type LineItem = { sku : Sku, quantity : Int, cents : Int }");
  assert.equal(hover(at("paymentId : PaymentId,") + 12), "brand PaymentId = String");
  assert.equal(hover(at("carrier : Carrier") + 10), "type Carrier = Post | Courier");
  assert.equal(
    hover(at("final state Delivered") + 12),
    "final state Delivered = { items : [LineItem], address : Address, deliveredAt : String }",
  );
});

test("lsp: a file with an error still has definitions and one diagnostic", () => {
  const broken = edit("-> End", "-> Edn");
  const result = analyze(broken);
  assert.deepEqual(result.diagnostics.map(({ message }) => message), ["Unknown state: Edn"]);
  assert.equal(definitionAt(result, broken.indexOf("on go") + 3)?.name, "go");
  assert.equal(definitionAt(result, broken.indexOf("state Middle") + 6)?.kind, "class");
});

test("lsp: keywords and operators highlight, and names take the kind of their definition", () => {
  const kinds = new Map(semanticTokens(analysis).map(({ span, kind }) => [span.start, kind]));
  assert.equal(kinds.get(at("initial")), "keyword");
  assert.equal(kinds.get(at("|>")), "operator");
  assert.equal(kinds.get(at("->")), "operator");
  assert.equal(kinds.get(at("...")), "operator");
  assert.equal(kinds.get(at("Paid") + 0), "class");
  assert.equal(kinds.get(at("// An order")), undefined);
});

const shopFile = (name: string) => new URL(`../examples/domain/${name}`, import.meta.url);
const commerce = readFileSync(shopFile("commerce.domain"), "utf8");
const order = readFileSync(shopFile("order.domain"), "utf8");

const files = (overrides: Readonly<Record<string, string>>) => ({
  uri: shopFile("order.domain").href,
  read: (uri: string) => overrides[uri] ?? readFileSync(new URL(uri), "utf8"),
});

const spanOf = (source: string, text: string, from = 0) => {
  const start = source.indexOf(text, from);
  assert.notEqual(start, -1, `${text} is not in the source`);
  return { start, end: start + text.length };
};

test("modules: an error in an imported file lands on the import line, and the original is related", () => {
  const broken = commerce.replace("sku : Sku,", "sku : Skuu,");
  const result = checkSource(order, files({ [shopFile("commerce.domain").href]: broken }));
  assert.ok(!result.success);
  const [error] = result.errors;
  assert.equal(result.errors.length, 1);
  assert.equal(error.message, "Unknown type: Skuu");
  assert.deepEqual(error.location, {
    uri: shopFile("order.domain").href,
    span: spanOf(order, order.slice(0, order.indexOf("\n"))),
  });
  assert.deepEqual(error.related?.at(-1), {
    location: { uri: shopFile("commerce.domain").href, span: spanOf(broken, "Skuu") },
    message: "Original diagnostic",
  });
});

test("modules: an import names only what the file exports", () => {
  const source = order.replace("CancelReason, Carrier", "CancelReason, Carier");
  const result = checkSource(source, files({}));
  assert.ok(!result.success);
  assert.deepEqual(
    result.errors.map(({ message, span }) => [message, source.slice(span!.start, span!.end)]),
    [
      ["Unknown export: ./commerce.domain has no Carier", "Carier"],
      ...Array(3).fill(["Unknown type: Carrier", "Carrier"]),
    ],
  );
});

test("lsp: go to definition and hover cross into the imported file", () => {
  const analysis = analyze(order, files({}));
  assert.deepEqual(analysis.diagnostics, []);
  const definition = definitionAt(analysis, order.indexOf("[LineItem]") + 1)!;
  assert.equal(definition.uri, shopFile("commerce.domain").href);
  assert.deepEqual(definition.span, spanOf(commerce, "LineItem", commerce.indexOf("type LineItem")));
  assert.equal(
    typeAt(analysis, order.indexOf("[LineItem]") + 1)?.type,
    "type LineItem = { sku : Sku, quantity : Int, price : Cents }",
  );
  assert.equal(typeAt(analysis, order.indexOf("OrderId"))?.type, "brand OrderId = String");
  assert.equal(analysis.sources?.get(shopFile("commerce.domain").href), commerce);
});

test("host: imported types print through import type lines, renamed when a local name would shadow them", () => {
  const { text } = project(host.host(order, shopFile("order.domain").href).declarations);
  assert.ok(
    text.startsWith(
      "import type { Address, CancelReason, Carrier, LineItem, OrderId, PaymentId } from \"./commerce.domain\";\n",
    ),
    text,
  );
  const shadowing = "import { Placed } from \"./commerce.domain\"\n\ntype Address = { street : String }\n"
    + "machine Box { event close initial state Open = { ...Placed, at : Address } |> on close -> Shut final state Shut }\n";
  const projected = project(host.host(shadowing, shopFile("box.domain").href).declarations).text;
  assert.ok(
    projected.includes("import type { Address as Address$2, LineItem } from \"./commerce.domain\";\n"),
    projected,
  );
  assert.ok(projected.includes("    readonly address: Address$2;\n    readonly at: Address;\n"), projected);
});

test("runtime: a module's tables close over imported types, so it runs importing only the runtime", async () => {
  const file = pathToFileURL(join(scratch, `module-${modules++}.mjs`));
  const { javascript, diagnostics } = host.host(order, shopFile("order.domain").href);
  assert.deepEqual(diagnostics, []);
  writeFileSync(
    file,
    javascript!().replace(
      /from "[^"]*runtime\.ts"/,
      `from "${new URL("../examples/domain/runtime.ts", import.meta.url).href}"`,
    ),
  );
  const { Order } = (await import(file.href)) as Readonly<Record<string, Runtime>>;
  const cart = Order!.start({ id: "ord_1", items: [{ sku: "kbd-60", quantity: 1, price: 12900 }] });
  assert.throws(
    () => fire(cart, "edit", { items: [{ sku: "kbd-60", quantity: 1, price: 1.5 }] }),
    /Order\.Cart\.edit\.items\[0\]\.price: expected Int, found 1\.5/,
  );
});
