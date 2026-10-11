import type { Span } from "./diagnostic.ts";

const dataType: unique symbol = Symbol("syntax.dataType");
const binderBrand: unique symbol = Symbol("syntax.binder");
const binders = new WeakSet<object>();

export type SyntaxBinder = {
  readonly id: symbol;
  readonly name: string;
  readonly [binderBrand]: true;
};

export type DataField<T, Optional extends boolean = false> = {
  readonly tag: "data";
  readonly optional: Optional;
  readonly [dataType]?: T;
};
export type BinderField = { readonly tag: "binder"; };
export type ChildField = {
  readonly tag: "child" | "children" | "entries";
  readonly binds: readonly string[];
};
export type SyntaxField = DataField<unknown, boolean> | BinderField | ChildField;
export type SyntaxFields = Readonly<Record<string, SyntaxField>>;
export type SyntaxNodeDeclaration = {
  readonly kind: string;
  readonly fields: SyntaxFields;
};
export type SyntaxDeclarations = Readonly<Record<string, SyntaxNodeDeclaration>>;

type BinderKeys<F extends SyntaxFields> =
  & {
    [K in keyof F]: F[K] extends BinderField ? K : never;
  }[keyof F]
  & string;
type CheckedFields<F extends SyntaxFields> = {
  [K in keyof F]: F[K] extends ChildField ? F[K] & { readonly binds: readonly BinderKeys<F>[]; }
    : F[K];
};
type OptionalKeys<F extends SyntaxFields> = {
  [K in keyof F]: F[K] extends DataField<unknown, true> ? K : never;
}[keyof F];
export type SyntaxData<T> = T extends object ? { readonly [K in keyof T]: SyntaxData<T[K]>; } : T;
type FieldValue<D extends SyntaxDeclarations, F extends SyntaxField> = F extends DataField<infer T, boolean>
  ? SyntaxData<T>
  : F extends BinderField ? SyntaxBinder
  : F extends { readonly tag: "children"; } ? readonly SyntaxNode<D>[]
  : F extends { readonly tag: "entries"; } ? readonly LabelledChild<SyntaxNode<D>>[]
  : SyntaxNode<D>;
type NodeFields<D extends SyntaxDeclarations, F extends SyntaxFields> =
  & {
    readonly [K in Exclude<keyof F, OptionalKeys<F>>]: FieldValue<D, F[K]>;
  }
  & {
    readonly [K in OptionalKeys<F>]?: FieldValue<D, F[K]>;
  };

export type LabelledChild<N> = { readonly label: string; readonly child: N; };
export type SyntaxIdentity = { readonly id: symbol; readonly span?: Span; };
export type SyntaxVariant<D extends SyntaxDeclarations, K extends keyof D> =
  & SyntaxIdentity
  & { readonly kind: K; }
  & NodeFields<D, D[K]["fields"]>;
export type SyntaxNode<D extends SyntaxDeclarations> = {
  [K in keyof D]: SyntaxVariant<D, K>;
}[keyof D];
export type NodeOf<S extends { readonly declarations: SyntaxDeclarations; }> = SyntaxNode<S["declarations"]>;
export type ChildEdge<N> = {
  readonly child: N;
  readonly field: string;
  readonly index?: number;
  readonly label?: string;
  readonly binders: readonly SyntaxBinder[];
};
export type ScopedVisit<N> = {
  readonly scope: readonly SyntaxBinder[];
  readonly parent?: N;
  readonly edge?: ChildEdge<N>;
};
export type SyntaxSchema<D extends SyntaxDeclarations> = {
  readonly declarations: D;
  readonly make: {
    readonly [K in keyof D]: (
      fields: NodeFields<D, D[K]["fields"]>,
      source?: { readonly span?: Span; },
    ) => SyntaxVariant<D, K>;
  };
  children(node: SyntaxNode<D>): readonly ChildEdge<SyntaxNode<D>>[];
  visitChildren(node: SyntaxNode<D>, visit: (child: SyntaxNode<D>, edge: ChildEdge<SyntaxNode<D>>) => void): void;
  map<N extends SyntaxNode<D>>(
    node: N,
    transform: (child: SyntaxNode<D>, edge: ChildEdge<SyntaxNode<D>>) => SyntaxNode<D>,
  ): Extract<SyntaxNode<D>, { readonly kind: N["kind"]; }>;
  walkScoped(node: SyntaxNode<D>, visit: (node: SyntaxNode<D>, context: ScopedVisit<SyntaxNode<D>>) => void): void;
};

const reserved = new Set(["kind", "id", "span"]);

function snapshot(value: unknown, active = new Set<object>()): unknown {
  if (typeof value === "function") throw new TypeError("Syntax data must be plain immutable data");
  if (value === null || typeof value !== "object") return value;
  if (active.has(value)) throw new TypeError("Cyclic syntax data");
  if (
    !Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null
  ) {
    throw new TypeError("Syntax data must be plain immutable data");
  }
  active.add(value);
  const copy: unknown = Array.isArray(value)
    ? value.map(item => snapshot(item, active))
    : Object.fromEntries(Reflect.ownKeys(value).map(key => [key, snapshot(Reflect.get(value, key), active)]));
  active.delete(value);
  return Object.freeze(copy);
}

