import { defineSyntax, syntax } from "../src/syntax.ts";
import type { NodeOf, SyntaxBinder } from "../src/syntax.ts";

const schema = defineSyntax({
  number: syntax.node("number", { value: syntax.data<number>() }),
  variable: syntax.node("variable", { name: syntax.data<string>() }),
  fn: syntax.node("fn", { param: syntax.binder(), body: syntax.scopedChild({ binds: ["param"] }) }),
  let: syntax.node("let", {
    name: syntax.binder(), value: syntax.child(), body: syntax.scopedChild({ binds: ["name"] }),
  }),
  pair: syntax.node("pair", { left: syntax.child(), right: syntax.child() }),
  record: syntax.node("record", { fields: syntax.entries(), note: syntax.optionalData<string>() }),
  call: syntax.node("call", { fn: syntax.child(), args: syntax.children() }),
});
type Node = NodeOf<typeof schema>;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type IsAny<T> = 0 extends 1 & T ? true : false;

const number = schema.make.number({ value: 1 });
const param = syntax.binding("x");
const fn = schema.make.fn({ param, body: number });
const record = schema.make.record({ fields: [{ label: "x", child: fn }] });
const pair = schema.make.pair({ left: record, right: number });
const tree = schema.make.let({ name: syntax.binding("id"), value: fn, body: pair });
const call = schema.make.call({ fn, args: [number, pair] });

type NumberKind = Assert<Equal<typeof number.kind, "number">>;
type NumberScalar = Assert<Equal<typeof number.value, number>>;
type NoAny = Assert<Equal<IsAny<Node>, false>>;
type NoAnyChild = Assert<Equal<IsAny<typeof fn.body>, false>>;
type Binder = Assert<Equal<typeof fn.param, SyntaxBinder>>;
type Body = Assert<Equal<typeof fn.body, Node>>;
type Optional = Assert<Equal<typeof record.note, string | undefined>>;
type Label = Assert<Equal<(typeof record.fields)[number]["label"], string>>;
type EntryChild = Assert<Equal<(typeof record.fields)[number]["child"], Node>>;
type Args = Assert<Equal<typeof call.args, readonly Node[]>>;
type Kinds = Assert<Equal<Node["kind"], "number" | "variable" | "fn" | "let" | "pair" | "record" | "call">>;
type Mapped = Assert<Equal<ReturnType<typeof mapNumber>, typeof number>>;
function mapNumber() { return schema.map(number, child => child); }

schema.map(tree, (child, edge) => {
  type Child = Assert<Equal<typeof child, Node>>;
  type EdgeChild = Assert<Equal<typeof edge.child, Node>>;
  if (child.kind === "number") {
    type Scalar = Assert<Equal<typeof child.value, number>>;
    return schema.make.number({ value: child.value + 1 });
  }
  return child;
});
schema.walkScoped(tree, (node, context) => {
  type Scope = Assert<Equal<typeof context.scope, readonly SyntaxBinder[]>>;
  if (node.kind === "fn") {
    type Param = Assert<Equal<typeof node.param, SyntaxBinder>>;
  }
});

// @ts-expect-error wrong scalar
schema.make.number({ value: "1" });
// @ts-expect-error wrong child
schema.make.fn({ param, body: 1 });
// @ts-expect-error wrong binder
schema.make.fn({ param: "x", body: number });
// @ts-expect-error missing field
schema.make.pair({ left: number });
// @ts-expect-error wrong optional data
schema.make.record({ fields: [], note: 1 });
// @ts-expect-error labelled children must contain nodes
schema.make.record({ fields: [{ label: "x", child: false }] });
// @ts-expect-error fields are immutable
number.value = 2;
// @ts-expect-error children are immutable
call.args.push(number);
// @ts-expect-error binds must select binder fields
syntax.node("bad", { value: syntax.data<string>(), body: syntax.scopedChild({ binds: ["value"] }) });
// @ts-expect-error binds must select existing fields
syntax.node("bad", { name: syntax.binder(), body: syntax.scopedChild({ binds: ["missing"] }) });
// @ts-expect-error key and kind must match
defineSyntax({ other: syntax.node("number", { value: syntax.data<number>() }) });
// @ts-expect-error direct declarations also check binder selections
defineSyntax({ bad: { kind: "bad", fields: { value: syntax.data<string>(), body: syntax.scopedChild({ binds: ["value"] }) } } });
const other = defineSyntax({ text: syntax.node("text", { value: syntax.data<string>() }) });
// @ts-expect-error selected schema rejects other child variant
schema.make.fn({ param, body: other.make.text({ value: "x" }) });

const literalSchema = defineSyntax({
  literal: syntax.node("literal", { value: syntax.data<"yes" | "no">(), info: syntax.data<{ items: number[] }>() }),
});
const literal = literalSchema.make.literal({ value: "yes", info: { items: [1] } });
type LiteralScalar = Assert<Equal<typeof literal.value, "yes" | "no">>;
type FrozenData = Assert<Equal<typeof literal.info, { readonly items: readonly number[] }>>;
// @ts-expect-error unknown scalar literal
literalSchema.make.literal({ value: "other", info: { items: [] } });
// @ts-expect-error nested data is immutable
literal.info.items.push(2);
