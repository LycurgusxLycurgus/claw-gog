import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

const port = 4173;
const root = path.resolve("web");

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
};

createServer(async (req, res) => {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  const filePath = pathname === "/" ? path.join(root, "index.html") : path.join(root, pathname);

  try {
    const body = await readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { "content-type": contentTypes[ext] ?? "text/plain; charset=utf-8" });
    res.end(body);
  } catch {
    const fallback = await readFile(path.join(root, "index.html"));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(fallback);
  }
}).listen(port, () => {
  console.log(JSON.stringify({ level: "info", phase: "web.serve", msg: "Static site serving", port }));
});
