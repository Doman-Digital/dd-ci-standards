// A static server for a built site, as the phone screenshot run needs it: `node serve.mjs <dir> <port>`.
// A path is served as the file itself, then <path>.html (Astro's `format: "file"`), then <path>/index.html.
// Nothing else: no redirects, no Worker routes. A page that needs the Worker is not a page to screenshot here.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const [dir, port] = process.argv.slice(2);
if (!dir || !port) throw new Error("usage: node serve.mjs <dir> <port>");
const root = resolve(dir);
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".avif": "image/avif", ".gif": "image/gif", ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff", ".mp4": "video/mp4", ".webm": "video/webm", ".txt": "text/plain", ".xml": "application/xml" };

async function file(path) {
  try { return (await stat(path)).isFile() ? path : null; } catch { return null; }
}

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
  const local = normalize(join(root, path));
  if (!local.startsWith(root)) return res.writeHead(403).end();
  const found = (await file(local)) ?? (await file(`${local.replace(/\/$/, "")}.html`)) ?? (await file(join(local, "index.html")));
  if (!found) return res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  res.writeHead(200, { "content-type": TYPES[extname(found)] ?? "application/octet-stream", "cache-control": "no-store" });
  res.end(await readFile(found));
}).listen(Number(port), "127.0.0.1");
