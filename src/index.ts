import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import { ensureDb } from "./db";
import { router } from "./routes";
import { startScheduler } from "./scheduler";
import { authRouter } from "./auth/routes";
import { attachUser, requireAuth } from "./auth/middleware";
import { hasAnySuperadmin } from "./auth/userStore";

// Safety net: an uncaught error in any async handler should never take the whole
// server down (Node terminates on unhandled rejections by default since v15).
// Individual routes should still handle their own errors — this is a last resort.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection (server stays up):", reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception (server stays up):", err);
});

ensureDb();

// No password is ever generated or printed by the server. On first run, with no
// superadmin account yet, the app itself shows a one-time "set up your superadmin
// account" screen where a human types their own username and password — this just logs
// a heads-up that that's what to expect.
if (!hasAnySuperadmin()) {
  console.log("No superadmin account exists yet — open the app to set one up (you'll choose the username and password yourself).");
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(attachUser); // populates req.user from the session cookie on every request; never rejects by itself

app.use("/api/auth", authRouter); // login/setup are intentionally public within here; everything else in this router checks req.user itself
app.use("/api", requireAuth, router); // every other API route requires a logged-in session; per-page edit/view checks happen inside routes.ts

const publicDir = path.join(__dirname, "..", "public");
app.use(express.static(publicDir));

const screenshotsDir = path.join(__dirname, "..", "data", "screenshots");
app.use("/screenshots", express.static(screenshotsDir));

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api") || req.path.startsWith("/screenshots")) return next();
  res.sendFile(path.join(publicDir, "index.html"));
});

const PORT = Number(process.env.PORT ?? 4000);
app.listen(PORT, () => {
  console.log(`Page Checker running at http://localhost:${PORT}`);
  startScheduler();
});
