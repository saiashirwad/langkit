import type { Program } from "../staging.ts";
import { assertProgram, validate } from "./internal.ts";
import type { Body, Node } from "./internal.ts";

export const emitProgram = <A>(program: Program<A>): string => {
  const root = assertProgram(program);
  validate(root);
  const names = new Map<symbol, string>();
  let index = 0;
  const name = (id: symbol) => {
    let found = names.get(id);
    if (!found) {
      found = `v${index++}`;
      names.set(id, found);
    }
    return found;
  };
  const output: string[] = [];
  const tasks: (() => void)[] = [];
  const text = (value: string) => {
    tasks.push(() => {
      output.push(value);
    });
  };
  const body = (source: Body) => {
    text("}");
    text(";");
    expr(source.result);
    text("return ");
    for (let i = source.statements.length - 1; i >= 0; i--) {
      const statement = source.statements[i]!;
      text(";");
      expr(statement.expr);
      text(`const ${name(statement.id)}=`);
    }
    text("{");
  };
  const expr = (node: Node) => {
    tasks.push(() => {
      const d = node.data;
      switch (node.kind) {
        case "literal":
          text(Object.is(d.value, -0) ? "-0" : JSON.stringify(d.value));
          return;
        case "external":
          text(`globalThis[${JSON.stringify(d.name)}]`);
          return;
        case "ref":
          text(name(d.id as symbol));
          return;
        case "binary":
          text(")");
          expr(d.right as Node);
          text(` ${d.op as string} `);
          expr(d.left as Node);
          text("(");
          return;
        case "unary":
          text(")");
          expr(d.operand as Node);
          text("(!");
          return;
        case "cond":
          text(")");
          expr(d.else as Node);
          text(":");
          expr(d.then as Node);
          text("?");
          expr(d.cond as Node);
          text("(");
          return;
        case "arrow": {
          text(")");
          body(d.body as Body);
          text(`((${(d.params as readonly Node[]).map((p) => name(p.data.id as symbol)).join(",")})=>`);
          return;
        }
        case "call": {
          text(")");
          const args = d.args as readonly Node[];
          for (let i = args.length - 1; i >= 0; i--) {
            expr(args[i]!);
            if (i > 0) text(",");
          }
          text("(");
          expr(d.fn as Node);
          return;
        }
        case "object": {
          text("})");
          const fields = d.fields as readonly (readonly [string, Node])[];
          for (let i = fields.length - 1; i >= 0; i--) {
            const [key, value] = fields[i]!;
            expr(value);
            text(`[${JSON.stringify(key)}]:`);
            if (i > 0) text(",");
          }
          text("({");
          return;
        }
        case "prop":
          text("]");
          text(JSON.stringify(d.key));
          text("[");
          expr(d.object as Node);
          return;
        default:
          throw new Error(`Unsupported staging expression: ${node.kind}`);
      }
    });
  };
  text(")()");
  body(root);
  text("(()=>");
  while (tasks.length) tasks.pop()!();
  return output.join("");
};
