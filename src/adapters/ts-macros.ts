import type { Binding, Body, Program, Value } from "../ir.ts";

type Constructor = (...args: never[]) => unknown;
/** Inject the real public namespace; no registry dependency or machine path is required. */
export type TSMacrosNamespace = {
  readonly [K in "number" | "string" | "boolean" | "binary" | "unary" | "cond" | "call" | "arrow" | "param" | "ref" | "const" | "object" | "prop" | "build"]: Constructor;
};
type DescriptorIdentity = { readonly id: symbol; readonly kind: string };
export type TSMacrosDescriptors = {
  readonly core: Readonly<Partial<Record<"literal" | "ref" | "unary" | "binary" | "call" | "fn" | "if" | "block", DescriptorIdentity>>>;
  readonly records?: Readonly<Partial<Record<"record" | "field", DescriptorIdentity>>>;
};
type Expr = { readonly kind: string; readonly id?: unknown; readonly nameHint?: string; readonly type?: unknown };
type BuiltBody = { statements: unknown[]; result: Expr };
type Scope = Map<symbol, Expr>;
type Node<T> = {
  kind: string; value: unknown; binding: Binding<T>; op: string;
  left: Value<T>; right: Value<T>; operand: Value<T>; fn: Value<T>; arg: Value<T>;
  param: Binding<T>; body: Body<T>; cond: Value<T>; then: Body<T>; else: Body<T>;
  fields: readonly { name: string; value: Value<T> }[]; base?: Value<T>; record: Value<T>; name: string;
};

/**
 * The host policy supplies target Type witnesses, not a proof of guest inference.
 * A policy returning the target's Unknown witness is the honest existential default.
 * Reference uses retain their guest type separately: TS Macros build annotates refs
 * from their declaration and cannot represent arbitrary guest let-polymorphism.
 */
