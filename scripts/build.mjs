/**
 * scripts/build.mjs
 *
 * Bundles all ES modules under src/ into a single self-contained
 * dist/timesheet.html file with inlined CSS and JS. The output is what
 * gets deployed to GitHub Pages or emailed to users.
 *
 * Run with: npm run build
 *
 * What this does:
 *   1. esbuild bundles src/app.js → one JS string
 *   2. Reads assets/styles.css → one CSS string
 *   3. Reads index.html, strips <link rel=stylesheet> and <script type=module>
 *   4. Injects inline <style> and <script> tags
 *   5. Writes dist/timesheet.html and dist/index.html (same content, both
 *      names so GitHub Pages picks it up either way)
 */

import esbuild from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

async function build() {
  console.log('Bundling JS...');
  const jsResult = await esbuild.build({
    entryPoints: [path.join(ROOT, 'src/app.js')],
    bundle: true,
    format: 'iife',
    target: ['es2020'],
    minify: true,
    write: false,
    logLevel: 'info',
  });
  const js = jsResult.outputFiles[0].text;

  console.log('Reading CSS...');
  const css = await readFile(path.join(ROOT, 'assets/styles.css'), 'utf8');

  console.log('Reading HTML shell...');
  let html = await readFile(path.join(ROOT, 'index.html'), 'utf8');

  // Strip the external CSS/JS links
  html = html.replace(/<link\s+rel="stylesheet"\s+href="assets\/styles\.css">/, '<style>\n' + css + '\n</style>');
  html = html.replace(/<script\s+type="module"\s+src="src\/app\.js"><\/script>/, '<script>\n' + js + '\n</script>');

  console.log('Writing dist/...');
  if (!existsSync(path.join(ROOT, 'dist'))) {
    await mkdir(path.join(ROOT, 'dist'), { recursive: true });
  }
  await writeFile(path.join(ROOT, 'dist/timesheet.html'), html, 'utf8');
  await writeFile(path.join(ROOT, 'dist/index.html'), html, 'utf8');

  const sizeKB = (html.length / 1024).toFixed(1);
  console.log(`Done. dist/timesheet.html (${sizeKB} KB)`);
}

build().catch(err => {
  console.error('Build failed:', err);
  process.exit(1);
});
