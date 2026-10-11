import { check, get, scoped, within, type Check } from "./check.ts";
import type { Span } from "./diagnostic.ts";
import { coreOperations } from "./operations/core.ts";
export type Operator = "+" | "-" | "*" | "/" | ">" | "==";

export type Binding<T> = { readonly id: symbol; readonly name: string; readonly type: T };
export type OperationNode = { readonly kind: string };
export type Value<T> = { readonly type: T; readonly node: OperationNode; readonly operationId: symbol; readonly span?: Span };
export type OperationValue<T, Node extends OperationNode> = Value<T> & { readonly node: Node };
export type Reference<T> = OperationValue<T, { readonly kind: "ref"; readonly binding: Binding<T> }>;
export type Declaration<T> = { readonly recursive?: true; readonly binding: Binding<T>; readonly value: Value<T> };
export type Body<T> = { readonly declarations: readonly Declaration<T>[]; readonly result: Value<T> };
export type Program<T> = {
  readonly body: Body<T>;
  readonly operations: readonly OperationTraversal<T>[];
  readonly coreFunctionId?: symbol;
};
export type MatchCase<T> = { readonly tag: string; readonly bindings: readonly Binding<T>[]; readonly body: Body<T> };
export type MatchFallback<T> = { readonly binding?: Binding<T>; readonly body: Body<T> };

/**
 * Descriptors own child order, scoped bindings, references and immutable reconstruction.
 * Core enforces recursive initialization separately by its own function descriptor identity.
 */
export type OperationTraversal<T> = {
  readonly id: symbol;
  readonly kind: string;
  readonly children: (node: OperationNode) => readonly Value<T>[];
  readonly scopedBodies: (node: OperationNode) => readonly { readonly body: Body<T>; readonly bindings: readonly Binding<T>[] }[];
  readonly references: (node: OperationNode) => readonly Binding<T>[];
  readonly map: (node: OperationNode, value: (child: Value<T>) => Value<T>, body: (child: Body<T>) => Body<T>, binding: (binding: Binding<T>) => Binding<T>) => OperationNode;
  readonly validate?: (node: OperationNode) => void;
};
export type OperationFeature<T, Methods extends object> = { readonly methods: Methods; readonly operations: readonly OperationTraversal<T>[] };
export type LanguageBuilder<T, Methods extends object> = Methods & {
  use<More extends object>(feature: OperationFeature<T, More>): LanguageBuilder<T, Methods & More>;
  operationTraversals(): readonly OperationTraversal<T>[];
  coreOperationTraversals(): readonly OperationTraversal<T>[];
  coreReferenceId(): symbol;
  coreFunctionId(): symbol;
  program(body: Body<T>): Program<T>;
  validate(root: Body<T>): void;
};
/** Narrow only values created by the given core reference descriptor instance. */
export const isReference = <T>(value: Value<T>, referenceOperationId: symbol): value is Reference<T> =>
  value.operationId === referenceOperationId && value.node.kind === "ref";

/** Core convenience builder includes only primitives; all richer operations are opt-in sets. */
export const create = <T>() => {
  const output = scoped<Declaration<T>[] | undefined>(undefined);
  const coreFeature = coreOperations<T>();
  const operations = [...coreFeature.operations];
  const binding = (name: string, type: T): Binding<T> => ({ id: Symbol(name), name, type });
  const ref = (target: Binding<T>, type: T = target.type): Reference<T> => coreFeature.methods.ref(type, target);
  const body = (result: Check<Value<T>>): Check<Body<T>> => check(function* () {
    const declarations: Declaration<T>[] = [];
    const returned = yield* within(output, declarations, result);
    return { declarations: [...declarations], result: returned };
  });
  const declare = (name: string, initial: Value<T>): Check<Reference<T>> => check(function* () {
    const declarations = yield* get(output);
    if (!declarations) throw new Error("IR declarations need an enclosing body");
    const target = binding(name, initial.type);
    declarations.push({ binding: target, value: initial });
    return ref(target);
  });
  const core = {
    binding, ref, body, declare,
    literal: coreFeature.methods.literal,
    binary: coreFeature.methods.binary,
    call: coreFeature.methods.call,
    fn: coreFeature.methods.fn,
    conditional: coreFeature.methods.conditional,
    block: coreFeature.methods.block,
    scope: (result: Check<Value<T>>): Check<Value<T>> => body(result).map((built) => coreFeature.methods.block(built.result.type, built)),
    at: (value: Value<T>, span: Span): Value<T> => ({ ...value, span }),
    declareRecursive: (target: Binding<T>, initial: Value<T>): Check<Reference<T>> => check(function* () {
      if (initial.operationId !== coreFeature.functionId) throw new Error("Recursive declarations require a function initializer");
      const declarations = yield* get(output);
      if (!declarations) throw new Error("IR declarations need an enclosing body");
      declarations.push({ binding: target, value: initial, recursive: true });
      return ref(target);
    }),
  };
  const methodNames = new Set(Object.keys(core));
  const use = <Methods extends object>(feature: OperationFeature<T, Methods>) => {
    for (const method of Object.keys(feature.methods)) {
      if (methodNames.has(method) || method === "use" || method === "program" || method === "validate" || method === "operationTraversals" || method === "coreOperationTraversals" || method === "coreReferenceId" || method === "coreFunctionId")
        throw new Error(`Duplicate language feature method: ${method}`);
    }
    for (const operation of feature.operations) {
      if (operations.some((existing) => existing.id === operation.id)) throw new Error(`Duplicate language operation descriptor: ${operation.kind}`);
    }
    for (const method of Object.keys(feature.methods)) methodNames.add(method);
    operations.push(...feature.operations);
    Object.assign(core, feature.methods);
    return core as unknown as LanguageBuilder<T, typeof core & Methods>;
  };
  return Object.assign(core, {
    use,
    operationTraversals: (): readonly OperationTraversal<T>[] => operations,
    coreOperationTraversals: (): readonly OperationTraversal<T>[] => coreFeature.operations,
    coreReferenceId: (): symbol => coreFeature.refId,
    coreFunctionId: (): symbol => coreFeature.functionId,
    program: (root: Body<T>): Program<T> => ({ body: root, operations, coreFunctionId: coreFeature.functionId }),
    validate: (root: Body<T>): void => validateBody(root, operations, coreFeature.functionId),
  });
};
/** Scope validation is descriptor-driven; recursive declarations require this core function id. */
export const validate = <T>(program: Program<T>): void =>
  validateBody(program.body, program.operations, program.coreFunctionId);

