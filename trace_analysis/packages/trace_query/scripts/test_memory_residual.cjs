// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { residualAnalyzerContext } = require('../dist/reports/memory_residual_analysis');
const {
  applyMemoryResidualResults,
  prepareMemoryResidualAnalysis,
  residualInputDigest,
  extractMemorySnapshot,
} = require('../dist');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-residual-check-'));
const content = JSON.stringify({ snapshot: { meta: {} }, nodes: [], edges: [], strings: ['中文😀'] });
const sha256 = createHash('sha256').update(content).digest('hex');
const metadata = {
  capture_count: 1,
  scope_id: 'bts_residual/1/slot_4',
  total_length: Buffer.byteLength(content),
  chunk_count: 2,
};
const chunks = [
  { chunk_index: 0, chunk_offset: 0, scope_id: metadata.scope_id, content: content.slice(0, -3) },
  {
    chunk_index: 1,
    chunk_offset: Buffer.byteLength(content.slice(0, -3)),
    scope_id: metadata.scope_id,
    content: content.slice(-3),
  },
];
const query = (meta = metadata, rows = chunks) => ({
  query: async (sql) => (sql.includes('COUNT(DISTINCT') ? [meta] : rows),
});
function fixture() {
  const snapshot = {
    snapshotId: 's1',
    sliceId: 1,
    vmId: metadata.scope_id,
    kind: 'bts_residual',
    assignedVmId: 'vm',
    instanceId: 1,
    slotId: 4,
    index: 1,
    captureTsMs: 20,
    totalLength: metadata.total_length,
    chunkCount: 2,
    integrity: 'complete',
    retainedBytes: 100,
    sha256,
  };
  const residual = {
    id: 'r1',
    vmId: 'vm',
    instanceId: 1,
    slotId: 4,
    destroyTsMs: 10,
    snapshotIds: ['s1'],
    latestSnapshotId: 's1',
    residualBytes: 100,
    tailComplete: true,
    status: 'pending',
    findings: [],
    gaps: [],
    reportAnchor: 'residual-instance-1',
  };
  const result = {
    schemaVersion: 4,
    valid: true,
    options: {},
    trace: { startTsMs: 0, endTsMs: 40 },
    pages: [{ instanceId: 1, url: 'example', btsCreateTsMs: 1 }],
    vms: [{ id: 'vm', generation: 0, createTsMs: 0 }],
    snapshots: [snapshot],
    residualAnalyses: [residual],
    issues: [],
    summary: {},
    sharedBtsVmAnalyses: [{ vmId: 'vm', chartId: 'chart' }],
    sharedBtsSlotCharts: [{ id: 'chart', events: [{ name: 'VM_GC', tsMs: 15 }], series: [] }],
  };
  residual.inputDigest = residualInputDigest(result, residual);
  return result;
}
function evidence(status = 'final', refs = ['/snapshots/0']) {
  return {
    residual_context: residualAnalyzerContext(fixture(), fixture().residualAnalyses[0]),
    inquiry: { question: 'Synthetic validation fixture' },
    snapshots: [{ sha256 }],
    analysis: {
      status,
      scope: 'Import contract verification only',
      gaps: [],
      findings: [
        {
          id: 'f1',
          title: 'Synthetic finding',
          conclusion: 'Synthetic fixture, not a trace conclusion.',
          evidence_refs: refs,
          limitations: [],
        },
      ],
    },
  };
}
const evidenceFile = path.join(directory, 'evidence.json');
fs.writeFileSync(path.join(directory, 'report.html'), '<!doctype html><html>Synthetic report</html>');
const writeEvidence = (value) => fs.writeFileSync(evidenceFile, JSON.stringify(value));
function manifest(result, disposition = 'retained') {
  return {
    schemaVersion: 1,
    translations: {
      'Synthetic finding': { zh: '测试发现', en: 'Synthetic finding' },
      'Synthetic fixture, not a trace conclusion.': {
        zh: '仅用于测试，不是 Trace 结论。',
        en: 'Synthetic fixture, not a trace conclusion.',
      },
      'Synthetic rule': { zh: '测试规则', en: 'Synthetic rule' },
    },
    pages: [
      {
        analysisId: 'r1',
        inputDigest: residualInputDigest(result, result.residualAnalyses[0]),
        analyzerVersion: 'fixture',
        rulesVersion: 'none',
        evidencePath: 'evidence.json',
        reportPath: 'report.html',
        decisions: [{ findingId: 'f1', disposition, confidence: 'high' }],
      },
    ],
  };
}

