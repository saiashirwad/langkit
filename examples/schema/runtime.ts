import { DatabaseSync, type SQLInputValue, type SQLOutputValue, type StatementSync } from "node:sqlite";

export type Cell = "value" | "bool" | "json";

export type Decode =
  | { readonly kind: "rows" | "row"; readonly cells: readonly (readonly [key: string, cell: Cell])[]; }
  | { readonly kind: "value"; readonly cell: Cell; }
  | { readonly kind: "changes"; };

export type Plan = { readonly sql: string; readonly params: readonly string[]; readonly decode: Decode; };

export type Compiled = { readonly ddl: string; readonly plans: Readonly<Record<string, Plan>>; };

type Params = Readonly<Record<string, SQLInputValue | boolean>>;

type Row = Record<string, SQLOutputValue>;

/** What every schema's database offers; each projection extends it with its queries. */
export interface Connection {
  transaction<T>(body: () => T): T;
  init(): void;
  close(): void;
}

interface Database extends Connection, Readonly<Record<string, unknown>> {}

/** A 31-bit FNV-1a hash of the DDL, stored in PRAGMA user_version. Never 0, which marks a fresh file. */
export const fingerprint = (ddl: string): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < ddl.length; index++) {
    hash = Math.imul(hash ^ ddl.charCodeAt(index), 0x01000193);
  }
  return (hash >>> 1) || 1;
};

const cell = (kind: Cell, value: SQLOutputValue | undefined): unknown => {
  if (value === null || value === undefined) return null;
  switch (kind) {
    case "value":
      return value;
    case "bool":
      return value === 1;
    case "json":
      return JSON.parse(String(value));
  }
};

const row = (cells: readonly (readonly [string, Cell])[], values: Row): Readonly<Record<string, unknown>> =>
  Object.fromEntries(cells.map(([key, kind]) => [key, cell(kind, values[key])]));

/** A missing parameter binds as null; the projected type makes every parameter required. */
const bind = (plan: Plan, params: Params | undefined): Record<string, SQLInputValue> =>
  Object.fromEntries(plan.params.map((name) => {
    const value = params?.[name];
    return [name, typeof value === "boolean" ? Number(value) : value ?? null];
  }));

const execute = (plan: Plan, statement: StatementSync, params: Params | undefined): unknown => {
  const bound = bind(plan, params);
  const { decode } = plan;
  switch (decode.kind) {
    case "rows":
      return statement.all(bound).map((values) => row(decode.cells, values));
    case "row": {
      const values = statement.get(bound);
      return values && row(decode.cells, values);
    }
    case "value":
      return cell(decode.cell, statement.get(bound)?.value);
    case "changes":
      return Number(statement.run(bound).changes);
  }
};

const isThenable = (value: unknown): boolean =>
  typeof value === "object" && value !== null && "then" in value && typeof value.then === "function";

export const statements = ({ plans }: Compiled): Readonly<Record<string, string>> =>
  Object.freeze(Object.fromEntries(Object.entries(plans).map(([name, plan]) => [name, plan.sql])));

export const connect = ({ ddl, plans }: Compiled) => (path: string): Database => {
  const connection = new DatabaseSync(path);
  connection.exec("PRAGMA foreign_keys = ON");
  const stamp = fingerprint(ddl);
  const version = () => Number(connection.prepare("PRAGMA user_version").get()?.user_version);
  const empty = () => Number(connection.prepare("SELECT count(*) AS tables FROM sqlite_schema").get()?.tables) === 0;
  const found = version();
  if (found !== stamp && !(found === 0 && empty())) {
    connection.close();
    throw new Error(`${path} has schema fingerprint ${found}, but this schema is ${stamp}; its types would not hold`);
  }
  const prepared = new Map<string, StatementSync>();
  const prepare = (name: string, plan: Plan): StatementSync => {
    const cached = prepared.get(name);
    if (cached) return cached;
    const statement = connection.prepare(plan.sql);
    prepared.set(name, statement);
    return statement;
  };
  let depth = 0;
  const transaction = <T>(body: () => T): T => {
    const savepoint = depth ? `"langkit_${depth}"` : undefined;
    connection.exec(savepoint ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
    depth++;
    try {
      const result = body();
      if (isThenable(result)) {
        throw new TypeError(
          "A transaction body must be synchronous: node:sqlite cannot hold a transaction across await",
        );
      }
      connection.exec(savepoint ? `RELEASE ${savepoint}` : "COMMIT");
      return result;
    } catch (error) {
      connection.exec(savepoint ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : "ROLLBACK");
      throw error;
    } finally {
      depth--;
    }
  };
  const init = (): void => {
    if (version() === stamp) return;
    transaction(() => {
      connection.exec(ddl);
      connection.exec(`PRAGMA user_version = ${stamp}`);
    });
  };
  const database: Database = Object.freeze({
    ...Object.fromEntries(
      Object.entries(plans).map((
        [name, plan],
      ) => [name, (params?: Params) => execute(plan, prepare(name, plan), params)]),
    ),
    init,
    close: (): void => connection.close(),
    transaction,
  });
  return database;
};
