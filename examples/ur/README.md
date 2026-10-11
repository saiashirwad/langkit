# Ur core

This runnable language is a first subset of Ur's core ideas with a new surface syntax. It is **not** an Ur/Web-compatible compiler and has no web features. References for the larger language are the [Ur core paper (PLDI 2010)](https://adam.chlipala.net/papers/UrPLDI10/UrPLDI10.pdf) and the [Ur manual](https://enn.github.io/urweb-doc/manual.html). The compiler is [ur.ts](./ur.ts), [main.ur](./main.ur) is the default program, and [folders.ur](./folders.ur) demonstrates ordered heterogeneous traversal.

```sh
pnpm ur                            # run main.ur
pnpm ur path/to/program.ur
pnpm ur:lsp                        # language server over stdio
```

## Explicit types and disjoint records

The language has rigid explicitly declared type parameters, type aliases, records, and named functions with optional blocks. A row is a type-level mapping of distinct labels to types. `Record<R>` requires `R : Row<Type>`; rows cannot contain duplicate labels, and record extension is statically disjoint. Generic functions state type parameters, kinds, and type applications explicitly rather than relying on Hindley–Milner inference; function arguments and results are annotated.

Records are exact, not width-subtyped: use a row parameter to accept extra fields. Row inference matches arguments left to right and can infer one unknown residual row at a time. A parameter containing multiple still-unknown rows is ambiguous: supply arguments that establish those rows first or provide explicit type arguments. Constraints are read left to right, so disjointness needed by a concatenation must be established by earlier constraints. Self-disjoint row hypotheses are conservatively rejected.

Kinds are `Type`, `Row<k>`, and right-associative kind arrows, including higher-order kinds. Only `Type` classifies runtime values. There is no kind polymorphism or kind inference: generic parameters default to `Type`, and other kinds must be explicit.

Transparent type functions can be higher-kinded and map a constructor over a row while retaining its labels. They are not assumed injective: a transparent function may discard its argument, so the checker does not invert neutral applications such as `F<A>` or mapped abstract rows such as `Map<F, R>`. Infer parameters from ordinary/unmapped arguments first or provide all generic arguments explicitly; phantom parameters also require explicit arguments. This is not a higher-order unifier and does not implement all of Ur's definitional equality or inference heuristics.

## Ordered heterogeneous traversal

`Folder<R>` is an opaque runtime traversal order indexed by `R : Row<Type>`. Construct one by listing every field of a **closed** row exactly once; missing, repeated, or unknown fields are errors. A folder, a mapped metadata record, and the value record together let callbacks process fields of differing types in explicit order:

```text
type Reading: Row<Type> = {
  temperature: number,
  station: string,
  active: boolean
};

let order = folder<Reading>(.station, .temperature, .active);
```

The [folder example](./folders.ur) passes this order with mapped metadata and a `Record<Reading>` to render the fields in that sequence.

This is a **fixed-accumulator subset**: accumulator `S` remains the same type through the traversal. Full Ur's row-indexed accumulator, field-name polymorphism, symbolic singleton rows, and field removal are not implemented. Ordinary records cannot impersonate folders; folder ordering is explicit, not inferred. The language has no formal soundness proof.

## Blocks, output, and runtime

Named functions may use statement blocks with local bindings and an output expression; [main.ur](./main.ur) and [folders.ur](./folders.ur) show block-form entry points. Runtime helpers include printing and text concatenation. Generic parameters and row proofs erase to ordinary closures and null-prototype records; the shared IR merge preserves left-to-right, once-only evaluation. The CLI runs trusted examples under a VM timeout, not a security sandbox.

## Deliberate limits

This dialect omits algebraic datatypes (including the proposed `Option<A>`), pattern matching, recursion, imports, field-name parameters, kind polymorphism, row-indexed folder accumulators, field removal, general impredicative polymorphism, constructor classes, signatures, modules, and functors. It is not full Ur with a syntax makeover; SQL, XML, HTTP, browser support, and the rest of Ur/Web are outside its goal. See [ur.ts](./ur.ts) for the implementation.