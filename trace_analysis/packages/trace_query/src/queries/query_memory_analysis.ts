// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import {
  BtsResidualAnalysis,
  MemoryAnalysisOptions,
  MemoryAnalysisResult,
  MemoryChart,
  MemoryChartEvent,
  MemoryChartSeries,
  MemoryIssue,
  MemoryPage,
  MemorySeriesPoint,
  MemorySnapshot,
  MemoryTrend,
  MemoryValue,
  MemoryVm,
  MtsPoolGrowthEvent,
  MtsPoolMemoryDelta,
  SharedBtsVmAnalysis,
} from '../types/memory_analysis';
import { NS_TO_MS } from '../utils/constant';
import { TraceQuery } from '../utils/trace_query';
import {
  createPageGraphicCharts,
  GraphicComponent,
  parseGraphicComponent,
  queryKryptonCharts,
} from './graphics_memory';

const PAGE_CREATE_EARLY_MS = 200;
const GC_SETTLE_MS = 10;
const MAX_ATTENTION_MS = 5000;
const GROUP_WINDOW_MS = 2000;
const OVERLAP_PEAK_WINDOW_MS = 3000;
const HIGH_MEMORY_BYTES = 150 * 1024 * 1024;
const PAGE_ROLLBACK_BYTES = 2 * 1024 * 1024;
const MTS_POOL_GROWTH_BYTES = 3 * 1024 * 1024;
const SUPPORTED_MEMORY_VMS = new Set(['quickjs(gc)', 'quickjs(rc)']);

const URL_EVENT_NAMES = [
  'LynxView::loadTemplateBundle',
  'LynxTemplateRender::loadTemplateBundle',
  'LynxDevtool::onLoadFromBundle',
  'LynxEngine::LoadTemplateBundle',
  'LynxLoadTemplate',
  'TemplateAssembler::OnJSPrepared',
  'NativeFacadeDarwin::OnTemplateLoaded',
  'LynxViewLifecycle::didLoadFinishedWithUrl',
];

interface RawMemorySample {
  id: number;
  tsMs: number;
  totalBytes: number;
  mts?: MemoryValue;
  uiCounts: Record<string, number>;
  graphics: GraphicComponent[];
}

interface RawBtsMemorySample {
  id: number;
  tsMs: number;
  ptr: string;
  memory: MemoryValue;
  slots: Record<number, number>;
}

interface RawBtsMemoryTrack {
  id: number;
  name: string;
  ptr: string;
  firstTsMs: number;
  lastTsMs: number;
  samples: RawBtsMemorySample[];
}

interface RawTrack {
  id: number;
  upid?: number;
  instanceId: number;
  url: string;
}

interface RawEvent {
  id: number;
  name: string;
  tsMs: number;
  endTsMs: number;
  instanceId?: number;
  url: string;
  desc: string;
  groupId: string;
  ptr: string;
  slot?: number;
  snapshotId: string;
  snapshotVmId: string;
  totalLength: number;
  chunkCount: number;
  retainedBytes?: number;
  triggerRetainedBytes?: number;
  previousRetainedBytes?: number;
  postExitPageCount?: number;
  captureReason: string;
  includeInternalAllocations?: boolean;
  changePercent?: number;
}

interface RawPoolState {
  id: number;
  name: 'bts_vm_pool_state' | 'mts_vm_pool_state';
  tsMs: number;
  poolInstanceId: string;
  url: string;
  isGlobalPool?: boolean;
  destroyed: boolean;
  instanceCount: number;
  memory: MemoryValue;
}

interface MtsPoolMemorySnapshot {
  url: string;
  instanceCount: number;
  memory: MemoryValue;
}

interface PssTrack {
  upid?: number;
  points: MemorySeriesPoint[];
}

interface MemoryDataContext {
  traceStartMs: number;
  traceEndMs: number;
  memoryTraceEnabled: boolean;
  events: RawEvent[];
  tracks: Map<number, RawTrack>;
  samples: Map<number, RawMemorySample[]>;
  btsMemoryTracks: Map<number, RawBtsMemoryTrack>;
  pages: MemoryPage[];
  vms: MemoryVm[];
  snapshots: MemorySnapshot[];
  gcEvents: RawEvent[];
  pssTracks: PssTrack[];
  poolStates: RawPoolState[];
  warnings: string[];
}

export interface VMMemoryQuery {
  tsMs: number;
  kind: 'mts' | 'bts';
  instanceId?: number;
  vmName?: string;
  generation?: number;
}

