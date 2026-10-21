import type { Declaration, Field, ModelOp, Name } from "./schema-syntax.ts";

export type Model = {
  readonly name: Name;
  readonly fields: readonly Field[];
  readonly constraints: readonly Extract<ModelOp, { kind: "index" | "unique"; }>[];
  readonly links: readonly Extract<ModelOp, { kind: "many" | "one"; }>[];
};

export type Arity = "one" | "optional" | "many";

/** A traversable edge: rows of `target` whose `inner` column equals the owner's `outer` column. */
export type Relation = {
  readonly id: symbol;
  readonly name: Name;
  readonly target: string;
  readonly outer: string;
  readonly inner: string;
  readonly arity: Arity;
};

export type Schema = {
  readonly models: readonly Model[];
  readonly enums: readonly Extract<Declaration, { kind: "enum"; }>[];
  readonly relations: ReadonlyMap<string, ReadonlyMap<string, Relation>>;
};

export type Scalar = "Int" | "Float" | "String" | "Bool" | "DateTime";

export type Base =
  | { readonly kind: "scalar"; readonly name: Scalar; }
  | { readonly kind: "enum"; readonly name: string; }
  | { readonly kind: "key"; readonly model: string; };

export type Value = { readonly base: Base; readonly nullable: boolean; };

export type Binding = { readonly id: symbol; readonly name: string; readonly type: string; };

const scalarNames: ReadonlySet<string> = new Set<Scalar>(["Int", "Float", "String", "Bool", "DateTime"]);

export const isScalar = (name: string): name is Scalar => scalarNames.has(name);

export const has = (field: Field, kind: Field["ops"][number]["kind"]): boolean =>
  field.ops.some((op) => op.kind === kind);

export const unique = (model: Model, field: Field): boolean =>
  has(field, "primaryKey") || has(field, "unique")
  || model.constraints.some((c) =>
    c.kind === "unique" && c.fields.length === 1 && c.fields[0]!.name === field.name.name
  );

export const showBase = (base: Base): string => (base.kind === "key" ? `${base.model}Id` : base.name);

export const showValue = ({ base, nullable }: Value): string => showBase(base) + (nullable ? "?" : "");

/** The value a field holds: a reference takes the value of the key it references. Undefined on a reference cycle. */
export const fieldValue = (
  models: ReadonlyMap<string, Model>,
  model: Model,
  field: Field,
): Value | undefined => {
  const resolve = (model: Model, field: Field, visiting: readonly Field[]): Base | undefined => {
    if (visiting.includes(field)) return undefined;
    const reference = field.ops.find((op) => op.kind === "references");
    if (reference) {
      const target = models.get(reference.model.name);
      const targetField = target?.fields.find((candidate) => candidate.name.name === reference.field.name);
      return target && targetField ? resolve(target, targetField, [...visiting, field]) : undefined;
    }
    if (has(field, "primaryKey")) return { kind: "key", model: model.name.name };
    return isScalar(field.type.name)
      ? { kind: "scalar", name: field.type.name }
      : { kind: "enum", name: field.type.name };
  };
  const base = resolve(model, field, []);
  return base && { base, nullable: field.optional };
};
