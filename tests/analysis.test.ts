import assert from "node:assert/strict"
import { test } from "node:test"
import { readFileSync } from "node:fs"
import { check, fail, pure, run } from "langkit"
import { create, definitionAt, highlight, semanticTokens, typeAt } from "langkit/analysis"
import { analyze, compile, show } from "../examples/toy.ts"

const main = readFileSync(new URL("../examples/main.toy", import.meta.url), "utf8")

test("the example has hover types and definitions without emitting code", () => {
  const analysis = analyze(main)
  assert.deepEqual(analysis.diagnostics, [])
  const twice = main.indexOf("twice(inc)")
  assert.equal(show(typeAt(analysis, twice)!.type), "((number -> number) -> (number -> number))")
  const inc = main.indexOf("inc)(40)")
  const definition = definitionAt(analysis, inc)!
  assert.equal(definition.name, "inc")
  assert.equal(definition.span.start, main.indexOf("inc ="))
  assert.equal(main.slice(definition.span.start, definition.span.end), "inc")
})

test("definition identities distinguish shadowed names", () => {
  const source = "let x = 1 in (let x = x + 1 in x) + x"
  const analysis = analyze(source)
  const outer = source.indexOf("x =")
  const inner = source.indexOf("x =", outer + 1)
  assert.equal(definitionAt(analysis, source.indexOf("x + 1"))!.span.start, outer)
  assert.equal(definitionAt(analysis, source.indexOf("x)"))!.span.start, inner)
  assert.equal(definitionAt(analysis, source.lastIndexOf("x"))!.span.start, outer)
  assert.notEqual(definitionAt(analysis, inner)!.id, definitionAt(analysis, outer)!.id)
})

test("closures refer to captured bindings rather than later shadowing", () => {
  const source = "let x = 1 in let f = fn(y: number) => x + y in let x = 2 in f(x)"
  const analysis = analyze(source)
  assert.equal(definitionAt(analysis, source.indexOf("x + y"))!.span.start, source.indexOf("x ="))
  assert.equal(definitionAt(analysis, source.lastIndexOf("x"))!.span.start, source.lastIndexOf("x ="))
  assert.equal(definitionAt(analysis, source.indexOf("y in"))!.span.start, source.indexOf("y:"))
})

test("identifier spans exclude whitespace and definition queries are half-open", () => {
  const source = "let value  = 1 in value  "
  const analysis = analyze(source)
  const start = source.lastIndexOf("value")
  assert.deepEqual(typeAt(analysis, start)!.span, { start, end: start + 5 })
  assert.equal(definitionAt(analysis, start + 5), undefined)
  assert.equal(definitionAt(analysis, source.indexOf("  =")), undefined)
})

test("hover chooses the smallest typed expression", () => {
  const source = "(1 + 2) > 0"
  const analysis = analyze(source)
  assert.equal(show(typeAt(analysis, source.indexOf("1"))!.type), "number")
  assert.equal(show(typeAt(analysis, source.indexOf(">"))!.type), "boolean")
})

test("checking errors retain earlier facts without inventing successful parent types", () => {
  const source = "let x = 1 in x + true"
  const analysis = analyze(source)
  assert.equal(analysis.diagnostics[0]!.message, "Expected number, found boolean")
  assert.equal(show(typeAt(analysis, source.lastIndexOf("x"))!.type), "number")
  assert.equal(show(typeAt(analysis, source.indexOf("true"))!.type), "boolean")
  assert.equal(typeAt(analysis, source.indexOf("+")), undefined)
  assert.equal(definitionAt(analysis, source.lastIndexOf("x"))!.name, "x")
})