export interface VMMemoryReading extends MemoryValue {
  available: boolean;
  sampleId?: number;
  sampleTsMs?: number;
  reason?: string;
}

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : fallback;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toOptionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') {
    return undefined;
  }
  const parsed = toNumber(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toString(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
}

function normalizeVmEngineDesc(desc: string): string {
  if (!desc.trimStart().startsWith('{')) {
    return desc;
  }
  try {
    const parsed = JSON.parse(desc) as Record<string, unknown>;
    return typeof parsed['vm_type'] === 'string' ? parsed['vm_type'] : desc;
  } catch {
    return desc;
  }
}

function supportsMemory(vmType: string): boolean {
  return SUPPORTED_MEMORY_VMS.has(vmType.toLowerCase());
}

function parseBtsSlotId(key: string): number | undefined {
  const match = /^(?:debug\.)?slot_(\d+)$/.exec(key);
  if (!match?.[1]) {
    return undefined;
  }
  const slotId = Number(match[1]);
  return Number.isSafeInteger(slotId) && slotId >= 0 && slotId <= 255 ? slotId : undefined;
}

function isBtsPageSlot(slotId: number | undefined): slotId is number {
  return slotId !== undefined && Number.isInteger(slotId) && slotId >= 3 && slotId <= 255;
}

function lastAt<T extends { tsMs: number }>(items: T[], tsMs: number): T | undefined {
  let low = 0;
  let high = items.length - 1;
  let result: T | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const item = items[middle];
    if (!item) {
      break;
    }
    if (item.tsMs <= tsMs) {
      result = item;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return result;
}

function valueAt(points: MemorySeriesPoint[], tsMs: number): number | undefined {
  return lastAt(points, tsMs)?.value;
}

function valuesInRange(points: MemorySeriesPoint[], startTsMs: number, endTsMs: number): MemorySeriesPoint[] {
  return points.filter((point) => point.tsMs >= startTsMs && point.tsMs <= endTsMs);
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const current = sorted[middle] ?? 0;
  if (sorted.length % 2 === 1) {
    return current;
  }
  return ((sorted[middle - 1] ?? current) + current) / 2;
}

function movingMedian(values: number[], radius = 2): number[] {
  return values.map((_, index) => median(values.slice(Math.max(0, index - radius), index + radius + 1)));
}

function theilSenSlope(points: MemorySeriesPoint[]): number {
  if (points.length < 2) {
    return 0;
  }
  const step = Math.max(1, Math.ceil(points.length / 80));
  const sampled = points.filter((_, index) => index % step === 0 || index === points.length - 1);
  const slopes: number[] = [];
  for (let i = 0; i < sampled.length; i += 1) {
    const left = sampled[i];
    if (!left) {
      continue;
    }
    for (let j = i + 1; j < sampled.length; j += 1) {
      const right = sampled[j];
      if (!right || right.tsMs === left.tsMs) {
        continue;
      }
      slopes.push(((right.value - left.value) * 1000) / (right.tsMs - left.tsMs));
    }
  }
  return median(slopes);
}

function analyzeTrend(series: MemoryChartSeries, minimumSamples = 10): MemoryTrend {
  const samples = series.points;
  if (samples.length < minimumSamples) {
    return {
      seriesName: series.name,
      unit: series.unit,
      rising: false,
      slopePerSecond: 0,
      delta: 0,
      noiseThreshold: 0,
      sampleCount: samples.length,
      reason: `样本少于 ${minimumSamples} 个，无法可靠判断趋势。`,
    };
  }

  const sparseSamples = minimumSamples < 10 && samples.length < 10;
  const smoothedValues = sparseSamples
    ? samples.map((point) => point.value)
    : movingMedian(samples.map((point) => point.value));
  const smoothed = samples.map((point, index) => ({ ...point, value: smoothedValues[index] ?? point.value }));
  const windowSize = sparseSamples
    ? Math.max(1, Math.floor(smoothed.length * 0.2))
    : Math.max(3, Math.floor(smoothed.length * 0.2));
  const startLevel = median(smoothed.slice(0, windowSize).map((point) => point.value));
  const endLevel = median(smoothed.slice(-windowSize).map((point) => point.value));
  const delta = endLevel - startLevel;
  const differences = smoothed.slice(1).map((point, index) => point.value - (smoothed[index]?.value ?? point.value));
  const differenceMedian = median(differences);
  const mad = median(differences.map((value) => Math.abs(value - differenceMedian)));
  const unitFloor = series.unit === 'bytes' ? 64 * 1024 : 1;
  const noiseThreshold = Math.max(unitFloor, Math.abs(startLevel) * 0.01, 3 * mad);
  const slopePerSecond = theilSenSlope(smoothed);
  const bucketSize = Math.max(1, Math.floor(smoothed.length / 5));
  const bucketMedians: number[] = [];
  for (let index = 0; index < smoothed.length; index += bucketSize) {
    bucketMedians.push(median(smoothed.slice(index, index + bucketSize).map((point) => point.value)));
  }
  const nonDecreasingBuckets = bucketMedians
    .slice(1)
    .filter((value, index) => value >= (bucketMedians[index] ?? value)).length;
  const requiredBuckets = Math.max(1, Math.ceil((bucketMedians.length - 1) * 0.6));
  const rising = slopePerSecond > 0 && delta > noiseThreshold && nonDecreasingBuckets >= requiredBuckets;

  return {
    seriesName: series.name,
    unit: series.unit,
    rising,
    slopePerSecond,
    delta,
    noiseThreshold,
    sampleCount: samples.length,
    reason: rising
      ? sparseSamples
        ? 'VM_GC 后内存水位整体上移，稳健斜率为正，且首尾差异超过噪声阈值。'
        : '平滑后的基线持续上移，稳健斜率为正，且首尾差异超过噪声阈值。'
      : sparseSamples
        ? '未同时满足 VM_GC 后内存水位整体上移、正斜率和显著首尾差异。'
        : '未同时满足基线持续上移、正斜率和显著首尾差异。',
  };
}

async function queryTraceBounds(traceQuery: TraceQuery): Promise<{ startMs: number; endMs: number }> {
  const rows = await traceQuery.query('SELECT start_ts, end_ts FROM trace_bounds');
  const row = rows[0];
  return {
    startMs: toNumber(row?.['start_ts']) / NS_TO_MS,
    endMs: toNumber(row?.['end_ts']) / NS_TO_MS,
  };
}

async function queryEvents(traceQuery: TraceQuery): Promise<RawEvent[]> {
  const eventNames = [
    'TRACE_BEGIN',
    'LynxShell::Create',
    'LynxShell::~LynxShell',
    'page_uses_mts_vm',
    'page_uses_bts_vm',
    'BTSRuntime::Destroy',
    'destroy_vm_instance',
    'VM_GC',
    'RunGC',
    'capture_snapshot',
    ...URL_EVENT_NAMES,
  ];
  const quotedNames = eventNames.map((name) => `'${name}'`).join(',');
  const rows = await traceQuery.query(`
    SELECT
      s.id,
      s.name,
      s.ts,
      s.dur,
      MAX(CASE WHEN a.flat_key IN ('debug.instance_id', 'args.instance_id') THEN a.display_value END) instance_id,
      MAX(CASE WHEN a.flat_key IN ('debug.url', 'args.url') THEN a.display_value END) url,
      MAX(
        CASE
          WHEN a.flat_key IN ('debug.desc', 'args.desc', 'desc')
          THEN COALESCE(a.string_value, a.display_value)
        END
      ) desc,
      MAX(CASE WHEN a.flat_key IN ('debug.group_id', 'args.group_id', 'group_id') THEN a.display_value END) group_id,
      MAX(CASE WHEN a.flat_key IN ('debug.ptr', 'args.ptr', 'ptr') THEN a.display_value END) ptr,
      MAX(CASE WHEN a.flat_key IN ('debug.slot', 'args.slot') THEN a.display_value END) slot,
      MAX(CASE WHEN a.flat_key = 'debug.snapshot_id' THEN a.display_value END) snapshot_id,
      MAX(CASE WHEN a.flat_key = 'debug.id' THEN a.display_value END) snapshot_vm_id,
      MAX(CASE WHEN a.flat_key = 'debug.total_length' THEN a.display_value END) total_length,
      MAX(CASE WHEN a.flat_key = 'debug.chunk_count' THEN a.display_value END) chunk_count,
      MAX(CASE WHEN a.flat_key = 'debug.retained_bytes' THEN a.display_value END) retained_bytes,
      MAX(CASE WHEN a.flat_key = 'debug.trigger_retained_bytes' THEN a.display_value END) trigger_retained_bytes,
      MAX(CASE WHEN a.flat_key = 'debug.previous_retained_bytes' THEN a.display_value END) previous_retained_bytes,
      MAX(CASE WHEN a.flat_key = 'debug.post_exit_page_count' THEN a.display_value END) post_exit_page_count,
      MAX(CASE WHEN a.flat_key = 'debug.capture_reason' THEN a.display_value END) capture_reason,
      MAX(CASE WHEN a.flat_key = 'debug.include_internal_allocations' THEN a.display_value END) include_internal_allocations,
      MAX(CASE WHEN a.flat_key = 'debug.change_percent' THEN a.display_value END) change_percent
    FROM slice s
    LEFT JOIN args a ON a.arg_set_id = s.arg_set_id
    WHERE s.name IN (${quotedNames})
      AND NOT (s.name IN ('LynxShell::~LynxShell', 'BTSRuntime::Destroy', 'VM_GC', 'RunGC') AND s.dur < 0)
    GROUP BY s.id
    ORDER BY s.ts
  `);
  return rows.map((row) => {
    const tsMs = toNumber(row['ts']) / NS_TO_MS;
    const durationMs = Math.max(0, toNumber(row['dur'])) / NS_TO_MS;
    return {
      id: toNumber(row['id']),
      name: toString(row['name']),
      tsMs,
      endTsMs: tsMs + durationMs,
      instanceId: toOptionalNumber(row['instance_id']),
      url: toString(row['url']),
      desc: toString(row['desc']),
      groupId: toString(row['group_id']),
      ptr: toString(row['ptr']),
      slot: toOptionalNumber(row['slot']),
      snapshotId: toString(row['snapshot_id']),
      snapshotVmId: toString(row['snapshot_vm_id']),
      totalLength: toNumber(row['total_length']),
      chunkCount: toNumber(row['chunk_count']),
      retainedBytes: toOptionalNumber(row['retained_bytes']),
      triggerRetainedBytes: toOptionalNumber(row['trigger_retained_bytes']),
      previousRetainedBytes: toOptionalNumber(row['previous_retained_bytes']),
      postExitPageCount: toOptionalNumber(row['post_exit_page_count']),
      captureReason: toString(row['capture_reason']),
      includeInternalAllocations:
        row['include_internal_allocations'] === null || row['include_internal_allocations'] === undefined
          ? undefined
          : ['1', 'true'].includes(toString(row['include_internal_allocations']).toLowerCase()),
      changePercent: toOptionalNumber(row['change_percent']),
    };
  });
}

async function queryTrackAndSampleData(
  traceQuery: TraceQuery,
): Promise<{ tracks: Map<number, RawTrack>; samples: Map<number, RawMemorySample[]> }> {
  const trackRows = await traceQuery.query(`
    SELECT ct.id, ct.name, pct.upid
    FROM counter_track ct
    LEFT JOIN process_counter_track pct ON pct.id = ct.id
    WHERE ct.name GLOB 'memory_[0-9]*'
    ORDER BY ct.id
  `);
  const tracks = new Map<number, RawTrack>();
  for (const row of trackRows) {
    const name = toString(row['name']);
    const match = /^memory_(\d+)$/.exec(name);
    if (!match?.[1]) {
      continue;
    }
    const id = toNumber(row['id']);
    tracks.set(id, {
      id,
      upid: toOptionalNumber(row['upid']),
      instanceId: Number(match[1]),
      url: '',
    });
  }

  if (tracks.size === 0) {
    return { tracks, samples: new Map() };
  }

  const trackIds = [...tracks.keys()].join(',');
  const sampleRows = await traceQuery.query(`
    SELECT c.id, c.track_id, c.ts, c.value
    FROM counter c
    WHERE c.track_id IN (${trackIds})
    ORDER BY c.track_id, c.ts
  `);
  const sampleById = new Map<number, RawMemorySample>();
  const samples = new Map<number, RawMemorySample[]>();
  for (const row of sampleRows) {
    const trackId = toNumber(row['track_id']);
    const track = tracks.get(trackId);
    if (!track) {
      continue;
    }
    const sample: RawMemorySample = {
      id: toNumber(row['id']),
      tsMs: toNumber(row['ts']) / NS_TO_MS,
      totalBytes: toNumber(row['value']),
      uiCounts: {},
      graphics: [],
    };
    sampleById.set(sample.id, sample);
    const current = samples.get(track.instanceId) ?? [];
    current.push(sample);
    samples.set(track.instanceId, current);
  }

  const detailRows = await traceQuery.query(`
    SELECT
      c.id counter_id,
      a.flat_key,
      a.string_value component_json,
      json_extract(a.string_value, '$.category') category,
      json_extract(a.string_value, '$.sizeBytes') size_bytes,
      json_extract(a.string_value, '$.instanceCount') instance_count,
      json_extract(a.string_value, '$.detail.base_usage') base_bytes,
      json_extract(a.string_value, '$.detail.page_rss_usage') page_rss_bytes
    FROM counter c
    JOIN args a ON a.arg_set_id = c.arg_set_id
    WHERE c.track_id IN (${trackIds})
      AND a.string_value IS NOT NULL
      AND json_valid(a.string_value)
      AND (json_extract(a.string_value, '$.category') IS NOT NULL
        OR lower(a.flat_key) LIKE '%canvas%' OR lower(a.flat_key) LIKE '%animax%')
    ORDER BY c.id
  `);
  for (const row of detailRows) {
    const sample = sampleById.get(toNumber(row['counter_id']));
    if (!sample) {
      continue;
    }
    const graphic = parseGraphicComponent(toString(row['component_json']), toString(row['flat_key']));
    if (graphic) sample.graphics.push(graphic);
    const category = graphic?.category ?? toString(row['category']);
    const memory: MemoryValue = {
      accumulateBytes: toNumber(row['size_bytes']),
      rssBytes: toNumber(row['base_bytes']) + toNumber(row['page_rss_bytes']),
    };
    if (category === 'mainThreadScriptingEngine') {
      sample.mts = memory;
    } else if (category !== 'backgroundThreadScriptingEngine' && category !== 'lynxTasmElement') {
      sample.uiCounts[category] = toNumber(row['instance_count']);
    }
  }

  const urlRows = await traceQuery.query(`
    SELECT c.track_id, a.display_value url
    FROM counter c
    JOIN args a ON a.arg_set_id = c.arg_set_id AND a.flat_key = 'debug.url'
    WHERE c.track_id IN (${trackIds})
    ORDER BY c.ts
  `);
  for (const row of urlRows) {
    const track = tracks.get(toNumber(row['track_id']));
    if (track && !track.url) {
      track.url = toString(row['url']);
    }
  }
  return { tracks, samples };
}

async function queryBtsMemoryTracks(traceQuery: TraceQuery): Promise<Map<number, RawBtsMemoryTrack>> {
  const rows = await traceQuery.query(`
    SELECT
      c.id,
      c.track_id,
      ct.name,
      c.ts,
      c.value,
      MAX(CASE WHEN a.flat_key IN ('ptr', 'debug.ptr') THEN a.display_value END) ptr,
      MAX(CASE WHEN a.flat_key IN ('base_usage', 'debug.base_usage') THEN a.display_value END) base_usage,
      MAX(
        CASE
          WHEN a.flat_key IN ('page_rss_usage', 'debug.page_rss_usage') THEN a.display_value
        END
      ) page_rss_usage
    FROM counter_track ct
    JOIN counter c ON c.track_id = ct.id
    LEFT JOIN args a ON a.arg_set_id = c.arg_set_id
    WHERE ct.name GLOB 'bts_vm_acc_*'
    GROUP BY c.id
    ORDER BY c.track_id, c.ts
  `);
  const tracks = new Map<number, RawBtsMemoryTrack>();
  const samplesById = new Map<number, RawBtsMemorySample>();
  for (const row of rows) {
    const trackId = toNumber(row['track_id']);
    const tsMs = toNumber(row['ts']) / NS_TO_MS;
    const ptr = toString(row['ptr']);
    const sample: RawBtsMemorySample = {
      id: toNumber(row['id']),
      tsMs,
      ptr,
      memory: {
        accumulateBytes: toNumber(row['value']),
        rssBytes: toNumber(row['base_usage']) + toNumber(row['page_rss_usage']),
      },
      slots: {},
    };
    samplesById.set(sample.id, sample);
    const current = tracks.get(trackId) ?? {
      id: trackId,
      name: toString(row['name']),
      ptr,
      firstTsMs: tsMs,
      lastTsMs: tsMs,
      samples: [],
    };
    current.ptr ||= ptr;
    current.firstTsMs = Math.min(current.firstTsMs, tsMs);
    current.lastTsMs = Math.max(current.lastTsMs, tsMs);
    current.samples.push(sample);
    tracks.set(trackId, current);
  }
  const slotRows = await traceQuery.query(`
    SELECT c.id counter_id, a.flat_key, a.display_value
    FROM counter_track ct
    JOIN counter c ON c.track_id = ct.id
    JOIN args a ON a.arg_set_id = c.arg_set_id
    WHERE ct.name GLOB 'bts_vm_acc_*'
      AND (
        a.flat_key GLOB 'debug.slot_[0-9]*'
        OR a.flat_key GLOB 'slot_[0-9]*'
      )
    ORDER BY c.id, a.flat_key
  `);
  for (const row of slotRows) {
    const sample = samplesById.get(toNumber(row['counter_id']));
    const slotId = parseBtsSlotId(toString(row['flat_key']));
    const value = toNumber(row['display_value'], Number.NaN);
    if (sample && slotId !== undefined && Number.isFinite(value)) {
      sample.slots[slotId] = Math.max(0, value);
    }
  }
  return tracks;
}

async function queryPssTracks(traceQuery: TraceQuery): Promise<PssTrack[]> {
  const rows = await traceQuery.query(`
    SELECT pct.upid, c.ts, c.value
    FROM counter_track ct
    LEFT JOIN process_counter_track pct ON pct.id = ct.id
    JOIN counter c ON c.track_id = ct.id
    WHERE ct.name = 'summary.total-pss'
    ORDER BY pct.upid, c.ts
  `);
  const byUpid = new Map<string, PssTrack>();
  for (const row of rows) {
    const upid = toOptionalNumber(row['upid']);
    const key = upid === undefined ? 'unknown' : String(upid);
    const current = byUpid.get(key) ?? { upid, points: [] };
    current.points.push({
      tsMs: toNumber(row['ts']) / NS_TO_MS,
      value: toNumber(row['value']),
    });
    byUpid.set(key, current);
  }
  return [...byUpid.values()];
}

async function queryPoolStates(traceQuery: TraceQuery): Promise<RawPoolState[]> {
  const rows = await traceQuery.query(`
    SELECT s.id, s.name, s.ts, a.flat_key, a.string_value, a.display_value
    FROM slice s
    LEFT JOIN args a ON a.arg_set_id = s.arg_set_id
    WHERE s.name IN ('bts_vm_pool_state', 'mts_vm_pool_state')
    ORDER BY s.ts, s.id
  `);
  const grouped = new Map<number, Record<string, string>>();
  const metadata = new Map<number, { id: number; name: RawPoolState['name']; tsMs: number }>();
  for (const row of rows) {
    const id = toNumber(row['id']);
    const args = grouped.get(id) ?? {};
    args[toString(row['flat_key'])] = toString(row['string_value'] ?? row['display_value']);
    grouped.set(id, args);
    metadata.set(id, {
      id,
      name: toString(row['name']) as RawPoolState['name'],
      tsMs: toNumber(row['ts']) / NS_TO_MS,
    });
  }

  const states: RawPoolState[] = [];
  for (const [id, args] of grouped) {
    const event = metadata.get(id);
    if (!event) {
      continue;
    }
    let accumulateBytes = 0;
    let rssBytes = 0;
    let instanceCount = 0;
    for (const [key, value] of Object.entries(args)) {
      if (!key.startsWith('debug.id_')) {
        continue;
      }
      try {
        const memory = JSON.parse(value) as Record<string, unknown>;
        instanceCount += 1;
        accumulateBytes += toNumber(memory['acc_usage']);
        rssBytes += toNumber(memory['base_usage']) + toNumber(memory['page_rss_usage']);
      } catch {
        // Ignore malformed pool entries and retain the remaining valid entries.
      }
    }
    const isGlobalPoolArg = args['debug.is_global_pool'];
    const isGlobalPool = isGlobalPoolArg === '1' ? true : isGlobalPoolArg === '0' ? false : undefined;
    const url =
      event.name === 'mts_vm_pool_state'
        ? isGlobalPool
          ? 'global_pool'
          : args['debug.url']?.trim() || 'Unknown URL'
        : '';
    states.push({
      ...event,
      poolInstanceId: args['debug.pool_instance_id'] ?? 'bts',
      url,
      isGlobalPool,
      destroyed: args['debug.destroyed'] === '1',
      instanceCount,
      memory: { accumulateBytes, rssBytes },
    });
  }
  return states;
}

function buildPages(
  events: RawEvent[],
  tracks: Map<number, RawTrack>,
  samples: Map<number, RawMemorySample[]>,
  traceStartMs: number,
  traceEndMs: number,
  options: MemoryAnalysisOptions,
): MemoryPage[] {
  const instanceIds = new Set<number>();
  for (const track of tracks.values()) {
    instanceIds.add(track.instanceId);
  }
  for (const event of events) {
    if (event.instanceId !== undefined) {
      instanceIds.add(event.instanceId);
    }
  }

  const pages: MemoryPage[] = [];
  for (const instanceId of [...instanceIds].sort((a, b) => a - b)) {
    const pageEvents = events.filter((event) => event.instanceId === instanceId);
    const createEvent = pageEvents.find((event) => event.name === 'LynxShell::Create');
    const destroyEvent = pageEvents.find((event) => event.name === 'LynxShell::~LynxShell');
    const btsCreateEvent = pageEvents.find((event) => event.name === 'page_uses_bts_vm');
    const btsDestroyEvent = pageEvents.find((event) => event.name === 'BTSRuntime::Destroy');
    const track = [...tracks.values()].find((item) => item.instanceId === instanceId);
    const pageSamples = samples.get(instanceId) ?? [];
    const url =
      createEvent?.url ||
      pageEvents.find((event) => URL_EVENT_NAMES.includes(event.name) && event.url)?.url ||
      pageEvents.find((event) => event.url)?.url ||
      track?.url ||
      '';
    const createTsMs = createEvent?.tsMs;
    const shellDestroyTsMs = destroyEvent?.endTsMs;
    const destroyTsMs = shellDestroyTsMs;
    const preExisting = createTsMs === undefined && pageSamples.some((sample) => sample.totalBytes > 0);
    const selectedByInstance = options.instanceId === undefined || options.instanceId === instanceId;
    const selectedByUrl = options.url === undefined || url.toLowerCase().includes(options.url.toLowerCase());
    const hasExplicitFilter = options.instanceId !== undefined || options.url !== undefined;
    const selected = hasExplicitFilter ? selectedByInstance && selectedByUrl : !preExisting;
    pages.push({
      instanceId,
      url,
      processUpid: track?.upid,
      memoryTrackId: track?.id,
      createTsMs,
      realCreateTsMs:
        createTsMs === undefined ? traceStartMs : Math.max(traceStartMs, createTsMs - PAGE_CREATE_EARLY_MS),
      shellDestroyTsMs,
      destroyTsMs,
      btsCreateTsMs: btsCreateEvent?.tsMs,
      btsDestroyTsMs: btsDestroyEvent?.endTsMs,
      preExisting,
      destroyed: destroyTsMs !== undefined && destroyTsMs <= traceEndMs,
      mtsVmType: '',
      btsVmType: '',
      btsVmName: '',
      btsVmGeneration: 0,
      btsSlot: btsCreateEvent?.slot,
      sharedBts: false,
      classification: preExisting ? 'pre-existing' : 'overlapping',
      selected,
      analysis: {
        trendCharts: [],
        trends: [],
        notes: [],
      },
    });
  }
  return pages;
}

function buildVms(events: RawEvent[], pages: MemoryPage[], traceStartMs: number): MemoryVm[] {
  const vms: MemoryVm[] = [];
  const pagesById = new Map(pages.map((page) => [page.instanceId, page]));
  for (const event of events.filter((item) => item.name === 'page_uses_mts_vm')) {
    if (event.instanceId === undefined) {
      continue;
    }
    const page = pagesById.get(event.instanceId);
    if (!page) {
      continue;
    }
    const type = normalizeVmEngineDesc(event.desc);
    page.mtsVmType = type;
    vms.push({
      id: `mts_${event.instanceId}`,
      kind: 'mts',
      name: `instance_${event.instanceId}`,
      generation: 0,
      type,
      shared: false,
      instanceIds: [event.instanceId],
      createTsMs: event.tsMs,
      destroyTsMs: page.destroyTsMs,
      gcEvents: [],
      destroyed: page.destroyed,
      supportsMemory: supportsMemory(type),
    });
  }

  const activeByPtr = new Map<string, MemoryVm>();
  const activeByName = new Map<string, MemoryVm>();
  const nextGeneration = new Map<string, number>();
  const btsEvents = events
    .filter(
      (event) => event.name === 'page_uses_bts_vm' || event.name === 'destroy_vm_instance' || event.name === 'VM_GC',
    )
    .sort((a, b) => {
      const leftTsMs = a.name === 'VM_GC' ? a.endTsMs : a.tsMs;
      const rightTsMs = b.name === 'VM_GC' ? b.endTsMs : b.tsMs;
      return leftTsMs - rightTsMs || a.id - b.id;
    });
  for (const event of btsEvents) {
    if (event.name === 'VM_GC') {
      const active = activeByPtr.get(event.ptr);
      if (active) {
        active.gcEvents.push({ sliceId: event.id, tsMs: event.endTsMs });
      }
      continue;
    }
    if (event.name === 'destroy_vm_instance') {
      const active = activeByPtr.get(event.ptr);
      if (!active) {
        continue;
      }
      active.destroyTsMs = event.tsMs;
      active.destroyed = true;
      nextGeneration.set(active.name, active.generation + 1);
      for (const [ptr, candidate] of activeByPtr) {
        if (candidate === active) {
          activeByPtr.delete(ptr);
        }
      }
      activeByName.delete(active.name);
      continue;
    }
    if (event.instanceId === undefined) {
      continue;
    }
    const page = pagesById.get(event.instanceId);
    if (!page) {
      continue;
    }
    const shared = event.groupId !== '-1';
    const name = shared ? event.groupId : `standalone_${event.instanceId}`;
    let vm = activeByPtr.get(event.ptr) ?? activeByName.get(name);
    if (!vm) {
      const generation = nextGeneration.get(name) ?? 0;
      const createdVm: MemoryVm = {
        id: `bts_${name}_${generation}`,
        kind: 'bts',
        name,
        generation,
        ptr: event.ptr,
        type: normalizeVmEngineDesc(event.desc),
        shared,
        instanceIds: [],
        createTsMs: event.tsMs,
        gcEvents: [],
        destroyed: false,
        supportsMemory: supportsMemory(normalizeVmEngineDesc(event.desc)),
      };
      vm = createdVm;
      vms.push(createdVm);
      activeByName.set(name, createdVm);
    }
    activeByPtr.set(event.ptr, vm);
    if (!vm.instanceIds.includes(event.instanceId)) {
      vm.instanceIds.push(event.instanceId);
    }
    page.btsVmId = vm.id;
    page.btsVmType = vm.type;
    page.btsVmName = vm.name;
    page.btsVmGeneration = vm.generation;
    page.btsVmPtr = vm.ptr;
    page.btsSlot ??= event.slot;
    page.sharedBts = vm.shared;
    page.btsDestroyed = vm.destroyed;
  }

  for (const vm of vms.filter((item) => item.kind === 'bts')) {
    for (const instanceId of vm.instanceIds) {
      const page = pagesById.get(instanceId);
      if (page) {
        page.btsDestroyed = vm.destroyed;
      }
    }
  }
  for (const page of pages) {
    if (!page.mtsVmType && page.preExisting) {
      const mtsEvent = events.find(
        (event) => event.name === 'page_uses_mts_vm' && event.instanceId === page.instanceId,
      );
      page.mtsVmType = normalizeVmEngineDesc(mtsEvent?.desc ?? '');
    }
  }
  return vms.map((vm) => ({ ...vm, createTsMs: Math.max(traceStartMs, vm.createTsMs) }));
}

function assignBtsMemoryTracks(vms: MemoryVm[], tracks: Map<number, RawBtsMemoryTrack>, traceEndMs: number): string[] {
  const warnings: string[] = [];
  for (const vm of vms.filter((item) => item.kind === 'bts' && item.supportsMemory)) {
    const vmEndTsMs = vm.destroyTsMs ?? traceEndMs;
    const candidates = [...tracks.values()].filter(
      (track) => track.ptr === vm.ptr && track.lastTsMs >= vm.createTsMs && track.firstTsMs <= vmEndTsMs,
    );
    if (candidates.length === 1) {
      vm.memoryTrackId = candidates[0]?.id;
      continue;
    }
    vm.supportsMemory = false;
    const reason =
      candidates.length === 0 ? '没有匹配的 bts_vm_acc_* 轨道' : `匹配到 ${candidates.length} 条 bts_vm_acc_* 轨道`;
    warnings.push(`BTS VM ${vm.id} ${reason}，已停用该 VM 的内存分析。`);
  }
  return warnings;
}

function buildSnapshots(
  events: RawEvent[],
  vms: MemoryVm[],
  pages: MemoryPage[],
  tracks: Map<number, RawBtsMemoryTrack>,
): MemorySnapshot[] {
  const snapshots: MemorySnapshot[] = [];
  for (const capture of events.filter((event) => event.name === 'capture_snapshot' && event.snapshotId)) {
    let memory: MemoryValue = { accumulateBytes: 0, rssBytes: 0 };
    let vmType = '';
    if (capture.desc.trimStart().startsWith('{')) {
      try {
        const desc = JSON.parse(capture.desc) as Record<string, unknown>;
        vmType = toString(desc['vm_type']);
        memory = {
          accumulateBytes: toNumber(desc['acc_usage']),
          rssBytes: toNumber(desc['base_usage']) + toNumber(desc['page_rss_usage']),
        };
      } catch {
        vmType = normalizeVmEngineDesc(capture.desc);
      }
    }
    const label = capture.snapshotVmId;
    const match =
      /^(mts_instance|bts_vm|bts_instance|bts_residual|bts_unknown|bts_common|bts_overflow)\/([^/]+)(?:\/slot_(\d+))?$/.exec(
        label,
      );
    const kind = (match?.[1] ?? 'unknown') as MemorySnapshot['kind'];
    const pageScope = ['mts_instance', 'bts_instance', 'bts_residual'].includes(kind);
    const instanceId = pageScope ? toOptionalNumber(match?.[2]) : undefined;
    const specialSlot = ({ bts_unknown: 0, bts_common: 1, bts_overflow: 2 } as Record<string, number>)[kind];
    const slotId = toOptionalNumber(match?.[3]) ?? specialSlot ?? capture.slot;
    const page = pages.find((item) => item.instanceId === instanceId);
    const candidates = vms.filter((vm) => {
      if (vm.createTsMs > capture.tsMs || (vm.destroyTsMs !== undefined && capture.tsMs > vm.destroyTsMs)) return false;
      if (!pageScope)
        return (
          kind !== 'unknown' &&
          vm.kind === 'bts' &&
          tracks.get(vm.memoryTrackId ?? -1)?.name === `bts_vm_acc_${match?.[2]}`
        );
      if (kind === 'mts_instance') return vm.kind === 'mts' && vm.instanceIds.includes(instanceId ?? -1);
      return kind !== 'unknown' && vm.id === page?.btsVmId;
    });
    const errors: string[] = [];
    if (candidates.length !== 1) errors.push('快照不能唯一绑定 VM generation。');
    if (capture.instanceId !== undefined && capture.instanceId !== instanceId)
      errors.push('instance_id 与范围 ID 冲突。');
    if (capture.slot !== undefined && capture.slot !== slotId) errors.push('slot 与范围 ID 冲突。');
    if ((kind === 'bts_instance' || kind === 'bts_residual') && (page?.btsSlot !== slotId || !isBtsPageSlot(slotId))) {
      errors.push('页面专用 slot 归属不明确。');
    }
    if (kind === 'bts_residual' && page?.btsDestroyTsMs !== undefined && capture.tsMs < page.btsDestroyTsMs) {
      errors.push('residual 采集早于 BTS 页面销毁。');
    }
    if (kind === 'bts_residual' && (capture.retainedBytes === undefined || capture.retainedBytes < 0)) {
      errors.push('residual 缺少有效的 retained_bytes。');
    }
    snapshots.push({
      sliceId: capture.id,
      vmId: label,
      snapshotId: capture.snapshotId,
      index: 0,
      captureTsMs: capture.tsMs,
      dumpDurationMs: capture.endTsMs > capture.tsMs ? capture.endTsMs - capture.tsMs : undefined,
      totalLength: capture.totalLength,
      chunkCount: capture.chunkCount,
      vmType,
      memory,
      assignedVmId: errors.length === 0 ? candidates[0]?.id : undefined,
      kind,
      instanceId,
      slotId,
      retainedBytes: capture.retainedBytes,
      triggerRetainedBytes: capture.triggerRetainedBytes,
      previousRetainedBytes: capture.previousRetainedBytes,
      postExitPageCount: capture.postExitPageCount,
      captureReason: capture.captureReason,
      includeInternalAllocations: capture.includeInternalAllocations,
      changePercent: capture.changePercent,
      integrity:
        capture.chunkCount === 0 && capture.totalLength === 0 && capture.retainedBytes === 0
          ? 'metadata-only'
          : 'pending',
      identityError: errors.length ? errors.join(' ') : undefined,
    });
  }
  const byLabel = new Map<string, MemorySnapshot[]>();
  for (const snapshot of snapshots.sort((a, b) => a.captureTsMs - b.captureTsMs || a.sliceId - b.sliceId)) {
    const key = snapshot.assignedVmId ?? snapshot.vmId;
    const current = byLabel.get(key) ?? [];
    current.push(snapshot);
    snapshot.index = current.length;
    byLabel.set(key, current);
  }
  return snapshots;
}

function classifyPages(pages: MemoryPage[], traceEndMs: number): void {
  const pagesAfterTraceStart = pages.filter((page) => !page.preExisting);
  for (const page of pagesAfterTraceStart) {
    const endTsMs = page.destroyTsMs ?? traceEndMs;
    const hasOverlappingCreation = pagesAfterTraceStart.some(
      (other) =>
        other.instanceId !== page.instanceId &&
        other.realCreateTsMs >= page.realCreateTsMs &&
        other.realCreateTsMs <= endTsMs,
    );
    page.classification = hasOverlappingCreation ? 'overlapping' : 'independent';
  }

  const overlapping = pagesAfterTraceStart
    .filter((page) => page.classification === 'overlapping' && page.sharedBts && page.destroyTsMs !== undefined)
    .sort((a, b) => a.realCreateTsMs - b.realCreateTsMs);
  const assigned = new Set<number>();
  let groupIndex = 0;
  for (const page of overlapping) {
    if (assigned.has(page.instanceId)) {
      continue;
    }
    const candidates = overlapping.filter(
      (other) =>
        !assigned.has(other.instanceId) &&
        other.btsVmId === page.btsVmId &&
        Math.abs(other.realCreateTsMs - page.realCreateTsMs) <= GROUP_WINDOW_MS &&
        Math.abs((other.destroyTsMs ?? 0) - (page.destroyTsMs ?? 0)) <= GROUP_WINDOW_MS,
    );
    if (candidates.length < 2) {
      continue;
    }
    groupIndex += 1;
    const groupId = `page_group_${groupIndex}`;
    for (const candidate of candidates) {
      candidate.classification = 'grouped';
      candidate.groupId = groupId;
      assigned.add(candidate.instanceId);
    }
  }

  const byUrl = new Map<string, MemoryPage[]>();
  for (const page of pagesAfterTraceStart.filter((item) => item.url)) {
    const current = byUrl.get(page.url) ?? [];
    current.push(page);
    byUrl.set(page.url, current);
  }
  for (const sameUrlPages of byUrl.values()) {
    sameUrlPages.sort((a, b) => a.realCreateTsMs - b.realCreateTsMs);
    const nonOverlapping =
      sameUrlPages.length > 1 &&
      sameUrlPages.slice(1).every((page, index) => {
        const previous = sameUrlPages[index];
        return previous?.destroyTsMs !== undefined && previous.destroyTsMs <= page.realCreateTsMs;
      });
    if (!nonOverlapping) {
      continue;
    }
    sameUrlPages.forEach((page, index) => {
      page.repeatedFocusIndex = index + 1;
      page.repeatedFocusTotal = sameUrlPages.length;
    });
  }
}

function memorySampleAt(context: MemoryDataContext, instanceId: number, tsMs: number): RawMemorySample | undefined {
  return lastAt(context.samples.get(instanceId) ?? [], tsMs);
}

function firstGcAfter(context: MemoryDataContext, tsMs: number): RawEvent | undefined {
  return context.gcEvents.find((event) => event.tsMs >= tsMs);
}

function gcSettledTsMs(event: RawEvent): number {
  return event.endTsMs + GC_SETTLE_MS;
}

function vmMemoryAt(context: MemoryDataContext, vm: MemoryVm, tsMs: number): MemoryValue {
  if (!vm.supportsMemory) {
    return { accumulateBytes: 0, rssBytes: 0 };
  }
  if (vm.kind === 'mts') {
    const sample = memorySampleAt(context, vm.instanceIds[0] ?? -1, tsMs);
    return sample?.mts ?? { accumulateBytes: 0, rssBytes: 0 };
  }
  const track = context.btsMemoryTracks.get(vm.memoryTrackId ?? -1);
  return lastAt(track?.samples ?? [], tsMs)?.memory ?? { accumulateBytes: 0, rssBytes: 0 };
}

function buildSharedBtsVmAnalyses(
  context: MemoryDataContext,
  issues: MemoryIssue[],
): { charts: MemoryChart[]; analyses: SharedBtsVmAnalysis[] } {
  const charts: MemoryChart[] = [];
  const analyses: SharedBtsVmAnalysis[] = [];
  context.vms
    .filter((vm) => vm.kind === 'bts' && vm.shared && vm.supportsMemory)
    .sort((left, right) => left.createTsMs - right.createTsMs)
    .forEach((vm, index) => {
      const vmPages = context.pages.filter((page) => vm.instanceIds.includes(page.instanceId));
      const startTsMs = vm.createTsMs;
      const endTsMs = Math.min(vm.destroyTsMs ?? context.traceEndMs, context.traceEndMs);
      const memoryTrack = context.btsMemoryTracks.get(vm.memoryTrackId ?? -1);
      if (!memoryTrack) {
        return;
      }
      const trackSamples = memoryTrack.samples.filter((sample) => sample.tsMs >= startTsMs && sample.tsMs <= endTsMs);
      if (trackSamples.length === 0) {
        return;
      }
      const chartSamples = [...trackSamples];
      const lastSample = chartSamples[chartSamples.length - 1];
      if (lastSample && lastSample.tsMs < endTsMs) {
        chartSamples.push({ ...lastSample, tsMs: endTsMs });
      }
      const slotIds = [
        ...new Set(chartSamples.flatMap((sample) => Object.keys(sample.slots).map((slotId) => Number(slotId)))),
      ].sort((left, right) => left - right);
      const series: MemoryChartSeries[] = slotIds.map((slotId) => {
        const slotPages = vmPages
          .filter((page) => page.btsSlot === slotId)
          .sort((left, right) => left.instanceId - right.instanceId);
        const name =
          slotId === 0
            ? 'slot_0 (unknown)'
            : slotId === 1
              ? 'slot_1 (common)'
              : slotId === 2
                ? 'slot_2 (overflow)'
                : slotPages.length === 1
                  ? `slot_${slotId} (instance_id=${slotPages[0]?.instanceId})`
                  : slotPages.length > 1
                    ? `slot_${slotId} (instance_ids=${slotPages.map((page) => page.instanceId).join(', ')})`
                    : `slot_${slotId}`;
        return {
          name,
          unit: 'bytes',
          renderMode: 'stacked-area',
          slotId,
          points: chartSamples.map((sample) => {
            const pagesAtSample = slotPages.filter(
              (page) => page.btsCreateTsMs !== undefined && page.btsCreateTsMs <= sample.tsMs,
            );
            return {
              tsMs: sample.tsMs,
              value: sample.slots[slotId] ?? 0,
              instanceIds: pagesAtSample.map((page) => page.instanceId),
              destroyedInstanceIds: pagesAtSample
                .filter((page) => page.btsDestroyTsMs !== undefined && page.btsDestroyTsMs <= sample.tsMs)
                .map((page) => page.instanceId),
            };
          }),
        };
      });
      const pageIds = new Set(vm.instanceIds);
      const lifecycleEvents: MemoryChartEvent[] = context.events
        .filter(
          (event) =>
            (event.name === 'page_uses_bts_vm' || event.name === 'BTSRuntime::Destroy') &&
            event.instanceId !== undefined &&
            pageIds.has(event.instanceId) &&
            event.tsMs >= startTsMs &&
            event.tsMs <= endTsMs,
        )
        .map((event) => {
          const page = vmPages.find((item) => item.instanceId === event.instanceId);
          return {
            sliceId: event.id,
            name: event.name,
            tsMs: event.name === 'BTSRuntime::Destroy' ? event.endTsMs : event.tsMs,
            instanceId: event.instanceId,
            url: page?.url || event.url,
          };
        });
      const vmGcEvents: MemoryChartEvent[] = vm.gcEvents
        .filter((event) => event.tsMs >= startTsMs && event.tsMs <= endTsMs)
        .map((event) => ({
          sliceId: event.sliceId,
          name: 'VM_GC',
          tsMs: event.tsMs,
          renderMode: 'vertical-line',
        }));
      const destroyEvents: MemoryChartEvent[] = context.events
        .filter(
          (event) =>
            event.name === 'destroy_vm_instance' &&
            event.ptr === vm.ptr &&
            event.tsMs >= startTsMs &&
            event.tsMs <= endTsMs,
        )
        .map((event) => ({
          sliceId: event.id,
          name: event.name,
          tsMs: event.tsMs,
        }));
      const snapshotEvents: MemoryChartEvent[] = context.snapshots
        .filter(
          (snapshot) =>
            snapshot.assignedVmId === vm.id && snapshot.captureTsMs >= startTsMs && snapshot.captureTsMs <= endTsMs,
        )
        .map((snapshot) => ({
          sliceId: snapshot.sliceId,
          name: 'capture_snapshot',
          tsMs: snapshot.captureTsMs,
          instanceId: snapshot.instanceId,
          snapshotId: snapshot.snapshotId,
        }));
      const events = [...lifecycleEvents, ...vmGcEvents, ...destroyEvents, ...snapshotEvents].sort(
        (left, right) => left.tsMs - right.tsMs || left.name.localeCompare(right.name),
      );
      const chartId = `shared_bts_slots_${index}`;
      const chart: MemoryChart = {
        id: chartId,
        title: `Shared BTS VM Slot Memory: ${vm.name} (generation ${vm.generation})`,
        xStartTsMs: startTsMs,
        xEndTsMs: endTsMs,
        zeroBaseline: true,
        renderMode: 'stacked-area',
        events,
        series,
      };
      const gcSamples = [
        ...new Map(
          vm.gcEvents
            .map((event) => memoryTrack.samples.find((sample) => sample.tsMs >= event.tsMs && sample.tsMs <= endTsMs))
            .filter((sample): sample is RawBtsMemorySample => sample !== undefined)
            .map((sample) => [sample.id, sample]),
        ).values(),
      ];
      const gcAccumulateSeries: MemoryChartSeries = {
        name: 'BTS Accumulate after VM_GC',
        unit: 'bytes',
        points: gcSamples.map((sample) => ({ tsMs: sample.tsMs, value: sample.memory.accumulateBytes })),
      };
      const gcAccumulateTrend = analyzeTrend(gcAccumulateSeries, 3);
      const createdAfterTraceStart = memoryTrack.firstTsMs > context.traceStartMs + 100;
      const endRssBytes = vmMemoryAt(context, vm, endTsMs).rssBytes;
      const notDestroyedIssue = createdAfterTraceStart && !vm.destroyed;
      if (notDestroyedIssue) {
        issues.push({
          code: 'shared_bts_vm_not_destroyed',
          title: 'BTS 虚拟机未销毁',
          message: `BTS 虚拟机在 Trace 启动后创建，但直到 Trace 结束仍未销毁，结束时 RSS 为 ${endRssBytes} bytes。`,
          confidence: 'high',
          instanceIds: [...vm.instanceIds].sort((left, right) => left - right),
          vmId: vm.id,
          valueBytes: endRssBytes,
        });
      }
      if (gcAccumulateTrend.rising) {
        issues.push({
          code: 'shared_bts_accumulate_rising',
          title: 'BTS 虚拟机 Accumulate 内存呈上涨趋势',
          message: `BTS 虚拟机各次 VM_GC 完成后的 Accumulate 内存呈上涨趋势，首尾稳定水位增加 ${gcAccumulateTrend.delta} bytes。`,
          confidence: 'medium',
          instanceIds: [...vm.instanceIds].sort((left, right) => left - right),
          vmId: vm.id,
          valueBytes: gcAccumulateTrend.delta,
        });
      }
      charts.push(chart);
      analyses.push({
        vmId: vm.id,
        vmName: vm.name,
        generation: vm.generation,
        instanceIds: [...vm.instanceIds].sort((left, right) => left - right),
        chartId,
        firstSampleTsMs: memoryTrack.firstTsMs,
        endTsMs,
        createdAfterTraceStart,
        destroyed: vm.destroyed,
        endRssBytes,
        endRssSampleTsMs: lastAt(memoryTrack.samples, endTsMs)?.tsMs,
        notDestroyedIssue,
        gcAccumulateTrend,
      });
    });
  return { charts, analyses };
}

function sharedBtsLoadedPagesAt(context: MemoryDataContext, vm: MemoryVm, tsMs: number): number[] {
  if (!vm.shared || tsMs < vm.createTsMs || (vm.destroyTsMs !== undefined && tsMs >= vm.destroyTsMs)) {
    return [];
  }
  return vm.instanceIds.filter((instanceId) => {
    const page = context.pages.find((item) => item.instanceId === instanceId);
    return (
      page?.btsCreateTsMs !== undefined &&
      page.btsCreateTsMs <= tsMs &&
      (page.btsDestroyTsMs === undefined || tsMs < page.btsDestroyTsMs)
    );
  });
}

function pssForPage(context: MemoryDataContext, page: MemoryPage): MemorySeriesPoint[] {
  return (
    context.pssTracks.find((track) => track.upid !== undefined && track.upid === page.processUpid)?.points ??
    context.pssTracks[0]?.points ??
    []
  );
}

function poolMemoryAt(
  context: MemoryDataContext,
  tsMs: number,
): {
  bts: MemoryValue;
  mts: MemoryValue;
  mtsPools: MtsPoolMemorySnapshot[];
} {
  const btsState = [...context.poolStates]
    .filter((state) => state.name === 'bts_vm_pool_state' && state.tsMs <= tsMs)
    .sort((a, b) => b.tsMs - a.tsMs || b.id - a.id)[0];
  const latestMtsByPool = new Map<string, RawPoolState>();
  const eligibleMtsStates = context.poolStates
    .filter((item) => item.name === 'mts_vm_pool_state' && item.tsMs <= tsMs)
    .sort((left, right) => left.tsMs - right.tsMs || left.id - right.id);
  for (const state of eligibleMtsStates) {
    latestMtsByPool.set(state.poolInstanceId, state);
  }
  const activeMtsStates = [...latestMtsByPool.values()].filter((state) => !state.destroyed);
  const mts = activeMtsStates.reduce(
    (total, state) => ({
      accumulateBytes: total.accumulateBytes + state.memory.accumulateBytes,
      rssBytes: total.rssBytes + state.memory.rssBytes,
    }),
    { accumulateBytes: 0, rssBytes: 0 },
  );
  const mtsPoolsByUrl = new Map<string, MtsPoolMemorySnapshot>();
  for (const state of activeMtsStates) {
    const current = mtsPoolsByUrl.get(state.url) ?? {
      url: state.url,
      instanceCount: 0,
      memory: { accumulateBytes: 0, rssBytes: 0 },
    };
    current.instanceCount += state.instanceCount;
    current.memory = {
      accumulateBytes: current.memory.accumulateBytes + state.memory.accumulateBytes,
      rssBytes: current.memory.rssBytes + state.memory.rssBytes,
    };
    mtsPoolsByUrl.set(state.url, current);
  }
  return {
    bts: btsState?.memory ?? { accumulateBytes: 0, rssBytes: 0 },
    mts,
    mtsPools: [...mtsPoolsByUrl.values()].sort((left, right) => left.url.localeCompare(right.url)),
  };
}

function diffMtsPoolMemory(
  startPools: MtsPoolMemorySnapshot[],
  endPools: MtsPoolMemorySnapshot[],
): MtsPoolMemoryDelta[] {
  const startByUrl = new Map(startPools.map((pool) => [pool.url, pool]));
  const endByUrl = new Map(endPools.map((pool) => [pool.url, pool]));
  const urls = [...new Set([...startByUrl.keys(), ...endByUrl.keys()])].sort((left, right) =>
    left.localeCompare(right),
  );
  return urls.map((url) => {
    const start = startByUrl.get(url);
    const end = endByUrl.get(url);
    const startInstanceCount = start?.instanceCount ?? 0;
    const endInstanceCount = end?.instanceCount ?? 0;
    const startAccumulateBytes = start?.memory.accumulateBytes ?? 0;
    const endAccumulateBytes = end?.memory.accumulateBytes ?? 0;
    const startRssBytes = start?.memory.rssBytes ?? 0;
    const endRssBytes = end?.memory.rssBytes ?? 0;
    return {
      url,
      startInstanceCount,
      endInstanceCount,
      instanceCountDelta: endInstanceCount - startInstanceCount,
      startAccumulateBytes,
      endAccumulateBytes,
      accumulateDeltaBytes: endAccumulateBytes - startAccumulateBytes,
      startRssBytes,
      endRssBytes,
      rssDeltaBytes: endRssBytes - startRssBytes,
    };
  });
}

function addIssue(issues: MemoryIssue[], issue: MemoryIssue): void {
  const key = `${issue.code}:${[...issue.instanceIds].sort((a, b) => a - b).join(',')}:${issue.vmId ?? ''}`;
  const exists = issues.some(
    (current) =>
      `${current.code}:${[...current.instanceIds].sort((a, b) => a - b).join(',')}:${current.vmId ?? ''}` === key,
  );
  if (!exists) {
    issues.push(issue);
  }
}

function analysisPagesFor(page: MemoryPage, pages: MemoryPage[]): MemoryPage[] {
  if (!page.groupId) {
    return [page];
  }
  return pages.filter((item) => item.groupId === page.groupId);
}

function createMemoryChart(context: MemoryDataContext, page: MemoryPage, vm?: MemoryVm): MemoryChart | undefined {
  if (page.classification !== 'independent' || (vm !== undefined && !vm.supportsMemory)) {
    return undefined;
  }
  const pss = pssForPage(context, page);
  let endTsMs = page.destroyTsMs ?? context.traceEndMs;
  if (page.analysis.rollback) {
    endTsMs = page.analysis.rollback.lowestTsMs;
  } else if (page.destroyTsMs !== undefined) {
    const destroyTsMs = page.destroyTsMs;
    if (context.memoryTraceEnabled) {
      const gc = firstGcAfter(context, destroyTsMs);
      endTsMs = gc === undefined ? destroyTsMs + GC_SETTLE_MS : gcSettledTsMs(gc);
    } else {
      endTsMs = destroyTsMs + GC_SETTLE_MS;
    }
  }
  endTsMs = Math.min(endTsMs, context.traceEndMs);
  const timestamps = valuesInRange(pss, page.realCreateTsMs, endTsMs);
  const pssBase = valueAt(pss, page.realCreateTsMs) ?? timestamps[0]?.value ?? 0;
  const mtsVm = context.vms.find((item) => item.kind === 'mts' && item.instanceIds.includes(page.instanceId));
  const series: MemoryChartSeries[] = [
    {
      name: 'Process PSS Delta',
      unit: 'bytes',
      points: timestamps.map((point) => ({ tsMs: point.tsMs, value: point.value - pssBase })),
    },
  ];
  if (vm) {
    const btsBase = vm.shared ? vmMemoryAt(context, vm, page.realCreateTsMs) : { accumulateBytes: 0, rssBytes: 0 };
    series.push(
      {
        name: 'BTS RSS Delta',
        unit: 'bytes',
        points: timestamps.map((point) => ({
          tsMs: point.tsMs,
          value: vmMemoryAt(context, vm, point.tsMs).rssBytes - btsBase.rssBytes,
        })),
      },
      {
        name: 'BTS Accumulate Delta',
        unit: 'bytes',
        points: timestamps.map((point) => ({
          tsMs: point.tsMs,
          value: vmMemoryAt(context, vm, point.tsMs).accumulateBytes - btsBase.accumulateBytes,
        })),
      },
    );
  }
  if (mtsVm?.supportsMemory) {
    series.push(
      {
        name: 'MTS RSS',
        unit: 'bytes',
        points: timestamps.map((point) => ({
          tsMs: point.tsMs,
          value: vmMemoryAt(context, mtsVm, point.tsMs).rssBytes,
        })),
      },
      {
        name: 'MTS Accumulate',
        unit: 'bytes',
        points: timestamps.map((point) => ({
          tsMs: point.tsMs,
          value: vmMemoryAt(context, mtsVm, point.tsMs).accumulateBytes,
        })),
      },
    );
  }
  return {
    id: `page_${page.instanceId}_memory_delta`,
    title: `Page ${page.instanceId} Memory Delta`,
    zeroBaseline: true,
    series,
  };
}

function createPageComponentChart(context: MemoryDataContext, page: MemoryPage): MemoryChart | undefined {
  const startTsMs = page.realCreateTsMs;
  const endTsMs = Math.min(page.destroyTsMs ?? context.traceEndMs, context.traceEndMs);
  const samples = (context.samples.get(page.instanceId) ?? []).filter(
    (sample) => sample.tsMs >= startTsMs && sample.tsMs <= endTsMs,
  );
  const categories = new Set<string>();
  for (const sample of samples) {
    Object.keys(sample.uiCounts).forEach((category) => categories.add(category));
  }
  if (samples.length === 0 || categories.size === 0) {
    return undefined;
  }
  const series: MemoryChartSeries[] = [...categories].sort().map((category) => {
    const points = samples.map((sample) => ({
      tsMs: sample.tsMs,
      value: sample.uiCounts[category] ?? 0,
    }));
    if (!page.preExisting && (points[0]?.tsMs ?? Number.POSITIVE_INFINITY) > startTsMs) {
      points.unshift({ tsMs: startTsMs, value: 0 });
    }
    const lastPoint = points[points.length - 1];
    if (page.destroyed && (lastPoint?.tsMs !== endTsMs || lastPoint.value !== 0)) {
      points.push({ tsMs: endTsMs, value: 0 });
    }
    return {
      name: category,
      unit: 'count',
      points,
    };
  });
  return {
    id: `page_${page.instanceId}_component_counts`,
    title: `Page ${page.instanceId} Component Counts`,
    xStartTsMs: startTsMs,
    xEndTsMs: endTsMs,
    zeroBaseline: true,
    series,
  };
}

function analyzePageMetrics(context: MemoryDataContext, issues: MemoryIssue[]): MtsPoolGrowthEvent[] {
  const completedGroups = new Set<string>();
  const mtsPoolGrowthEvents: MtsPoolGrowthEvent[] = [];
  for (const page of context.pages) {
    page.analysis.componentChart = createPageComponentChart(context, page);
    createPageGraphicCharts(page, context.samples.get(page.instanceId) ?? [], context.traceEndMs, context.traceStartMs);
  }

  for (const page of context.pages.filter((item) => !item.preExisting)) {
    const groupKey = page.groupId ?? `page_${page.instanceId}`;
    if (completedGroups.has(groupKey)) {
      continue;
    }
    completedGroups.add(groupKey);
    const groupPages = analysisPagesFor(page, context.pages);
    const startTsMs = Math.min(...groupPages.map((item) => item.realCreateTsMs));
    const endTsMs = Math.max(...groupPages.map((item) => item.destroyTsMs ?? context.traceEndMs));
    const pss = pssForPage(context, page);
    let peakEndTsMs = endTsMs;
    let peakConfidence: 'high' | 'medium' | undefined;

    if (page.classification === 'independent' || page.classification === 'grouped') {
      peakConfidence = 'high';
    } else {
      const nextPage = context.pages
        .filter((item) => item.instanceId !== page.instanceId && item.realCreateTsMs > startTsMs)
        .sort((a, b) => a.realCreateTsMs - b.realCreateTsMs)[0];
      if (nextPage && nextPage.realCreateTsMs - startTsMs > OVERLAP_PEAK_WINDOW_MS) {
        peakEndTsMs = nextPage.realCreateTsMs;
        peakConfidence = 'medium';
      }
    }
    const baseline = valueAt(pss, startTsMs);
    const peakPoints = valuesInRange(pss, startTsMs, peakEndTsMs);
    if (peakConfidence && baseline !== undefined && peakPoints.length > 0) {
      const peak = Math.max(...peakPoints.map((point) => point.value));
      const peakAnalysis = {
        deltaBytes: peak - baseline,
        startTsMs,
        endTsMs: peakEndTsMs,
        confidence: peakConfidence,
        groupedInstanceIds: groupPages.length > 1 ? groupPages.map((item) => item.instanceId) : undefined,
      };
      for (const groupPage of groupPages) {
        groupPage.analysis.peakMemory = peakAnalysis;
      }
      if (peakAnalysis.deltaBytes > HIGH_MEMORY_BYTES) {
        addIssue(issues, {
          code: 'high_page_memory',
          title: '高内存消耗页面',
          message: `页面加载阶段的 PSS 峰值增量为 ${peakAnalysis.deltaBytes} bytes，超过 150 MiB。`,
          confidence: peakConfidence,
          instanceIds: groupPages.map((item) => item.instanceId),
          valueBytes: peakAnalysis.deltaBytes,
        });
      }
    } else {
      page.analysis.notes.push('页面生命期高度重合，无法准确计算单一页面的峰值内存增量。');
    }

    for (const groupPage of groupPages) {
      if (groupPage.destroyTsMs === undefined) {
        groupPage.analysis.notes.push('页面在 Trace 结束前未销毁，跳过退出后的内存回落分析。');
        continue;
      }
      const poolStart = poolMemoryAt(context, groupPage.realCreateTsMs);
      const poolEndTsMs = Math.max(groupPage.realCreateTsMs, groupPage.destroyTsMs - 100);
      const poolEnd = poolMemoryAt(context, poolEndTsMs);
      const mtsPoolDeltaBytes = poolEnd.mts.rssBytes - poolStart.mts.rssBytes;
      const pools = diffMtsPoolMemory(poolStart.mtsPools, poolEnd.mtsPools);
      groupPage.analysis.mtsPool = {
        mtsPoolDeltaBytes,
        startTsMs: groupPage.realCreateTsMs,
        endTsMs: poolEndTsMs,
        confidence: 'high',
        pools,
      };
      if (mtsPoolDeltaBytes > MTS_POOL_GROWTH_BYTES) {
        const poolUrls = pools.filter((pool) => pool.rssDeltaBytes > 0).map((pool) => pool.url);
        addIssue(issues, {
          code: 'mts_pool_growth',
          title: 'MTS 虚拟机缓存池增长过多',
          message: `页面生命期内 MTS VM Pool RSS 增长 ${mtsPoolDeltaBytes} bytes，超过 3 MiB。归属：${
            poolUrls.join(', ') || 'Unknown URL'
          }。`,
          confidence: 'high',
          instanceIds: [groupPage.instanceId],
          valueBytes: mtsPoolDeltaBytes,
          poolUrls,
        });
        mtsPoolGrowthEvents.push({
          id: `mts_pool_growth_${groupPage.instanceId}_${Math.round(poolEndTsMs)}`,
          instanceId: groupPage.instanceId,
          startTsMs: groupPage.realCreateTsMs,
          endTsMs: poolEndTsMs,
          totalRssDeltaBytes: mtsPoolDeltaBytes,
          pools,
        });
      }
    }

    if (
      (page.classification === 'independent' || page.classification === 'grouped') &&
      groupPages.every((item) => item.destroyTsMs !== undefined)
    ) {
      const rollbackStart = startTsMs;
      const destroyTsMs = Math.max(...groupPages.map((item) => item.destroyTsMs ?? 0));
      const nextPage = context.pages
        .filter((item) => !groupPages.includes(item) && item.realCreateTsMs > destroyTsMs)
        .sort((a, b) => a.realCreateTsMs - b.realCreateTsMs)[0];
      const nextCreateTsMs = nextPage?.realCreateTsMs ?? Number.POSITIVE_INFINITY;
      let observationStartTsMs = destroyTsMs;
      if (context.memoryTraceEnabled) {
        const gc = firstGcAfter(context, destroyTsMs);
        if (gc === undefined) {
          for (const groupPage of groupPages) {
            groupPage.analysis.notes.push('页面销毁后没有找到 RunGC，无法计算高置信度内存回落。');
          }
          continue;
        }
        observationStartTsMs = gcSettledTsMs(gc);
        if (nextCreateTsMs < observationStartTsMs) {
          for (const groupPage of groupPages) {
            groupPage.analysis.notes.push('GC 完成前有其它页面创建，放弃计算物理内存回落。');
          }
          continue;
        }
      }
      const observationEndTsMs = Math.min(observationStartTsMs + MAX_ATTENTION_MS, nextCreateTsMs, context.traceEndMs);
      const baselinePoint = lastAt(pss, rollbackStart);
      const rollbackPoints = valuesInRange(pss, observationStartTsMs, observationEndTsMs);
      if (!baselinePoint || rollbackPoints.length === 0) {
        continue;
      }
      let lowestPoint = rollbackPoints[0];
      if (!lowestPoint) {
        continue;
      }
      for (const point of rollbackPoints) {
        if (point.value < lowestPoint.value) {
          lowestPoint = point;
        }
      }
      const lowestBytes = lowestPoint.value;
      const deltaBytes = lowestBytes - baselinePoint.value;
      const confidence = context.memoryTraceEnabled ? (deltaBytes < 0 ? 'low' : 'high') : 'low';
      let message = '';
      if (deltaBytes < 0) {
        message = '页面退出后 PSS 低于页面创建前水位，存在其它内存下降因素。';
      } else if (deltaBytes < PAGE_ROLLBACK_BYTES) {
        message = '页面创建并销毁后 PSS 上涨不明显，内存泄漏概率较低。';
      } else {
        message = context.memoryTraceEnabled
          ? '页面退出并完成 GC 后 PSS 仍有明显上涨。'
          : '页面退出后 PSS 仍有上涨；未开启强制 GC，仅作为低置信度趋势参考。';
      }
      const rollback = {
        deltaBytes,
        baselineBytes: baselinePoint.value,
        baselineTsMs: baselinePoint.tsMs,
        lowestBytes,
        lowestTsMs: lowestPoint.tsMs,
        observationStartTsMs,
        observationEndTsMs,
        confidence,
        forcedGc: context.memoryTraceEnabled,
        message,
      } as const;
      for (const groupPage of groupPages) {
        groupPage.analysis.rollback = rollback;
      }
    }
  }

  for (const page of context.pages.filter((item) => !item.preExisting)) {
    const btsVm = context.vms.find((vm) => vm.id === page.btsVmId);
    page.analysis.memoryChart = createMemoryChart(context, page, btsVm);
    if (!btsVm) {
      page.analysis.notes.push('该页面没有 BTS Runtime，已省略 BTS 相关分析。');
      if (!page.analysis.memoryChart) {
        page.analysis.notes.push('页面不是独立页面，未绘制高置信度内存增量图。');
      }
      continue;
    }
    if (!page.analysis.memoryChart) {
      page.analysis.notes.push('页面不是独立页面或 BTS 不支持内存上报，未绘制高置信度内存增量图。');
    }
    if (!btsVm.shared) {
      page.analysis.notes.push('该页面未使用共享 BTS 虚拟机。');
    }
  }
  return mtsPoolGrowthEvents;
}

function buildResidualAnalyses(context: MemoryDataContext): BtsResidualAnalysis[] {
  const analyses: BtsResidualAnalysis[] = [];
  for (const page of context.pages) {
    if (!page.selected || page.btsVmId === undefined || page.btsSlot === undefined) continue;
    const snapshots = context.snapshots.filter(
      (snapshot) => snapshot.kind === 'bts_residual' && snapshot.instanceId === page.instanceId,
    );
    if (snapshots.length === 0 && page.btsDestroyTsMs === undefined) continue;
    const id = `${page.btsVmId}_instance_${page.instanceId}_slot_${page.btsSlot}`;
    const gaps = snapshots.flatMap((snapshot) => (snapshot.identityError ? [snapshot.identityError] : []));
    if (snapshots.length === 0) gaps.push('没有该销毁页面的 residual 快照，无法分析对象残留。');
    if (!isBtsPageSlot(page.btsSlot)) gaps.push('非页面专用 slot，无法归因到单页。');
    const analysis: BtsResidualAnalysis = {
      id,
      vmId: page.btsVmId,
      instanceId: page.instanceId,
      slotId: page.btsSlot,
      destroyTsMs: page.btsDestroyTsMs,
      snapshotIds: snapshots.map((snapshot) => snapshot.snapshotId),
      tailComplete: false,
      status: gaps.length ? 'insufficient' : 'pending',
      gaps,
      findings: [],
      reportAnchor: `residual-instance-${page.instanceId}`,
    };
    analyses.push(analysis);
    page.analysis.residualAnalysisId = id;
  }
  return analyses;
}

function createScenarioTrend(context: MemoryDataContext, page: MemoryPage, options: MemoryAnalysisOptions): void {
  if (options.scenario !== 'scroll' || options.startTsMs === undefined || options.endTsMs === undefined) {
    return;
  }
  const lifeStart = page.realCreateTsMs;
  const lifeEnd = page.destroyTsMs ?? context.traceEndMs;
  const startTsMs = Math.max(options.startTsMs, lifeStart);
  const endTsMs = Math.min(options.endTsMs, lifeEnd);
  if (startTsMs >= endTsMs) {
    page.analysis.notes.push('指定的滚动时间范围与页面生命期没有交集。');
    return;
  }
  const pss = valuesInRange(pssForPage(context, page), startTsMs, endTsMs);
  const btsVm = context.vms.find((vm) => vm.id === page.btsVmId);
  const mtsVm = context.vms.find((vm) => vm.kind === 'mts' && vm.instanceIds.includes(page.instanceId));
  if (pss.length === 0) {
    page.analysis.notes.push('指定时间范围内没有足够的 PSS 数据。');
    return;
  }
  const memorySeries: MemoryChartSeries[] = [{ name: 'Process PSS', unit: 'bytes', points: pss }];
  if (btsVm?.supportsMemory) {
    memorySeries.push(
      {
        name: 'BTS RSS',
        unit: 'bytes',
        points: pss.map((point) => ({
          tsMs: point.tsMs,
          value: vmMemoryAt(context, btsVm, point.tsMs).rssBytes,
        })),
      },
      {
        name: 'BTS Accumulate',
        unit: 'bytes',
        points: pss.map((point) => ({
          tsMs: point.tsMs,
          value: vmMemoryAt(context, btsVm, point.tsMs).accumulateBytes,
        })),
      },
    );
  }
  if (mtsVm?.supportsMemory) {
    memorySeries.push(
      {
        name: 'MTS RSS',
        unit: 'bytes',
        points: pss.map((point) => ({ tsMs: point.tsMs, value: vmMemoryAt(context, mtsVm, point.tsMs).rssBytes })),
      },
      {
        name: 'MTS Accumulate',
        unit: 'bytes',
        points: pss.map((point) => ({
          tsMs: point.tsMs,
          value: vmMemoryAt(context, mtsVm, point.tsMs).accumulateBytes,
        })),
      },
    );
  }
  const categories = new Set<string>();
  for (const sample of context.samples.get(page.instanceId) ?? []) {
    if (sample.tsMs >= startTsMs && sample.tsMs <= endTsMs) {
      Object.keys(sample.uiCounts).forEach((category) => categories.add(category));
    }
  }
  const uiSeries: MemoryChartSeries[] = [...categories].sort().map((category) => ({
    name: category,
    unit: 'count',
    points: pss.map((point) => ({
      tsMs: point.tsMs,
      value: memorySampleAt(context, page.instanceId, point.tsMs)?.uiCounts[category] ?? 0,
    })),
  }));
  const memoryChart: MemoryChart = {
    id: `page_${page.instanceId}_scroll_memory`,
    title: `Page ${page.instanceId} Scroll Memory Trend`,
    series: memorySeries,
  };
  page.analysis.trendCharts.push(memoryChart);
  if (uiSeries.length > 0) {
    page.analysis.trendCharts.push({
      id: `page_${page.instanceId}_scroll_ui`,
      title: `Page ${page.instanceId} Lynx UI View Trend`,
      series: uiSeries,
    });
  }
  page.analysis.trends.push(...memorySeries.map(analyzeTrend), ...uiSeries.map(analyzeTrend));
}

async function loadMemoryData(traceQuery: TraceQuery, options: MemoryAnalysisOptions): Promise<MemoryDataContext> {
  const bounds = await queryTraceBounds(traceQuery);
  const [events, trackData, btsMemoryTracks, pssTracks, poolStates] = await Promise.all([
    queryEvents(traceQuery),
    queryTrackAndSampleData(traceQuery),
    queryBtsMemoryTracks(traceQuery),
    queryPssTracks(traceQuery),
    queryPoolStates(traceQuery),
  ]);
  const traceBegin = events.find((event) => event.name === 'TRACE_BEGIN');
  const traceBeginRows = await traceQuery.query(`
    SELECT a.flat_key, a.display_value
    FROM slice s
    JOIN args a ON a.arg_set_id = s.arg_set_id
    WHERE s.name = 'TRACE_BEGIN'
  `);
  const traceArgs = new Map(traceBeginRows.map((row) => [toString(row['flat_key']), toString(row['display_value'])]));
  const memoryTraceEnabled =
    traceBegin !== undefined &&
    ['1', 'true'].includes((traceArgs.get('debug.enable_memory_trace') ?? '').toLowerCase());
  const pages = buildPages(events, trackData.tracks, trackData.samples, bounds.startMs, bounds.endMs, options);
  const vms = buildVms(events, pages, bounds.startMs);
  const warnings: string[] = [];
  warnings.push(...assignBtsMemoryTracks(vms, btsMemoryTracks, bounds.endMs));
  classifyPages(pages, bounds.endMs);
  if ((options.url !== undefined || options.instanceId !== undefined) && !pages.some((page) => page.selected)) {
    warnings.push('Trace 中没有找到与用户指定 URL 或 instance_id 匹配的页面。');
  }
  const selectedPages = pages.filter((page) => page.selected);
  if (selectedPages.some((page) => page.classification === 'overlapping')) {
    warnings.push('目标页面与其它页面创建过程重叠，部分单页面结论置信度较低。');
  }
  if (options.url !== undefined) {
    const unrelatedUrls = new Set(pages.filter((page) => !page.selected && page.url).map((page) => page.url));
    if (unrelatedUrls.size >= 2) {
      warnings.push('Trace 中还加载了至少两个无关页面，建议减少无关 Lynx 页面或使用回放重新录制。');
    }
  } else {
    const alivePages = pages.filter((page) => !page.preExisting && !page.destroyed);
    if (pages.length > 0 && alivePages.length > pages.length / 3) {
      warnings.push('超过三分之一的页面创建后未退出，页面数量增加会自然推高进程物理内存。');
    }
  }
  return {
    traceStartMs: bounds.startMs,
    traceEndMs: bounds.endMs,
    memoryTraceEnabled,
    events,
    tracks: trackData.tracks,
    samples: trackData.samples,
    btsMemoryTracks,
    pages,
    vms,
    snapshots: buildSnapshots(events, vms, pages, btsMemoryTracks),
    gcEvents: events.filter((event) => event.name === 'RunGC'),
    pssTracks,
    poolStates,
    warnings,
  };
}

export async function queryVMMemory(traceQuery: TraceQuery, request: VMMemoryQuery): Promise<VMMemoryReading> {
  const context = await loadMemoryData(traceQuery, {});
  const vm =
    request.kind === 'mts'
      ? context.vms.find((item) => item.kind === 'mts' && item.instanceIds.includes(request.instanceId ?? -1))
      : context.vms.find(
          (item) =>
            item.kind === 'bts' && item.name === request.vmName && item.generation === (request.generation ?? 0),
        );
  if (!vm?.supportsMemory || request.tsMs < vm.createTsMs || request.tsMs > (vm.destroyTsMs ?? context.traceEndMs)) {
    return {
      accumulateBytes: 0,
      rssBytes: 0,
      available: false,
      reason: 'VM 不存在、不支持内存上报或查询时间不在生命周期内。',
    };
  }
  const sample =
    vm.kind === 'mts'
      ? memorySampleAt(context, vm.instanceIds[0] ?? -1, request.tsMs)
      : lastAt(context.btsMemoryTracks.get(vm.memoryTrackId ?? -1)?.samples ?? [], request.tsMs);
  const memory = sample && ('memory' in sample ? sample.memory : sample.mts);
  return memory && sample
    ? { ...memory, available: true, sampleId: sample.id, sampleTsMs: sample.tsMs }
    : { accumulateBytes: 0, rssBytes: 0, available: false, reason: '没有可用的源样本。' };
}

export async function querySharedBtsLoadedPages(
  traceQuery: TraceQuery,
  vmName: string,
  generation: number,
  tsMs: number,
): Promise<number[]> {
  const context = await loadMemoryData(traceQuery, {});
  const vm = context.vms.find(
    (item) => item.kind === 'bts' && item.shared && item.name === vmName && item.generation === generation,
  );
  return vm ? sharedBtsLoadedPagesAt(context, vm, tsMs) : [];
}

export async function queryMemoryAnalysis(
  traceQuery: TraceQuery,
  options: MemoryAnalysisOptions = {},
): Promise<MemoryAnalysisResult> {
  const context = await loadMemoryData(traceQuery, options);
  const processUpids = [
    ...new Set(
      [...context.tracks.values()].map((track) => track.upid).filter((upid): upid is number => upid !== undefined),
    ),
  ];
  if (!context.memoryTraceEnabled) {
    const error = 'Trace 未开启内存数据采集。请升级 Lynx 并在录制时启用 enable_memory_trace。';
    return {
      schemaVersion: 4,
      valid: false,
      error,
      options,
      trace: {
        startTsMs: context.traceStartMs,
        endTsMs: context.traceEndMs,
        memoryTraceEnabled: false,
        processUpids,
      },
      pages: context.pages,
      vms: context.vms,
      snapshots: context.snapshots,
      mtsPoolGrowthEvents: [],
      sharedBtsSlotCharts: [],
      sharedBtsVmAnalyses: [],
      residualAnalyses: [],
      issues: [],
      warnings: context.warnings,
      summary: {
        pageCount: context.pages.length,
        analyzedPageCount: 0,
        vmCount: context.vms.length,
        snapshotCount: context.snapshots.length,
        issueCount: 0,
        selectedInstanceIds: [],
        conclusion: error,
        confirmedLeakPageCount: 0,
        suspectedPageCount: 0,
        incompletePageCount: 0,
      },
    };
  }

  const supportedBtsVms = context.vms.filter((vm) => vm.kind === 'bts' && vm.supportsMemory);
  if (context.vms.some((vm) => vm.kind === 'bts') && supportedBtsVms.length === 0) {
    context.warnings.push('所有 BTS 虚拟机均没有可用的 bts_vm_acc_* 内存轨道，或 VM 类型不支持内存上报。');
  }
  const issues: MemoryIssue[] = [];
  const mtsPoolGrowthEvents = analyzePageMetrics(context, issues);
  const kryptonAnalyses = await queryKryptonCharts(traceQuery, context.traceStartMs, context.traceEndMs, context.pages);
  for (const group of kryptonAnalyses) {
    const graphicPages = context.pages.filter(
      (page) =>
        page.selected &&
        page.analysis.graphicMemoryChart &&
        group.processUpid !== undefined &&
        page.processUpid === group.processUpid,
    );
    const events: MemoryChartEvent[] = context.events.flatMap((event) => {
      const page = graphicPages.find((p) => p.instanceId === event.instanceId);
      if (!page || !['LynxShell::Create', 'LynxShell::~LynxShell'].includes(event.name)) return [];
      return [
        {
          sliceId: event.id,
          name: event.name,
          tsMs: event.name === 'LynxShell::Create' ? event.tsMs : event.endTsMs,
          instanceId: page.instanceId,
          url: page.url,
          btsVmName: page.btsVmName,
          renderMode: 'bubble',
        },
      ];
    });
    group.memoryChart.events = events;
    group.countChart.events = events;
  }
  const residualAnalyses = buildResidualAnalyses(context);
  const sharedBtsVmAnalysis = buildSharedBtsVmAnalyses(context, issues);
  for (const page of context.pages.filter((item) => item.selected)) {
    createScenarioTrend(context, page, options);
  }
  const selectedInstanceIds = context.pages.filter((page) => page.selected).map((page) => page.instanceId);
  const relevantIssues =
    options.url !== undefined || options.instanceId !== undefined
      ? issues.filter((issue) => issue.instanceIds.some((instanceId) => selectedInstanceIds.includes(instanceId)))
      : issues;
  const conclusion =
    relevantIssues.length > 0
      ? `发现 ${relevantIssues.length} 个与目标页面相关的内存 issue，请查看 HTML 报告中的高亮结论。`
      : '未发现规则命中的高或中置信度内存问题，请结合 HTML 报告检查完整数据。';
  return {
    schemaVersion: 4,
    valid: true,
    options,
    trace: {
      startTsMs: context.traceStartMs,
      endTsMs: context.traceEndMs,
      memoryTraceEnabled: true,
      processUpids,
    },
    pages: context.pages,
    vms: context.vms,
    snapshots: context.snapshots,
    mtsPoolGrowthEvents,
    sharedBtsSlotCharts: sharedBtsVmAnalysis.charts,
    kryptonAnalyses,
    sharedBtsVmAnalyses: sharedBtsVmAnalysis.analyses,
    residualAnalyses,
    issues,
    warnings: context.warnings,
    summary: {
      pageCount: context.pages.length,
      analyzedPageCount: context.pages.filter((page) => page.selected).length,
      vmCount: context.vms.length,
      snapshotCount: context.snapshots.length,
      issueCount: issues.length,
      selectedInstanceIds,
      conclusion,
      confirmedLeakPageCount: 0,
      suspectedPageCount: 0,
      incompletePageCount: residualAnalyses.length,
    },
  };
}
