import type { Span } from "./diagnostic.ts";
import { coreOperations, type CoreDescriptors } from "./operations/core.ts";
import { defineDialect, type DescriptorRecord, type Dialect } from "./operations/dialect.ts";
export type Operator = "+" | "-" | "*" | "/" | ">" | "==";

export type Binding<T> = { readonly id: symbol; readonly name: string; readonly type: T };
export type OperationNode = { readonly kind: string };
export type Value<T> = { readonly type: T; readonly node: OperationNode; readonly operationId: symbol; readonly span?: Span };
export type OperationValue<T, Node extends OperationNode> = Value<T> & { readonly node: Node };
export type Reference<T> = OperationValue<T, { readonly kind: "ref"; readonly binding: Binding<T> }>;
export type Declaration<T> = { readonly recursive?: true; readonly binding: Binding<T>; readonly value: Value<T> };
export type Body<T> = { readonly declarations: readonly Declaration<T>[]; readonly result: Value<T> };
export type BodySource<T> = Body<T> | (() => Generator<Declaration<T>, Value<T>, unknown>);
export type Program<T> = {
  readonly body: Body<T>;
  readonly operations: readonly OperationTraversal<T>[];
  readonly coreFunctionId?: symbol;
};
export type MatchCase<T> = { readonly tag: string; readonly bindings: readonly Binding<T>[]; readonly body: Body<T> };
export type MatchFallback<T> = { readonly binding?: Binding<T>; readonly body: Body<T> };

export type OperationTraversal<T> = {
  readonly id: symbol;
  readonly kind: string;
  readonly children: (node: OperationNode) => readonly Value<T>[];
  readonly scopedBodies: (node: OperationNode) => readonly { readonly body: Body<T>; readonly bindings: readonly Binding<T>[] }[];
  readonly references: (node: OperationNode) => readonly Binding<T>[];
  readonly map: (node: OperationNode, value: (child: Value<T>) => Value<T>, body: (child: Body<T>) => Body<T>, binding: (binding: Binding<T>) => Binding<T>) => OperationNode;
  readonly validate?: (node: OperationNode) => void;
};
export type OperationFeature<T, Methods extends object, Descriptors extends DescriptorRecord = DescriptorRecord> = { readonly methods: Methods; readonly descriptors: Descriptors; readonly operations: readonly OperationTraversal<T>[] };
export type LanguageBuilder<T, Methods extends object, Descriptors extends DescriptorRecord = DescriptorRecord> = Methods & {
  use<More extends object, Added extends DescriptorRecord>(feature: OperationFeature<T, More, Added>): LanguageBuilder<T, Methods & More, Descriptors & Added>;
  readonly descriptors: Descriptors;
  readonly coreDescriptors: CoreDescriptors<T>;
  dialect(): Dialect<Descriptors, T>;
  operationTraversals(): readonly OperationTraversal<T>[];
  coreReferenceId(): symbol;
  coreFunctionId(): symbol;
  body(factory: BodySource<T>): Body<T>;
  declare(name: string, initial: Value<T>): Generator<Declaration<T>, Reference<T>, unknown>;
  declareRecursive(target: Binding<T>, initial: Value<T>): Generator<Declaration<T>, Reference<T>, unknown>;
  block(type: T, source: BodySource<T>): Value<T>;
  program(body: Body<T>): Program<T>;
  validate(root: Body<T>): void;
};
export const isReference = <T>(value: Value<T>, referenceOperationId: symbol): value is Reference<T> =>
  value.operationId === referenceOperationId && value.node.kind === "ref";

