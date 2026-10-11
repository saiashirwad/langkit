export type Shape =
  | { readonly kind: "number" | "string" | "boolean" | "unknown"; }
  | { readonly kind: "object"; readonly fields: Readonly<Record<string, Shape>>; }
  | { readonly kind: "function"; readonly params: readonly Shape[]; readonly result: Shape; };
export interface Node {
  readonly kind: string;
  readonly shape: Shape;
  readonly data: Readonly<Record<string, unknown>>;
}
export interface Statement {
  readonly kind: "const";
  readonly id: symbol;
  readonly nameHint: string;
  readonly expr: Node;
}
export interface Body {
  readonly statements: readonly Statement[];
  readonly result: Node;
}
const nodes = new WeakSet<object>();
const statements = new WeakSet<object>();
const programs = new WeakSet<object>();
const types = new WeakSet<object>();
export const makeNode = (kind: string, shape: Shape, data: Record<string, unknown>): Node => {
  const node = Object.freeze({
    kind,
    shape,
    data: Object.freeze(data),
    ...(kind === "ref" || kind === "param" ? { id: data.id, nameHint: data.nameHint } : {}),
  });
  nodes.add(node);
  return node;
};
export const makeStatement = (id: symbol, nameHint: string, expr: Node): Statement => {
  const statement = Object.freeze({ kind: "const" as const, id, nameHint, expr });
  statements.add(statement);
  return statement;
};
export const makeType = (shape: Shape): object => {
  const type = Object.freeze({ shape });
  types.add(type);
  return type;
};
export const typeShape = (value: unknown): Shape => {
  if (!value || typeof value !== "object" || !types.has(value)) throw new Error("Invalid staging Type witness");
  return (value as { shape: Shape; }).shape;
};
export const assertNode: (value: unknown) => asserts value is Node = (value) => {
  if (!value || typeof value !== "object" || !nodes.has(value)) throw new Error("Invalid staging expression");
};
export const assertStatement: (value: unknown) => asserts value is Statement = (value) => {
  if (!value || typeof value !== "object" || !statements.has(value)) throw new Error("Invalid staging statement");
};
export const registerProgram = <B extends Body>(body: B): B => {
  programs.add(body);
  return body;
};
export const assertProgram = (body: unknown): Body => {
  if (!body || typeof body !== "object" || !programs.has(body)) throw new Error("Expected built staging Program");
  return body as Body;
};
export const accepts = (expected: Shape, actual: Shape): boolean => {
  if (expected.kind === "unknown" || actual.kind === "unknown") return true;
  if (expected.kind !== actual.kind) return false;
  if (expected.kind === "object" && actual.kind === "object") {
    return Object.entries(expected.fields).every(([key, shape]) =>
      Object.hasOwn(actual.fields, key) && accepts(shape, actual.fields[key]!)
    );
  }
  if (expected.kind === "function" && actual.kind === "function") {
    return expected.params.length === actual.params.length && expected.params.every((shape, i) =>
      accepts(actual.params[i]!, shape)
    ) && accepts(expected.result, actual.result);
  }
  return true;
};
export const requireShape = (expected: Shape, actual: Shape): void => {
  if (!accepts(expected, actual)) {
    throw new Error(`Staging type mismatch: expected ${expected.kind}, received ${actual.kind}`);
  }
};
export const materialize = (factory: () => Generator<Statement, Node, unknown>): Body => {
  const iterator = factory();
  const items: Statement[] = [];
  let done = false;
  try {
    let step = iterator.next();
    while (!step.done) {
      assertStatement(step.value);
      items.push(step.value);
      step = iterator.next();
    }
    done = true;
    assertNode(step.value);
    return Object.freeze({ statements: Object.freeze(items), result: step.value });
  } finally {
    if (!done && !iterator.return(undefined as never).done) {
      throw new TypeError("Staging cleanup cannot yield declarations");
    }
  }
};
export const validate = (body: Body): void => {
  const owners = new Map<symbol, Body>();
  const active = new Set<Node>();
  const tasks: (() => void)[] = [];
  const visitBody = (source: Body, parent: Map<symbol, Shape>, params: readonly Node[] = []) => {
    const scope = new Map(parent);
    const introduced = new Set<symbol>();
    const introduce = (id: symbol, shape: Shape) => {
      const owner = owners.get(id);
      if (introduced.has(id) || (owner !== undefined && owner !== source)) {
        throw new Error("Duplicate staging binding identity");
      }
      introduced.add(id);
      owners.set(id, source);
      scope.set(id, shape);
    };
    for (const param of params) {
      assertNode(param);
      if (param.kind !== "param") throw new Error("Invalid staging parameter");
      introduce(param.data.id as symbol, param.shape);
    }
    let i = 0;
    const next = () => {
      const statement = source.statements[i++];
      if (!statement) {
        visit(source.result, scope);
        return;
      }
      assertStatement(statement);
      tasks.push(() => {
        introduce(statement.id, statement.expr.shape);
        tasks.push(next);
      });
      visit(statement.expr, scope);
    };
    tasks.push(next);
  };
  const visit = (node: Node, scope: Map<symbol, Shape>) => {
    tasks.push(() => {
      assertNode(node);
      if (active.has(node)) throw new Error("Cyclic staging expression");
      active.add(node);
      tasks.push(() => {
        active.delete(node);
      });
      const d = node.data;
      switch (node.kind) {
        case "literal":
        case "external":
          return;
        case "ref": {
          const declared = scope.get(d.id as symbol);
          if (!declared) throw new Error("Out-of-scope staging binding");
          requireShape(declared, node.shape);
          return;
        }
        case "arrow":
          visitBody(d.body as Body, scope, d.params as readonly Node[]);
          return;
        case "binary":
          visit(d.right as Node, scope);
          visit(d.left as Node, scope);
          return;
        case "unary":
          visit(d.operand as Node, scope);
          return;
        case "cond":
          visit(d.else as Node, scope);
          visit(d.then as Node, scope);
          visit(d.cond as Node, scope);
          return;
        case "call":
          for (const arg of [...d.args as readonly Node[]].reverse()) visit(arg, scope);
          visit(d.fn as Node, scope);
          return;
        case "object":
          for (const [, field] of [...d.fields as readonly (readonly [string, Node])[]].reverse()) visit(field, scope);
          return;
        case "prop":
          visit(d.object as Node, scope);
          return;
        default:
          throw new Error(`Unsupported staging node: ${node.kind}`);
      }
    });
  };
  visitBody(body, new Map());
  while (tasks.length) tasks.pop()!();
};
