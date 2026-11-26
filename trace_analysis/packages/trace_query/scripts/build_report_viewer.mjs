// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ui = path.resolve(here, '../../../../ui');
if (!fs.existsSync(path.join(ui, 'out/dist_version/assets/Roboto.woff2'))) {
  throw new Error('Build the Perfetto UI first with ui/build; report assets use its fonts.');
}
const require = createRequire(path.join(ui, 'package.json'));
const { build } = require('esbuild');
const sass = require('sass');
const out = path.resolve(here, '../dist/report-assets');
fs.mkdirSync(out, { recursive: true });
const source = path.join(ui, 'src/plugins/lynx.memory');
const viewerDocument = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Snapshot details</title><link rel="stylesheet" href="viewer.css"></head>
<body class="pf-theme-provider pf-theme-provider--light">
<script src="runtime.js"></script><script src="viewer.js"></script></body></html>`;
const bundle = async (entry) => {
  const result = await build({
    entryPoints: [path.join(source, entry)],
    bundle: true,
    write: false,
    format: 'iife',
    target: 'es2022',
    minify: true,
    define: {
      MEMORY_REPORT_VIEWER_DOCUMENT: JSON.stringify(viewerDocument.replace('<head>', '<head><base href="assets/">')),
    },
  });
  return result.outputFiles[0].text;
};
for (const [entry, name] of [
  ['report_viewer.ts', 'viewer.js'],
  ['report_bridge.ts', 'bridge.js'],
]) {
  fs.writeFileSync(path.join(out, name), await bundle(entry));
}
const runtime = {
  snapshot: await bundle('snapshot_worker/index.ts'),
};
fs.writeFileSync(path.join(out, 'runtime.js'), `window.memoryReportRuntime=${JSON.stringify(runtime)};`);
const css = sass.compile(path.join(source, 'report_viewer.scss'), {
  style: 'compressed',
}).css;
// Keep fonts next to the stylesheet, including direct file:// use.
fs.mkdirSync(path.join(out, 'assets'), { recursive: true });
for (const font of ['Roboto.woff2', 'RobotoMono-Regular.woff2', 'MaterialSymbolsOutlined.woff2']) {
  fs.copyFileSync(path.join(ui, 'out/dist_version/assets', font), path.join(out, 'assets', font));
}
fs.writeFileSync(path.join(out, 'viewer.css'), css);
fs.writeFileSync(path.join(out, 'snapshot-viewer.html'), viewerDocument);
console.log(`Built report viewer: ${out}`);
