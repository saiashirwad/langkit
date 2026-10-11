import { assertNode, makeNode, makeType, makeStatement, materialize, registerProgram, requireShape, typeShape, validate } from "./staging/internal.ts";
import type { Node, Shape, Statement } from "./staging/internal.ts";

declare const denotes: unique symbol;
declare const invariant: unique symbol;
declare const typeBrand: unique symbol;
declare const built: unique symbol;
declare const parameter: unique symbol;
export interface Operand<A> extends Node { readonly [denotes]: A }
export interface Expr<A> extends Operand<A> { readonly [invariant]: (value: A) => A }
export interface TypeWitness { readonly [typeBrand]: (value: never) => unknown }
export interface Type<A> extends TypeWitness { readonly [typeBrand]: (value: A) => A }
export interface Ref<A> extends Expr<A> { readonly id: symbol; readonly nameHint: string }
export interface Param<Name extends string, A> extends Ref<A> { readonly nameHint: Name; readonly [parameter]: true }
export interface Program<A> { readonly [built]: (value: A) => A; readonly statements: readonly Statement[]; readonly result: Expr<A> }
export type Denotes<E> = E extends Operand<infer A> ? A : never;
export type { Statement } from "./staging/internal.ts";
const numberShape = Object.freeze({ kind: "number" as const });
const stringShape = Object.freeze({ kind: "string" as const });
const booleanShape = Object.freeze({ kind: "boolean" as const });
const unknownShape = Object.freeze({ kind: "unknown" as const });
export const Number = makeType(numberShape) as Type<number>;
export const String = makeType(stringShape) as Type<string>;
export const Boolean = makeType(booleanShape) as Type<boolean>;
export const Unknown = makeType(unknownShape) as Type<unknown>;
type WitnessValue<T> = T extends Type<infer A> ? A : never;
export const functionType = <const P extends readonly TypeWitness[], A>(params: P, result: Type<A>): Type<(...args: { -readonly [K in keyof P]: WitnessValue<P[K]> }) => A> =>
  makeType(Object.freeze({ kind: "function", params: Object.freeze(params.map(typeShape)), result: typeShape(result) })) as Type<(...args: { -readonly [K in keyof P]: WitnessValue<P[K]> }) => A>;
const expression = <A>(kind: string, shape: Shape, data: Record<string, unknown>): Expr<A> => makeNode(kind, shape, data) as Expr<A>;
const check = (node: Node, shape: Shape) => { assertNode(node); requireShape(shape, node.shape); };
export const number = <const A extends number>(value: A): Expr<A> => {
  if (typeof value !== "number" || !globalThis.Number.isFinite(value)) throw new Error("Staging number must be finite");
  return expression("literal", numberShape, { value });
};
export const string = <const A extends string>(value: A): Expr<A> => {
  if (typeof value !== "string") throw new Error("Invalid staging string"); return expression("literal", stringShape, { value });
};
export const boolean = <const A extends boolean>(value: A): Expr<A> => {
  if (typeof value !== "boolean") throw new Error("Invalid staging boolean"); return expression("literal", booleanShape, { value });
};
export function binary(op: "+", left: Operand<string>, right: Operand<string>): Expr<string>;
export function binary(op: "+" | "-" | "*" | "/", left: Operand<number>, right: Operand<number>): Expr<number>;
export function binary(op: ">", left: Operand<number>, right: Operand<number>): Expr<boolean>;
export function binary<A, B>(op: "===", left: Expr<A>, right: Expr<B>): Expr<boolean>;
export function binary(op: string, left: Node, right: Node): Node {
  assertNode(left); assertNode(right);
  if (!["+", "-", "*", "/", ">", "==="].includes(op)) throw new Error("Unsupported staging binary operator");
  if (op !== "===") {
    const shape = op === "+" && left.shape.kind === "string" ? stringShape : numberShape;
    check(left, shape); check(right, shape);
  }
  return expression("binary", op === ">" || op === "===" ? booleanShape : left.shape.kind === "string" ? stringShape : numberShape, { op, left, right });
}
export const unary = (op: "!", operand: Operand<boolean>): Expr<boolean> => {
  if (op !== "!") throw new Error("Unsupported staging unary operator"); check(operand, booleanShape);
  return expression("unary", booleanShape, { op, operand });
};
export const cond = <A, B>(condition: Operand<boolean>, then: Expr<A>, otherwise: Expr<B>): Expr<A | B> => {
  check(condition, booleanShape); assertNode(then); assertNode(otherwise);
  const shape = then.shape.kind === otherwise.shape.kind && ["number", "string", "boolean"].includes(then.shape.kind) ? then.shape : unknownShape;
  return expression("cond", shape, { cond: condition, then, else: otherwise });
};
const binding = <A>(kind: "ref" | "param", id: symbol, nameHint: string, shape: Shape): Ref<A> => {
  return makeNode(kind, shape, { id, nameHint }) as Ref<A>;
};
export const param = <const Name extends string, A>(name: Name, type: Type<A>): Param<Name, A> =>
  binding("param", Symbol(name), name, typeShape(type)) as Param<Name, A>;
