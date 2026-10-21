import { open } from "../schema/blog.schema";

const db = open(":memory:");
db.init();

const sai = db.createUser({ email: "sai@example.com", role: "Admin" });
const kim = db.createUser({ email: "kim@example.com", role: "Member" });
const hello = db.createPost({ author: sai.id, title: "Hello", featured: true, at: "2026-01-01 09:00:00" });
db.createPost({ author: sai.id, title: "Notes", featured: false, at: "2026-01-02 09:00:00" });
db.addComment({ post: hello.id, author: kim.id, body: "Nice post", hidden: false, at: "2026-01-01 10:00:00" });
db.addComment({ post: hello.id, author: kim.id, body: "Buy now", hidden: true, at: "2026-01-01 11:00:00" });
console.log("published", db.publish({ post: hello.id, editor: kim.id }), hello.status);

for (const entry of db.feed({ n: 10, before: null })) {
  const featured: boolean = entry.featured;
  const comments = entry.comments.map((comment) => `${comment.by}: ${comment.body}`);
  console.log(entry.title, featured, entry.author.email, entry.editor?.email, comments, entry.commentCount);
}

for (const post of db.postsBy({ author: sai.id, skip: 0 })) {
  console.log(post.title, post.status, post.editor === null ? "unedited" : `edited by ${post.editor.email}`);
}

const me = db.userByEmail({ email: "sai@example.com" });
console.log(me?.role, db.userByEmail({ email: "nobody@example.com" }), db.latestStaffPick()?.title);
console.log(db.activeAuthors({ role: "Admin" }).map((author) => `${author.email} has ${author.drafts} draft`));

try {
  db.transaction((tx) => {
    tx.purgeDrafts({ author: sai.id });
    throw new Error("changed my mind");
  });
} catch (error) {
  console.log(error instanceof Error ? error.message : error, "drafts:", db.draftCount({ author: sai.id }));
}

console.log(db.hideComments({ author: kim.id }));
db.close();
