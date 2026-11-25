// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import type { PreparedFrontend, SnapshotSourceLocations } from '../reports/frontend_sources';
import type { SourcePreparation } from '../reports/source_preparation';

export type MemoryConfidence = 'high' | 'medium' | 'low';

export interface MemoryText {
  zh: string;
  en: string;
}

export type MemoryScenario = 'default' | 'scroll';

export interface MemoryAnalysisOptions {
  url?: string;
  instanceId?: number;
  scenario?: MemoryScenario;
  startTsMs?: number;
  endTsMs?: number;
}

export interface MemoryValue {
  accumulateBytes: number;
  rssBytes: number;
}

export interface MemorySeriesPoint {
  tsMs: number;
  value: number;
  /** Graphics observations preserve unknown intervals and the original counter provenance. */
  unavailable?: string;
  /** The value sums known contributors, but some active contributors are unavailable. */
  partial?: boolean;
  sourceTsMs?: number;
  counterId?: number;
  rawValues?: unknown[];
  loadedInstanceIds?: number[];
  instanceIds?: number[];
  destroyedInstanceIds?: number[];
}

export interface MemoryChartSeries {
  name: string;
  label?: MemoryText;
  colorKey?: string;
  color?: string;
  interpolation?: 'step' | 'linear';
  trackId?: number;
  unit: 'bytes' | 'count';
  renderMode?: 'line' | 'interval-bars' | 'stacked-area';
  slotId?: number;
  points: MemorySeriesPoint[];
}

export interface MemoryChartEvent {
  sliceId?: number;
  name: string;
  tsMs: number;
  instanceId?: number;
  instanceIds?: number[];
  url?: string;
  snapshotId?: string;
  confidence?: MemoryConfidence;
  accumulateDeltaBytes?: number;
  rssDeltaBytes?: number;
  residualBytes?: number;
  leakBytes?: number;
  leakSizeBasis?: string;
  leakSizeBasisText?: MemoryText;
  slotId?: number;
  renderMode?: 'bubble' | 'vertical-line';
  reportAnchor?: string;
  btsVmName?: string;
}

export interface MemoryChart {
  id: string;
  title: string;
  xStartTsMs?: number;
  xEndTsMs?: number;
  zeroBaseline?: boolean;
  renderMode?: 'line' | 'interval-bars' | 'stacked-area';
  events?: MemoryChartEvent[];
  series: MemoryChartSeries[];
  graphics?: {
    notes: MemoryText[];
    comparisons?: MemoryChartSeries[];
    filterPageEvents?: boolean;
  };
}

export interface MemoryTrend {
  seriesName: string;
  unit: 'bytes' | 'count';
  rising: boolean;
  slopePerSecond: number;
  delta: number;
  noiseThreshold: number;
  sampleCount: number;
  reason: string;
}

export interface MemoryIssue {
  /** Only snapshots explicitly identified by the issue's evidence. */
  snapshotIds?: string[];
  code: string;
  title: string;
  message: string;
  titleText?: MemoryText;
  messageText?: MemoryText;
  confidence: MemoryConfidence;
  instanceIds: number[];
  vmId?: string;
  valueBytes?: number;
  poolUrls?: string[];
  slotId?: number;
}

export interface PagePeakMemoryAnalysis {
  deltaBytes: number;
  startTsMs: number;
  endTsMs: number;
  confidence: MemoryConfidence;
  groupedInstanceIds?: number[];
}

export interface PagePoolMemoryAnalysis {
  mtsPoolDeltaBytes: number;
  startTsMs: number;
  endTsMs: number;
  confidence: MemoryConfidence;
  pools: MtsPoolMemoryDelta[];
}

export interface MtsPoolMemoryDelta {
  url: string;
  startInstanceCount: number;
  endInstanceCount: number;
  instanceCountDelta: number;
  startAccumulateBytes: number;
  endAccumulateBytes: number;
  accumulateDeltaBytes: number;
  startRssBytes: number;
  endRssBytes: number;
  rssDeltaBytes: number;
}

export interface MtsPoolGrowthEvent {
  id: string;
  instanceId: number;
  startTsMs: number;
  endTsMs: number;
  totalRssDeltaBytes: number;
  pools: MtsPoolMemoryDelta[];
}

