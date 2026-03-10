import { spawn } from "node:child_process";

const convex = spawn("npx", ["convex", "dev"], { stdio: "inherit", shell: true });
const web = spawn("node", ["scripts/serve-web.mjs"], { stdio: "inherit", shell: true });

const closeAll = (code = 0) => {
  convex.kill();
  web.kill();
  process.exit(code);
};

process.on("SIGINT", () => closeAll(0));
process.on("SIGTERM", () => closeAll(0));

convex.on("exit", (code) => closeAll(code ?? 0));
web.on("exit", (code) => closeAll(code ?? 0));
