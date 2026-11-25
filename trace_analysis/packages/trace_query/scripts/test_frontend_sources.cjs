// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0.
// CLI and artifact integration checks. No Trace processor or network is needed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { SourceMapGenerator } = require('source-map-js');
const {
  prepareFrontend,
  readFrontend,
  confirmFrontend,
  FrontendSourceResolver,
  generatedPosition,
} = require('../dist/reports/frontend_sources');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-frontend-sources-'));
const root = path.join(directory, 'project');
const output = path.join(root, 'dist/.rspeedy/main');
fs.mkdirSync(output, { recursive: true });
fs.mkdirSync(path.join(root, 'src'));
const original = 'const callback = () => 42;\n';
fs.writeFileSync(path.join(root, 'src/App.tsx'), original);
const prefix = '/* 中😀 */\r\nconst x = ';
const script = prefix + '()=>42;';
fs.writeFileSync(path.join(output, 'background.hash.js'), script);
const source = 'file:///build/machine/project/src/App.tsx';
const map = new SourceMapGenerator({ file: 'background.hash.js' });
map.addMapping({ generated: { line: 2, column: 10 }, source, original: { line: 1, column: 17 } });
map.setSourceContent(source, original);
fs.writeFileSync(path.join(output, 'background.hash.js.map'), map.toString());
const config = { version: 1, projects: [{ id: 'page', root, outputDirs: ['dist'] }] };
const snapshot = JSON.stringify({
  snapshot: {
    node_count: 1,
    meta: {
      node_fields: ['type', 'name', 'id'],
      node_types: [['closure'], 'string', 'number'],
      location_fields: ['object_index', 'script_id', 'source_offset'],
    },
  },
  strings: ['Function', 'file://view3/.rspeedy/main/background.hash.js'],
  nodes: [0, 0, 123],
  locations: [0, 4, Buffer.byteLength(prefix)],
  primjs_sources: { version: 1, fields: ['script_id', 'name'], scripts: [4, 1] },
});
const manifestFile = path.join(directory, 'manifest.json');
const cli = path.resolve(__dirname, '../dist/cli/index.js');
function writeManifest(manifest) {
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
}
function command(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    // Missing Trace paths fail before launching this local binary; no download or processor is needed.
    env: { ...process.env, TRACE_PROCESSOR_SHELL_URL: process.execPath },
  });
  return { ...result, text: result.stdout + result.stderr };
}