export const createTSMacrosAdapter = <N extends TSMacrosNamespace, T,>(
  target: N,
  descriptors: TSMacrosDescriptors,
  hostType: (guest: T) => unknown,
) => {
  const selected = new Map<symbol, { role: string; descriptor: DescriptorIdentity }>();
  for (const [role, descriptor] of Object.entries({ ...descriptors.core, ...descriptors.records })) {
    if (!descriptor) continue;
    if (descriptor.kind !== role) throw new Error(`TS Macros descriptor role mismatch: ${role} (${String(descriptor.id)})`);
    if (selected.has(descriptor.id)) throw new Error(`Duplicate TS Macros descriptor: ${String(descriptor.id)}`);
    selected.set(descriptor.id, { role, descriptor });
  }
  // The only dynamic generic erasure is at the constructor call boundary. No
  // Expr<number> (or other host denotation) is inferred from a guest runtime type.
  const invoke = (name: keyof TSMacrosNamespace, ...args: unknown[]): Expr =>
    (target[name] as unknown as (...args: unknown[]) => Expr)(...args);
  const declare = (name: string, expr: Expr, statements: unknown[]): Expr => {
    const builder = invoke("const", name, expr) as unknown as Iterable<unknown>;
    const iterator = builder[Symbol.iterator]();
    let step = iterator.next();
    while (!step.done) { statements.push(step.value); step = iterator.next(); }
    return step.value as Expr;
  };
  const arrow = (body: BuiltBody, params: Expr[] = []): Expr => invoke("arrow", {
    params,
    body: function* () { yield* body.statements; return body.result; },
  });
  return {
    lower(program: Program<T>) {
      const registered = new Map(program.operations.map((descriptor) => [descriptor.id, descriptor]));
      if (registered.size !== program.operations.length) throw new Error("Duplicate program operation descriptor");
      const uses: { readonly binding: Binding<T>; readonly type: T; readonly reference: Expr }[] = [];
      const introduced = new Set<symbol>();
      const tasks: (() => void)[] = [];
      const active = new Set<object>();
      const introduce = (binding: Binding<T>, reference: Expr, scope: Scope) => {
        if (introduced.has(binding.id)) throw new Error(`Binding declared twice: ${binding.name}`);
        introduced.add(binding.id); scope.set(binding.id, reference);
      };
      const body = (source: Body<T>, parent: Scope, done: (result: BuiltBody) => void) => {
        const scope = new Map(parent);
        const statements: unknown[] = [];
        let index = 0;
        const next = () => {
          const declaration = source.declarations[index++];
          if (!declaration) { value(source.result, scope, statements, (result) => done({ statements, result })); return; }
          if (declaration.recursive) throw new Error("TS Macros adapter does not support recursive declarations");
          value(declaration.value, scope, statements, (expr) => {
            introduce(declaration.binding, declare(declaration.binding.name, expr, statements), scope);
            tasks.push(next);
          });
        };
        tasks.push(next);
      };
      const value = (source: Value<T>, scope: Scope, statements: unknown[], done: (expr: Expr) => void) => {
        tasks.push(() => {
          if (active.has(source)) throw new Error("Cyclic IR value");
          active.add(source);
          const selection = selected.get(source.operationId);
          if (!selection || !registered.has(source.operationId))
            throw new Error(`Unsupported TS Macros descriptor: ${String(source.operationId)} (${source.node.kind})`);
          registered.get(source.operationId)!.validate?.(source.node);
          const n = source.node as Node<T>;
          if (n.kind !== selection.role) throw new Error(`TS Macros descriptor node mismatch: ${String(source.operationId)}`);
          const finish = (expr: Expr, temporary = true) => {
            active.delete(source);
            done(temporary ? declare("value", expr, statements) : expr);
          };
          const children = (sources: readonly Value<T>[], complete: (exprs: Expr[]) => void) => {
            const exprs: Expr[] = []; let index = 0;
            const next = () => {
              const child = sources[index++];
              if (!child) { complete(exprs); return; }
              value(child, scope, statements, (expr) => { exprs.push(expr); tasks.push(next); });
            };
            tasks.push(next);
          };
          switch (selection.role) {
            case "literal": {
              const primitive = typeof n.value;
              if (primitive !== "number" && primitive !== "string" && primitive !== "boolean") throw new Error("Unsupported TS Macros literal");
              if (primitive === "number" && !Number.isFinite(n.value)) throw new Error("TS Macros number must be finite");
              finish(invoke(primitive, n.value)); return;
            }
            case "ref": {
              const binding = scope.get(n.binding.id);
              if (!binding) throw new Error(`Out-of-scope binding: ${n.binding.name}`);
              const reference = invoke("ref", binding.id, binding.nameHint, hostType(source.type), false, false);
              uses.push({ binding: n.binding, type: source.type, reference });
              finish(reference, false); return;
            }
            case "binary":
              if (!["+", "-", "*", "/", ">", "=="].includes(n.op)) throw new Error(`Unsupported TS Macros binary: ${n.op}`);
              children([n.left, n.right], ([left, right]) => finish(invoke("binary", n.op === "==" ? "===" : n.op, left, right))); return;
            case "unary":
              if (n.op !== "!") throw new Error(`Unsupported TS Macros unary: ${n.op}`);
              children([n.operand], ([operand]) => finish(invoke("unary", n.op, operand))); return;
            case "call": children([n.fn, n.arg], ([fn, arg]) => finish(invoke("call", fn, arg))); return;
            case "fn": {
              const parameter = invoke("param", n.param.name, hostType(n.param.type));
              const inner = new Map(scope);
              introduce(n.param, invoke("ref", parameter.id, parameter.nameHint, hostType(n.param.type), true, false), inner);
              body(n.body, inner, (built) => finish(arrow(built, [parameter]))); return;
            }
            case "block": body(n.body, scope, (built) => finish(invoke("call", arrow(built)))); return;
            case "if":
              children([n.cond], ([condition]) => {
                body(n.then, scope, (then) => body(n.else, scope, (otherwise) =>
                  finish(invoke("cond", condition, invoke("call", arrow(then)), invoke("call", arrow(otherwise))))));
              }); return;
            case "record":
              if (n.base) throw new Error("TS Macros adapter does not support record bases");
              if (n.fields.some((field) => !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(field.name))) throw new Error("TS Macros JS target requires identifier field names");
              if (new Set(n.fields.map((field) => field.name)).size !== n.fields.length) throw new Error("Duplicate record field");
              children(n.fields.map((field) => field.value), (exprs) => finish(invoke("object", Object.fromEntries(n.fields.map((field, index) => [field.name, exprs[index]]))))); return;
            case "field":
              if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(n.name)) throw new Error("TS Macros JS target requires identifier field names");
              children([n.record], ([record]) => finish(invoke("prop", record, n.name))); return;
            default: throw new Error(`Unsupported TS Macros descriptor: ${String(source.operationId)}`);
          }
        });
      };
      let built: BuiltBody | undefined;
      body(program.body, new Map(), (result) => { built = result; });
      while (tasks.length) tasks.pop()!();
      const complete = built!;
      const result = (target.build as unknown as (body: () => Generator<unknown, Expr, unknown>) => ReturnType<N["build"]>)(function* () {
        yield* complete.statements; return complete.result;
      });
      return { program: result, referenceUses: uses as readonly (typeof uses)[number][] };
    },
  };
};
