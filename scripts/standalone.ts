// Packs the standalone build (vite build --mode standalone) into single HTML
// files that need no server:
//
//   dist/ai-hustle-city.html     open it straight from disk in a browser
//   dist/artifact/index.html     the same page without the <html>/<head> shell
//                                (for hosts that add their own, e.g. a
//                                claude.ai artifact)
//
//   npm run build:standalone

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "dist/standalone");
const assets = path.join(dist, "assets");
const files = readdirSync(assets);
const js = files.filter((f) => f.endsWith(".js"));
const css = files.filter((f) => f.endsWith(".css"));
if (js.length !== 1) throw new Error(`expected one JS bundle, found ${js.join(", ") || "none"}`);

// Inline <script> content must not contain "</script" or "<!--".
const script = readFileSync(path.join(assets, js[0]), "utf8").replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
const style = css.map((f) => readFileSync(path.join(assets, f), "utf8")).join("\n").replace(/<\/style/gi, "<\\/style");

const title = "AI Hustle City";
const body = `<div id="root"></div>\n<script type="module">\n${script}\n</script>\n`;
const page = `<title>${title}</title>\n<style>\n${style}\n</style>\n${body}`;
const full = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🏙️</text></svg>" />
<title>${title}</title>
<style>
${style}
</style>
</head>
<body>
${body}</body>
</html>
`;

mkdirSync(path.join(root, "dist/artifact"), { recursive: true });
writeFileSync(path.join(root, "dist/ai-hustle-city.html"), full);
writeFileSync(path.join(root, "dist/artifact/index.html"), page);
const kb = (s: string) => `${Math.round(Buffer.byteLength(s) / 1024)} KB`;
console.log(`\n  📦 dist/ai-hustle-city.html (${kb(full)}) — open it in a browser, no server needed`);
console.log(`  📦 dist/artifact/index.html (${kb(page)})\n`);
