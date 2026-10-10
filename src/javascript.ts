import { validate, type Binding, type Body, type Value } from "./ir.ts"

/** Emit a JavaScript expression. Evaluating it returns the body's result. */
export const emit = <T>(root: Body<T>): string => {
  validate(root)
  const names = new Map<symbol, string>()

  const name = (binding: Binding<T>): string => {
    const known = names.get(binding.id)
    if (known) return known
    // A prefix and unique suffix avoid keywords, shadowing, and accidental capture.
    const hint = binding.name.replace(/[^a-zA-Z0-9_]/g, "_")
    const chosen = `_${hint}_${names.size}`
    names.set(binding.id, chosen)
    return chosen
  }

  const literal = (value: number | boolean): string => {
    if (typeof value === "boolean") return String(value)
    if (Object.is(value, -0)) return "-0"
    if (Number.isNaN(value)) return "(0 / 0)"
    if (value === Infinity) return "(1 / 0)"
    if (value === -Infinity) return "(-1 / 0)"
    return String(value)
  }

  const block = (body: Body<T>, depth: number): string => {
    const indent = "  ".repeat(depth + 1)
    return [
      "{",
      ...body.declarations.map(({ binding, value }) =>
        `${indent}const ${name(binding)} = ${expr(value, depth + 1)};`
      ),
      `${indent}return ${expr(body.result, depth + 1)};`,
      `${"  ".repeat(depth)}}`
    ].join("\n")
  }

  const expr = (value: Value<T>, depth: number): string => {
    const node = value.node
    switch (node.kind) {
      case "literal": return literal(node.value)
      case "ref": return name(node.binding)
      case "binary":
        return `(${expr(node.left, depth)} ${node.op === "==" ? "===" : node.op} ${expr(node.right, depth)})`
      case "call": return `(${expr(node.fn, depth)})(${expr(node.arg, depth)})`
      case "fn": return `((${name(node.param)}) => ${block(node.body, depth)})`
      case "block": return `(() => ${block(node.body, depth)})()`
      case "if":
        return `(${expr(node.cond, depth)} ? (() => ${block(node.then, depth)})() : (() => ${block(node.else, depth)})())`
    }
  }

  return `(() => ${block(root, 0)})()\n`
}