try {
  assert.deepEqual(generatedPosition(Buffer.from(prefix), Buffer.byteLength(prefix)), { line: 2, column: 10 });
  assert.deepEqual(generatedPosition(Buffer.from('中😀x'), 7), { line: 1, column: 3 });
  assert.throws(() => generatedPosition(Buffer.from('中'), 1), /UTF-8/);
  let manifest = prepareFrontend(config, directory);
  assert.equal(manifest.artifacts.length, 1);
  assert.equal(Object.keys(manifest.artifacts[0].sources).length, 1);
  writeManifest(manifest);
  assert.equal(readFrontend(manifestFile).digest, manifest.digest);
  assert.equal(readFrontend(manifestFile).confirmation, undefined);
  const preparation = path.join(directory, 'source-preparation.json');
  fs.writeFileSync(preparation, JSON.stringify({
    version: 1,
    frontend: { state: 'prepared', manifestDigest: manifest.digest },
    lynx: { state: 'opted-out', reason: 'Synthetic frontend-only fixture', userStatement: 'Test without runtime sources' },
  }));
  for (const name of ['memory-analysis', 'metadata']) {
    const unconfirmed = command([
      '--source-preparation',
      preparation,
      '--frontend-manifest',
      manifestFile,
      name,
      '--path',
      path.join(directory, 'absent.pftrace'),
    ]);
    assert.notEqual(unconfirmed.status, 0);
    assert.match(
      unconfirmed.text,
      /Trace file does not exist/,
      'Prepared artifacts reach Trace access without approval',
    );
    assert.doesNotMatch(unconfirmed.text, /not user-confirmed/);
  }
  assert.throws(() => confirmFrontend(manifestFile, 'stale-digest', 'Synthetic test approval'), /digest/);
  confirmFrontend(manifestFile, manifest.digest, 'Synthetic integration fixture approval; no user Trace');
  assert.equal(readFrontend(manifestFile).confirmation.digest, manifest.digest);

  const cache = path.join(directory, 'cache.json');
  let resolver = new FrontendSourceResolver(manifest, cache);
  const location = resolver.snapshot(snapshot).nodes[0];
  assert.equal(location.error, undefined);
  assert.equal(location.file, fs.realpathSync(path.join(root, 'src/App.tsx')));
  assert.equal(location.line, 1);
  assert.equal(location.column, 18);
  assert.match(location.url, /App\.tsx#L1:18$/);
  assert.deepEqual([location.generatedLine, location.generatedColumn], [2, 10]);
  assert.match(location.generatedUrl, /file:\/\/\/.*\/dist\/\.rspeedy\/main\/background\.hash\.js#L2:11$/);
  assert.equal(location.snippet, original);
  assert.deepEqual(
    location.generatedSnippet,
    {
      before: prefix,
      after: '()=>42;',
      truncatedBefore: false,
      truncatedAfter: false,
    },
    'Successful mappings retain the VM-loaded script alongside original source',
  );
  resolver.save();
  resolver = new FrontendSourceResolver(manifest, cache);
  resolver.snapshot(snapshot);
  assert.equal(resolver.hits, 1);
  assert.equal(resolver.misses, 0);
  assert.deepEqual(resolver.snapshot('{"snapshot":{"meta":{}}}'), { nodes: {} });
  const bytecodeHeap = JSON.parse(snapshot);
  bytecodeHeap.snapshot.meta.node_types[0] = ['code'];
  bytecodeHeap.strings[0] = 'anonymous';
  assert.deepEqual(resolver.snapshot(JSON.stringify(bytecodeHeap)).nodes[0], location);
  assert.equal(resolver.hits, 2, 'Bytecode nodes reuse the Function source position cache');
  assert.equal(resolver.misses, 0);

  const view4Heap = JSON.parse(snapshot);
  view4Heap.strings[1] = 'file://view4/.rspeedy/main/background.hash.js';
  const view4Location = resolver.snapshot(JSON.stringify(view4Heap)).nodes[0];
  assert.equal(view4Location.generatedUrl, location.generatedUrl);
  assert.equal(view4Location.script, view4Heap.strings[1], 'Keep runtime labels while linking the real local file');

  // An unmapped generated script still supplies precise, bounded UTF-8 context.
  const generatedOnly = '中😀'.repeat(100) + '<tag> & "text"' + '界🚀'.repeat(120);
  const generatedMap = new SourceMapGenerator({ file: 'background.hash.js' });
  generatedMap.addMapping({ generated: { line: 1, column: 0 } });
  fs.writeFileSync(path.join(output, 'background.hash.js'), generatedOnly);
  fs.writeFileSync(path.join(output, 'background.hash.js.map'), generatedMap.toString());
  const generatedManifest = prepareFrontend(config, directory);
  const generatedResolver = new FrontendSourceResolver(generatedManifest, cache);
  const locateGenerated = (offset, target = generatedResolver) => {
    const heap = JSON.parse(snapshot);
    heap.locations[2] = offset;
    return target.snapshot(JSON.stringify(heap)).nodes[0];
  };
  const offset = Buffer.byteLength('中😀'.repeat(100));
  const fallback = locateGenerated(offset);
  assert.match(fallback.error, /No source mapping/);
  assert.equal(fallback.snippet, undefined, 'Generated text is not mislabeled as original source');
  assert.equal(fallback.generatedSnippet.before, '中😀'.repeat(40));
  assert.equal(fallback.generatedSnippet.after, Array.from(generatedOnly).slice(200, 360).join(''));
  assert.equal(fallback.generatedSnippet.truncatedBefore, true);
  assert.equal(fallback.generatedSnippet.truncatedAfter, true);
  assert.match(fallback.generatedUrl, /background\.hash\.js#L1:301$/);
  assert.equal(locateGenerated(0).generatedSnippet.before, '');
  const atEnd = locateGenerated(Buffer.byteLength(generatedOnly)).generatedSnippet;
  assert.equal(atEnd.after, '');
  assert.equal(atEnd.truncatedAfter, false);
  const invalidPosition = locateGenerated(1);
  assert.equal(invalidPosition.generatedSnippet, undefined, 'Reject offsets inside a UTF-8 code point');
  assert.equal(invalidPosition.generatedUrl, undefined, 'Invalid positions do not get coordinate links');
  assert.equal(locateGenerated(Buffer.byteLength(generatedOnly) + 1).generatedSnippet, undefined);
  generatedResolver.save();
  const oldCache = JSON.parse(fs.readFileSync(cache, 'utf8'));
  oldCache.version = 5;
  for (const entry of Object.values(oldCache.entries)) {
    delete entry.generatedSnippet;
    delete entry.generatedUrl;
  }
  fs.writeFileSync(cache, JSON.stringify(oldCache));
  const refreshed = new FrontendSourceResolver(generatedManifest, cache);
  assert.deepEqual(locateGenerated(offset, refreshed).generatedSnippet, fallback.generatedSnippet);
  assert.equal(locateGenerated(offset, refreshed).generatedUrl, fallback.generatedUrl);
  assert.equal(refreshed.misses, 1, 'Old cached failures are recomputed');
  refreshed.save();
  const reused = new FrontendSourceResolver(generatedManifest, cache);
  assert.deepEqual(locateGenerated(offset, reused).generatedSnippet, fallback.generatedSnippet);
  assert.equal(reused.hits, 1, 'Generated excerpts are cached');
  fs.writeFileSync(path.join(output, 'background.hash.js'), script);
  fs.writeFileSync(path.join(output, 'background.hash.js.map'), map.toString());

  // Acquired scripts/maps are independent from the original project and each other.
  const downloaded = path.join(directory, 'downloads');
  const maps = path.join(directory, 'maps');
  fs.mkdirSync(downloaded);
  fs.mkdirSync(maps);
  const suppliedScript = path.join(downloaded, 'background.hash.js');
  const suppliedMap = path.join(maps, 'separate.map');
  fs.writeFileSync(suppliedScript, script);
  const relativeMap = new SourceMapGenerator({ file: 'background.hash.js' });
  relativeMap.addMapping({
    generated: { line: 2, column: 10 },
    source: '../src/App.tsx',
    original: { line: 1, column: 17 },
  });
  relativeMap.setSourceContent('../src/App.tsx', original);
  fs.writeFileSync(suppliedMap, relativeMap.toString());
  const separateConfig = {
    version: 1,
    projects: [
      {
        id: 'page',
        root,
        outputDirs: ['does-not-exist'],
        artifactFiles: [{ script: 'downloads/background.hash.js', map: 'maps/separate.map' }],
        artifactOrigin: { kind: 'url', locator: 'https://example.test/build.zip' },
      },
    ],
  };
  const separate = prepareFrontend(separateConfig, directory);
  assert.equal(separate.artifacts.length, 1, 'Explicit inputs suppress project output scanning');
  assert.equal(separate.artifacts[0].script, suppliedScript);
  assert.equal(separate.artifacts[0].map, suppliedMap);
  assert.equal(separate.projects[0].artifactOrigin.locator, 'https://example.test/build.zip');
  writeManifest(separate);
  assert.equal(readFrontend(manifestFile).digest, separate.digest, 'Normalized external paths survive revalidation');
  const separateLocation = new FrontendSourceResolver(separate, cache).snapshot(snapshot).nodes[0];
  assert.equal(separateLocation.file, location.file);
  assert.equal(separateLocation.error, undefined);
  assert.equal(separateLocation.url, location.url, 'Original links point into the supplied source project');
  assert.match(separateLocation.generatedUrl, /downloads\/background\.hash\.js#L2:11$/);
  fs.appendFileSync(suppliedScript, '\n');
  assert.throws(() => readFrontend(manifestFile), /changed/);
  fs.writeFileSync(suppliedScript, script);
  relativeMap.setSourceContent('../src/App.tsx', '// Different source revision\n');
  fs.writeFileSync(suppliedMap, relativeMap.toString());
  assert.throws(() => readFrontend(manifestFile), /changed/);
  const wrongSource = new FrontendSourceResolver(prepareFrontend(separateConfig, directory), cache).snapshot(snapshot)
    .nodes[0];
  assert.match(wrongSource.error, /differs from sourcesContent/);
  assert.equal(wrongSource.file, undefined);
  relativeMap.setSourceContent('../src/App.tsx', original);
  fs.writeFileSync(suppliedMap, relativeMap.toString());

  // Rebased paths never escape the source root through a symlink.
  const originalPath = path.join(root, 'src/App.tsx');
  fs.renameSync(originalPath, path.join(directory, 'outside.tsx'));
  fs.symlinkSync(path.join(directory, 'outside.tsx'), originalPath);
  assert.equal(Object.keys(prepareFrontend(separateConfig, directory).artifacts[0].sources).length, 0);
  fs.unlinkSync(originalPath);
  fs.renameSync(path.join(directory, 'outside.tsx'), originalPath);

  const jsOnlyConfig = structuredClone(separateConfig);
  delete jsOnlyConfig.projects[0].artifactFiles[0].map;
  const jsOnly = prepareFrontend(jsOnlyConfig, directory);
  assert.equal(jsOnly.artifacts[0].map, undefined);
  assert.match(jsOnly.warnings[0], /generated JavaScript locations only/);
  writeManifest(jsOnly);
  assert.equal(readFrontend(manifestFile).digest, jsOnly.digest);
  const jsOnlyLocation = new FrontendSourceResolver(jsOnly, cache).snapshot(snapshot).nodes[0];
  assert.equal(jsOnlyLocation.generatedUrl, separateLocation.generatedUrl);
  assert.deepEqual(jsOnlyLocation.generatedSnippet, location.generatedSnippet);
  assert.equal(jsOnlyLocation.url, undefined);
  assert.equal(jsOnlyLocation.file, undefined);
  assert.match(jsOnlyLocation.error, /No sourcemap supplied/);
  fs.appendFileSync(suppliedScript, '\n');
  assert.throws(() => readFrontend(manifestFile), /changed/);
  fs.writeFileSync(suppliedScript, script);
  fs.unlinkSync(suppliedMap);
  assert.throws(
    () => prepareFrontend(separateConfig, directory),
    /ENOENT/,
    'An explicitly supplied missing map is not silently downgraded to JS-only',
  );
  fs.writeFileSync(suppliedMap, relativeMap.toString());
  const duplicateConfig = structuredClone(separateConfig);
  duplicateConfig.projects[0].artifactFiles.push(duplicateConfig.projects[0].artifactFiles[0]);
  assert.throws(() => prepareFrontend(duplicateConfig, directory), /Duplicate/);
  writeManifest(manifest);

  const remote = structuredClone(separate);
  remote.digest = 'synthetic-remote-fixture';
  remote.projects[0].origin = { kind: 'git', url: 'https://github.com/example/repository.git', ref: 'release' };
  remote.projects[0].commit = '1234567890abcdef1234567890abcdef12345678';
  remote.artifacts[0].sources['../src/App.tsx'].tracked = true;
  const remoteLocation = new FrontendSourceResolver(remote, cache).snapshot(snapshot).nodes[0];
  assert.equal(
    remoteLocation.url,
    'https://github.com/example/repository/blob/1234567890abcdef1234567890abcdef12345678/src/App.tsx#L1',
  );
  assert.equal(remoteLocation.column, 18);
  assert.equal(remoteLocation.file, 'src/App.tsx');

  const multi = { version: 1, projects: [config.projects[0], { ...config.projects[0], id: 'second' }] };
  const ambiguous = new FrontendSourceResolver(prepareFrontend(multi, directory), cache).snapshot(snapshot).nodes[0];
  assert.match(ambiguous.error, /Ambiguous/);
  assert.equal(ambiguous.generatedUrl, undefined);
  multi.projects[0] = { ...multi.projects[0], scriptPrefixes: ['file://other/'] };
  const selected = new FrontendSourceResolver(prepareFrontend(multi, directory), cache).snapshot(snapshot).nodes[0];
  assert.equal(selected.projectId, 'second');
  assert.equal(selected.error, undefined);

  fs.appendFileSync(path.join(root, 'src/App.tsx'), '// changed');
  assert.throws(() => readFrontend(manifestFile), /changed/);
  const stale = command(['--frontend-manifest', manifestFile, 'memory-analysis', '--path', '/nonexistent-trace']);
  assert.match(stale.text, /artifacts or sources changed/);
  assert.doesNotMatch(stale.text, /Trace file does not exist|Error initializing/);
  const changed = prepareFrontend(config, directory);
  resolver = new FrontendSourceResolver(changed, cache);
  assert.match(resolver.snapshot(snapshot).nodes[0].error, /differs from sourcesContent/);
  assert.equal(resolver.hits, 0);
  fs.writeFileSync(path.join(root, 'src/App.tsx'), original);
  // A successful rebuild with a changed filename is accepted at preparation, then fails the old binding.
  fs.renameSync(path.join(output, 'background.hash.js'), path.join(output, 'background.rebuilt.js'));
  fs.renameSync(path.join(output, 'background.hash.js.map'), path.join(output, 'background.rebuilt.js.map'));
  const rebuilt = prepareFrontend(config, directory);
  writeManifest(rebuilt);
  assert.equal(readFrontend(manifestFile).confirmation, undefined);
  const unmatched = new FrontendSourceResolver(rebuilt, cache).snapshot(snapshot).nodes[0];
  assert.equal(unmatched.url, undefined);
  assert.ok(unmatched.error, 'A changed hash must not silently bind the old runtime filename');
  fs.renameSync(path.join(output, 'background.rebuilt.js'), path.join(output, 'background.hash.js'));
  fs.renameSync(path.join(output, 'background.rebuilt.js.map'), path.join(output, 'background.hash.js.map'));
  fs.writeFileSync(path.join(output, 'background.hash.js.map'), '{"version":3}');
  assert.throws(() => prepareFrontend(config, directory), /Invalid or empty/);
  fs.unlinkSync(path.join(output, 'background.hash.js.map'));
  assert.throws(() => prepareFrontend(config, directory), /No nonempty JS/);
  assert.throws(
    () =>
      prepareFrontend(
        {
          version: 1,
          projects: [{ id: 'dropped', root: '', abandoned: { reason: 'test', userConfirmed: false } }],
        },
        directory,
      ),
    /explicit agreement/,
  );
  manifest = prepareFrontend(
    {
      version: 1,
      projects: [
        { id: 'dropped', root: '', abandoned: { reason: 'Synthetic explicit abandonment', userConfirmed: true } },
      ],
    },
    directory,
  );
  writeManifest(manifest);
  assert.equal(readFrontend(manifestFile).artifacts.length, 0);

  if (process.argv[2]) {
    const exampleRoot = path.resolve(__dirname, '../../../docs/proto/leak-example');
    const example = prepareFrontend({ version: 1, projects: [{ id: 'leak-example', root: exampleRoot }] }, directory);
    const actualNodes = new FrontendSourceResolver(example, cache).snapshot(
      fs.readFileSync(process.argv[2], 'utf8'),
    ).nodes;
    const actual = actualNodes[449];
    assert.equal(actual.error, undefined);
    assert.equal(actual.line, 20);
    assert.equal(actual.column, 59);
    assert.match(actual.file, /src\/App\.tsx$/);
    assert.equal(actual.offset, 39549);
    assert.match(actual.generatedUrl, /background\.a3deaafc\.js#L1:39550$/);
    assert.deepEqual(actualNodes[450], actual, 'Bytecode @14365 shares Function @16581 source coordinates');
    console.log('Actual Function @16581 -> App.tsx:20:59 verified.');
    console.log('Actual bytecode @14365 -> App.tsx:20:59 verified.');
    if (process.argv[3]) {
      const missingMap = new FrontendSourceResolver(example, cache).snapshot(fs.readFileSync(process.argv[3], 'utf8'))
        .nodes[399];
      assert.equal(missingMap.offset, 58);
      assert.match(missingMap.generatedUrl, /background\.a3deaafc\.js#L1:59$/);
      assert.match(missingMap.error, /No source mapping/);
      assert.ok(missingMap.generatedSnippet.after.startsWith('function t(t){'));
      assert.equal(missingMap.generatedSnippet.before, '(function(){"use strict";var e=Function("return this;")();');
      console.log('Actual Function @12931 -> generated JS byte offset 58 verified.');
    }
  }
  console.log('Frontend source CLI/artifact integration checks passed.');
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