const validateBody = <T>(root: Body<T>, operations: readonly OperationTraversal<T>[], coreFunctionId?: symbol): void => {
  const byId = new Map<symbol, OperationTraversal<T>>();
  for (const operation of operations) {
    if (byId.has(operation.id)) throw new Error(`Duplicate operation descriptor: ${operation.kind}`);
    byId.set(operation.id, operation);
  }
  const declarations = new Set<symbol>();
  const introduce = (item: Binding<T>, visible: Set<symbol>) => {
    if (declarations.has(item.id)) throw new Error(`Binding declared twice: ${item.name}`);
    declarations.add(item.id);
    visible.add(item.id);
  };
  const visitBody = (built: Body<T>, parent: ReadonlySet<symbol>, parameters: readonly Binding<T>[] = []): void => {
    const visible = new Set(parent);
    for (const parameter of parameters) introduce(parameter, visible);
    for (const declaration of built.declarations) {
      const descriptor = byId.get(declaration.value.operationId);
      if (!descriptor) throw new Error(`Missing operation traversal for IR operation: ${declaration.value.node.kind}`);
      if (declaration.recursive) {
        if (!coreFunctionId || declaration.value.operationId !== coreFunctionId)
          throw new Error("Recursive declarations require a function initializer");
        introduce(declaration.binding, visible);
      }
      visitValue(declaration.value, visible);
      if (!declaration.recursive) introduce(declaration.binding, visible);
    }
    visitValue(built.result, visible);
  };
  const visitValue = (value: Value<T>, visible: ReadonlySet<symbol>): void => {
    const descriptor = byId.get(value.operationId);
    if (!descriptor) throw new Error(`Missing operation traversal for IR operation: ${value.node.kind}`);
    descriptor.validate?.(value.node);
    for (const referenced of descriptor.references(value.node)) {
      if (!visible.has(referenced.id)) throw new Error(`Out-of-scope binding: ${referenced.name}`);
    }
    for (const child of descriptor.children(value.node)) visitValue(child, visible);
    for (const scoped of descriptor.scopedBodies(value.node)) visitBody(scoped.body, visible, scoped.bindings);
  };
  visitBody(root, new Set());
};

/** Reconstructs recursively and allows bottom-up replacement after descriptor mapping. */
export const mapBody = <T>(
  root: Body<T>,
  operations: readonly OperationTraversal<T>[],
  mapBinding: (binding: Binding<T>) => Binding<T> = (binding) => binding,
  transformValue: (original: Value<T>, mapped: Value<T>) => Value<T> = (_original, mapped) => mapped,
): Body<T> => {
  const byId = new Map(operations.map((operation) => [operation.id, operation]));
  const mapValue = (original: Value<T>): Value<T> => {
    const descriptor = byId.get(original.operationId);
    if (!descriptor) throw new Error(`Missing operation mapping for IR operation: ${original.node.kind}`);
    const mapped = { ...original, node: descriptor.map(original.node, mapValue, mapBuiltBody, mapBinding) };
    return transformValue(original, mapped);
  };
  const mapBuiltBody = (built: Body<T>): Body<T> => ({
    declarations: built.declarations.map((declaration) => ({ ...declaration, binding: mapBinding(declaration.binding), value: mapValue(declaration.value) })),
    result: mapValue(built.result),
  });
  return mapBuiltBody(root);
};
