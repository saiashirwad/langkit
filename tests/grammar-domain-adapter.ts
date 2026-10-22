import type * as M from "../examples/data/data-model.ts";
import type * as D from "../examples/data/data-types.ts";
import type * as H from "../examples/domain/domain-syntax.ts";
import type * as G from "../examples/grammar/domain.grammar";

const name = ({ name, span }: G.Name | G.FieldName): M.Name => ({ name, span });

const dataType = (type: G.DataType): D.TypeExpr => {
  switch (type.kind) {
    case "named":
      return { kind: "named", name: name(type.name), span: type.span };
    case "list":
      return { kind: "list", element: dataType(type.element), max: undefined, span: type.span };
    case "postfix":
      return { kind: "optional", inner: dataType(type.operand), span: type.span };
  }
};

const field = ({ name: id, type }: G.Field): D.FieldExpr => ({ name: name(id), type: dataType(type) });

const entry = (value: G.Entry): D.Entry =>
  value.kind === "spread"
    ? { kind: "spread", record: name(value.record) }
    : { kind: "field", field: field(value.field) };

const item = (value: G.MachineItem): H.MachineItem =>
  value.kind === "event"
    ? { kind: "event", sync: value.sync !== null, name: name(value.name), payload: value.payload.map(field) }
    : {
      kind: "state",
      name: name(value.name),
      role: value.marker?.role ?? "step",
      marker: value.marker?.span,
      entries: value.entries.map(entry),
      on: value.on.map(({ event, target, span }) => ({ event: name(event), target: name(target), span })),
    };

const port = ({ component, event, span }: G.Port): H.Port => ({ component: name(component), event: name(event), span });

/** The hand parser widens a parenthesized formula to its parentheses; here the group node already spans them. */
const formula = (value: G.Formula): H.FormulaExpr => {
  switch (value.kind) {
    case "is":
      return {
        kind: "is",
        component: name(value.component),
        negated: value.negated !== null,
        states: value.states.map(name),
        span: value.span,
      };
    case "group":
      return { ...formula(value.inner), span: value.span };
    case "binary":
      return { kind: value.operator, left: formula(value.left), right: formula(value.right), span: value.span };
  }
};

const claim = (value: G.Claim): H.ClaimExpr =>
  value.kind === "leadsTo"
    ? { kind: "leadsTo", from: formula(value.from), to: formula(value.to) }
    : { kind: value.kind, formula: formula(value.formula) };

const systemClause = (value: G.SystemClause): H.SystemClause => {
  switch (value.kind) {
    case "sync": {
      const [second, ...rest] = value.rest;
      return { kind: "sync", ports: [port(value.first), port(second), ...rest.map(port)], span: value.span };
    }
    case "fair":
      return { kind: "fair", component: name(value.component), span: value.span };
    case "property":
      return { kind: "property", name: name(value.name), claim: claim(value.claim), span: value.span };
  }
};

const declaration = (value: G.Declaration): H.Declaration => {
  switch (value.kind) {
    case "brand":
      return { kind: "brand", name: name(value.name), underlying: name(value.underlying) };
    case "type":
      return value.body.kind === "record"
        ? { kind: "record", name: name(value.name), fields: value.body.fields.map(field) }
        : {
          kind: "union",
          name: name(value.name),
          members: value.body.members.map((member) => ({
            name: name(member.name),
            fields: member.fields?.map(field),
          })),
        };
    case "machine":
      return { kind: "machine", name: name(value.name), items: value.items.map(item) };
    case "system":
      return {
        kind: "system",
        name: name(value.name),
        parts: value.parts.span,
        components: value.parts.components.map((part) => ({ name: name(part.name), machine: name(part.machine) })),
        clauses: value.clauses.map(systemClause),
      };
  }
};

/** The documented adapter: what the grammar's AST says, written in the hand parser's shape. */
export const adapt = ({ imports, declarations }: G.File): H.File => ({
  imports: imports.map(({ names, path, span }) => ({ names: names.map(name), path: path.slice(1, -1), span })),
  declarations: declarations.map(declaration),
});