function node<const K extends string, const F extends SyntaxFields>(kind: K, fields: F & CheckedFields<F>): {
  readonly kind: K;
  readonly fields: F;
} {
  return Object.freeze({ kind, fields: snapshot(fields) as F });
}

function child<const T extends ChildField["tag"], const B extends readonly string[]>(tag: T, binds: B): {
  readonly tag: T;
  readonly binds: B;
} {
  return Object.freeze({ tag, binds: Object.freeze([...binds]) as unknown as B });
}

export const syntax = Object.freeze({
  node,
  data<T>(): DataField<T> {
    return Object.freeze({ tag: "data", optional: false });
  },
  optionalData<T>(): DataField<T, true> {
    return Object.freeze({ tag: "data", optional: true });
  },
  binder(): BinderField {
    return Object.freeze({ tag: "binder" });
  },
  binding(name: string): SyntaxBinder {
    if (typeof name !== "string") throw new TypeError("Binder name must be a string");
    const result = Object.freeze({ id: Symbol(name), name, [binderBrand]: true as const });
    binders.add(result);
    return result;
  },
  child: () => child("child", [] as const),
  children: () => child("children", [] as const),
  entries: () => child("entries", [] as const),
  scopedChild: <const B extends readonly string[]>(options: { readonly binds: B; }) => child("child", options.binds),
  scopedChildren: <const B extends readonly string[]>(options: { readonly binds: B; }) =>
    child("children", options.binds),
  scopedEntries: <const B extends readonly string[]>(options: { readonly binds: B; }) =>
    child("entries", options.binds),
});

type RuntimeNode = SyntaxIdentity & { readonly kind: string; readonly [key: string]: unknown; };