export const ref = <A>(source: Ref<A>, type?: Type<A>): Ref<A> => {
  assertNode(source);
  if (source.kind !== "ref" && source.kind !== "param") throw new Error("Expected staging binding reference");
  const shape = type === undefined ? source.shape : typeShape(type);
  requireShape(source.shape, shape);
  return binding("ref", source.id, source.nameHint, shape);
};
export interface Declaration<A> { [Symbol.iterator](): Generator<Statement, Ref<A>, unknown> }
function declare<A>(name: string, expr: Expr<A>): Declaration<A>;
function declare<A>(name: string, expr: Operand<A>, annotation: Type<A>): Declaration<A>;
function declare(name: string, expr: Node, annotation?: TypeWitness): Declaration<unknown> {
  assertNode(expr); const shape = annotation === undefined ? expr.shape : typeShape(annotation); requireShape(shape, expr.shape);
  return Object.freeze({ *[Symbol.iterator]() {
    const id = Symbol(name); yield makeStatement(id, name, expr); return binding("ref", id, name, shape);
  } });
}
export { declare as const };
type Values<P extends readonly Node[]> = { -readonly [K in keyof P]: Denotes<P[K]> };
type Refs<P extends readonly Node[]> = { readonly [K in keyof P]: Ref<Denotes<P[K]>> };
type Parameter = Operand<unknown> & { readonly id: symbol; readonly nameHint: string; readonly [parameter]: true };
export const arrow = <const P extends readonly Parameter[], A>(spec: { readonly params: P; readonly body: (params: Refs<P>) => Generator<Statement, Expr<A>, unknown> }): Expr<(...args: Values<P>) => A> => {
  const params = Object.freeze([...spec.params]);
  for (const parameter of params) { assertNode(parameter); if (parameter.kind !== "param") throw new Error("Expected staging parameter"); }
  const refs = params.map((parameter) => binding("ref", parameter.id, parameter.nameHint, parameter.shape)) as Refs<P>;
  const body = materialize(() => spec.body(refs));
  return expression("arrow", Object.freeze({ kind: "function", params: Object.freeze(params.map((p) => p.shape)), result: body.result.shape }), { params, body });
};
type Args<F> = F extends (...args: infer A) => unknown ? A : never;
type Result<F> = F extends (...args: never[]) => infer A ? A : never;
type Inputs<A extends readonly unknown[]> = { [K in keyof A]: Operand<A[K]> };
export const call = <F>(fn: Expr<F>, ...args: Inputs<Args<F>>): Expr<Result<F>> => {
  assertNode(fn); for (const arg of args as readonly Node[]) assertNode(arg);
  if (fn.shape.kind !== "unknown") {
    if (fn.shape.kind !== "function") throw new Error("Staging call requires a function");
    if (fn.shape.params.length !== args.length) throw new Error("Staging call arity mismatch");
    fn.shape.params.forEach((shape, index) => check(args[index] as Node, shape));
  }
  return expression("call", fn.shape.kind === "function" ? fn.shape.result : unknownShape, { fn, args: Object.freeze([...args]) });
};
export const object = <const F extends Readonly<Record<string, Operand<unknown>>>>(fields: F): Expr<{ -readonly [K in keyof F]: Denotes<F[K]> }> => {
  if (Object.getOwnPropertySymbols(fields).length) throw new Error("Staging object requires string fields");
  const entries = Object.entries(fields); for (const [, value] of entries) assertNode(value);
  const shapes = Object.fromEntries(entries.map(([key, value]) => [key, value.shape]));
  return expression("object", Object.freeze({ kind: "object", fields: Object.freeze(shapes) }), { fields: Object.freeze(entries.map((entry) => Object.freeze(entry))) });
};
export const prop = <A, K extends keyof A & string>(record: Expr<A>, key: K): Expr<A[K]> => {
  assertNode(record);
  if (record.shape.kind !== "unknown" && (record.shape.kind !== "object" || !Object.hasOwn(record.shape.fields, key))) throw new Error("Unknown staging record field");
  return expression("prop", record.shape.kind === "object" ? record.shape.fields[key]! : unknownShape, { object: record, key });
};
export const external = <A>(name: string, type: Type<A>): Expr<A> => {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) throw new Error("Invalid staging external name");
  return expression("external", typeShape(type), { name });
};
export const build = <A>(body: () => Generator<Statement, Expr<A>, unknown>): Program<A> => {
  const result = materialize(body); validate(result); return registerProgram(result) as Program<A>;
};
