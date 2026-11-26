// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0.
// CLI and artifact integration checks; no network or Trace processor is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { SourceMapGenerator } = require('source-map-js');
const { prepareFrontend, FrontendSourceResolver, combineSources } = require('../dist/reports/frontend_sources');
const { requestedLynxSource, queryLynxEngineVersions, traceLynxVersionInvalidReason } = require('../dist/reports/lynx_source_selection');

async function main() {
  for (const version of ['1.4.0', '3.8.1', '4.4.999', '4.5.0-rc.1']) {
    assert.equal(traceLynxVersionInvalidReason(version), 'below-minimum', version);
  }
  for (const version of ['4.5.0', '4.5.0+build.7', '4.5.1-rc.1', '4.10.0', '5.0.0']) {
    assert.equal(traceLynxVersionInvalidReason(version), undefined, version);
  }
  for (const version of ['local-build', '4.5', '04.5.0', '4.5.0-01', '4.5.0junk']) {
    assert.equal(traceLynxVersionInvalidReason(version), 'invalid-format', version);
  }
  // The floor applies to metadata, not an explicit user revision selection.
  assert.equal(requestedLynxSource({ lynxVersion: '3.8.1' }).ref, 'A_3.8.1');
  assert.equal(requestedLynxSource({ lynxVersion: '3.8.1', lynxVersionRef: 'v3.8.1' }).ref, 'v3.8.1');
  assert.equal(requestedLynxSource({ lynxBranch: 'release/3.8' }).ref, 'release/3.8');
  assert.throws(() => requestedLynxSource({ lynxVersion: '1', lynxCommit: 'abc' }), /only one/);
  assert.throws(() => requestedLynxSource({ lynxBranch: '-bad' }), /Invalid/);
  assert.throws(() => requestedLynxSource({ lynxCommit: 'abc', lynxVersionRef: 'v1' }), /requires/);
  assert.throws(() => requestedLynxSource({ lynxVersion: '1', lynxVersionRef: '' }), /Invalid/);
  assert.deepEqual(
    await queryLynxEngineVersions({
      query: async (sql) => {
        assert.match(sql, /LynxEngineVersion/);
        return [
          { version: '3.8.1', slice_id: 4 },
          { version: '3.8.1', slice_id: 5 },
          { version: null },
          { version: 'local', slice_id: 6 },
          { version: '4.5.0', slice_id: 7 },
          { version: '4.5.0', slice_id: 8 },
          { version: '4.10.0', slice_id: 9 },
        ];
      },
    }),
    [
      { version: '3.8.1', ref: null, status: 'invalid', invalidReason: 'below-minimum', sliceIds: [4, 5] },
      { version: 'local', ref: null, status: 'invalid', invalidReason: 'invalid-format', sliceIds: [6] },
      { version: '4.5.0', ref: 'A_4.5.0', status: 'candidate', sliceIds: [7, 8] },
      { version: '4.10.0', ref: 'A_4.10.0', status: 'candidate', sliceIds: [9] },
    ],
  );
  const cli = spawnSync(
    process.execPath,
    [
      path.resolve(__dirname, '../dist/cli/index.js'),
      '--frontend-manifest',
      '/absent-manifest',
      'lynx-source-version',
      '--lynx-commit',
      'abc123',
      '--path',
      '/absent-trace',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(cli.status, 0, cli.stderr);
  const selection = JSON.parse(cli.stdout);
  assert.equal(selection.requiresConsent, false);
  assert.equal(selection.repository, undefined, 'A bare revision must not select internal implicitly');
  assert.deepEqual(selection.repositories, [
    { kind: 'internal', url: 'https://code.byted.org/lynx/template-assembler', sourceRoot: 'lynx/' },
    { kind: 'oss', url: 'https://github.com/lynx-family/lynx.git', sourceRoot: './' },
  ]);
  const versionCli = spawnSync(
    process.execPath,
    [
      path.resolve(__dirname, '../dist/cli/index.js'),
      'lynx-source-version',
      '--lynx-version',
      '3.8.1',
      '--lynx-version-ref',
      'v3.8.1',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(versionCli.status, 0, versionCli.stderr);
  assert.deepEqual(JSON.parse(versionCli.stdout).selection, { kind: 'version', requested: '3.8.1', ref: 'v3.8.1' });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-runtime-test-'));
  try {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.mkdirSync(path.join(dir, 'dist'));
    const source = 'export function alpha() { return 1; }\n';
    fs.writeFileSync(path.join(dir, 'src/runtime.ts'), source);
    const code = '/* 中😀 */\nfunction alpha(){} function beta(){} class Gamma { static run(){} }\n';
    const offsets = ['function alpha', 'function beta', 'class Gamma', 'run()'].map((token) =>
      Buffer.byteLength(code.slice(0, code.indexOf(token))),
    );
    const map = new SourceMapGenerator({ file: 'lynx_core_dev.js' });
    for (const offset of offsets) {
      const text = Buffer.from(code).subarray(0, offset).toString();
      map.addMapping({
        source: '../src/runtime.ts',
        generated: { line: 2, column: text.split('\n')[1].length },
        original: { line: 1, column: 7 },
      });
    }
    map.setSourceContent('../src/runtime.ts', source);
    fs.writeFileSync(
      path.join(dir, 'dist/lynx_core_dev.js'),
      code + '//# sourceMappingURL=data:application/json;base64,' + Buffer.from(map.toString()).toString('base64'),
    );
    fs.writeFileSync(path.join(dir, 'dist/lynx_core.js'), 'function x(){}');
    fs.writeFileSync(path.join(dir, 'dist/lynx_core.js.map'), map.toString());
    const manifest = prepareFrontend({ version: 1, projects: [{ id: 'runtime', root: dir }] }, dir);
    assert.equal(
      manifest.artifacts.find((a) => a.inlineMap).sources['../src/runtime.ts'].file,
      fs.realpathSync(path.join(dir, 'src/runtime.ts')),
    );
    // Synthetic runtime provenance for resolver testing; production manifests validate Git and selection evidence.
    manifest.projects[0].lynx = { platform: 'test' };
    manifest.projects[0].scriptAliases = { 'lynx_core_dev.js': ['lynx_core.js'] };
    const heap = (values) =>
      JSON.stringify({
        snapshot: {
          node_count: values.length,
          meta: {
            node_fields: ['type', 'name', 'id'],
            location_fields: ['object_index', 'script_id', 'source_offset'],
          },
        },
        strings: ['Function', 'file://shared/lynx_core.js'],
        nodes: values.flatMap((_, i) => [0, 0, i + 1]),
        locations: values.flatMap((offset, i) => [i * 3, 1, offset]),
        primjs_sources: { version: 1, fields: ['script_id', 'name'], scripts: [1, 1] },
      });
    const cache = path.join(dir, 'cache.json');
    const resolver = new FrontendSourceResolver(manifest, cache);
    const resolved = resolver.snapshot(heap(offsets));
    assert.match(resolved.runtimeMatches[1].selected, /lynx_core_dev\.js$/);
    assert.equal(resolved.runtimeMatches[1].candidates.find((c) => c.matched === 4).total, 4);
    assert.equal(resolved.nodes[0].line, 1);
    assert.equal(resolved.nodes[0].column, 8);
    assert.equal(resolved.nodes[0].error, undefined);
    assert.match(resolver.snapshot(heap(offsets.slice(0, 2))).nodes[0].error, /at least three/);
    assert.match(resolver.snapshot(heap(offsets.map((x) => x + 1))).nodes[0].error, /does not match/);
    const duplicate = structuredClone(manifest);
    duplicate.digest = 'ambiguous';
    duplicate.artifacts.push({ ...duplicate.artifacts.find((a) => a.inlineMap) });
    assert.match(new FrontendSourceResolver(duplicate, cache).snapshot(heap(offsets)).nodes[0].error, /Ambiguous/);
    assert.throws(() => combineSources(manifest, manifest), /distinct/);

    // Real temporary Git checkouts exercise provenance and checkout-relative links without network.
    for (const repository of selection.repositories) {
      const root = path.join(dir, repository.kind);
      const relative = `${repository.kind === 'internal' ? 'lynx/' : ''}js_libraries/lynx-core/src/runtime.ts`;
      const sourceFile = path.join(root, relative);
      fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
      fs.mkdirSync(path.join(root, 'dist'));
      fs.writeFileSync(sourceFile, source);
      fs.writeFileSync(path.join(root, 'build.lock'), 'Original dependency state\n');
      const git = (...args) => {
        const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
      };
      git('init', '--quiet');
      git('add', relative, 'build.lock');
      git(
        '-c',
        'user.name=Source fixture',
        '-c',
        'user.email=source-fixture@example.test',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--quiet',
        '-m',
        'Source fixture',
      );
      const commit = git('rev-parse', 'HEAD');
      const ref = repository.kind === 'internal' ? 'A_4.5.0' : 'v4.5.0';
      git('tag', ref);
      git('remote', 'add', 'origin', repository.url);
      const raw = JSON.parse(map.toString());
      raw.sources = [`../${relative}`];
      fs.writeFileSync(
        path.join(root, 'dist/lynx_core_dev.js'),
        code +
          '//# sourceMappingURL=data:application/json;base64,' +
          Buffer.from(JSON.stringify(raw)).toString('base64'),
      );
      const url = new URL(repository.url);
      const config = {
        version: 1,
        projects: [
          {
            id: repository.kind,
            root,
            scriptAliases: { 'lynx_core_dev.js': ['lynx_core.js'] },
            origin: { kind: 'git', url: repository.url, ref, linkTemplate: '{repo}/blob/{commit}/{path}#L{line}' },
            lynx: {
              selection: { kind: 'version', requested: '4.5.0', ref },
              consent: 'trace-version-resolved',
              statement: `Synthetic Trace 4.5.0 -> ${ref} -> ${commit}`,
              platform: 'test',
            },
          },
        ],
      };
      const project = config.projects[0];
      const oldRef = repository.kind === 'internal' ? 'A_4.4.999' : 'v4.4.999';
      git('tag', oldRef);
      assert.equal(git('rev-parse', oldRef), commit, 'The below-minimum tag really exists');
      const belowMinimum = structuredClone(config);
      belowMinimum.projects[0].origin.ref = oldRef;
      belowMinimum.projects[0].lynx.selection = { kind: 'version', requested: '4.4.999', ref: oldRef };
      for (const consent of ['trace-version-resolved', 'trace-version-approved']) {
        belowMinimum.projects[0].lynx.consent = consent;
        assert.throws(() => prepareFrontend(belowMinimum, dir), /minimum is 4\.5\.0.*missing tag/);
      }
      belowMinimum.projects[0].lynx.consent = 'user-specified';
      assert.equal(prepareFrontend(belowMinimum, dir).projects[0].commit, commit);
      const legacy = structuredClone(config);
      legacy.projects[0].lynx.consent = 'trace-version-approved';
      assert.equal(prepareFrontend(legacy, dir).projects[0].commit, commit);
      const missingComponent = structuredClone(config);
      missingComponent.projects[0].scriptAliases['krypton.js'] = ['krypton.js'];
      assert.throws(() => prepareFrontend(missingComponent, dir), /Declared runtime script.*krypton\.js/);
      for (const origin of [
        repository.url,
        `git@${url.host}:${url.pathname.slice(1)}`,
        `ssh://git@${url.host}${url.pathname}`,
        `ssh://git@${url.host}:22${url.pathname}`,
      ]) {
        project.origin.url = origin;
        const prepared = prepareFrontend(config, dir);
        assert.equal(prepared.projects[0].commit, commit);
        const located = new FrontendSourceResolver(prepared, cache).snapshot(heap(offsets)).nodes[0];
        assert.equal(located.error, undefined);
        assert.equal(located.url, `${repository.url.replace(/\.git$/, '')}/blob/${commit}/${relative}#L1`);
      }
      // Check normalization of the actual remote as well as the manifest URL.
      git('remote', 'set-url', 'origin', `ssh://git@${url.host}${url.pathname}`);
      project.origin.url = repository.url;
      assert.equal(prepareFrontend(config, dir).projects[0].commit, commit);
      if (repository.kind === 'oss') {
        delete project.origin.linkTemplate;
        const prepared = prepareFrontend(config, dir);
        assert.equal(
          new FrontendSourceResolver(prepared, cache).snapshot(heap(offsets)).nodes[0].url,
          `https://github.com/lynx-family/lynx/blob/${commit}/${relative}#L1`,
        );
      }
      project.origin.url = 'https://github.com/other/lynx.git';
      assert.throws(() => prepareFrontend(config, dir), /Invalid Lynx/);
      project.origin.url = selection.repositories.find((candidate) => candidate.kind !== repository.kind).url;
      assert.throws(() => prepareFrontend(config, dir), /origin does not match/);
      project.origin.url = repository.url;
      project.origin.ref = 'different-ref';
      assert.throws(() => prepareFrontend(config, dir), /Invalid Lynx/);
      project.origin.ref = ref;
      const beforeBuildChanges = prepareFrontend(config, dir);
      fs.appendFileSync(path.join(root, 'build.lock'), 'Generated dependency state\n');
      const afterBuildChanges = prepareFrontend(config, dir);
      assert.equal(
        afterBuildChanges.digest,
        beforeBuildChanges.digest,
        'Unrelated tracked build changes do not invalidate sources',
      );
      assert.ok(new FrontendSourceResolver(afterBuildChanges, cache).snapshot(heap(offsets)).nodes[0].url);

      fs.appendFileSync(sourceFile, '// Local changes must not produce remote source links.\n');
      const staleMap = prepareFrontend(config, dir);
      assert.match(
        new FrontendSourceResolver(staleMap, cache).snapshot(heap(offsets)).nodes[0].error,
        /differs from sourcesContent/,
        'Dirty-tree tolerance does not bypass source-map content matching',
      );
      raw.sourcesContent = [fs.readFileSync(sourceFile, 'utf8')];
      fs.writeFileSync(
        path.join(root, 'dist/lynx_core_dev.js'),
        code +
          '//# sourceMappingURL=data:application/json;base64,' +
          Buffer.from(JSON.stringify(raw)).toString('base64'),
      );
      git('add', relative);
      const rebuilt = prepareFrontend(config, dir);
      const localLocation = new FrontendSourceResolver(rebuilt, cache).snapshot(heap(offsets)).nodes[0];
      assert.equal(localLocation.line, 1);
      assert.ok(localLocation.snippet.includes('Local changes'));
      assert.equal(localLocation.url, undefined, 'Changed committed source has no misleading commit permalink');
      assert.match(localLocation.error, /matching committed file bytes/);
      git(
        '-c',
        'user.name=Source fixture',
        '-c',
        'user.email=source-fixture@example.test',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--quiet',
        '-m',
        'Changed fixture',
      );
      assert.throws(() => prepareFrontend(config, dir), /Checkout does not match requested ref/);
    }
    console.log('Internal/OSS provenance, revision, inline-map and runtime-variant integration checks passed.');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
