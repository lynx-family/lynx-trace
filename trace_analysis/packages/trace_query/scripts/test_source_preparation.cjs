// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0.
// CLI checkpoint regression: no network; optional local Trace exercises offline rerender.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { prepareFrontend } = require('../dist/reports/frontend_sources');
const { checkSourcePreparation, discardOptedOutSources } = require('../dist/reports/source_preparation');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'source-preparation-'));
const cli = path.resolve(process.env.TRACE_QUERY_CLI || path.join(__dirname, '../dist/cli/index.js'));
const write = (name, value) => {
  const file = path.join(directory, name);
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
};
let checks = 0;
const run = (args, expected, realTrace = false) => {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
    // Negative cases stop before launching a processor and must never download one.
    env: realTrace ? process.env : { ...process.env, TRACE_PROCESSOR_SHELL_URL: process.execPath },
  });
  const text = result.stdout + result.stderr;
  if (expected) {
    assert.notEqual(result.status, 0, text);
    assert.match(text, expected);
  } else assert.equal(result.status, 0, text);
  checks++;
  return result;
};
const optOut = { state: 'opted-out', reason: 'Synthetic fixture excludes runtime', userStatement: 'Test without runtime sources' };
const base = { version: 1, frontend: { state: 'not-provided' }, lynx: optOut };
try {
  for (const name of ['memory-analysis', 'memory-snapshot']) {
    run([name, '--path', path.join(directory, 'absent.pftrace')], /Source preparation blocked/);
  }
  for (const state of ['pending', 'aborted', 'not-provided']) {
    const ledger = write(`runtime-${state}.json`, { ...base, lynx: { state } });
    run(['--source-preparation', ledger, 'memory-analysis', '--path', '/absent'], /Source preparation blocked: lynx/);
  }
  const badOptOut = write('inferred-optout.json', { ...base, lynx: { state: 'opted-out', reason: 'Tool says skip' } });
  run(['--source-preparation', badOptOut, 'memory-analysis', '--path', '/absent'], /actual statement/);
  const ledgerFile = write('ready.json', base);
  run(['--source-preparation', ledgerFile, 'memory-analysis', '--path', '/absent'], /Trace file does not exist/);
  run(['--source-preparation', '/absent', 'lynx-source-version', '--lynx-commit', 'abc123']);

  const generated = write('app.js', 'function example() { return 1; }');
  const manifest = prepareFrontend({ version: 1, projects: [{ id: 'app', root: directory, artifactFiles: [{ script: generated }] }] }, directory);
  const manifestFile = write('frontend.json', manifest);
  const prepared = { ...base, frontend: { state: 'prepared', manifestDigest: manifest.digest } };
  write('ready.json', prepared);
  run(['--source-preparation', ledgerFile, '--frontend-manifest', manifestFile, 'memory-analysis', '--path', '/absent'], /Trace file does not exist/);
  const stale = write('stale.json', { ...prepared, frontend: { ...prepared.frontend, manifestDigest: 'stale' } });
  run(['--source-preparation', stale, '--frontend-manifest', manifestFile, 'memory-analysis', '--path', '/absent'], /digest changed/);
  const hash = 'a'.repeat(64);
  const data = {
    schemaVersion: 4, sourcePreparation: prepared, snapshots: [{ sha256: hash }], warnings: [],
    frontendSources: { digest: manifest.digest, projects: manifest.projects, artifacts: manifest.artifacts, snapshots: {} },
  };
  const dataFile = write('analysis.json', data);
  const output = path.join(directory, 'blocked-output');
  run(['memory-report', '--data', dataFile, '--output', output], /binding review is pending/);
  assert.equal(fs.existsSync(output), false, 'Pending report has no output side effects');
  for (const state of ['mismatch', 'pending']) {
    const ledger = write(`binding-${state}.json`, { ...prepared, frontend: {
      ...prepared.frontend, binding: { state, snapshotSha256s: [hash], reason: '244 definitions, 3 conflicts' },
    } });
    run(['--source-preparation', ledger, 'memory-report', '--data', dataFile, '--output', output], /known binding failure/);
  }
  const final = { ...prepared, frontend: { ...prepared.frontend, binding: {
    state: 'verified', snapshotSha256s: [hash], reason: 'Replacement preflight matched with no conflicts',
  } } };
  assert.doesNotThrow(() => checkSourcePreparation(final, 'report', {}, data));
  assert.throws(() => checkSourcePreparation(final, 'report', {}, { ...data, snapshots: [{ sha256: 'b'.repeat(64) }] }), /current exported snapshot hashes/);
  for (const limitation of ['no-locations', 'insufficient-evidence', 'unused-artifacts', 'no-map']) {
    const limited = structuredClone(final);
    limited.frontend.binding.state = 'limited';
    limited.frontend.binding.limitation = limitation;
    assert.doesNotThrow(() => checkSourcePreparation(limited, 'report', {}, data));
  }
  const mislabeled = structuredClone(final);
  mislabeled.frontend.binding.state = 'limited';
  mislabeled.frontend.binding.limitation = 'mismatch';
  assert.throws(() => checkSourcePreparation(mislabeled, 'report', {}, data), /evidence-gap category/);
  const missingFrontend = { ...base };
  assert.throws(() => checkSourcePreparation(missingFrontend, 'report', {}, data), /not-provided cannot replace/);
  const legacy = { ...data, sourcePreparation: undefined };
  assert.throws(() => checkSourcePreparation(undefined, 'report', {}, legacy), /provide --source-preparation/);
  assert.throws(() => checkSourcePreparation(final, 'report', {}, legacy), /verified manifest/);
  assert.doesNotThrow(() => checkSourcePreparation(final, 'report', { frontend: manifest }, legacy));
  const bothPrepared = { ...final, lynx: { ...final.frontend } };
  assert.throws(() => checkSourcePreparation(bothPrepared, 'report', { frontend: manifest }, data), /every prepared group's manifest/);
  const noSnapshots = structuredClone(final);
  noSnapshots.frontend.binding = { state: 'limited', limitation: 'no-snapshots', snapshotSha256s: [], reason: 'No exported heaps' };
  assert.doesNotThrow(() => checkSourcePreparation(noSnapshots, 'report', {}, { ...data, snapshots: [] }));
  const dropped = structuredClone(data);
  dropped.frontendSources.projects.push({ id: 'runtime', lynx: {} });
  dropped.frontendSources.snapshots.sample = { locations: { nodes: {
    1: { projectId: 'app' }, 2: { projectId: 'runtime' },
  } } };
  discardOptedOutSources(dropped, { ...base, frontend: optOut, lynx: { state: 'prepared' } });
  assert.deepEqual(Object.keys(dropped.frontendSources.snapshots.sample.locations.nodes), ['2']);
  assert.deepEqual(dropped.frontendSources.projects.map((project) => project.id), ['runtime']);
  assert.match(dropped.warnings[0], /frontend source assistance opted out/);

  // An explicit fixture opt-out authorizes both commands and survives portable rerender.
  if (process.argv[2]) {
    write('ready.json', base);
    const initial = path.join(directory, 'initial');
    const moved = path.join(directory, 'moved');
    run(['--source-preparation', ledgerFile, 'memory-analysis', '--path', path.resolve(process.argv[2]), '--output', initial], undefined, true);
    run(['memory-report', '--data', path.join(initial, 'analysis.json'), '--output', moved], undefined, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(moved, 'analysis.json'))).sourcePreparation, base);
    assert.ok(fs.existsSync(path.join(moved, 'report.html')));
  }
  console.log(JSON.stringify({ cliChecks: checks, decisionTransitions: 'passed', offlineRerender: process.argv[2] ? 'passed' : 'not requested' }));
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