export const create = <T>() => {
  const coreFeature = coreOperations<T>();
  const operations = [...coreFeature.operations];
  const descriptors: Record<string, DescriptorRecord[string]> = { ...coreFeature.descriptors };
  const binding = (name: string, type: T): Binding<T> => ({ id: Symbol(name), name, type });
  const ref = (target: Binding<T>, type: T = target.type): Reference<T> => coreFeature.methods.ref(type, target);
  const body = (source: BodySource<T>): Body<T> => {
    if (typeof source !== "function") return source;
    const declarations: Declaration<T>[] = [];
    const iterator = source();
    let done = false;
    try {
      let step = iterator.next();
      while (!step.done) {
        declarations.push(step.value);
        step = iterator.next();
      }
      done = true;
      return { declarations, result: step.value };
    } finally {
      if (!done && !iterator.return(undefined as never).done) {
        throw new TypeError("IR body cleanup cannot yield declarations");
      }
    }
  };
  const declare = function* (name: string, initial: Value<T>): Generator<Declaration<T>, Reference<T>, unknown> {
    const target = binding(name, initial.type);
    yield { binding: target, value: initial };
    return ref(target);
  };
  const declareRecursive = function* (target: Binding<T>, initial: Value<T>): Generator<Declaration<T>, Reference<T>, unknown> {
    if (initial.operationId !== coreFeature.functionId) throw new Error("Recursive declarations require a function initializer");
    yield { binding: target, value: initial, recursive: true };
    return ref(target);
  };
  const core = {
    binding, ref, body, declare, declareRecursive,
    literal: coreFeature.methods.literal,
    binary: coreFeature.methods.binary,
    call: coreFeature.methods.call,
    fn: (type: T, param: Binding<T>, source: BodySource<T>) => coreFeature.methods.fn(type, param, body(source)),
    conditional: (type: T, cond: Value<T>, thenSource: BodySource<T>, elseSource: BodySource<T>) =>
      coreFeature.methods.conditional(type, cond, body(thenSource), body(elseSource)),
    block: (type: T, source: BodySource<T>) => coreFeature.methods.block(type, body(source)),
    scope: (source: BodySource<T>) => { const built = body(source); return coreFeature.methods.block(built.result.type, built); },
    at: (value: Value<T>, span: Span): Value<T> => ({ ...value, span }),
  };
  const methodNames = new Set(Object.keys(core));
  const use = <Methods extends object, Added extends DescriptorRecord>(feature: OperationFeature<T, Methods, Added>) => {
    for (const method of Object.keys(feature.methods)) {
      if (methodNames.has(method) || ["use", "program", "validate", "operationTraversals", "coreReferenceId", "coreFunctionId", "descriptors", "coreDescriptors", "dialect"].includes(method))
        throw new Error(`Duplicate language feature method: ${method}`);
    }
    const selected = defineDialect(feature.descriptors);
    for (const key of Object.keys(feature.descriptors)) {
      if (Object.hasOwn(descriptors, key)) throw new Error(`Duplicate dialect key: ${key}`);
    }
    for (const operation of selected.operations) {
      if (operations.some((existing) => existing.id === operation.id)) throw new Error(`Duplicate language operation descriptor: ${operation.kind}`);
    }
    for (const method of Object.keys(feature.methods)) methodNames.add(method);
    operations.push(...selected.operations as unknown as OperationTraversal<T>[]);
    Object.assign(descriptors, feature.descriptors);
    Object.assign(core, feature.methods);
    return core as unknown as LanguageBuilder<T, typeof core & Methods>;
  };
  return Object.assign(core, {
    use,
    descriptors,
    coreDescriptors: coreFeature.descriptors,
    dialect: () => defineDialect(descriptors),
    operationTraversals: (): readonly OperationTraversal<T>[] => [...operations],
    coreReferenceId: (): symbol => coreFeature.refId,
    coreFunctionId: (): symbol => coreFeature.functionId,
    validate: (root: Body<T>): void => validateBody(root, operations, coreFeature.functionId),
    program: (root: Body<T>): Program<T> => {
      validateBody(root, operations, coreFeature.functionId);
      return { body: root, operations: [...operations], coreFunctionId: coreFeature.functionId };
    },
  }) as unknown as LanguageBuilder<T, typeof core, CoreDescriptors<T>>;
};
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
