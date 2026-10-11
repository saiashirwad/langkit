# Strict

Strict is a small PureScript-inspired language experiment, **not** a compatible implementation of Haskell or PureScript. Ordinary evaluation is strict, not lazy. The compiler is [strict.ts](./strict.ts); [main.strict](./main.strict) is the default runnable program, and [stdlib.strict](./stdlib.strict) contains source-written data types, classes, instances, and functions.

```sh
pnpm strict                         # run main.strict
pnpm strict path/to/program.strict
```

## Types, classes, and dictionaries

The language supports algebraic data types, explicit polymorphic signatures, higher-kinded types, one-parameter type classes, instances, and inferred class constraints. Class declarations specify methods with explicit signatures:

```text
class Functor (f : Type -> Type) where {
  map : forall a b. (a -> b) -> f a -> f b;
}
```

A class method is elaborated to dictionary selection; constrained functions receive dictionary arguments during compilation. Dictionaries are ordinary records in the shared IR, not a runtime type-class system.

Kinds distinguish values from constructors: `number : Type`, while `List : Type -> Type`. Datatype parameter kinds are inferred from fields; unconstrained kinds default to `Type`. There is no kind polymorphism. The library declares `Option`, `Result`, and `List`, together with `Functor` and `Monad` and instances for `Option`, `List`, and `Effect`. Nothing from this source-written library is implicitly imported: use `import "./stdlib.strict";` when needed.

Instances apply only to closed nominal types/constructors or primitives. Duplicate instances, missing/extra methods, ambiguous or missing constraints, and incompatible method implementations are errors. Resolution does not guess an instance to determine an unknown type; no numeric/default-instance defaulting is provided. Instances are checked in source order before that module's value definitions. Methods may use prelude/earlier module bindings or local helpers, but not later dictionaries or same-module top-level helpers.

Inferred constrained bindings must be functions or aliases, not overloaded computed values. Recursive overloaded functions need a complete constrained signature. Constraints under arrows and constrained higher-rank parameters are unsupported; unconstrained higher-rank parameters are supported. The selected entry's constraints must resolve.

## Strict evaluation and explicit effects

`Effect a` is opaque to source programs. The following runtime primitives are available without an import:

| Primitive | Type | Role |
| --- | --- | --- |
| `print` | `forall a. a -> Effect {}` | Construct an action that prints a value. |
| `pureEffect` | `forall a. a -> Effect a` | Construct a completed action. |
| `bindEffect` | `forall a b. Effect a -> (a -> Effect b) -> Effect b` | Sequence actions. |

The library defines `Monad`, `pure`, and `bind` in source, including the `Effect` instance. A `do { ... }` block sequences actions; its final expression supplies the result:

```text
main = do {
  print answer;
  pure {};
};
```

Constructing `print 42` does not print. Runtime actions are functions taking an empty record; only explicit effects are delayed, while ordinary expressions still evaluate strictly. Pure arithmetic cannot consume an action, a record cannot impersonate `Effect`, and source code cannot call an action as a function or run it inside pure code. There are no effect rows.

The compiler produces the source result; it does not itself execute an effect action. The CLI executes an effect entry once under a VM timeout and does not print its returned value again. A pure entry is evaluated and displayed. Analysis never evaluates source or executes actions.

## Deliberate limits

This is a bounded teaching language, not a general Haskell/PureScript implementation. It has no instance contexts, superclasses, overlapping instances, deriving, associated types, or multi-parameter classes. There are no FFI, asynchronous effects, mutable references, tail-call optimization, or untrusted-code sandbox. See [strict.ts](./strict.ts), [main.strict](./main.strict), and [stdlib.strict](./stdlib.strict) for implementation, language tour, and library source.