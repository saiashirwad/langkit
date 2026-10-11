import type { Result } from "langkit/check";
import type { Program, Value } from "langkit/ir";
import assert from "node:assert/strict";
import { test } from "node:test";
import { compile as compileHM } from "../examples/hm/hm.ts";
import { compile as compileRows } from "../examples/rows/rows.ts";

function initializers<T>(program: Program<T>): readonly Value<T>[] {
  const result: Value<T>[] = [];
  const tasks = [program.body];
  const descriptors = new Map(program.operations.map(descriptor => [descriptor.id, descriptor]));
  while (tasks.length) {
    const body = tasks.pop()!;
    for (const declaration of body.declarations) result.push(declaration.value);
    const values = [...body.declarations.map(declaration => declaration.value), body.result];
    while (values.length) {
      const value = values.pop()!;
      const descriptor = descriptors.get(value.operationId)!;
      values.push(...descriptor.children(value.node));
      tasks.push(...descriptor.scopedBodies(value.node).map(scoped => scoped.body));
    }
  }
  return result;
}

function checkOrigins<T>(name: string, compile: (source: string) => Result<{ readonly ir: Program<T>; }>): void {
  for (const source of ["let x = 1 in x", "let x = (let y = 1 in y) in x"]) {
    test(`${name} retains let-initializer IR origins: ${source}`, () => {
      const compiled = compile(source);
      assert(compiled.success);
      const literals = initializers(compiled.value.ir).filter(value => value.node.kind === "literal");
      assert.equal(literals.length, 1);
      const span = literals[0]!.span;
      assert(span);
      assert.equal(span.start, source.indexOf("1"));
      assert.equal(source.slice(span.start, span.end).trim(), "1");
    });
  }
}

checkOrigins("HM", compileHM);
checkOrigins("Rows", compileRows);
