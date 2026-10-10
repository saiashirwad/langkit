import assert from "node:assert/strict"
import { test } from "node:test"
import { runInNewContext } from "node:vm"
import { create, validate, type Value } from "langkit/ir"
import { emit } from "langkit/javascript"

const code = create<string>()
const body = (result: Value<string>) => ({ declarations: [], result })
const evaluate = (result: Value<string>, context = {}) => runInNewContext(emit(body(result)), context)

test("record fields evaluate once in source order before the base, which merges first", () => {
  const seen: unknown[] = []
  const effect = (label: string, value: Value<string>): Value<string> => ({
    type: value.type,
    node: { kind: "block", body: {
      declarations: [{ binding: code.binding(label, "unit"), value: code.print("unit", code.literal("string", label)) }],
      result: value
    } }
  })
  const result = evaluate(code.record("record", [
    { name: "x", value: effect("first", code.literal("number", 1)) },
    { name: "y", value: effect("second", code.literal("number", 2)) }
  ], effect("base", code.record("record", [
    { name: "x", value: code.literal("number", 99) },
    { name: "z", value: code.literal("number", 3) }
  ]))), { console: { log: (value: unknown) => seen.push(value) } })
  assert.deepEqual(seen, ["first", "second", "base"])
  assert.deepEqual(Object.entries(result), [["x", 1], ["z", 3], ["y", 2]])
  assert.equal(Object.getPrototypeOf(result), null)
})

test("record labels and string literals are escaped and have no inherited properties", () => {
  const labels = ["__proto__", "constructor", "toString", '\"]; throw new Error("injected"); //', "line\n\u2028break"]
  const value = '\"\\\n\r\t\u0000\u2028\u2029💩'
  for (const label of labels) {
    const record = code.record("record", [{ name: label, value: code.literal("string", value) }])
    assert.equal(evaluate(code.field("string", record, label)), value)
    const runtime = evaluate(record)
    assert.equal(Object.getPrototypeOf(runtime), null)
    assert.deepEqual(Object.keys(runtime), [label])
  }
  assert.equal(evaluate(code.field("unknown", code.record("record", []), "toString")), undefined)
})

test("print evaluates its operand once and returns an empty null-prototype record", () => {
  const seen: unknown[] = []
  const result = evaluate(code.print("unit", code.print("unit", code.literal("string", "hello"))), {
    console: { log: (value: unknown) => seen.push(value) }
  })
  assert.equal(seen.length, 2)
  assert.equal(seen[0], "hello")
  assert.equal(Object.getPrototypeOf(seen[1]), null)
  assert.deepEqual(Object.keys(seen[1] as object), [])
  assert.equal(Object.getPrototypeOf(result), null)
  assert.deepEqual(Object.keys(result), [])
  assert.notEqual(result, seen[1])
})

test("scope validation traverses every record, field, and print child", () => {
  const escaped = code.ref(code.binding("escaped", "number"))
  for (const result of [
    code.record("record", [{ name: "x", value: escaped }]),
    code.record("record", [], escaped),
    code.field("number", escaped, "x"),
    code.merge("record", escaped, code.record("record", [])),
    code.merge("record", code.record("record", []), escaped),
    code.print("unit", escaped)
  ]) {
    assert.throws(() => validate(body(result)), /Out-of-scope binding: escaped/)
    assert.throws(() => emit(body(result)), /Out-of-scope binding: escaped/)
  }
})

test("record merge evaluates each side once, left to right, without inherited properties", () => {
  const seen: unknown[] = []
  const side = (label: string, key: string, value: number): Value<string> => ({
    type: "record",
    node: { kind: "block", body: {
      declarations: [{ binding: code.binding(label, "unit"), value: code.print("unit", code.literal("string", label)) }],
      result: code.record("record", [{ name: key, value: code.literal("number", value) }])
    } }
  })
  const result = evaluate(code.merge("record", side("left", "__proto__", 20), side("right", "constructor", 22)), {
    console: { log: (value: unknown) => seen.push(value) }
  })
  assert.deepEqual(seen, ["left", "right"])
  assert.deepEqual(Object.entries(result), [["__proto__", 20], ["constructor", 22]])
  assert.equal(Object.getPrototypeOf(result), null)
})

test("record emission does not capture bindings named like its temporaries", () => {
  const binding = code.binding("field0", "number")
  const result = code.field("number", code.record("record", [{ name: "x", value: code.ref(binding) }]), "x")
  assert.equal(runInNewContext(emit({
    declarations: [{ binding, value: code.literal("number", 42) }], result
  })), 42)
})
