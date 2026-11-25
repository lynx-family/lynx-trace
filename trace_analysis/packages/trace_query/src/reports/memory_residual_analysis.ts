// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { extractMemorySnapshot } from '../queries/query_memory_snapshot';
import {
  BtsResidualAnalysis,
  BtsResidualContext,
  MemoryAnalysisResult,
  MemoryText,
  ResidualFinding,
} from '../types/memory_analysis';
import { TraceQuery } from '../utils/trace_query';
import { importCacheBreakdown } from './memory_cache_retention';

/** Decisions refer to findings in a finalized js-memory-analyzer evidence file. */
export interface ResidualAnalysisImport {
  schemaVersion: 1;
  translations: Record<string, MemoryText>;
  failures?: { analysisId: string; inputDigest: string; error: string }[];
  pages: {
    analysisId: string;
    inputDigest: string;
    analyzerVersion: string;
    rulesVersion: string;
    evidencePath: string;
    reportPath: string;
    decisions: {
      findingId: string;
      disposition: ResidualFinding['disposition'];
      confidence: ResidualFinding['confidence'];
      exclusion?: ResidualFinding['exclusion'];
    }[];
    leakBytes?: number;
    leakSizeBasis?: string;
  }[];
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function residualInputDigest(result: MemoryAnalysisResult, analysis: BtsResidualAnalysis): string {
  const page = result.pages.find((item) => item.instanceId === analysis.instanceId);
  const vm = result.vms.find((item) => item.id === analysis.vmId);
  return digest({
    trace: result.trace,
    page: [page?.instanceId, page?.url, page?.btsCreateTsMs, analysis.destroyTsMs],
    vm: [vm?.id, vm?.ptr, vm?.generation, vm?.createTsMs, vm?.destroyTsMs, vm?.type, page?.btsVmType],
    slot: analysis.slotId,
    snapshots: analysis.snapshotIds.map((id) => {
      const snapshot = result.snapshots.find((item) => item.snapshotId === id);
      if (!snapshot) throw new Error(`Missing snapshot metadata: ${id}`);
      const metadata = { ...snapshot };
      delete metadata.outputPath;
      delete metadata.extractionError;
      return metadata;
    }),
  });
}

export function residualAnalyzerContext(
  result: MemoryAnalysisResult,
  analysis: BtsResidualAnalysis,
): BtsResidualContext {
  const type = result.vms.find((vm) => vm.id === analysis.vmId)?.type ?? '';
  return {
    kind: 'bts_residual',
    sequence: 'same-page-post-exit',
    engineMode: /\(gc\)$/i.test(type) ? 'gc' : /\(rc\)$/i.test(type) ? 'rc' : 'unknown',
    vmId: analysis.vmId,
    instanceId: analysis.instanceId,
    slotId: analysis.slotId,
    snapshots: analysis.snapshotIds.flatMap((id) => {
      const snapshot = result.snapshots.find((item) => item.snapshotId === id)!;
      return snapshot.integrity === 'complete' && !snapshot.identityError && snapshot.sha256
        ? [{ snapshotId: id, sha256: snapshot.sha256, captureTsMs: snapshot.captureTsMs }]
        : [];
    }),
  };
}

function captureGaps(result: MemoryAnalysisResult, analysis: BtsResidualAnalysis): string[] {
  const snapshots = analysis.snapshotIds.map((id) => result.snapshots.find((item) => item.snapshotId === id)!);
  const complete = snapshots.filter((item) => item.integrity === 'complete' && !item.identityError);
  return [
    ...new Set([
      ...snapshots.flatMap((item) => (item.identityError ? [item.identityError] : [])),
      ...(snapshots.length === 0 ? ['没有该销毁页面的 residual 快照，无法分析对象残留。'] : []),
      ...snapshots.flatMap((item) => (item.extractionError ? [`${item.snapshotId}: ${item.extractionError}`] : [])),
      ...(snapshots.length && !analysis.tailComplete ? ['序列末端未完整覆盖，展示的是末次有效观察。'] : []),
      ...(new Set(complete.map((item) => item.includeInternalAllocations)).size > 1
        ? ['快照 include_internal_allocations 不一致，统计不可直接比较。']
        : []),
    ]),
  ];
}

/** Extract every residual record, preserving failures and later observations. */
export async function prepareMemoryResidualAnalysis(
  traceQuery: TraceQuery,
  result: MemoryAnalysisResult,
  directory: string,
): Promise<void> {
  for (const analysis of result.residualAnalyses) {
    analysis.findings = [];
    analysis.translations = undefined;
    analysis.reportHtml = undefined;
    analysis.reportPath = undefined;
    analysis.evidencePath = undefined;
    analysis.leakBytes = undefined;
    analysis.leakSizeBasis = undefined;
    analysis.analyzerVersion = undefined;
    analysis.rulesVersion = undefined;
    analysis.knownNonLeakBytes = undefined;
    for (const id of analysis.snapshotIds) {
      const snapshot = result.snapshots.find((item) => item.snapshotId === id)!;
      if (snapshot.integrity === 'metadata-only') {
        snapshot.extractionError = undefined;
        snapshot.outputPath = undefined;
        snapshot.sha256 = undefined;
        continue;
      }
      try {
        const file = path.join(directory, `${snapshot.sliceId}.heapsnapshot`);
        Object.assign(snapshot, await extractMemorySnapshot(traceQuery, id, file), {
          integrity: 'complete',
          extractionError: undefined,
        });
      } catch (error) {
        snapshot.integrity = 'incomplete';
        snapshot.extractionError = String(error);
      }
    }
    const snapshots = analysis.snapshotIds.map((id) => result.snapshots.find((item) => item.snapshotId === id)!);
    const valid = snapshots.filter(
      (item) => !item.identityError && (item.integrity === 'complete' || item.integrity === 'metadata-only'),
    );
    const latest = valid[valid.length - 1];
    analysis.latestSnapshotId = latest?.snapshotId;
    analysis.residualBytes = latest?.retainedBytes;
    analysis.tailComplete = latest !== undefined && latest === snapshots[snapshots.length - 1];
    analysis.gaps = captureGaps(result, analysis);
    analysis.status =
      analysis.tailComplete && latest?.retainedBytes === 0
        ? 'cleared'
        : analysis.gaps.length
          ? 'insufficient'
          : 'pending';
    analysis.inputDigest = residualInputDigest(result, analysis);
    analysis.analyzerContext = residualAnalyzerContext(result, analysis);
    fs.mkdirSync(directory, { recursive: true });
    analysis.contextPath = path.resolve(directory, `${analysis.reportAnchor}.context.json`);
    fs.writeFileSync(analysis.contextPath, JSON.stringify(analysis.analyzerContext, null, 2));
  }
  refreshResidualSummary(result);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected JSON object');
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Expected nonempty text');
  return value;
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error('Expected string array');
  return value as string[];
}

function readTranslations(
  texts: string[],
  translations: ResidualAnalysisImport['translations'],
): Record<string, MemoryText> {
  const result: Record<string, MemoryText> = Object.create(null);
  for (const source of new Set(texts)) {
    if (!translations || !Object.prototype.hasOwnProperty.call(translations, source)) {
      throw new Error(`Missing Chinese/English translation for residual text: ${source.slice(0, 80)}`);
    }
    const copy = object(translations[source]);
    result[source] = { zh: text(copy['zh']), en: text(copy['en']) };
  }
  return result;
}

function resolveEvidenceRef(evidence: Record<string, unknown>, ref: string): unknown {
  if (
    /~(?![01])/u.test(ref) ||
    !/^\/(snapshots|queries|comparisons|source_evidence|source_materials|analysis\/observations)\/\d+(?:\/|$)/.test(ref)
  ) {
    throw new Error(`Invalid evidence reference: ${ref}`);
  }
  let current: unknown = evidence;
  for (const key of ref
    .slice(1)
    .split('/')
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (current === null || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, key)) {
      throw new Error(`Unresolved evidence reference: ${ref}`);
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function validateRefs(evidence: Record<string, unknown>, refs: string[]): void {
  if (!refs.length) throw new Error('A finding must have evidence references');
  for (const ref of refs) resolveEvidenceRef(evidence, ref);
}

/** Structured node evidence requires navigation or a visible explanation for its absence. */
function containsMeasuredNode(value: unknown): boolean {
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== 'object') continue;
    const node = item as Record<string, unknown>;
    if (
      Number.isSafeInteger(node['ord']) &&
      (node['ord'] as number) >= 0 &&
      Number.isSafeInteger(node['id']) &&
      (node['id'] as number) >= 0
    )
      return true;
    for (const child of Object.values(item)) if (child && typeof child === 'object') pending.push(child);
  }
  return false;
}

function representativeObjects(
  evidence: Record<string, unknown>,
  finding: Record<string, unknown>,
  refs: string[],
  context: BtsResidualContext,
): ResidualFinding['representativeObjects'] {
  const anchors = finding['representative_objects'];
  const gap = finding['object_anchor_gap'];
  if (gap !== undefined && text(gap).length > 2000) throw new Error('Object anchor gap exceeds 2000 characters');
  if (
    (anchors === undefined || (Array.isArray(anchors) && !anchors.length)) &&
    gap === undefined &&
    refs.some(
      (ref) => /^\/(?:queries|snapshots)\//.test(ref) && containsMeasuredNode(resolveEvidenceRef(evidence, ref)),
    )
  ) {
    throw new Error('Measured node evidence requires representative objects or an explicit object_anchor_gap');
  }
  if (anchors === undefined) return undefined;
  if (!Array.isArray(anchors) || anchors.length > 10) throw new Error('Expected at most 10 representative objects');
  const nodes = new Set<string>();
  const labels = new Set<string>();
  return anchors.map((raw) => {
    const anchor = object(raw);
    const label = text(anchor['label']);
    const ref = text(anchor['evidence_ref']);
    validateRefs(evidence, [ref]);
    if (
      label.length > 80 ||
      !/^\/(?:queries|snapshots)\/\d+\//.test(ref) ||
      !refs.some((parent) => ref === parent || ref.startsWith(`${parent}/`))
    ) {
      throw new Error('Representative object must belong to its finding evidence');
    }
    let current: unknown = evidence;
    let hash: unknown;
    for (const token of ref.slice(1).split('/')) {
      const row = current as Record<string, unknown>;
      hash = row['snapshot_sha256'] ?? row['sha256'] ?? hash;
      current = row[token.replace(/~1/g, '/').replace(/~0/g, '~')];
    }
    const node = object(current);
    const nodeIndex = node['ord'] as number;
    const nodeId = node['id'] as number;
    const snapshots = context.snapshots.filter((item) => item.sha256 === hash);
    const source = (evidence['snapshots'] as Record<string, unknown>[]).find((item) => item['sha256'] === hash);
    if (
      snapshots.length !== 1 ||
      !Number.isSafeInteger(nodeIndex) ||
      nodeIndex < 0 ||
      !Number.isSafeInteger(source?.['node_count']) ||
      nodeIndex >= (source!['node_count'] as number) ||
      !Number.isSafeInteger(nodeId) ||
      nodeId < 0
    ) {
      throw new Error('Representative object requires a measured node and unique snapshot identity');
    }
    const key = `${hash}:${nodeIndex}`;
    if (nodes.has(key) || labels.has(label)) throw new Error('Duplicate representative object');
    nodes.add(key);
    labels.add(label);
    return { label, snapshotId: snapshots[0]!.snapshotId, nodeIndex, nodeId };
  });
}

/** Resolve hashes only within the referenced evidence, never from finding prose. */
function findingSnapshotIds(evidence: Record<string, unknown>, refs: string[], context: BtsResidualContext): string[] {
  const hashes = new Set<string>();
  const collect = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(collect);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if ((key === 'sha256' || key === 'snapshot_sha256') && typeof child === 'string') hashes.add(child);
      else if (typeof child === 'object') collect(child);
    }
  };
  for (const ref of refs) {
    const keys = ref
      .slice(1)
      .split('/')
      .map((key) => key.replace(/~1/g, '/').replace(/~0/g, '~'));
    let current: unknown = evidence;
    for (const key of keys) {
      if (!current || typeof current !== 'object') break;
      const row = current as Record<string, unknown>;
      // A reference to a nested path inherits its sample/snapshot identity.
      for (const field of ['sha256', 'snapshot_sha256']) {
        if (typeof row[field] === 'string') hashes.add(row[field] as string);
      }
      current = row[key];
    }
    collect(current);
  }
  return context.snapshots.filter((snapshot) => hashes.has(snapshot.sha256)).map((snapshot) => snapshot.snapshotId);
}

