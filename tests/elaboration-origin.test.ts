import type { Result } from "langkit";
import type { Body, Value } from "langkit/ir";
import assert from "node:assert/strict";
import { test } from "node:test";
import { compile as compileHM } from "../examples/hm/hm.ts";

function initializers<T>(body: Body<T>): Value<T>[] {
  const nested = (value: Value<T>): Value<T>[] => {
    switch (value.kind) {
      case "binary":
        return [...nested(value.left), ...nested(value.right)];
      case "call":
        return [...nested(value.fn), ...nested(value.arg)];
      case "fn":
      case "block":
        return initializers(value.body);
      case "conditional":
        return [...nested(value.cond), ...initializers(value.then), ...initializers(value.else)];
      default:
        return [];
    }
  };
  return [
    ...body.declarations.flatMap((declaration) => [declaration.value, ...nested(declaration.value)]),
    ...nested(body.result),
  ];
}

function checkOrigins<T>(name: string, compile: (source: string) => Result<{ readonly body: Body<T>; }>): void {
  for (const source of ["let x = 1 in x", "let x = (let y = 1 in y) in x"]) {
    test(`${name} retains let-initializer IR origins: ${source}`, () => {
      const compiled = compile(source);
      assert(compiled.success);
      const literals = initializers(compiled.value.body).filter((value) => value.kind === "literal");
      assert.equal(literals.length, 1);
      const span = literals[0]!.span;
      assert(span);
      assert.equal(span.start, source.indexOf("1"));
      assert.equal(source.slice(span.start, span.end).trim(), "1");
    });
  }
}

checkOrigins("HM", compileHM);
