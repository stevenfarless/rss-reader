const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2"
};

http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filename = path.resolve(root, relative);
  if (!filename.startsWith(root + path.sep)) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  fs.readFile(filename, (error, contents) => {
    if (error) {
      response.writeHead(error.code === "ENOENT" ? 404 : 500).end("Not found");
      return;
    }
    response.writeHead(200, {
      "Content-Type": types[path.extname(filename)] || "application/octet-stream",
      "Cache-Control": "no-store",
      "Service-Worker-Allowed": "/"
    });
    response.end(contents);
  });
}).listen(4173, "127.0.0.1");
