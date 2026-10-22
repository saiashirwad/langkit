import type { Diagnostic, Span } from "langkit";
import { atom, type HostLanguage, type Piece, specifier, unhosted, verbatim } from "langkit/host";
import { binding, field, type Module, ref } from "langkit/ir";
import { emitModule } from "langkit/javascript";
import { flatten, prune, type Type } from "langkit/types/higher-rank";
import { namer, printer, reserved } from "langkit/types/typescript";
import type { DataDecl, Expr } from "./advanced-syntax.ts";
import { type Checked, checkSource } from "./advanced.ts";

const brand = (declaration: DataDecl, datatypes: ReadonlyMap<string, string>): Piece[] => {
  const parameters = declaration.parameters.map((parameter) => parameter.toUpperCase()).map(namer(datatypes));
  const tuple = `readonly [${parameters.join(", ")}]`;
  return [
    `declare const $${declaration.name}: unique symbol;\nexport type `,
    verbatim(declaration.name, declaration.nameSpan),
    `${
      parameters.length ? `<${parameters.join(", ")}>` : ""
    } = { readonly [$${declaration.name}]: (x: ${tuple}) => ${tuple} };\n`,
  ];
};

const exported = (body: Expr) => {
  const binders = new Map<string, Span>();
  let result = body;
  while (result.kind === "let") {
    binders.set(result.name, result.nameSpan);
    result = result.body;
  }
  const origin = (name: string): Span => {
    const field = result.kind === "record" ? result.fields.find((candidate) => candidate.name === name) : undefined;
    if (!field) return result.span;
    const binder = field.value.kind === "name" && field.value.name === name ? binders.get(name) : undefined;
    return binder ?? field.nameSpan;
  };
  return { result, origin };
};

const program = (checked: Checked, fields: readonly (readonly [string, Type])[], uri: string): Module<Type> => {
  const { body, imports, constructors } = checked;
  const main = binding("main", body.result.type);
  const exports = fields.map(([name, type]) => [name, binding(name, type)] as const);
  return {
    imports: [...Map.groupBy(imports, (imported) => imported.from)].map(([from, names]) => ({
      from: specifier(uri, from),
      names: names.map((imported) => [imported.name, imported.binding] as const),
    })),
    body: {
      declarations: [
        ...body.declarations,
        { binding: main, value: body.result },
        ...exports.map(([name, exported]) => ({ binding: exported, value: field(exported.type, ref(main), name) })),
      ],
      result: ref(main),
    },
    exports: [...exports, ...constructors.filter(([name]) => !fields.some(([exported]) => exported === name))],
  };
};

const unrepresentable = (name: string, reason: string, span: Span): Diagnostic => ({
  message: `TypeScript cannot represent ${name}: ${reason}`,
  span,
  context: [],
});

export const host: HostLanguage = {
  extension: ".advanced",
  host: (source, uri) => {
    const checked = checkSource(source, { uri });
    if (!checked.success) return unhosted(checked.errors);
    const { type, syntax, datatypes } = checked.value;
    const referenced = new Map<string, string>();
    const typescript = printer(datatypes, referenced);
    const { result, origin } = exported(syntax.body);
    const diagnostics: Diagnostic[] = [];
    const declarations: Piece[] = syntax.types.flatMap((declaration) => brand(declaration, datatypes));
    const resultType = prune(type);
    const fields = resultType.kind === "record" && !flatten(resultType.row).tail
      ? [...flatten(resultType.row).fields]
      : [];
    const members: string[] = [];
    for (const [name, fieldType] of fields) {
      const span = origin(name);
      const printed = typescript(fieldType);
      const problem = name === "default" ? "a field called default collides with the default export" : printed.problem;
      if (problem) {
        diagnostics.push(unrepresentable(name, problem, span));
        continue;
      }
      members.push(`readonly ${name}: ${printed.text}`);
      declarations.push(
        ...(reserved.has(name)
          ? ["declare const ", atom(`$${name}`, span), `: ${printed.text};\nexport { $${name} as ${name} };\n`]
          : [
            "export declare const ",
            source.slice(span.start, span.end) === name ? verbatim(name, span) : atom(name, span),
            `: ${printed.text};\n`,
          ]),
      );
    }
    const main = fields.some(([name]) => name === "main") ? "$main" : "main";
    const printed = fields.length
      ? { text: members.length ? `{ ${members.join("; ")} }` : "object", problem: undefined }
      : typescript(type);
    if (printed.problem) diagnostics.push(unrepresentable("the module result", printed.problem, result.span));
    else declarations.push("declare const ", atom(main, result.span), `: ${printed.text};\nexport default ${main};\n`);
    const taken = new Set(["main", ...fields.map(([name]) => name), ...datatypes.keys()]);
    const assumed = checked.value.imports.flatMap(({ name, from, kind, type, span }) => {
      if (kind !== "field") return [];
      const local = reserved.has(name) || taken.has(name) ? `$$${name}` : name;
      const printed = typescript(type);
      return [atom(
        `import { ${local === name ? name : `${name} as ${local}`} } from "${specifier(uri, from)}";\n`
          + (printed.problem ? "" : `${local} satisfies ${printed.text};\n`),
        span,
      )];
    });
    const imports = Map.groupBy([...referenced].filter(([, module]) => module !== uri), ([, module]) => module);
    return {
      declarations: [
        ...[...imports].map(([module, names]) =>
          `import type { ${names.map(([name]) => name).sort().join(", ")} } from "${specifier(uri, module)}";\n`
        ),
        ...assumed,
        ...declarations,
      ],
      javascript: diagnostics.length ? undefined : () => emitModule(program(checked.value, fields, uri)),
      diagnostics,
    };
  },
};
