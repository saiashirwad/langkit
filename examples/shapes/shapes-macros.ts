import { check, fail, type Check, type Span } from "langkit";
import type { Form } from "./shapes-syntax.ts";

export const macroReserved = new Set([
  "true",
  "false",
  "fn",
  "let",
  "if",
  "def",
  "shape",
  "macro",
  "extend",
  "update",
  "select",
  "merge",
]);
export const macroName = (form: Form): Check<string> =>
  check(function* () {
    if (form.kind !== "symbol" || !/^[a-zA-Z_][\w?!-]*$/.test(form.value))
      return yield* fail("Expected a macro name or parameter name").at(form.span);
    if (macroReserved.has(form.value))
      return yield* fail(`Reserved binding name: ${form.value}`).at(form.span);
    return form.value;
  });

// Only expression identifiers are replaceable. Labels and type syntax are data;
// fn parameters and sequential let bindings introduce ordinary lexical scopes.
export const template = (
  root: Form,
  reference: (
    form: Form & { kind: "symbol" },
    bound: ReadonlySet<string>,
    callee: boolean,
  ) => Check<Form>,
  span?: Span,
  annotation?: (form: Form) => Check<void>,
): Check<Form> => check(function* () {
  let remaining = 10000;
  const visit = (form: Form, bound: ReadonlySet<string>, depth = 0, callee = false): Check<Form> =>
    check(function* () {
      if (--remaining < 0 || depth > 64)
        return yield* fail("Macro template resource limit exceeded");
      const at = span ?? form.span;
      if (form.kind === "symbol") return yield* reference({ ...form, span: at }, bound, callee);
      if (form.kind === "string") return { ...form, span: at };
      const items = [...form.items];
      const expr = (i: number, scope = bound) => visit(items[i]!, scope, depth + 1);
      const count = (n: number): Check<void> =>
        check(function* () {
          if (items.length !== n) yield* fail(`Macro template: expected ${n - 1} operands`);
        });
      const record = function* (): Generator<Check<unknown>, Form, unknown> {
        if (items.length % 2) return yield* fail("Record fields need name/value pairs");
        for (let i = 1; i < items.length; i += 2) items[i] = yield* expr(i);
        return { ...form, items, span: at };
      };
      if (form.kind === "record") return yield* check(record);
      if (form.kind !== "list" || !items.length)
        return yield* fail("Expected an expression in macro template");
      const head = items[0]!.kind === "symbol" ? items[0]!.value : undefined;
      if (head === "macro" || head === "shape" || head === "def")
        return yield* fail("Definitions are only allowed at the top level");
      if (head === "fn" || head === "let") {
        yield* count(3);
        const vector = items[1]!;
        if (vector.kind !== "vector" || (head === "fn" ? !vector.items.length : vector.items.length % 2))
          return yield* fail(`Invalid ${head} bindings in macro template`);
        const locals = new Set(bound);
        const bindings = [...vector.items];
        const seen = new Set<string>();
        for (let i = 0; i < bindings.length; i += head === "fn" ? 1 : 2) {
          const param = bindings[i]!;
          if (head === "fn" && param.kind === "list" && param.items.length !== 2)
            return yield* fail("Annotated parameter syntax: (name Type)");
          if (head === "fn" && param.kind === "list" && annotation)
            yield* annotation(param.items[1]!);
          const label = head === "fn" && param.kind === "list" ? param.items[0]! : param;
          const key = yield* macroName(label);
          if (head === "fn" && seen.has(key)) return yield* fail(`Duplicate parameter: ${key}`);
          seen.add(key);
          if (head === "let") bindings[i + 1] = yield* visit(bindings[i + 1]!, locals, depth + 1);
          locals.add(key);
        }
        items[1] = { ...vector, items: bindings, span: at };
        items[2] = yield* expr(2, locals);
      } else if (head === "." || head === "update" || head === "select") {
        yield* count(head === "update" ? 4 : 3);
        items[1] = yield* expr(1);
        if (head === "update") items[3] = yield* expr(3);
      } else {
        if (head === "if") yield* count(4);
        else if (head === "extend" || head === "merge") yield* count(3);
        else items[0] = yield* visit(items[0]!, bound, depth + 1, true);
        if (head === "extend" && items[2]!.kind !== "record")
          return yield* fail("Macro extend template needs a literal record; fields cannot be spliced");
        for (let i = 1; i < items.length; i++) items[i] = yield* expr(i);
      }
      return { ...form, items, span: at };
    }).at(span ?? form.span);
  return yield* visit(root, new Set());
});
