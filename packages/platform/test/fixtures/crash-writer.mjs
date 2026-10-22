// Child process for the crash-recovery test: commits one project, starts a second write and waits to be killed.
// Uses the driver directly with the host's pragmas, so the parent can reopen through openStateDatabase.
import Database from "better-sqlite3";

const db = new Database(process.argv[2]);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = FULL");
db.pragma("foreign_keys = ON");
const insert = db.prepare(
  "INSERT INTO projects (id, name, default_languages_json, created_at, updated_at) VALUES (?, ?, '[\"en\"]', ?, ?)",
);
const at = new Date().toISOString();
db.transaction(() => insert.run("project:committed", "Committed", at, at)).immediate();
db.exec("BEGIN IMMEDIATE");
insert.run("project:in-flight", "In flight", at, at);
for (let i = 0; i < 2000; i++) insert.run(`project:in-flight-${i}`, "In flight", at, at);
process.stdout.write("ready\n");
setInterval(() => {}, 1000); // never commits; the parent kills this process
