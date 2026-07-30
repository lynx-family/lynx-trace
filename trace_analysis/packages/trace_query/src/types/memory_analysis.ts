// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

export type MemoryConfidence = 'high' | 'medium' | 'low';

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
  loadedInstanceIds?: number[];
}

export interface MemoryChartSeries {
  name: string;
  unit: 'bytes' | 'count';
  renderMode?: 'line' | 'interval-bars';
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
}

export interface MemoryChart {
  id: string;
  title: string;
  xStartTsMs?: number;
  xEndTsMs?: number;
  zeroBaseline?: boolean;
  renderMode?: 'line' | 'interval-bars';
  events?: MemoryChartEvent[];
  series: MemoryChartSeries[];
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
  code: string;
  title: string;
  message: string;
  confidence: MemoryConfidence;
  instanceIds: number[];
  vmId?: string;
  valueBytes?: number;
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

export interface SharedBtsLeakEvent {
  id: string;
  vmId: string;
  instanceIds: number[];
  beginTsMs: number;
  gcTsMs: number;
  gcEndTsMs: number;
  accumulateDeltaBytes: number;
  rssDeltaBytes: number;
  confidence: MemoryConfidence;
  issue: boolean;
  preSnapshotId?: string;
  postSnapshotId?: string;
  analysable: boolean;
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
  notDestroyedIssue: boolean;
  gcAccumulateTrend: MemoryTrend;
}

export type MemoryPageClassification = 'pre-existing' | 'independent' | 'grouped' | 'overlapping';

export interface MemoryPageAnalysis {
  peakMemory?: PagePeakMemoryAnalysis;
  mtsPool?: PagePoolMemoryAnalysis;
  rollback?: PageMemoryRollbackAnalysis;
  sharedBtsLeaks: SharedBtsLeakEvent[];
  memoryChart?: MemoryChart;
  componentChart?: MemoryChart;
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
  destroyed: boolean;
  supportsMemory: boolean;
}

export interface MemorySnapshot {
  sliceId: number;
  vmId: string;
  snapshotId: string;
  index: number;
  willTsMs: number;
  captureTsMs: number;
  dumpDurationMs: number;
  totalLength: number;
  chunkCount: number;
  vmType: string;
  memory: MemoryValue;
  assignedVmId?: string;
}

export interface MemoryAnalysisSummary {
  pageCount: number;
  analyzedPageCount: number;
  vmCount: number;
  snapshotCount: number;
  issueCount: number;
  selectedInstanceIds: number[];
  conclusion: string;
}

export interface MemoryTraceInfo {
  startTsMs: number;
  endTsMs: number;
  memoryTraceEnabled: boolean;
  forceGc: boolean;
  processUpids: number[];
}

export interface MemoryAnalysisResult {
  schemaVersion: 2;
  valid: boolean;
  error?: string;
  options: MemoryAnalysisOptions;
  trace: MemoryTraceInfo;
  pages: MemoryPage[];
  vms: MemoryVm[];
  snapshots: MemorySnapshot[];
  sharedBtsHeapCharts: MemoryChart[];
  sharedBtsVmAnalyses: SharedBtsVmAnalysis[];
  sharedBtsLeakEvents: SharedBtsLeakEvent[];
  analysableLeakEvents: SharedBtsLeakEvent[];
  issues: MemoryIssue[];
  warnings: string[];
  summary: MemoryAnalysisSummary;
}
