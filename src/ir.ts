import type { Span } from "./diagnostic.ts";
import { type CoreDescriptors, coreOperations } from "./operations/core.ts";
import type { DescriptorRecord, OperationDescriptor } from "./operations/descriptor.ts";

export type Operator = "+" | "-" | "*" | "/" | ">" | "==";

export type Binding<T> = { readonly id: symbol; readonly name: string; readonly type: T; };
export type OperationNode = { readonly kind: string; };
export type Value<T> = {
  readonly type: T;
  readonly node: OperationNode;
  readonly operationId: symbol;
  readonly span?: Span;
};
export type OperationValue<T, Node extends OperationNode> = Value<T> & { readonly node: Node; };
export type Reference<T> = OperationValue<T, { readonly kind: "ref"; readonly binding: Binding<T>; }>;
export type Declaration<T> = { readonly recursive?: true; readonly binding: Binding<T>; readonly value: Value<T>; };
export type Body<T> = { readonly declarations: readonly Declaration<T>[]; readonly result: Value<T>; };
export type BodySource<T> = Body<T> | (() => Generator<Declaration<T>, Value<T>, unknown>);

type Operation<T> = OperationDescriptor<T, OperationNode>;
export type Program<T> = {
  readonly body: Body<T>;
  readonly operations: readonly Operation<T>[];
  readonly functionId: symbol;
};

export type OperationFeature<T, Methods extends object, Descriptors extends DescriptorRecord> = {
  readonly methods: Methods;
  readonly descriptors: Descriptors;
};
export type LanguageBuilder<T, Methods extends object> = Methods & {
  use<More extends object, Added extends DescriptorRecord>(
    feature: OperationFeature<T, More, Added>,
  ): LanguageBuilder<T, Methods & More>;
  readonly coreDescriptors: CoreDescriptors<T>;
  body(source: BodySource<T>): Body<T>;
  declare(name: string, initial: Value<T>): Generator<Declaration<T>, Reference<T>, unknown>;
  declareRecursive(target: Binding<T>, initial: Value<T>): Generator<Declaration<T>, Reference<T>, unknown>;
  scope(source: BodySource<T>): Value<T>;
  program(body: Body<T>): Program<T>;
};

export const create = <T>() => {
  const core = coreOperations<T>();
  const functionId = core.descriptors.fn.id;
  const operations: Operation<T>[] = [];
  const register = (descriptors: DescriptorRecord) => {
    for (const operation of Object.values(descriptors) as Operation<T>[]) {
      if (operations.some((existing) => existing.id === operation.id)) {
        throw new Error(`Duplicate operation descriptor: ${operation.kind}`);
      }
      operations.push(operation);
    }
  };
  register(core.descriptors);

  const binding = (name: string, type: T): Binding<T> => ({ id: Symbol(name), name, type });
  const ref = (target: Binding<T>, type: T = target.type): Reference<T> => core.methods.ref(type, target);
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
  const builder = {
    coreDescriptors: core.descriptors,
    binding,
    ref,
    body,
    *declare(name: string, initial: Value<T>): Generator<Declaration<T>, Reference<T>, unknown> {
      const target = binding(name, initial.type);
      yield { binding: target, value: initial };
      return ref(target);
    },
    *declareRecursive(target: Binding<T>, initial: Value<T>): Generator<Declaration<T>, Reference<T>, unknown> {
      if (initial.operationId !== functionId) throw new Error("Recursive declarations require a function initializer");
      yield { binding: target, value: initial, recursive: true };
      return ref(target);
    },
    literal: core.methods.literal,
    binary: core.methods.binary,
    call: core.methods.call,
    fn: (type: T, param: Binding<T>, source: BodySource<T>) => core.methods.fn(type, param, body(source)),
    conditional: (type: T, cond: Value<T>, thenSource: BodySource<T>, elseSource: BodySource<T>) =>
      core.methods.conditional(type, cond, body(thenSource), body(elseSource)),
    scope: (source: BodySource<T>) => {
      const built = body(source);
      return core.methods.block(built.result.type, built);
    },
    at: (value: Value<T>, span: Span): Value<T> => ({ ...value, span }),
    program: (root: Body<T>): Program<T> => {
      const program = { body: root, operations: [...operations], functionId };
      validate(program);
      return program;
    },
  };
  const use = <Methods extends object, Added extends DescriptorRecord>(
    feature: OperationFeature<T, Methods, Added>,
  ): unknown => {
    for (const method of Object.keys(feature.methods)) {
      if (method in language) throw new Error(`Duplicate language feature method: ${method}`);
    }
    register(feature.descriptors);
    return Object.assign(language, feature.methods);
  };
  const language = Object.assign(builder, { use });
  return language as unknown as LanguageBuilder<T, typeof builder>;
};

/** Checks lexical scoping: every reference sees its binding, and every binding is declared once. */
export const validate = <T>({ body, operations, functionId }: Program<T>): void => {
  const byId = new Map(operations.map((operation) => [operation.id, operation]));
  const operation = (value: Value<T>) => {
    const found = byId.get(value.operationId);
    if (!found) throw new Error(`Missing operation descriptor for IR operation: ${value.node.kind}`);
    return found;
  };
  const declared = new Set<symbol>();
  const introduce = (item: Binding<T>, visible: Set<symbol>) => {
    if (declared.has(item.id)) throw new Error(`Binding declared twice: ${item.name}`);
    declared.add(item.id);
    visible.add(item.id);
  };
  const visitBody = (built: Body<T>, parent: ReadonlySet<symbol>, parameters: readonly Binding<T>[]): void => {
    const visible = new Set(parent);
    for (const parameter of parameters) introduce(parameter, visible);
    for (const declaration of built.declarations) {
      if (declaration.recursive) {
        if (declaration.value.operationId !== functionId) {
          throw new Error("Recursive declarations require a function initializer");
        }
        introduce(declaration.binding, visible);
      }
      visitValue(declaration.value, visible);
      if (!declaration.recursive) introduce(declaration.binding, visible);
    }
    visitValue(built.result, visible);
  };
  const visitValue = (value: Value<T>, visible: ReadonlySet<symbol>): void => {
    const descriptor = operation(value);
    descriptor.validate?.(value.node);
    for (const referenced of descriptor.references(value.node)) {
      if (!visible.has(referenced.id)) throw new Error(`Out-of-scope binding: ${referenced.name}`);
    }
    for (const child of descriptor.children(value.node)) visitValue(child, visible);
    for (const scoped of descriptor.scopedBodies(value.node)) visitBody(scoped.body, visible, scoped.bindings);
  };
  visitBody(body, new Set(), []);
};