/** Validates the whole import before replacing any previous page conclusions. */
export function applyMemoryResidualResults(
  result: MemoryAnalysisResult,
  input: ResidualAnalysisImport,
  baseDirectory = '.',
): void {
  if (result.schemaVersion !== 4 || input.schemaVersion !== 1 || !Array.isArray(input.pages)) {
    throw new Error('Unsupported memory analysis or residual import schema');
  }
  const seen = new Set<string>();
  const updates = input.pages.map((entry) => {
    const analysis = result.residualAnalyses.find((item) => item.id === entry.analysisId);
    if (!analysis || seen.has(entry.analysisId)) throw new Error(`Unknown or duplicate analysis: ${entry.analysisId}`);
    seen.add(entry.analysisId);
    if (entry.inputDigest !== residualInputDigest(result, analysis))
      throw new Error(`Stale residual result: ${entry.analysisId}`);
    const evidence = object(JSON.parse(fs.readFileSync(path.resolve(baseDirectory, text(entry.evidencePath)), 'utf8')));
    const finalAnalysis = object(evidence['analysis']);
    const expectedContext = residualAnalyzerContext(result, analysis);
    if (JSON.stringify(evidence['residual_context']) !== JSON.stringify(expectedContext)) {
      throw new Error('Analyzer must receive the matching engine mode and complete same-page residual sequence');
    }
    if (finalAnalysis['status'] !== 'final') throw new Error('Only finalized analyzer findings can be imported');
    text(object(evidence['inquiry'])['question']);
    text(finalAnalysis['scope']);
    const gaps = strings(finalAnalysis['gaps']);
    const snapshots = evidence['snapshots'];
    const latest = result.snapshots.find((item) => item.snapshotId === analysis.latestSnapshotId);
    if (
      !Array.isArray(snapshots) ||
      snapshots.length !== expectedContext.snapshots.length ||
      snapshots.some((item, index) => object(item)['sha256'] !== expectedContext.snapshots[index]?.sha256) ||
      !latest?.sha256 ||
      !snapshots.some((item) => object(item)['sha256'] === latest.sha256)
    ) {
      throw new Error('Analyzer evidence must include the latest valid residual snapshot hash');
    }
    const rawFindings = finalAnalysis['findings'];
    if (
      !Array.isArray(rawFindings) ||
      !Array.isArray(entry.decisions) ||
      entry.decisions.length !== rawFindings.length
    ) {
      throw new Error('Every analyzer finding needs exactly one disposition');
    }
    const findingIds = new Set<string>();
    const findings: ResidualFinding[] = rawFindings.map((raw) => {
      const finding = object(raw);
      const id = text(finding['id']);
      if (findingIds.has(id)) throw new Error(`Duplicate finding: ${id}`);
      findingIds.add(id);
      const decisions = entry.decisions.filter((item) => item.findingId === id);
      const decision = decisions[0];
      if (
        decisions.length !== 1 ||
        !decision ||
        !['confirmed', 'suspected', 'retained', 'excluded', 'information', 'known-non-leak'].includes(
          decision.disposition,
        ) ||
        !['high', 'medium', 'low'].includes(decision.confidence)
      )
        throw new Error(`Invalid finding disposition: ${id}`);
      const refs = strings(finding['evidence_refs']);
      validateRefs(evidence, refs);
      if (decision.disposition === 'excluded' || decision.disposition === 'known-non-leak') {
        if (!decision.exclusion) throw new Error('Excluded findings require a versioned rule and evidence');
        text(decision.exclusion.ruleId);
        text(decision.exclusion.version);
        text(decision.exclusion.reason);
        validateRefs(evidence, decision.exclusion.evidenceRefs);
      }
      if (decision.disposition === 'known-non-leak') {
        const exclusion = decision.exclusion!;
        const last = object((snapshots as unknown[]).at(-1));
        const residual = object(last['residual']);
        const rules = Array.isArray(residual['rules']) ? residual['rules'] : [];
        const rule = rules.find((row) => object(row)['rule_id'] === exclusion.ruleId);
        if (
          !rule ||
          object(rule)['version'] !== exclusion.version ||
          entry.rulesVersion !== exclusion.version ||
          !Number.isSafeInteger(exclusion.bytes) ||
          exclusion.bytes! < 0 ||
          object(rule)['bytes'] !== exclusion.bytes ||
          (exclusion.ruleId === 'gc-atom-string' && expectedContext.engineMode !== 'gc') ||
          !['debugger', 'object-shape', 'builtin-function', 'gc-atom-string', 'vm-current-app-id'].includes(
            exclusion.ruleId,
          )
        ) {
          throw new Error('Known non-leak finding must match the latest analyzer rule evidence and engine mode');
        }
        const ruleRef = `/snapshots/${(snapshots as unknown[]).length - 1}/residual/rules/${rules.indexOf(rule)}`;
        if (!refs.includes(ruleRef) || !exclusion.evidenceRefs.includes(ruleRef)) {
          throw new Error('Known non-leak finding must reference its latest rule evidence');
        }
      }
      return {
        id,
        title: text(finding['title']),
        conclusion: text(finding['conclusion']),
        evidence_refs: refs,
        snapshotIds: findingSnapshotIds(evidence, refs, expectedContext),
        representativeObjects: representativeObjects(evidence, finding, refs, expectedContext),
        allocationBreakdown: importCacheBreakdown(evidence, finding, refs, expectedContext),
        limitations: [
          ...new Set([
            ...strings(finding['limitations']),
            ...(finding['object_anchor_gap'] === undefined ? [] : [text(finding['object_anchor_gap'])]),
          ]),
        ],
        disposition: decision.disposition,
        confidence: decision.confidence,
        exclusion: decision.exclusion,
      };
    });
    const reportPath = path.resolve(baseDirectory, text(entry.reportPath));
    const allocated = new Set<string>();
    for (const finding of findings) {
      for (const id of finding.allocationBreakdown?.nodeIds ?? []) {
        const key = `${finding.allocationBreakdown!.snapshotId}:${id}`;
        if (allocated.has(key)) throw new Error('Overlapping finding allocation breakdowns');
        allocated.add(key);
      }
    }
    const reportHtml = fs.readFileSync(reportPath, 'utf8');
    if (!/<html[\s>]/i.test(reportHtml)) throw new Error('Expected an analyzer HTML report');
    const confirmed = findings.some((item) => item.disposition === 'confirmed');
    const knownFindings = findings.filter((item) => item.disposition === 'known-non-leak');
    if (new Set(knownFindings.map((item) => item.exclusion!.ruleId)).size !== knownFindings.length)
      throw new Error('Duplicate known non-leak rule');
    const knownNonLeakBytes = knownFindings.reduce((sum, item) => sum + item.exclusion!.bytes!, 0);
    if (knownNonLeakBytes > (analysis.residualBytes ?? 0)) throw new Error('Known non-leak size exceeds slot residual');
    if (
      confirmed &&
      (!analysis.tailComplete ||
        analysis.residualBytes === 0 ||
        analysis.snapshotIds.some((id) => result.snapshots.find((item) => item.snapshotId === id)?.identityError))
    ) {
      throw new Error(
        'Cannot confirm a current page leak with ambiguous identity, an incomplete tail, or a cleared slot',
      );
    }
    if (
      entry.leakBytes !== undefined &&
      (!confirmed || !Number.isFinite(entry.leakBytes) || entry.leakBytes < 0 || !entry.leakSizeBasis)
    ) {
      throw new Error('Quantified leak size requires confirmed findings and a non-overlapping size basis');
    }
    const status: BtsResidualAnalysis['status'] =
      analysis.status === 'cleared'
        ? 'cleared'
        : confirmed
          ? 'confirmed'
          : findings.some((item) => item.disposition === 'suspected')
            ? 'suspected'
            : findings.some((item) => item.disposition === 'retained')
              ? 'retained'
              : knownFindings.length &&
                  knownNonLeakBytes === analysis.residualBytes &&
                  analysis.tailComplete &&
                  !gaps.length &&
                  !captureGaps(result, analysis).length
                ? 'known-non-leak'
                : findings.some((item) => item.disposition === 'excluded')
                  ? 'excluded'
                  : 'insufficient';
    const translations = readTranslations(
      [
        ...findings.flatMap((finding) => [
          finding.title,
          finding.conclusion,
          ...finding.limitations,
          ...(finding.exclusion ? [finding.exclusion.reason] : []),
        ]),
        ...gaps,
        ...(entry.leakSizeBasis ? [entry.leakSizeBasis] : []),
      ],
      input.translations,
    );
    return {
      analysis,
      values: {
        findings,
        translations,
        status,
        gaps: [...new Set([...captureGaps(result, analysis), ...gaps])],
        analyzerVersion: text(entry.analyzerVersion),
        rulesVersion: text(entry.rulesVersion),
        knownNonLeakBytes,
        reportPath,
        evidencePath: path.resolve(baseDirectory, entry.evidencePath),
        reportHtml,
        leakBytes: entry.leakBytes,
        leakSizeBasis: entry.leakSizeBasis,
      },
    };
  });
  const failures = (input.failures ?? []).map((failure) => {
    const analysis = result.residualAnalyses.find((item) => item.id === failure.analysisId);
    if (!analysis || seen.has(failure.analysisId) || failure.inputDigest !== residualInputDigest(result, analysis)) {
      throw new Error(`Unknown, duplicate or stale failed analysis: ${failure.analysisId}`);
    }
    seen.add(failure.analysisId);
    const error = text(failure.error);
    return { analysis, error, translations: readTranslations([error], input.translations) };
  });
  for (const update of updates) Object.assign(update.analysis, update.values);
  for (const failure of failures)
    Object.assign(failure.analysis, {
      status: 'failed',
      findings: [],
      translations: failure.translations,
      reportHtml: undefined,
      reportPath: undefined,
      evidencePath: undefined,
      leakBytes: undefined,
      leakSizeBasis: undefined,
      analyzerVersion: undefined,
      rulesVersion: undefined,
      knownNonLeakBytes: undefined,
      gaps: [...captureGaps(result, failure.analysis), failure.error],
    });
  refreshResidualSummary(result);
}

