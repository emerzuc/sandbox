import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Folds the Vite build into one self-contained HTML file — the shape a
 * published page needs: no asset requests, title first, bundle last.
 *
 *   npm run build && node tools/single-file.mjs [out.html]
 */
const out = process.argv[2] || 'dist/river-raid.html';
let html = await readFile('dist/index.html', 'utf8');

const tag = html.match(/<script type="module" crossorigin src="\.\/assets\/([^"]+)"><\/script>\n?/);
if (!tag) throw new Error('bundle <script> not found in dist/index.html');
// Inside JS strings and regexes "<\/" is the same as "</", and it keeps the
// HTML parser from ending the inline script early.
const code = (await readFile(`dist/assets/${tag[1]}`, 'utf8')).replaceAll('</script', '<\\/script');

html = html.replace(tag[0], '');
// The host page supplies charset, viewport and icon; the title must lead.
html = html
  .replace(/^\s*<meta charset="utf-8" \/>\s*/m, '')
  .replace(/^\s*<meta name="viewport"[^>]*>\s*/m, '')
  .replace(/^\s*<link rel="icon"[^>]*>\s*/m, '');
html = `${html.trimEnd()}\n\n<script type="module">\n${code}\n</script>\n`;

await mkdir(dirname(out), { recursive: true });
await writeFile(out, html);
console.log(`${out}  ${(html.length / 1024).toFixed(0)} kB  ${html.slice(0, 28).replace(/\n/g, ' ')}`);