export function defineSyntax<const D extends SyntaxDeclarations>(
  declarations:
    & D
    & {
      readonly [K in keyof D]: { readonly kind: K; readonly fields: CheckedFields<D[K]["fields"]>; };
    },
): SyntaxSchema<D> {
  if (!declarations || typeof declarations !== "object" || Array.isArray(declarations)) {
    throw new TypeError("Expected syntax declaration record");
  }
  const saved = snapshot(declarations) as D;
  if (Reflect.ownKeys(saved).some(key => typeof key !== "string")) {
    throw new TypeError("Syntax kinds must be string keys");
  }
  const kinds = new Set<string>();
  for (const [key, declaration] of Object.entries(saved)) {
    if (
      !declaration || typeof declaration.kind !== "string" || !declaration.fields
      || typeof declaration.fields !== "object" || Array.isArray(declaration.fields)
    ) {
      throw new TypeError("Invalid syntax declaration");
    }
    if (kinds.has(declaration.kind)) throw new TypeError(`Duplicate syntax kind: ${declaration.kind}`);
    kinds.add(declaration.kind);
    if (key !== declaration.kind) throw new TypeError(`Syntax key ${key} must match kind ${declaration.kind}`);
    if (Reflect.ownKeys(declaration.fields).some(key => typeof key !== "string")) {
      throw new TypeError("Syntax fields must be string keys");
    }
    for (const [field, descriptor] of Object.entries(declaration.fields)) {
      if (reserved.has(field)) throw new TypeError(`Reserved syntax field: ${field}`);
      if (!descriptor || !["data", "binder", "child", "children", "entries"].includes(descriptor.tag)) {
        throw new TypeError(`Invalid syntax field: ${field}`);
      }
      if (descriptor.tag === "data" && typeof descriptor.optional !== "boolean") {
        throw new TypeError(`Invalid optional data field: ${field}`);
      }
      if (descriptor.tag === "child" || descriptor.tag === "children" || descriptor.tag === "entries") {
        if (!Array.isArray(descriptor.binds) || new Set(descriptor.binds).size !== descriptor.binds.length) {
          throw new TypeError(`Invalid binds for ${field}`);
        }
        for (const bound of descriptor.binds) {
          if (typeof bound !== "string" || declaration.fields[bound]?.tag !== "binder") {
            throw new TypeError(`Scope ${field} selects non-binder field: ${String(bound)}`);
          }
        }
      }
    }
  }
  const members = new WeakSet<object>();
  function assertNode(value: unknown): asserts value is RuntimeNode {
    if (!value || typeof value !== "object" || !members.has(value)) {
      throw new TypeError("Node does not belong to this syntax schema");
    }
  }
  function construct(
    kind: string,
    input: Readonly<Record<string, unknown>>,
    identity: SyntaxIdentity,
    snapshotData = true,
  ): RuntimeNode {
    if (!input || typeof input !== "object") throw new TypeError("Expected syntax fields");
    const declaration = saved[kind];
    if (!declaration) throw new TypeError(`Unknown syntax kind: ${kind}`);
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== "string" || !Object.hasOwn(declaration.fields, key)) {
        throw new TypeError(`Unknown syntax field: ${String(key)}`);
      }
    }
    const output: Record<string, unknown> = Object.assign(Object.create(null), { kind, ...identity });
    for (const [field, descriptor] of Object.entries(declaration.fields)) {
      if (!Object.hasOwn(input, field)) {
        if (descriptor.tag === "data" && descriptor.optional) continue;
        throw new TypeError(`Missing syntax field: ${field}`);
      }
      const value = input[field];
      if (descriptor.tag === "data") output[field] = snapshotData ? snapshot(value) : value;
      else if (descriptor.tag === "binder") {
        if (!value || typeof value !== "object" || !binders.has(value)) {
          throw new TypeError(`Invalid binder: ${field}`);
        }
        output[field] = value;
      } else if (descriptor.tag === "child") {
        assertNode(value);
        output[field] = value;
      } else {
        if (!Array.isArray(value)) throw new TypeError(`Expected child list: ${field}`);
        output[field] = Object.freeze(Array.from(value, item => {
          if (descriptor.tag === "children") {
            assertNode(item);
            return item;
          }
          if (!item || typeof item !== "object" || typeof item.label !== "string") {
            throw new TypeError(`Invalid labelled child: ${field}`);
          }
          assertNode(item.child);
          return Object.freeze({ label: item.label, child: item.child });
        }));
      }
    }
    const result = Object.freeze(output) as RuntimeNode;
    members.add(result);
    return result;
  }
  function children(node: RuntimeNode): readonly ChildEdge<RuntimeNode>[] {
    assertNode(node);
    const edges: ChildEdge<RuntimeNode>[] = [];
    for (const [field, descriptor] of Object.entries(saved[node.kind]!.fields)) {
      if (descriptor.tag === "data" || descriptor.tag === "binder") continue;
      const binders = Object.freeze(descriptor.binds.map(key => node[key] as SyntaxBinder));
      if (descriptor.tag === "child") edges.push(Object.freeze({ field, child: node[field] as RuntimeNode, binders }));
      else if (descriptor.tag === "children") {
        (node[field] as readonly RuntimeNode[]).forEach((child, index) =>
          edges.push(Object.freeze({ field, child, index, binders }))
        );
      } else {
        (node[field] as readonly LabelledChild<RuntimeNode>[]).forEach(({ label, child }, index) =>
          edges.push(Object.freeze({ field, child, index, label, binders }))
        );
      }
    }
    return Object.freeze(edges);
  }
  const make = Object.fromEntries(
    Object.keys(saved).map(
      kind => [kind, (fields: Readonly<Record<string, unknown>>, source?: { readonly span?: Span; }) => {
        const identity: SyntaxIdentity = source?.span === undefined
          ? Object.freeze({ id: Symbol(kind) })
          : Object.freeze({ id: Symbol(kind), span: snapshot(source.span) as Span });
        return construct(kind, fields, identity);
      }],
    ),
  );
  function map(
    node: RuntimeNode,
    transform: (child: RuntimeNode, edge: ChildEdge<RuntimeNode>) => RuntimeNode,
  ): RuntimeNode {
    const edges = children(node);
    const fields: Record<string, unknown> = Object.fromEntries(
      Object.keys(saved[node.kind]!.fields).filter(key => Object.hasOwn(node, key)).map(key => [key, node[key]]),
    );
    let changed = false;
    for (const edge of edges) {
      const replacement = transform(edge.child, edge);
      assertNode(replacement);
      if (replacement === edge.child) continue;
      changed = true;
      if (edge.index === undefined) fields[edge.field] = replacement;
      else {
        const list = [...fields[edge.field] as readonly unknown[]];
        list[edge.index] = edge.label === undefined ? replacement : { label: edge.label, child: replacement };
        fields[edge.field] = list;
      }
    }
    return changed
      ? construct(
        node.kind,
        fields,
        node.span === undefined ? { id: node.id } : { id: node.id, span: node.span },
        false,
      )
      : node;
  }
  function walkScoped(root: RuntimeNode, visit: (node: RuntimeNode, context: ScopedVisit<RuntimeNode>) => void): void {
    assertNode(root);
    const stack: { node: RuntimeNode; context: ScopedVisit<RuntimeNode>; }[] = [{
      node: root,
      context: Object.freeze({ scope: Object.freeze([]) }),
    }];
    while (stack.length) {
      const { node, context } = stack.pop()!;
      visit(node, context);
      const edges = children(node);
      for (let index = edges.length - 1; index >= 0; index--) {
        const edge = edges[index]!;
        stack.push({
          node: edge.child,
          context: Object.freeze({ parent: node, edge, scope: Object.freeze([...context.scope, ...edge.binders]) }),
        });
      }
    }
  }
  return Object.freeze({
    declarations: saved,
    make: Object.freeze(make),
    children,
    visitChildren(node: RuntimeNode, visit: (node: RuntimeNode, edge: ChildEdge<RuntimeNode>) => void) {
      for (const edge of children(node)) visit(edge.child, edge);
    },
    map,
    walkScoped,
  }) as unknown as SyntaxSchema<D>;
}
