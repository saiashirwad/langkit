import { check, get, scoped, within, type Check } from "./check.ts"
import type { Span } from "./diagnostic.ts"

export type Operator = "+" | "-" | "*" | "/" | ">" | "=="

export type Binding<T> = {
  readonly id: symbol
  readonly name: string
  readonly type: T
}

export type Value<T> = {
  readonly type: T
  readonly node: Node<T>
  readonly span?: Span
}

export type Reference<T> = Value<T> & {
  readonly node: { readonly kind: "ref"; readonly binding: Binding<T> }
}

export type Node<T> =
  | { readonly kind: "literal"; readonly value: number | boolean | string }
  | { readonly kind: "record"; readonly fields: readonly { readonly name: string; readonly value: Value<T> }[]; readonly base?: Value<T> }
  | { readonly kind: "field"; readonly record: Value<T>; readonly name: string }
  | { readonly kind: "merge"; readonly left: Value<T>; readonly right: Value<T> }
  | { readonly kind: "print"; readonly value: Value<T> }
  | { readonly kind: "variant"; readonly tag: string; readonly fields: readonly Value<T>[] }
  | { readonly kind: "match"; readonly value: Value<T>; readonly cases: readonly MatchCase<T>[]; readonly fallback?: MatchFallback<T> }
  | { readonly kind: "ref"; readonly binding: Binding<T> }
  | { readonly kind: "binary"; readonly op: Operator; readonly left: Value<T>; readonly right: Value<T> }
  | { readonly kind: "call"; readonly fn: Value<T>; readonly arg: Value<T> }
  | { readonly kind: "fn"; readonly param: Binding<T>; readonly body: Body<T> }
  | { readonly kind: "if"; readonly cond: Value<T>; readonly then: Body<T>; readonly else: Body<T> }
  | { readonly kind: "block"; readonly body: Body<T> }

export type MatchCase<T> = {
  readonly tag: string
  readonly bindings: readonly Binding<T>[]
  readonly body: Body<T>
}

export type MatchFallback<T> = {
  readonly binding?: Binding<T>
  readonly body: Body<T>
}

export type Declaration<T> = {
  readonly recursive?: true
  readonly binding: Binding<T>
  readonly value: Value<T>
}

/** A constructed body, not the generator function that constructs it. */
export type Body<T> = {
  readonly declarations: readonly Declaration<T>[]
  readonly result: Value<T>
}

/** T belongs to the language. These constructors do not decide its typing rules. */
export const create = <T>() => {
  const output = scoped<Declaration<T>[] | undefined>(undefined)
  const value = (type: T, node: Node<T>): Value<T> => ({ type, node })
  const binding = (name: string, type: T): Binding<T> => ({ id: Symbol(name), name, type })
  // A polymorphic binding can have a different instantiated type at each use.
  const ref = (binding: Binding<T>, type: T = binding.type): Reference<T> =>
    ({ type, node: { kind: "ref", binding } })

  const body = (result: Check<Value<T>>): Check<Body<T>> => check(function* () {
    // Allocate on each run: a reusable Check never retains a previous body's statements.
    const declarations: Declaration<T>[] = []
    const returned = yield* within(output, declarations, result)
    return { declarations: [...declarations], result: returned }
  })

  const declare = (name: string, initial: Value<T>): Check<Reference<T>> => check(function* () {
    const declarations = yield* get(output)
    if (!declarations) throw new Error("IR declarations need an enclosing body")
    const target = binding(name, initial.type)
    declarations.push({ binding: target, value: initial })
    return ref(target)
  })

  return {
    binding,
    ref,
    body,
    declare,
    declareRecursive: (target: Binding<T>, initial: Value<T>): Check<Reference<T>> => check(function* () {
      if (initial.node.kind !== "fn") throw new Error("Recursive declarations require a function initializer")
      const declarations = yield* get(output)
      if (!declarations) throw new Error("IR declarations need an enclosing body")
      declarations.push({ binding: target, value: initial, recursive: true })
      return ref(target)
    }),
    variant: (type: T, tag: string, fields: readonly Value<T>[]): Value<T> =>
      value(type, { kind: "variant", tag, fields }),
    match: (type: T, matched: Value<T>, cases: readonly MatchCase<T>[], fallback?: MatchFallback<T>): Value<T> =>
      value(type, fallback ? { kind: "match", value: matched, cases, fallback } : { kind: "match", value: matched, cases }),
    literal: (type: T, literal: number | boolean | string): Value<T> => value(type, { kind: "literal", value: literal }),
    // Fields evaluate in source order, followed by the optional base.
    record: (type: T, fields: readonly { readonly name: string; readonly value: Value<T> }[], base?: Value<T>): Value<T> =>
      value(type, base ? { kind: "record", fields, base } : { kind: "record", fields }),
    // Languages must prove disjointness themselves; the IR only preserves evaluation order.
    merge: (type: T, left: Value<T>, right: Value<T>): Value<T> =>
      value(type, { kind: "merge", left, right }),
    field: (type: T, record: Value<T>, name: string): Value<T> => value(type, { kind: "field", record, name }),
    print: (type: T, printed: Value<T>): Value<T> => value(type, { kind: "print", value: printed }),
    binary: (type: T, op: Operator, left: Value<T>, right: Value<T>): Value<T> =>
      value(type, { kind: "binary", op, left, right }),
    call: (type: T, fn: Value<T>, arg: Value<T>): Value<T> => value(type, { kind: "call", fn, arg }),
    fn: (type: T, param: Binding<T>, body: Body<T>): Value<T> => value(type, { kind: "fn", param, body }),
    conditional: (type: T, cond: Value<T>, then: Body<T>, otherwise: Body<T>): Value<T> =>
      value(type, { kind: "if", cond, then, else: otherwise }),
    scope: (result: Check<Value<T>>): Check<Value<T>> =>
      body(result).map(body => value(body.result.type, { kind: "block", body })),
    at: (value: Value<T>, span: Span): Value<T> => ({ ...value, span })
  }
}

