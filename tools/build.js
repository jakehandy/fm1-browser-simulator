#!/usr/bin/env node
/* Folds index.html, src/ and the built-in firmware into one self-contained page:
 * dist/fm1-simulator.html. That file runs from anywhere (a static host, an iframe, a double-click),
 * since it needs no fetch for its own parts.   node tools/build.js */
"use strict";
const fs = require("fs"), path = require("path");
const root = path.join(__dirname, "..");
const read = f => fs.readFileSync(path.join(root, f), "utf8");

let html = read("index.html");
const css = read("src/style.css"), host = read("src/rfm1.js"), tiles = read("src/remote-screen.js"), remote = read("src/remote.js"), app = read("src/app.js");
const m = html.match(/<script>window\.FM1_BUILTIN = (\[.*?\]);<\/script>/);
if (!m) throw new Error("index.html: no FM1_BUILTIN line");
const builtin = eval(m[1]).map(b => ({ key: b.key, b64: fs.readFileSync(path.join(root, b.url)).toString("base64") }));
for (const s of [css, host, tiles, remote, app]) if (/<\/(script|style)/i.test(s)) throw new Error("a source file closes its own tag");

html = html
  .replace('<link rel="stylesheet" href="src/style.css">', () => "<style>\n" + css + "</style>")
  .replace(m[0], () => "<script>window.FM1_BUILTIN = " + JSON.stringify(builtin) + ";</script>")
  .replace('<script src="src/rfm1.js"></script>', () => "<script>\n" + host + "</script>")
  .replace('<script src="src/remote-screen.js"></script>', () => "<script>\n" + tiles + "</script>")
  .replace('<script src="src/remote.js"></script>', () => "<script>\n" + remote + "</script>")
  .replace('<script src="src/app.js"></script>', () => "<script>\n" + app + "</script>");
fs.mkdirSync(path.join(root, "dist"), { recursive: true });
fs.writeFileSync(path.join(root, "dist/fm1-simulator.html"), html);
console.log("wrote dist/fm1-simulator.html, " + Math.round(html.length / 1024) + " KB");