test("syntax errors still receive lexical highlighting", () => {
  const source = "let double = fn(x: number) => x +"
  const analysis = analyze(source)
  assert.equal(analysis.diagnostics.length, 1)
  assert.equal(analysis.definitions.length, 0)
  assert.equal(analysis.types.length, 0)
  const highlighted = semanticTokens(analysis).map(token => [source.slice(token.span.start, token.span.end), token.kind])
  assert.deepEqual(highlighted, [
    ["let", "keyword"], ["double", "variable"], ["=", "operator"],
    ["fn", "keyword"], ["x", "variable"], ["number", "type"],
    ["=>", "operator"], ["x", "variable"], ["+", "operator"]
  ])
})

test("checking refines lexical names to function and parameter roles", () => {
  const source = "let inc = fn(x: number) => x + 1 in inc(2)"
  const analysis = analyze(source)
  const tokens = semanticTokens(analysis)
  const roles = tokens.filter(token => ["inc", "x"].includes(source.slice(token.span.start, token.span.end)))
  assert.deepEqual(roles.map(token => token.kind), ["function", "parameter", "parameter", "function"])
  for (let i = 1; i < tokens.length; i++) assert.ok(tokens[i - 1]!.span.end <= tokens[i]!.span.start)
})

test("lexical rules preserve UTF-16 offsets after unexpected Unicode and CRLF", () => {
  const source = "😀\r\nlet x = 42"
  const tokens = analyze(source).tokens
  assert.deepEqual(tokens[0], { kind: "keyword", span: { start: 4, end: 7 } })
  assert.deepEqual(tokens.at(-1), { kind: "number", span: { start: 12, end: 14 } })
})

test("highlight rules are ordered, reusable, and must consume input", () => {
  const rule = { pattern: /\w+/g, kind: "variable" as const }
  rule.pattern.lastIndex = 10
  assert.deepEqual(highlight("x", [rule]), [{ kind: "variable", span: { start: 0, end: 1 } }])
  assert.equal(rule.pattern.lastIndex, 10)
  assert.throws(() => highlight("x", [{ pattern: /\s*/, kind: "keyword" }]), /must consume/)
  assert.deepEqual(highlight("x", [
    { pattern: /x/, kind: () => undefined }, rule
  ]), [])
})

test("reference identity does not impose the declaration type on its use", () => {
  const facts = create<string>()
  const binding = { id: Symbol("id"), name: "id", type: "a -> a" }
  const declaration = { start: 0, end: 2 }
  const use = { start: 3, end: 5 }
  const identityOnly = facts.collect(facts.reference(binding, use)).analysis
  assert.deepEqual(identityOnly.types, [])
  const analysis = facts.collect(check(function* () {
    yield* facts.define(binding, declaration, "function")
    yield* facts.reference({ id: binding.id }, use)
    yield* facts.typed("number -> number", use)
  })).analysis
  assert.equal(typeAt(analysis, 0)!.type, "a -> a")
  assert.equal(typeAt(analysis, 3)!.type, "number -> number")
  assert.equal(definitionAt(analysis, 3)!.id, binding.id)
})

test("collect is optional and isolated between runs, including errors", () => {
  const facts = create<string>()
  const body = check(function* () {
    yield* facts.typed("number", { start: 0, end: 1 })
    return yield* fail("no")
  })
  assert.equal(run(body).success, false)
  const first = facts.collect(body).analysis
  assert.equal(first.types.length, 1)
  assert.equal(first.diagnostics.length, 1)
  const empty = facts.collect(pure(42)).analysis
  assert.equal(empty.types.length, 0)
  assert.equal(empty.diagnostics.length, 0)
  assert.equal(facts.collect(body).analysis.types.length, 1)
  assert.equal(first.types.length, 1)
})

test("separate source analyses and compilation do not share facts", () => {
  const first = analyze("let x = 1 in x")
  const compiled = compile("let x = 1 in x")
  assert.equal(compiled.success, true)
  const second = analyze("x")
  assert.equal(second.definitions.length, 0)
  assert.equal(second.references.length, 0)
  assert.equal(second.diagnostics[0]!.message, "Unbound variable: x")
  assert.equal(first.definitions.length, 1)
  assert.equal(first.references.length, 1)
})
