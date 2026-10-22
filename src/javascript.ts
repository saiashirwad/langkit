import type { Binding, Body, Import, Module, Value } from "./ir.ts";

const literal = (value: number | boolean | string): string => {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return String(value);
  if (Object.is(value, -0)) return "-0";
  if (Number.isNaN(value)) return "(0 / 0)";
  if (value === Infinity) return "(1 / 0)";
  if (value === -Infinity) return "(-1 / 0)";
  return String(value);
};

const emitter = <T>() => {
  const names = new Map<symbol, string>();
  const name = (binding: Binding<T>): string => {
    const known = names.get(binding.id);
    if (known) return known;
    const chosen = `_${binding.name.replace(/[^a-zA-Z0-9_]/g, "_")}_${names.size}`;
    names.set(binding.id, chosen);
    return chosen;
  };
  let temporaries = 0;
  const block = (body: Body<T>, depth: number): string => {
    const indent = "  ".repeat(depth + 1);
    return [
      "{",
      ...body.declarations.map(({ binding, value }) => `${indent}const ${name(binding)} = ${expr(value, depth + 1)};`),
      `${indent}return ${expr(body.result, depth + 1)};`,
      `${"  ".repeat(depth)}}`,
    ].join("\n");
  };
  const iife = (body: Body<T>, depth: number): string => `(() => ${block(body, depth)})()`;
  const expr = (value: Value<T>, depth: number): string => {
    switch (value.kind) {
      case "literal":
        return literal(value.value);
      case "data":
        return JSON.stringify(value.value);
      case "ref":
        return name(value.binding);
      case "binary":
        return `(${expr(value.left, depth)} ${value.op === "==" ? "===" : value.op} ${expr(value.right, depth)})`;
      case "call":
        return `(${expr(value.fn, depth)})(${expr(value.arg, depth)})`;
      case "fn":
        return `((${name(value.param)}) => ${block(value.body, depth)})`;
      case "conditional":
        return `(${expr(value.cond, depth)} ? ${iife(value.then, depth)} : ${iife(value.else, depth)})`;
      case "block":
        return iife(value.body, depth);
      case "record": {
        const params = value.fields.map((_, index) => `_field${index}`);
        const args = value.fields.map((field) => expr(field.value, depth));
        const entries = value.fields.map((field, index) => `[${JSON.stringify(field.name)}]: ${params[index]}`);
        if (value.base) {
          params.push("_base");
          args.push(expr(value.base, depth));
          entries.unshift("..._base");
        }
        return `((${params.join(", ")}) => ({ __proto__: null${entries.length ? `, ${entries.join(", ")}` : ""} }))(${
          args.join(", ")
        })`;
      }
      case "field":
        return `(${expr(value.record, depth)})[${JSON.stringify(value.name)}]`;
      case "variant":
        return `({ __proto__: null, tag: ${JSON.stringify(value.tag)}, fields: [${
          value.fields.map((field) => expr(field, depth)).join(", ")
        }] })`;
      case "match": {
        const temporary = `$match${temporaries++}`;
        const branches = value.cases.map((branch) => {
          const bindings = branch.bindings
            .map((binding, index) => `const ${name(binding)} = ${temporary}.fields[${index}];`)
            .join(" ");
          return `case ${JSON.stringify(branch.tag)}: { ${bindings} return ${iife(branch.body, depth + 1)}; }`;
        });
        if (value.fallback) {
          const binding = value.fallback.binding;
          branches.push(
            `default: { ${binding ? `const ${name(binding)} = ${temporary};` : ""} return ${
              iife(value.fallback.body, depth + 1)
            }; }`,
          );
        } else branches.push("default: throw new Error(\"Internal non-exhaustive match\");");
        return `((${temporary}) => { switch (${temporary}.tag) { ${branches.join(" ")} } })(${
          expr(value.value, depth)
        })`;
      }
      case "print":
        return `(console.log(${expr(value.value, depth)}), { __proto__: null })`;
    }
  };
  return { name, iife, expr };
};

export const emit = <T>(root: Body<T>): string => `${emitter<T>().iife(root, 0)}\n`;

export const emitModule = <T>({ imports, body, exports }: Module<T>): string => {
  const { name, expr } = emitter<T>();
  const imported = ({ from, names }: Import<T>) =>
    `import { ${
      names.map(([exported, binding]) => `${JSON.stringify(exported)} as ${name(binding)}`).join(", ")
    } } from ${JSON.stringify(from)};`;
  return [
    ...imports.map(imported),
    ...body.declarations.map(({ binding, value }) => `const ${name(binding)} = ${expr(value, 0)};`),
    ...(exports.length
      ? [
        `export { ${
          exports.map(([exported, binding]) => `${name(binding)} as ${JSON.stringify(exported)}`).join(", ")
        } };`,
      ]
      : []),
    `export default ${expr(body.result, 0)};`,
    "",
  ].join("\n");
};
