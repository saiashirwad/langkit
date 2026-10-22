import { type Expr, type ExprBinary, parse } from "../grammar/expr.grammar";

type Scope = Readonly<Record<string, number>>;

const evaluate = (expr: Expr, scope: Scope): number => {
  switch (expr.kind) {
    case "Num":
      return Number(expr.value);
    case "Path":
      return scope[[expr.head, ...expr.tail].join(".")] ?? 0;
    case "prefix": {
      const operand = evaluate(expr.operand, scope);
      return expr.operator === "-" ? -operand : Number(!operand);
    }
    case "postfix":
      return Array.from({ length: evaluate(expr.operand, scope) }, (_, index) => index + 1).reduce((a, b) => a * b, 1);
    case "binary": {
      const [left, right] = [evaluate(expr.left, scope), evaluate(expr.right, scope)];
      switch (expr.operator) {
        case "or":
          return Number(left !== 0 || right !== 0);
        case "and":
          return Number(left !== 0 && right !== 0);
        case "==":
          return Number(left === right);
        case "!=":
          return Number(left !== right);
        case "<":
          return Number(left < right);
        case "<=":
          return Number(left <= right);
        case ">":
          return Number(left > right);
        case ">=":
          return Number(left >= right);
        case "+":
          return left + right;
        case "-":
          return left - right;
        case "*":
          return left * right;
        case "/":
          return left / right;
      }
    }
  }
};

const parsed = parse("2 * (3 + 4) - x!");
if (!parsed.success) throw new Error(parsed.errors[0].message);
console.log(evaluate(parsed.value, { x: 3 }));

// @ts-expect-error "%" is not an operator of this grammar.
const modulo = (expr: ExprBinary) => expr.operator === "%";

// @ts-expect-error An Expr is one of several nodes, and only some have an operand.
const operandOf = (expr: Expr) => expr.operand;

// @ts-expect-error The kinds Num and Path are unhandled, so the function can fall off the end.
const incomplete = (expr: Expr): number => {
  switch (expr.kind) {
    case "binary":
    case "prefix":
    case "postfix":
      return 0;
  }
};

void modulo, operandOf, incomplete;
