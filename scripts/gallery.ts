/**
 * Build a contact sheet of everything in `out/` so a human (or an agent with a
 * browser) can actually look at the renders.
 *
 * Rendering blind through an API is the failure mode this avoids: statistics
 * tell you an image is not blank, they do not tell you the layout is right.
 */
import { readdir, writeFile } from "node:fs/promises";
import { join, extname, relative } from "node:path";

const ROOT = process.argv[2] ?? "out";
const OUT = process.argv[3] ?? "out/gallery.html";

async function* walk(d: string): AsyncGenerator<string> {
  for (const entry of await readdir(d, { withFileTypes: true })) {
    const p = join(d, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if ([".png", ".jpg", ".jpeg", ".webp", ".pdf"].includes(extname(p))) yield p;
  }
}

const files: string[] = [];
for await (const f of walk(ROOT)) files.push(f);
files.sort();

const cards = files
  .map((f) => {
    const rel = relative("out", f);
    const isPdf = extname(f) === ".pdf";
    const media = isPdf
      ? `<div class="pdf">PDF — ${rel}</div>`
      : `<img src="${rel}" loading="lazy">`;
    return `<figure>${media}<figcaption>${rel}</figcaption></figure>`;
  })
  .join("\n");

const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>meco renders</title>
<style>
  body { margin:0; padding:24px; background:#14161a; color:#e6e8ea;
         font:14px/1.4 ui-sans-serif, system-ui, sans-serif; }
  h1 { font-size:18px; font-weight:600; margin:0 0 20px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(300px,1fr)); gap:20px; }
  figure { margin:0; background:#1d2026; border:1px solid #2c313a; border-radius:8px; overflow:hidden; }
  img { display:block; width:100%; height:auto; background:#fff; }
  .pdf { padding:40px 16px; text-align:center; color:#9aa3af; }
  figcaption { padding:8px 10px; font-size:12px; color:#9aa3af; word-break:break-all; }
</style></head>
<body>
<h1>meco — ${files.length} renders</h1>
<div class="grid">
${cards}
</div>
</body></html>`;

await writeFile(OUT, html);
console.log(`${OUT} — ${files.length} files`);
