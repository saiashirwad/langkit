import mainSql from "../schema/main.schema";
import simpleSql, { type NewPost, type NewUser, type Post, type Role, sql, type User } from "../schema/simple.schema";

const author: User = JSON.parse(
  "{\"id\":1,\"email\":\"sai@example.com\",\"role\":\"Admin\",\"createdAt\":\"2026-01-01 00:00:00\",\"updatedAt\":\"2026-01-01 00:00:00\"}",
);
const post: Post = JSON.parse(
  "{\"id\":7,\"title\":\"Hello\",\"status\":\"Draft\",\"authorId\":1,\"createdAt\":\"2026-01-02 00:00:00\",\"updatedAt\":\"2026-01-02 00:00:00\"}",
);

const timestamp: string = author.updatedAt;
const role: Role = "Admin";
const welcome: NewUser = { email: author.email, role };
const draft = (by: User): NewPost => ({ title: "Hello", authorId: by.id });
const wrote = (by: User, entry: Post): boolean => entry.authorId === by.id;

const tables = (ddl: string): number => ddl.match(/CREATE TABLE/g)?.length ?? 0;

console.log(sql === simpleSql, tables(sql), tables(mainSql));
console.log(timestamp, wrote(author, post));
console.log(JSON.stringify(welcome), JSON.stringify(draft(author)));
