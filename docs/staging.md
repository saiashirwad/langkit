# Host-typed staging contracts

`langkit/staging` constructs typed JavaScript expressions without a source-language checker. `Expr<A>` denotes a host-known `A`; `Program<A>` contains declarations and an expression of that type. Their private invariant brands prevent structural construction and accidental widening.

## Constructors and emission

Literal constructors preserve literal denotations. `binary`, `unary`, `cond`, `object`, and `prop` construct expressions. `param` and `arrow` preserve parameter tuples and function results. `call` checks the argument tuple. `const` yields a declaration and returns a fresh reference; `build` collects declarations in order.

This complete example declares a function and calls it:

```ts
import * as S from "langkit/staging";
import { emitProgram } from "langkit/staging/javascript";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";

const program = S.build(function*() {
  const add = yield* S.const(
    "add",
    S.arrow({
      params: [S.param("x", S.Number)],
      body: function*([x]) {
        return S.binary("+", x, S.number(1));
      },
    }),
  );
  return S.call(add, S.number(41));
});

const javascript = emitProgram(program);
assert.equal(runInNewContext(javascript), 42);
```

`Number`, `String`, `Boolean`, `Unknown`, and `functionType` are runtime type witnesses. `Type<A>` preserves a specific denotation. `TypeWitness` accepts a witness of any denotation without claiming that denotation is known. `external(name, type)` supplies a host contract for a named global; it does not inspect the global's runtime value.

Runtime validation rejects forged expressions, statements, witnesses, and programs. It checks binding scope, declaration identity, and supported shapes. Object fields and projection use arbitrary string keys, including `__proto__`, as ordinary own properties.

Reusing a declaration builder creates a fresh declaration identity, including when its initializer is a function. Revisited function expressions retain their own lexical binder identities; validation checks captured references against each occurrence's scope. Duplicate identities within one body or across different lexical owners remain invalid.

Normal generator completion permits declarations yielded from `finally`. Forced closure after a rejected yield runs cleanup and rejects further yielded declarations. A cleanup exception supersedes the pending validation error.

The supported operations are finite primitive literals, arithmetic and comparison, strict equality, negation, lexical functions and calls, lazy conditionals, and objects with field access. Validation and emission use explicit work stacks. This does not make arbitrary recursive host callbacks stack-safe.

## IR adapter

`createStagingAdapter<T>(descriptors, hostType?)` from `langkit/adapters/staging` lowers a selected IR dialect into the local staging target. The adapter imports that target itself. No external constructor namespace, npm package, or sibling checkout is required.

The selected descriptor roles cover primitive core operations and optional records and projection. Runtime symbols determine membership. The adapter preserves declaration identity, evaluation order, lexical capture, lazy branches, and the guest type of each reference use.

`hostType` maps guest type data to `TypeWitness`; the default is `Unknown`. Local constructors validate supplied witnesses. A runtime guest annotation cannot discover a new TypeScript generic, so the lowered result remains `Program<unknown>`. `referenceUses` retains the guest binding and instantiated use type separately.

The adapter rejects recursion, record bases and merges, unsupported operations, duplicate bindings, and out-of-scope references. Direct host construction remains more precise than dynamic guest lowering.

The local implementation independently recreates a bounded construction pattern studied in TS Macros at `7e6a7624b999eee79a2289eed6a260a6625c7fa3`. No TS Macros implementation was copied. It does not implement guest macro expansion, hygiene, a generic overload engine, or a type-level source language.

`npm run staging:integration` constructs, lowers, emits, and executes the supported paths using only this repository.
