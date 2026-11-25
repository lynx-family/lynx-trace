// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0.
// CLI integration check: source Trace plus an already finalized sample directory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');

const trace = path.resolve(process.argv[2]);
const finalized = path.resolve(process.argv[3]);
const cli = process.argv[4] ? path.resolve(process.argv[4]) : path.resolve(__dirname, '../dist/cli/index.js');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-report-artifacts-'));
const preparation = path.join(directory, 'source-preparation.json');
const fixtureOptOut = {
  state: 'opted-out',
  reason: 'Synthetic packaging fixture; source attribution is tested separately',
  userStatement: 'Run this integration fixture without source assistance',
};
fs.writeFileSync(preparation, JSON.stringify({ version: 1, frontend: fixtureOptOut, lynx: fixtureOptOut }));
const run = (...args) =>
  execFileSync(process.execPath, [cli, '--source-preparation', preparation, ...args], { encoding: 'utf8', stdio: 'pipe', maxBuffer: 20 * 1024 * 1024 });
const read = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'analysis.json'), 'utf8'));
const embedded = (dir) => {
  const html = fs.readFileSync(path.join(dir, 'report.html'), 'utf8');
  const match = /<script type="application\/json" id="memory-report-snapshots">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(match, 'Report contains embedded snapshots');
  assert.ok(!match[1].includes('<'), 'Snapshot payload escapes HTML delimiters');
  return JSON.parse(match[1]);
};
const verify = (dir) => {
  const result = read(dir);
  const payload = embedded(dir);
  assert.equal(payload.snapshots.length, result.snapshots.length);
  const runtime = fs.readFileSync(path.join(dir, 'assets/runtime.js'), 'utf8');
  assert.ok(!runtime.includes('"wasm":'), 'No Trace processor WASM in report');
  const savedTrace = fs.readFileSync(path.join(dir, result.artifacts.trace.file));
  assert.equal(createHash('sha256').update(savedTrace).digest('hex'), result.artifacts.trace.sha256);
  assert.equal(savedTrace.length, result.artifacts.trace.size);
  for (const file of ['report.html', 'assets/bridge.js', 'assets/snapshot-viewer.html', 'assets/runtime.js']) {
    assert.ok(fs.existsSync(path.join(dir, file)), file);
  }
  for (const snapshot of result.snapshots) {
    if (snapshot.outputPath) assert.ok(fs.existsSync(path.join(dir, snapshot.outputPath)));
    assert.equal(snapshot.content, undefined, 'Raw heap stays out of analysis.json');
    const stored = payload.snapshots.find((item) => item.sliceId === snapshot.sliceId);
    if (stored.content !== undefined) {
      assert.equal(stored.content, fs.readFileSync(path.join(dir, snapshot.outputPath), 'utf8'));
      assert.equal(Buffer.byteLength(stored.content), snapshot.totalLength);
      if (snapshot.sha256) assert.equal(createHash('sha256').update(stored.content).digest('hex'), snapshot.sha256);
    } else {
      assert.ok(stored.contentError, 'Unavailable captures have an explanation');
    }
  }
  for (const analysis of result.residualAnalyses) {
    for (const file of [analysis.contextPath, analysis.evidencePath, analysis.reportPath].filter(Boolean)) {
      assert.equal(path.isAbsolute(file), false);
      assert.ok(fs.existsSync(path.join(dir, file)), file);
    }
  }
  return result;
};
const initial = path.join(directory, 'initial report');
const moved = path.join(directory, 'moved report');
const extra = path.join(directory, 'extra', 'data.json');
run('memory-analysis', '--path', trace, '--output', initial, '--output-data', extra);
verify(initial);
assert.ok(read(initial).snapshots.length > 0);
run('memory-report', '--data', extra, '--output', path.join(directory, 'from-extra'));
verify(path.join(directory, 'from-extra'));
run('memory-report', '--data', path.join(finalized, 'analysis.json'), '--output', moved);
const result = verify(moved);
assert.deepEqual(result.issues, read(finalized).issues);
assert.ok(fs.existsSync(path.join(moved, 'residual-results.json')));
run(
  'memory-report',
  '--data',
  path.join(moved, 'analysis.json'),
  '--residual-results',
  path.join(moved, 'residual-results.json'),
  '--output',
  moved,
);
verify(moved);
const recovery = path.join(directory, 'recovered');
const missing = result.snapshots.find((item) => item.outputPath);
fs.unlinkSync(path.join(moved, missing.outputPath));
run('memory-report', '--data', path.join(moved, 'analysis.json'), '--output', recovery);
assert.deepEqual(verify(recovery).issues, result.issues);
assert.equal(
  embedded(recovery).snapshots.find((item) => item.sliceId === missing.sliceId).content,
  embedded(moved).snapshots.find((item) => item.sliceId === missing.sliceId).content,
);
const recoveredData = read(recovery);
recoveredData.snapshots.push(
  {
    ...missing,
    sliceId: 90000001,
    snapshotId: 'test-cleared',
    chunkCount: 0,
    totalLength: 0,
    integrity: 'metadata-only',
    outputPath: undefined,
    sha256: undefined,
  },
  { ...missing, sliceId: 90000002, snapshotId: 'test-missing-chunks', outputPath: undefined, sha256: undefined },
);
fs.writeFileSync(path.join(recovery, 'analysis.json'), JSON.stringify(recoveredData));
const unavailable = path.join(directory, 'unavailable');
run('memory-report', '--data', path.join(recovery, 'analysis.json'), '--output', unavailable);
const unavailablePayload = embedded(unavailable);
assert.match(unavailablePayload.snapshots.at(-2).contentError, /metadata only/);
assert.match(unavailablePayload.snapshots.at(-1).contentError, /exactly one capture/);
assert.equal(unavailablePayload.snapshots.at(-2).content, undefined);
assert.equal(unavailablePayload.snapshots.at(-1).content, undefined);
fs.appendFileSync(path.join(recovery, missing.outputPath), ' ');
assert.throws(
  () =>
    run('memory-report', '--data', path.join(recovery, 'analysis.json'), '--output', path.join(directory, 'bad-hash')),
  /Snapshot SHA-256 mismatch/,
);
// Render hostile heap strings without executing them as part of the report.
const { generateMemoryAnalysisReport } = require('../dist/reports/memory_analysis_report.js');
const escaped = path.join(directory, 'escaped');
fs.mkdirSync(escaped);
const hostile = '</script><script>window.snapshotInjected = true</script>\u2028\u2029';
const hostileAnchor = '" onmouseover="window.anchorInjected = true';
const finding = result.residualAnalyses.flatMap((analysis) => analysis.findings)[0];
finding.representativeObjects = [
  { label: hostile, snapshotId: missing.snapshotId, nodeIndex: hostileAnchor, nodeId: hostileAnchor },
];
generateMemoryAnalysisReport(result, path.join(escaped, 'report.html'), {
  snapshots: [{ ...missing, content: hostile }],
  vms: result.vms,
});
assert.equal(embedded(escaped).snapshots[0].content, hostile);
const escapedHtml = fs.readFileSync(path.join(escaped, 'report.html'), 'utf8');
assert.ok(escapedHtml.includes('data-node-index="&quot; onmouseover=&quot;window.anchorInjected = true"'));
assert.ok(!escapedHtml.includes('<script>window.snapshotInjected'));
assert.ok(!escapedHtml.includes('data-node-index="" onmouseover='));
console.log(
  JSON.stringify({
    directory,
    initial: 'passed',
    extraData: 'passed',
    moved: 'passed',
    reimport: 'passed',
    recovery: 'passed',
    unavailable: 'passed',
    hashMismatch: 'passed',
    escaping: 'passed',
  }),
);