export interface PageMemoryRollbackAnalysis {
  deltaBytes: number;
  baselineBytes: number;
  baselineTsMs: number;
  lowestBytes: number;
  lowestTsMs: number;
  observationStartTsMs: number;
  observationEndTsMs: number;
  confidence: MemoryConfidence;
  forcedGc: boolean;
  message: string;
}

export type ResidualStatus =
  | 'pending'
  | 'failed'
  | 'insufficient'
  | 'retained'
  | 'suspected'
  | 'cleared'
  | 'confirmed'
  | 'known-non-leak'
  | 'excluded';

export interface ResidualFinding {
  snapshotIds?: string[];
  representativeObjects?: { label: string; snapshotId: string; nodeIndex: number; nodeId: number }[];
  allocationBreakdown?: {
    snapshotId: string;
    bytes: number;
    nodeIds: number[];
    rows: {
      bytes: number;
      count: number;
      owners: { label: string; labels?: string[]; nodeIndex: number; nodeId: number }[];
      otherRoot: boolean;
      gcAtom: boolean;
      samples: {
        nodeIndex: number;
        nodeId: number;
        type: string;
        bytes: number;
        stringPreview?: { text: string; truncated: boolean };
        paths: string[];
      }[];
    }[];
  };
  id: string;
  title: string;
  conclusion: string;
  evidence_refs: string[];
  limitations: string[];
  disposition: 'confirmed' | 'suspected' | 'retained' | 'excluded' | 'information' | 'known-non-leak';
  confidence: MemoryConfidence;
  exclusion?: { ruleId: string; version: string; reason: string; evidenceRefs: string[]; bytes?: number };
}

export interface BtsResidualContext {
  kind: 'bts_residual';
  sequence: 'same-page-post-exit';
  engineMode: 'gc' | 'rc' | 'unknown';
  vmId: string;
  instanceId: number;
  slotId: number;
  snapshots: { snapshotId: string; sha256: string; captureTsMs: number }[];
}

export interface BtsResidualAnalysis {
  id: string;
  vmId: string;
  instanceId: number;
  slotId: number;
  destroyTsMs?: number;
  snapshotIds: string[];
  latestSnapshotId?: string;
  residualBytes?: number;
  analyzerContext?: BtsResidualContext;
  contextPath?: string;
  knownNonLeakBytes?: number;
  tailComplete: boolean;
  status: ResidualStatus;
  findings: ResidualFinding[];
  gaps: string[];
  translations?: Record<string, MemoryText>;
  inputDigest?: string;
  analyzerVersion?: string;
  rulesVersion?: string;
  reportHtml?: string;
  reportPath?: string;
  evidencePath?: string;
  reportAnchor: string;
  leakBytes?: number;
  leakSizeBasis?: string;
}

export interface SharedBtsVmAnalysis {
  vmId: string;
  vmName: string;
  generation: number;
  instanceIds: number[];
  chartId: string;
  firstSampleTsMs: number;
  endTsMs: number;
  createdAfterTraceStart: boolean;
  destroyed: boolean;
  endRssBytes: number;
  endRssSampleTsMs?: number;
  notDestroyedIssue: boolean;
  gcAccumulateTrend: MemoryTrend;
}

export type MemoryPageClassification = 'pre-existing' | 'independent' | 'grouped' | 'overlapping';

export interface MemoryPageAnalysis {
  peakMemory?: PagePeakMemoryAnalysis;
  mtsPool?: PagePoolMemoryAnalysis;
  rollback?: PageMemoryRollbackAnalysis;
  residualAnalysisId?: string;
  memoryChart?: MemoryChart;
  componentChart?: MemoryChart;
  graphicMemoryChart?: MemoryChart;
  canvasResourceChart?: MemoryChart;
  trendCharts: MemoryChart[];
  trends: MemoryTrend[];
  notes: string[];
}

export interface MemoryPage {
  instanceId: number;
  url: string;
  processUpid?: number;
  memoryTrackId?: number;
  createTsMs?: number;
  realCreateTsMs: number;
  shellDestroyTsMs?: number;
  destroyTsMs?: number;
  btsCreateTsMs?: number;
  btsDestroyTsMs?: number;
  preExisting: boolean;
  destroyed: boolean;
  mtsVmType: string;
  btsVmId?: string;
  btsVmType: string;
  btsVmName: string;
  btsVmGeneration: number;
  btsVmPtr?: string;
  btsSlot?: number;
  sharedBts: boolean;
  btsDestroyed?: boolean;
  classification: MemoryPageClassification;
  groupId?: string;
  repeatedFocusIndex?: number;
  repeatedFocusTotal?: number;
  selected: boolean;
  analysis: MemoryPageAnalysis;
}