(async () => {
  const output = path.join(directory, 'unicode.heapsnapshot');
  const extracted = await extractMemorySnapshot(query(), 's1', output);
  assert.equal(extracted.sha256, sha256);
  assert.equal(fs.readFileSync(output, 'utf8'), content);
  assert.equal(extracted.totalLength, Buffer.byteLength(content));
  for (const rows of [
    chunks.slice(0, 1),
    [chunks[0], { ...chunks[1], chunk_index: 0 }],
    [chunks[0], { ...chunks[1], chunk_offset: 999 }],
    [chunks[0], { ...chunks[1], scope_id: 'another-page' }],
  ])
    await assert.rejects(extractMemorySnapshot(query(metadata, rows), 's1', output));
  await assert.rejects(extractMemorySnapshot(query({ ...metadata, capture_count: 2 }), 's1', output));
  await assert.rejects(extractMemorySnapshot(query({ ...metadata, total_length: content.length }), 's1', output));

  const prepared = fixture();
  await prepareMemoryResidualAnalysis(query(), prepared, directory);
  assert.equal(prepared.residualAnalyses[0].tailComplete, true);
  assert.equal(prepared.residualAnalyses[0].status, 'pending');
  prepared.snapshots.push({ ...prepared.snapshots[0], snapshotId: 's2', sliceId: 2, captureTsMs: 30 });
  prepared.residualAnalyses[0].snapshotIds.push('s2');
  const partialQuery = {
    query: async (sql) => (sql.includes("'s2'") && !sql.includes('COUNT(DISTINCT') ? [] : query().query(sql)),
  };
  await prepareMemoryResidualAnalysis(partialQuery, prepared, directory);
  assert.equal(prepared.residualAnalyses[0].latestSnapshotId, 's1');
  assert.equal(prepared.residualAnalyses[0].residualBytes, 100);
  assert.equal(prepared.residualAnalyses[0].tailComplete, false);
  prepared.snapshots[1] = { ...prepared.snapshots[1], integrity: 'metadata-only', retainedBytes: 0 };
  await prepareMemoryResidualAnalysis(query(), prepared, directory);
  assert.equal(prepared.residualAnalyses[0].status, 'cleared');
  prepared.snapshots.push({ ...prepared.snapshots[0], snapshotId: 's3', sliceId: 3, captureTsMs: 35 });
  prepared.residualAnalyses[0].snapshotIds.push('s3');
  await prepareMemoryResidualAnalysis(query(), prepared, directory);
  assert.equal(prepared.residualAnalyses[0].status, 'pending');
  assert.equal(prepared.residualAnalyses[0].residualBytes, 100);

  writeEvidence(evidence());
  const result = fixture();
  const untranslated = manifest(result);
  delete untranslated.translations['Synthetic finding'];
  assert.throws(() => applyMemoryResidualResults(result, untranslated, directory), /Missing Chinese\/English/);
  assert.equal(result.residualAnalyses[0].status, 'pending');
  applyMemoryResidualResults(result, manifest(result), directory);
  assert.equal(result.residualAnalyses[0].findings[0].title, 'Synthetic finding');
  assert.equal(result.residualAnalyses[0].translations['Synthetic finding'].zh, '测试发现');
  assert.equal(result.summary.confirmedLeakPageCount, 0);
  assert.equal(result.summary.suspectedPageCount, 1);
  assert.equal(result.issues.length, 0);
  assert.equal(result.sharedBtsSlotCharts[0].events.length, 1);
  const anchored = evidence('final', ['/queries/0']);
  anchored.snapshots[0].node_count = 10;
  anchored.queries = [{ samples: [{ snapshot_sha256: sha256, path: [{ to: { ord: 0, id: 42, self: 0 } }] }] }];
  anchored.analysis.findings[0].representative_objects = [
    { label: 'cache', evidence_ref: '/queries/0/samples/0/path/0/to' },
  ];
  writeEvidence(anchored);
  applyMemoryResidualResults(result, manifest(result), directory);
  assert.deepEqual(result.residualAnalyses[0].findings[0].representativeObjects, [
    { label: 'cache', snapshotId: 's1', nodeIndex: 0, nodeId: 42 },
  ]);
  const missingAnchor = structuredClone(anchored);
  delete missingAnchor.analysis.findings[0].representative_objects;
  for (const anchors of [undefined, []]) {
    missingAnchor.analysis.findings[0].representative_objects = anchors;
    writeEvidence(missingAnchor);
    const previous = JSON.stringify(result);
    assert.throws(
      () => applyMemoryResidualResults(result, manifest(result), directory),
      /representative objects.*object_anchor_gap/,
    );
    assert.equal(JSON.stringify(result), previous, 'Missing anchors leave the previous report intact');
  }
  const gapReason = 'Only aggregate retention is discussed; no representative object was selected.';
  missingAnchor.analysis.findings[0].object_anchor_gap = gapReason;
  writeEvidence(missingAnchor);
  const gapManifest = manifest(result);
  gapManifest.translations[gapReason] = { zh: '该项仅讨论汇总保活量，未选择单个代表对象。', en: gapReason };
  applyMemoryResidualResults(result, gapManifest, directory);
  assert.ok(result.residualAnalyses[0].findings[0].limitations.includes(gapReason));
  assert.equal(result.residualAnalyses[0].translations[gapReason].zh, gapManifest.translations[gapReason].zh);
  missingAnchor.analysis.findings[0].object_anchor_gap = ' ';
  writeEvidence(missingAnchor);
  assert.throws(() => applyMemoryResidualResults(result, gapManifest, directory), /nonempty text/);
  const tenObjects = structuredClone(anchored);
  tenObjects.queries[0].samples[0].path = Array.from({ length: 10 }, (_, ord) => ({ to: { ord, id: ord + 42 } }));
  tenObjects.analysis.findings[0].representative_objects = Array.from({ length: 10 }, (_, index) => ({
    label: `cache${index}`,
    evidence_ref: `/queries/0/samples/0/path/${index}/to`,
  }));
  writeEvidence(tenObjects);
  const limitResult = fixture();
  applyMemoryResidualResults(limitResult, manifest(limitResult), directory);
  assert.equal(limitResult.residualAnalyses[0].findings[0].representativeObjects.length, 10);
  tenObjects.snapshots[0].node_count = 11;
  tenObjects.queries[0].samples[0].path.push({ to: { ord: 10, id: 52 } });
  tenObjects.analysis.findings[0].representative_objects.push({
    label: 'cache10',
    evidence_ref: '/queries/0/samples/0/path/10/to',
  });
  writeEvidence(tenObjects);
  assert.throws(() => applyMemoryResidualResults(limitResult, manifest(limitResult), directory), /at most 10/);
  assert.equal(limitResult.residualAnalyses[0].findings[0].representativeObjects.length, 10);
  for (const change of [
    (item) => {
      item.queries[0].samples[0].snapshot_sha256 = 'f'.repeat(64);
    },
    (item) => {
      item.queries[0].samples[0].path[0].to.ord = 10;
    },
    (item) => {
      item.analysis.findings[0].evidence_refs = ['/snapshots/0'];
    },
    (item) => {
      item.analysis.findings[0].representative_objects[0].evidence_ref = '/queries/0/samples/0';
    },
    (item) => {
      item.analysis.findings[0].representative_objects.push(item.analysis.findings[0].representative_objects[0]);
    },
  ]) {
    const invalid = structuredClone(anchored);
    change(invalid);
    writeEvidence(invalid);
    const previous = JSON.stringify(result);
    assert.throws(() => applyMemoryResidualResults(result, manifest(result), directory), /[Rr]epresentative object/);
    assert.equal(JSON.stringify(result), previous, 'Invalid anchors leave the previous report intact');
  }
  const wrongMode = evidence();
  wrongMode.residual_context.engineMode = 'gc';
  writeEvidence(wrongMode);
  assert.throws(() => applyMemoryResidualResults(result, manifest(result), directory), /engine mode/);
  writeEvidence(evidence());
  const stale = manifest(result);
  result.snapshots[0].sha256 = 'b'.repeat(64);
  assert.throws(() => applyMemoryResidualResults(result, stale, directory), /Stale/);
  result.snapshots[0].sha256 = sha256;
  writeEvidence(evidence('draft'));
  assert.throws(() => applyMemoryResidualResults(result, manifest(result), directory), /finalized/);
  writeEvidence(evidence('final', ['/queries/100']));
  assert.throws(() => applyMemoryResidualResults(result, manifest(result), directory), /Unresolved/);
  writeEvidence(evidence());
  applyMemoryResidualResults(result, manifest(result, 'confirmed'), directory);
  assert.equal(result.summary.confirmedLeakPageCount, 1);
  assert.equal(result.issues.length, 1);
  assert.deepEqual(result.issues[0].titleText, { zh: '测试发现', en: 'Synthetic finding' });
  assert.equal(result.issues[0].messageText.en, 'Synthetic fixture, not a trace conclusion.');
  assert.equal(result.sharedBtsSlotCharts[0].events[1].reportAnchor, 'residual-instance-1');
  applyMemoryResidualResults(result, manifest(result, 'confirmed'), directory);
  assert.equal(result.issues.length, 1);
  assert.equal(result.sharedBtsSlotCharts[0].events.length, 2);
  const excluded = manifest(result, 'excluded');
  assert.throws(() => applyMemoryResidualResults(result, excluded, directory), /versioned/);
  excluded.pages[0].decisions[0].exclusion = {
    ruleId: 'fixture-rule',
    version: '1',
    reason: 'Synthetic rule',
    evidenceRefs: ['/snapshots/0'],
  };
  result.residualAnalyses[0].gaps.push('Obsolete analyzer gap from an earlier run');
  applyMemoryResidualResults(result, excluded, directory);
  assert.deepEqual(result.residualAnalyses[0].gaps, []);
  assert.equal(result.summary.confirmedLeakPageCount, 0);
  assert.equal(result.issues.length, 0);
  assert.equal(result.sharedBtsSlotCharts[0].events.length, 1);
  result.residualAnalyses[0].residualBytes = 0;
  assert.throws(() => applyMemoryResidualResults(result, manifest(result, 'confirmed'), directory), /cleared/);
  const knownResult = fixture();
  const ruleRef = '/snapshots/0/residual/rules/0';
  const knownEvidence = evidence('final', [ruleRef]);
  knownEvidence.snapshots[0].residual = { rules: [{ rule_id: 'debugger', version: 'bts-residual-1', bytes: 100 }] };
  writeEvidence(knownEvidence);
  const knownManifest = manifest(knownResult, 'known-non-leak');
  knownManifest.pages[0].rulesVersion = 'bts-residual-1';
  knownManifest.pages[0].decisions[0].exclusion = {
    ruleId: 'debugger',
    version: 'bts-residual-1',
    reason: 'Synthetic rule',
    bytes: 100,
    evidenceRefs: [ruleRef],
  };
  applyMemoryResidualResults(knownResult, knownManifest, directory);
  assert.equal(knownResult.residualAnalyses[0].status, 'known-non-leak');
  assert.equal(knownResult.residualAnalyses[0].knownNonLeakBytes, 100);
  assert.equal(knownResult.summary.suspectedPageCount, 0);
  assert.equal(knownResult.summary.confirmedLeakPageCount, 0);
  assert.equal(knownResult.issues.length, 0);
  knownManifest.pages[0].decisions[0].exclusion.bytes = 101;
  assert.throws(() => applyMemoryResidualResults(knownResult, knownManifest, directory), /latest analyzer rule/);
  knownManifest.pages[0].decisions[0].exclusion.bytes = 100;
  knownEvidence.snapshots[0].residual.rules[0].rule_id = 'gc-atom-string';
  knownManifest.pages[0].decisions[0].exclusion.ruleId = 'gc-atom-string';
  writeEvidence(knownEvidence);
  assert.throws(() => applyMemoryResidualResults(knownResult, knownManifest, directory), /engine mode/);
  applyMemoryResidualResults(
    result,
    {
      schemaVersion: 1,
      translations: { 'Analyzer unavailable': { zh: '分析器不可用', en: 'Analyzer unavailable' } },
      pages: [],
      failures: [
        {
          analysisId: 'r1',
          inputDigest: residualInputDigest(result, result.residualAnalyses[0]),
          error: 'Analyzer unavailable',
        },
      ],
    },
    directory,
  );
  assert.equal(result.residualAnalyses[0].status, 'failed');
  assert.equal(result.residualAnalyses[0].reportHtml, undefined);
  assert.deepEqual(Object.keys(result.residualAnalyses[0].translations), ['Analyzer unavailable']);
  assert.equal(result.summary.incompletePageCount, 1);
  console.log(
    'Memory residual checks passed: extraction, sequence tails, reappearance, stale/final evidence, markers, exclusions, failures.',
  );
})()
  .finally(() => fs.rmSync(directory, { recursive: true, force: true }))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
