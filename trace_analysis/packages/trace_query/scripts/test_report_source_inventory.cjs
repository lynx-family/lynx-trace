// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0.
// Exercise preparation, resolution, packaging and offline rendering without a Trace processor.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { SourceMapGenerator } = require('source-map-js');
const { prepareFrontend, FrontendSourceResolver } = require('../dist/reports/frontend_sources');
const { generateMemoryAnalysisArtifacts } = require('../dist/reports/memory_analysis_artifacts');
const { generateMemoryAnalysisReport } = require('../dist/reports/memory_analysis_report');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'source-inventory-report-'));
const root = path.join(directory, 'project');
const output = path.join(root, 'dist');
const cache = path.join(directory, 'cache.json');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const count = (text, marker) => text.split(marker).length - 1;
const section = (html) =>
  html.slice(html.indexOf('<section id="snapshots">'), html.indexOf('<h3 id="snapshot-inventory">'));

async function main() {
  fs.mkdirSync(output, { recursive: true });
  fs.mkdirSync(path.join(root, 'src'));
  const original = 'export function first() {}\n';
  fs.writeFileSync(path.join(root, 'src/app.ts'), original);
  const script = 'function first(){}\nfunction second(){}\n';
  const map = new SourceMapGenerator({ file: 'app.js' });
  map.addMapping({ generated: { line: 1, column: 0 }, source: '../src/app.ts', original: { line: 1, column: 0 } });
  map.addMapping({ generated: { line: 2, column: 0 } });
  map.setSourceContent('../src/app.ts', original);
  for (const name of ['app', 'unused']) {
    fs.writeFileSync(path.join(output, `${name}.js`), script);
    fs.writeFileSync(path.join(output, `${name}.js.map`), map.toString());
  }
  const project = { id: 'page<script>', root, origin: { kind: 'local' } };
  const manifest = prepareFrontend(
    {
      version: 1,
      projects: [
        project,
        { id: 'skipped', root: '', abandoned: { reason: 'Explicit fixture opt-out <reason>', userConfirmed: true } },
      ],
    },
    directory,
  );
  const heap = {
    snapshot: {
      node_count: 4,
      meta: {
        node_fields: ['type', 'name', 'id'],
        location_fields: ['object_index', 'script_id', 'source_offset'],
      },
    },
    strings: ['Function', 'file://view/app.js', 'file://view/missing<script>.js'],
    nodes: [0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0, 4],
    locations: [0, 1, 0, 3, 1, script.indexOf('function second'), 6, 1, 10000, 9, 3, 0],
    primjs_sources: { version: 1, fields: ['script_id', 'name'], scripts: [1, 1, 2, 1, 3, 2] },
  };
  const resolver = new FrontendSourceResolver(manifest, cache);
  const resolved = resolver.snapshot(JSON.stringify(heap));
  assert.deepEqual(Object.keys(resolved.bindings), ['1', '2', '3']);
  assert.equal(resolved.bindings[1].selected.projectId, project.id);
  assert.equal(resolved.bindings[2].selected, undefined, 'Unused script-table entries are unchecked');
  assert.equal(resolved.bindings[2].candidates.length, 1);
  assert.deepEqual(resolved.bindings[3].candidates, []);
  const noLocations = structuredClone(heap);
  delete noLocations.locations;
  delete noLocations.snapshot.meta.location_fields;
  assert.equal(Object.keys(resolver.snapshot(JSON.stringify(noLocations)).bindings).length, 3);
  const unnamed = structuredClone(heap);
  delete unnamed.primjs_sources;
  assert.equal(resolver.snapshot(JSON.stringify(unnamed)).bindings[1].script, 'script_id:1');
  const ambiguous = prepareFrontend({ version: 1, projects: [project, { ...project, id: 'second' }] }, directory);
  const ambiguousLocations = new FrontendSourceResolver(ambiguous, cache).snapshot(JSON.stringify(heap));
  assert.equal(ambiguousLocations.bindings[1].candidates.length, 2);
  assert.equal(ambiguousLocations.bindings[1].selected, undefined);
  assert.match(ambiguousLocations.nodes[0].error, /Ambiguous/);

  const content = JSON.stringify(heap);
  fs.writeFileSync(path.join(directory, 'input.heapsnapshot'), content);
  fs.writeFileSync(path.join(directory, 'input.pftrace'), 'Synthetic report packaging fixture');
  const result = {
    schemaVersion: 4,
    valid: true,
    options: {},
    trace: { startTsMs: 0, endTsMs: 1, memoryTraceEnabled: true, processUpids: [] },
    pages: [],
    vms: [],
    mtsPoolGrowthEvents: [],
    sharedBtsSlotCharts: [],
    sharedBtsVmAnalyses: [],
    residualAnalyses: [],
    issues: [],
    warnings: [],
    snapshots: [
      {
        sliceId: 1,
        snapshotId: 's1',
        vmId: 'vm',
        index: 1,
        captureTsMs: 0,
        kind: 'manual',
        integrity: 'complete',
        chunkCount: 1,
        memory: {},
        outputPath: 'input.heapsnapshot',
        sha256: hash(content),
      },
    ],
    summary: {
      pageCount: 0,
      analyzedPageCount: 0,
      vmCount: 1,
      snapshotCount: 1,
      issueCount: 0,
      confirmedLeakPageCount: 0,
      suspectedPageCount: 0,
      incompletePageCount: 0,
      conclusion: 'Fixture',
    },
  };
  const first = path.join(directory, 'first');
  await generateMemoryAnalysisArtifacts(result, first, {
    tracePath: path.join(directory, 'input.pftrace'),
    baseDirectory: directory,
    frontend: manifest,
  });
  assert.equal(result.frontendSources.artifacts.length, 2);
  assert.equal(result.frontendSources.artifacts[0].sources, undefined, 'Full maps and sources are not copied');
  assert.equal(result.frontendSources.artifacts[0].sourceFileCount, 1);
  assert.equal(result.frontendSources.projects[0].root, fs.realpathSync(root));
  assert.equal(result.frontendSources.projects[1].abandoned.userConfirmed, true);
  const html = fs.readFileSync(path.join(first, 'report.html'), 'utf8');
  const table = section(html);
  assert.equal(count(table, 'data-source-artifact'), 2);
  assert.equal(count(table, 'data-source-project'), 1);
  assert.equal(count(table, 'data-source-binding'), 0);
  assert.equal(count(table, 'data-source-artifact class="source-bound"'), 1);
  assert.equal(count(table, 'data-source-artifact class="source-unbound"'), 1);
  assert.equal(count(table, 'data-source-project class="source-unbound"'), 1);
  assert.ok(!html.includes('各快照脚本的绑定与可用性'));
  assert.ok(!html.includes('id="source-bindings"'));
  for (const text of [
    '已绑定 1 个快照脚本',
    '已提供，未引用',
    '已跳过（用户同意）',
    'page&lt;script&gt;',
    'Explicit fixture opt-out &lt;reason&gt;',
  ]) {
    assert.ok(table.includes(text), text);
  }
  assert.ok(!html.slice(html.indexOf('<header>'), html.indexOf('</header>')).includes('source-inventory'));
  assert.ok(html.includes('data-snapshot-viewer'));
  assert.ok(table.includes('data-en="Bound to 1 snapshot scripts"'));
  for (const id of ['source-origins', 'snapshot-inventory']) {
    assert.ok(html.includes(`<h3 id="${id}">`));
    assert.ok(html.includes(`data-report-target="${id}"`));
  }

  const failedBindings = structuredClone(result);
  failedBindings.frontendSources.snapshots.s1.locations = ambiguousLocations;
  const failedHtml = fs.readFileSync(
    generateMemoryAnalysisReport(failedBindings, path.join(directory, 'ambiguous.html')),
    'utf8',
  );
  assert.ok(section(failedHtml).includes('未绑定'));
  assert.equal(count(section(failedHtml), 'data-source-artifact class="source-bound"'), 0);
  assert.equal(count(section(failedHtml), 'data-source-artifact class="source-unbound"'), 2);

  // Persist separate acquisition provenance and render a mapless artifact honestly.
  const external = path.join(directory, 'download');
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, 'app.js'), script);
  const supplied = prepareFrontend(
    {
      version: 1,
      projects: [
        {
          ...project,
          artifactFiles: [{ script: path.join(external, 'app.js') }],
          artifactOrigin: { kind: 'url', locator: 'https://example.test/build.js?name=<artifact>' },
        },
      ],
    },
    directory,
  );
  const suppliedResult = structuredClone(result);
  suppliedResult.snapshots[0].outputPath = 'input.heapsnapshot';
  await generateMemoryAnalysisArtifacts(suppliedResult, path.join(directory, 'supplied'), {
    tracePath: path.join(directory, 'input.pftrace'),
    baseDirectory: directory,
    frontend: supplied,
  });
  assert.equal(suppliedResult.frontendSources.projects[0].artifactOrigin.kind, 'url');
  const suppliedHtml = fs.readFileSync(path.join(directory, 'supplied/report.html'), 'utf8');
  assert.ok(section(suppliedHtml).includes('仅生成 JS；未提供 sourcemap'));
  assert.ok(section(suppliedHtml).includes('build.js?name=&lt;artifact&gt;'));
  const suppliedNode = suppliedResult.frontendSources.snapshots.s1.locations.nodes[0];
  assert.ok(suppliedNode.generatedUrl);
  assert.equal(suppliedNode.url, undefined);

  // Moving the checkout proves rerendering uses saved evidence, not current source files.
  fs.renameSync(root, `${root}-offline`);
  const second = path.join(directory, 'second');
  await generateMemoryAnalysisArtifacts(result, second, { baseDirectory: first });
  assert.equal(section(fs.readFileSync(path.join(second, 'report.html'), 'utf8')), table);
  const legacy = structuredClone(result);
  delete legacy.frontendSources.artifacts;
  delete legacy.frontendSources.snapshots.s1.locations.bindings;
  const legacyHtml = fs.readFileSync(generateMemoryAnalysisReport(legacy, path.join(directory, 'legacy.html')), 'utf8');
  assert.ok(section(legacyHtml).includes('旧分析数据未保存完整产物清单'));
  assert.ok(section(legacyHtml).includes('产物清单未保存'));
  const noSources = structuredClone(result);
  delete noSources.frontendSources;
  const noSourcesHtml = fs.readFileSync(
    generateMemoryAnalysisReport(noSources, path.join(directory, 'no-sources.html')),
    'utf8',
  );
  assert.ok(noSourcesHtml.includes('未提供源码绑定资料'));
  assert.ok(noSourcesHtml.includes('快照清单'));
  result.frontendSources.snapshots.s1.sha256 = 'stale';
  await generateMemoryAnalysisArtifacts(result, path.join(directory, 'stale'), { baseDirectory: second });
  assert.equal(result.frontendSources.snapshots.s1, undefined, 'Stale source evidence is not displayed');
  console.log('Single source table, binding styles, navigation, escaping and offline report checks passed.');
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(directory, { recursive: true, force: true }));