/** Structural scope checks only. Language-specific type verification belongs to T's owner. */
export const validate = <T>(root: Body<T>): void => {
  const declared = new Set<symbol>()

  const introduce = (binding: Binding<T>, visible: Set<symbol>) => {
    if (declared.has(binding.id)) throw new Error(`Binding declared twice: ${binding.name}`)
    declared.add(binding.id)
    visible.add(binding.id)
  }

  const body = (body: Body<T>, parent: ReadonlySet<symbol>, params: readonly Binding<T>[] = []) => {
    const visible = new Set(parent)
    for (const param of params) introduce(param, visible)
    for (const declaration of body.declarations) {
      if (declaration.recursive) {
        if (declaration.value.node.kind !== "fn") throw new Error("Recursive declarations require a function initializer")
        introduce(declaration.binding, visible)
      }
      visit(declaration.value, visible)
      if (!declaration.recursive) introduce(declaration.binding, visible)
    }
    visit(body.result, visible)
  }

  const visit = (value: Value<T>, visible: ReadonlySet<symbol>): void => {
    const node = value.node
    switch (node.kind) {
      case "literal": return
      case "variant":
        for (const field of node.fields) visit(field, visible)
        return
      case "match": {
        visit(node.value, visible)
        const tags = new Set<string>()
        for (const branch of node.cases) {
          if (tags.has(branch.tag)) throw new Error(`Duplicate match tag: ${branch.tag}`)
          tags.add(branch.tag)
          body(branch.body, visible, branch.bindings)
        }
        if (node.fallback) body(node.fallback.body, visible, node.fallback.binding ? [node.fallback.binding] : [])
        return
      }
      case "record":
        for (const field of node.fields) visit(field.value, visible)
        if (node.base) visit(node.base, visible)
        return
      case "field": return visit(node.record, visible)
      case "print": return visit(node.value, visible)
      case "ref":
        if (!visible.has(node.binding.id)) throw new Error(`Out-of-scope binding: ${node.binding.name}`)
        return
      case "merge":
      case "binary":
        visit(node.left, visible)
        visit(node.right, visible)
        return
      case "call":
        visit(node.fn, visible)
        visit(node.arg, visible)
        return
      case "fn": return body(node.body, visible, [node.param])
      case "block": return body(node.body, visible)
      case "if":
        visit(node.cond, visible)
        body(node.then, visible)
        body(node.else, visible)
    }
  }

  body(root, new Set())
}