export interface MemoryVm {
  id: string;
  kind: 'mts' | 'bts';
  name: string;
  generation: number;
  ptr?: string;
  type: string;
  shared: boolean;
  instanceIds: number[];
  createTsMs: number;
  destroyTsMs?: number;
  memoryTrackId?: number;
  gcEvents: MemoryVmGcEvent[];
  destroyed: boolean;
  supportsMemory: boolean;
}

export interface MemoryVmGcEvent {
  sliceId: number;
  tsMs: number;
}

export interface MemorySnapshot {
  sliceId: number;
  vmId: string;
  snapshotId: string;
  index: number;
  captureTsMs: number;
  dumpDurationMs?: number;
  totalLength: number;
  chunkCount: number;
  vmType: string;
  memory: MemoryValue;
  assignedVmId?: string;
  kind:
    | 'mts_instance'
    | 'bts_vm'
    | 'bts_instance'
    | 'bts_residual'
    | 'bts_unknown'
    | 'bts_common'
    | 'bts_overflow'
    | 'unknown';
  instanceId?: number;
  slotId?: number;
  retainedBytes?: number;
  triggerRetainedBytes?: number;
  previousRetainedBytes?: number;
  postExitPageCount?: number;
  captureReason?: string;
  includeInternalAllocations?: boolean;
  changePercent?: number;
  integrity: 'pending' | 'complete' | 'incomplete' | 'metadata-only';
  identityError?: string;
  extractionError?: string;
  outputPath?: string;
  sha256?: string;
}

export interface MemoryAnalysisSummary {
  pageCount: number;
  analyzedPageCount: number;
  vmCount: number;
  snapshotCount: number;
  issueCount: number;
  selectedInstanceIds: number[];
  conclusion: string;
  confirmedLeakPageCount: number;
  suspectedPageCount: number;
  incompletePageCount: number;
}

export interface MemoryTraceInfo {
  startTsMs: number;
  endTsMs: number;
  memoryTraceEnabled: boolean;
  processUpids: number[];
}

export interface MemoryAnalysisResult {
  /** Source prerequisites and user decisions, persisted for offline finalization. */
  sourcePreparation?: SourcePreparation;
  /** Analyst conclusions and recommendations, separate from rule-based issues. */
  analystNotes?: MemoryText[];
  kryptonAnalyses?: { processUpid?: number; memoryChart: MemoryChart; countChart: MemoryChart }[];
  /** Portable source results, bound to snapshot SHA-256; raw source maps remain local. */
  frontendSources?: {
    digest: string;
    warnings: string[];
    projects?: (Pick<
      PreparedFrontend['projects'][number],
      'id' | 'origin' | 'commit' | 'artifactOrigin' | 'lynx' | 'abandoned'
    > & {
      root?: string;
    })[];
    artifacts?: (Omit<PreparedFrontend['artifacts'][number], 'sources'> & { sourceFileCount: number })[];
    snapshots: Record<string, { sha256: string; locations: SnapshotSourceLocations }>;
  };
  artifacts?: {
    trace: { file: string; sha256: string; size: number };
  };
  schemaVersion: 4;
  valid: boolean;
  error?: string;
  options: MemoryAnalysisOptions;
  trace: MemoryTraceInfo;
  pages: MemoryPage[];
  vms: MemoryVm[];
  snapshots: MemorySnapshot[];
  mtsPoolGrowthEvents: MtsPoolGrowthEvent[];
  sharedBtsSlotCharts: MemoryChart[];
  sharedBtsVmAnalyses: SharedBtsVmAnalysis[];
  residualAnalyses: BtsResidualAnalysis[];
  issues: MemoryIssue[];
  warnings: string[];
  summary: MemoryAnalysisSummary;
}

/** Report-only payload; raw heap strings must not be serialized into analysis.json. */
export interface MemoryReportSnapshotData {
  snapshots: (MemorySnapshot & {
    content?: string;
    contentError?: string;
    sourceLocations?: SnapshotSourceLocations;
  })[];
  vms: MemoryVm[];
}
