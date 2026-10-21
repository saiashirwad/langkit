import type { Column, Query, Read, Shape, Term } from "./queries.ts";

export const quote = (name: string): string => `"${name.replaceAll("\"", "\"\"")}"`;

/** SQLite SQL text cannot contain a literal NUL. Hex preserves all UTF-8 text. */
export const text = (value: string): string =>
  value.includes("\0")
    ? `(CAST(X'${Buffer.from(value).toString("hex")}' AS TEXT))`
    : `'${value.replaceAll("'", "''")}'`;

const operators = { "==": "=", "!=": "<>", "<": "<", "<=": "<=", ">": ">", ">=": ">=" } as const;

const isBool = (column: Column): boolean =>
  column.output.kind === "value" && column.output.value.base.kind === "scalar"
  && column.output.value.base.name === "Bool";

/** One statement per query. Depth 0 is `t0` in reads and the table itself in writes, which cannot alias it. */
export const statement = ({ statement }: Query): string => {
  const root = statement.kind === "read" ? "\"t0\"" : quote(statement.model.name.name);
  const alias = (depth: number): string => (depth === 0 ? root : `"t${depth}"`);

  const sql = (term: Term): string => {
    switch (term.kind) {
      case "column":
        return `${alias(term.depth)}.${quote(term.column)}`;
      case "param":
        return `:${term.name}`;
      case "literal":
        return term.value === null
          ? "NULL"
          : typeof term.value === "string"
          ? text(term.value)
          : typeof term.value === "boolean"
          ? (term.value ? "1" : "0")
          : String(term.value);
      case "now":
        return "CURRENT_TIMESTAMP";
      case "not":
        return `NOT ${sql(term.operand)}`;
      case "and":
      case "or":
        return `(${sql(term.left)} ${term.kind.toUpperCase()} ${sql(term.right)})`;
      case "compare": {
        const op = term.nullSafe && (term.op === "==" || term.op === "!=")
          ? (term.op === "==" ? "IS" : "IS NOT")
          : operators[term.op];
        return `${sql(term.left)} ${op} ${sql(term.right)}`;
      }
      case "isNull":
        return `${sql(term.operand)} IS ${term.negated ? "NOT " : ""}NULL`;
      case "follow": {
        const inner = term.depth + 1;
        return `(SELECT ${sql(term.then)} FROM ${quote(term.relation.target)} AS ${alias(inner)} WHERE ${
          alias(inner)
        }.${quote(term.relation.inner)} = ${alias(term.depth)}.${quote(term.relation.outer)})`;
      }
      case "read":
        return nested(term.read);
    }
  };

  const conditions = (read: Read): readonly string[] => [
    ...(read.link
      ? [`${alias(read.depth)}.${quote(read.link.inner)} = ${alias(read.depth - 1)}.${quote(read.link.outer)}`]
      : []),
    ...read.where.map(sql),
  ];

  const where = (
    terms: readonly string[],
    gap = " ",
  ): string => (terms.length ? `${gap}WHERE ${terms.join(" AND ")}` : "");

  const orderBy = (read: Read): string =>
    read.order.length
      ? ` ORDER BY ${
        read.order.map(({ column, descending }) => `${alias(read.depth)}.${quote(column)}${descending ? " DESC" : ""}`)
          .join(", ")
      }`
      : "";

  const page = (read: Read): string =>
    `${read.limit ? ` LIMIT ${sql(read.limit)}` : read.offset ? " LIMIT -1" : ""}${
      read.offset ? ` OFFSET ${sql(read.offset)}` : ""
    }`;

  const filtered = (read: Read): string =>
    `${quote(read.model.name.name)} AS ${alias(read.depth)}${where(conditions(read))}`;

  // Paging happens in a FROM subquery so relations are projected only for the rows that survive it.
  const from = (read: Read): string =>
    read.limit || read.offset
      ? `(SELECT * FROM ${filtered(read)}${orderBy(read)}${page(read)}) AS ${alias(read.depth)}`
      : filtered(read);

  const json = (column: Column): string => {
    if (isBool(column)) return `json(CASE ${sql(column.term)} WHEN 1 THEN 'true' WHEN 0 THEN 'false' END)`;
    return column.output.kind === "value" ? sql(column.term) : `json(${sql(column.term)})`;
  };

  const object = (shape: Shape): string =>
    `json_object(${shape.columns.map((column) => `${text(column.key.name)}, ${json(column)}`).join(", ")})`;

  const first = (read: Read, project: string, gap = " "): string =>
    `SELECT ${project}${gap}FROM ${filtered(read)}${orderBy(read)} LIMIT 1${
      read.offset ? ` OFFSET ${sql(read.offset)}` : ""
    }`;

  const nested = (read: Read): string => {
    switch (read.result.kind) {
      case "count":
        return `(SELECT count(*) FROM ${from(read)})`;
      case "exists":
        return `EXISTS (SELECT 1 FROM ${from(read)})`;
      case "single":
        return `(SELECT ${object(read.result.shape)} FROM ${filtered(read)})`;
      case "first":
        return `(${first(read, object(read.result.shape))})`;
      case "rows":
        return `(SELECT json_group_array(${object(read.result.shape)}${orderBy(read)}) FROM ${from(read)})`;
    }
  };

  const columns = (shape: Shape): string =>
    shape.columns.map((column) => `${sql(column.term)} AS ${quote(column.key.name)}`).join(", ");

  const returning = (shape: Shape | undefined): string => (shape ? `\nRETURNING ${columns(shape)}` : "");

  switch (statement.kind) {
    case "read": {
      const read = statement;
      switch (read.result.kind) {
        case "count":
          return `SELECT count(*) AS "value"\nFROM ${from(read)}`;
        case "exists":
          return `SELECT EXISTS (SELECT 1 FROM ${from(read)}) AS "value"`;
        case "first":
          return first(read, columns(read.result.shape), "\n");
        case "rows":
        case "single":
          return `SELECT ${columns(read.result.shape)}\nFROM ${from(read)}${orderBy(read)}`;
      }
    }
    case "insert": {
      const table = quote(statement.model.name.name);
      const values = statement.values;
      return (values.length
        ? `INSERT INTO ${table} (${values.map((value) => quote(value.column)).join(", ")})\nVALUES (${
          values.map((value) => sql(value.term)).join(", ")
        })`
        : `INSERT INTO ${table} DEFAULT VALUES`) + returning(statement.returning);
    }
    case "update":
      return `UPDATE ${root}\nSET ${
        statement.values.map((value) => `${quote(value.column)} = ${sql(value.term)}`).join(", ")
      }${where(statement.where.map(sql), "\n")}${returning(statement.returning)}`;
    case "delete":
      return `DELETE FROM ${root}${where(statement.where.map(sql), "\n")}${returning(statement.returning)}`;
  }
};