export function refreshResidualSummary(result: MemoryAnalysisResult): void {
  result.issues = result.issues.filter((issue) => issue.code !== 'bts_residual_confirmed');
  for (const chart of result.sharedBtsSlotCharts) {
    chart.events = (chart.events ?? []).filter((event) => event.name !== 'bts_residual_confirmed');
  }
  for (const analysis of result.residualAnalyses.filter((item) => item.status === 'confirmed')) {
    const snapshot = result.snapshots.find((item) => item.snapshotId === analysis.latestSnapshotId)!;
    const findings = analysis.findings.filter((item) => item.disposition === 'confirmed');
    for (const finding of findings)
      result.issues.push({
        code: 'bts_residual_confirmed',
        title: finding.title,
        message: finding.conclusion,
        titleText: analysis.translations?.[finding.title],
        messageText: analysis.translations?.[finding.conclusion],
        confidence: finding.confidence,
        instanceIds: [analysis.instanceId],
        vmId: analysis.vmId,
        slotId: analysis.slotId,
        snapshotIds: finding.snapshotIds,
      });
    const chartId = result.sharedBtsVmAnalyses.find((item) => item.vmId === analysis.vmId)?.chartId;
    result.sharedBtsSlotCharts
      .find((item) => item.id === chartId)
      ?.events?.push({
        name: 'bts_residual_confirmed',
        tsMs: snapshot.captureTsMs,
        instanceId: analysis.instanceId,
        snapshotId: snapshot.snapshotId,
        slotId: analysis.slotId,
        residualBytes: analysis.residualBytes,
        leakBytes: analysis.leakBytes,
        leakSizeBasis: analysis.leakSizeBasis,
        leakSizeBasisText: analysis.leakSizeBasis ? analysis.translations?.[analysis.leakSizeBasis] : undefined,
        confidence: findings[0]!.confidence,
        reportAnchor: analysis.reportAnchor,
      });
  }
  const summary = result.summary;
  summary.issueCount = result.issues.length;
  summary.confirmedLeakPageCount = result.residualAnalyses.filter((item) => item.status === 'confirmed').length;
  summary.suspectedPageCount = result.residualAnalyses.filter((item) =>
    ['retained', 'suspected'].includes(item.status),
  ).length;
  summary.incompletePageCount = result.residualAnalyses.filter((item) =>
    ['pending', 'failed', 'insufficient'].includes(item.status),
  ).length;
  if (result.valid)
    summary.conclusion = `发现 ${summary.issueCount} 个内存 issue；泄漏 ${summary.confirmedLeakPageCount} 页，待核实 ${summary.suspectedPageCount} 页，分析未完成或证据不足 ${summary.incompletePageCount} 页。`;
}
