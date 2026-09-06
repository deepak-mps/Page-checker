import { ensureDb } from "./db";

ensureDb();
console.log("Database ready.");
process.exit(0);
