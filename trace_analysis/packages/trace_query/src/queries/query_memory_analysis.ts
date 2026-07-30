// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import {
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
  SharedBtsLeakEvent,
  SharedBtsVmAnalysis,
} from '../types/memory_analysis';
import { NS_TO_MS } from '../utils/constant';
import { TraceQuery } from '../utils/trace_query';

const PAGE_CREATE_EARLY_MS = 200;
const GC_SETTLE_MS = 10;
const MAX_ATTENTION_MS = 5000;
const GROUP_WINDOW_MS = 2000;
const OVERLAP_PEAK_WINDOW_MS = 3000;
const HIGH_MEMORY_BYTES = 150 * 1024 * 1024;
const PAGE_ROLLBACK_BYTES = 2 * 1024 * 1024;
const MTS_POOL_GROWTH_BYTES = 3 * 1024 * 1024;
const SHARED_BTS_LEAK_BYTES = 32 * 1024;
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
}

interface RawBtsMemorySample {
  id: number;
  tsMs: number;
  ptr: string;
  memory: MemoryValue;
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
  snapshotId: string;
  snapshotVmId: string;
  totalLength: number;
  chunkCount: number;
}

interface RawPoolState {
  name: 'bts_vm_pool_state' | 'mts_vm_pool_state';
  tsMs: number;
  poolInstanceId: string;
  destroyed: boolean;
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
  forceGc: boolean;
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

function sameNumberSet(left: number[], right: number[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const sortedLeft = [...left].sort((a, b) => a - b);
  const sortedRight = [...right].sort((a, b) => a - b);
  return sortedLeft.every((value, index) => value === sortedRight[index]);
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
        ? 'GC 后内存水位整体上移，稳健斜率为正，且首尾差异超过噪声阈值。'
        : '平滑后的基线持续上移，稳健斜率为正，且首尾差异超过噪声阈值。'
      : sparseSamples
        ? '未同时满足 GC 后内存水位整体上移、正斜率和显著首尾差异。'
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
    'RunGC',
    'will_capture_snapshot',
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
      MAX(CASE WHEN a.flat_key = 'debug.desc' THEN COALESCE(a.string_value, a.display_value) END) desc,
      MAX(CASE WHEN a.flat_key = 'debug.group_id' THEN a.display_value END) group_id,
      MAX(CASE WHEN a.flat_key = 'debug.ptr' THEN a.display_value END) ptr,
      MAX(CASE WHEN a.flat_key = 'debug.snapshot_id' THEN a.display_value END) snapshot_id,
      MAX(CASE WHEN a.flat_key = 'debug.id' THEN a.display_value END) snapshot_vm_id,
      MAX(CASE WHEN a.flat_key = 'debug.total_length' THEN a.display_value END) total_length,
      MAX(CASE WHEN a.flat_key = 'debug.chunk_count' THEN a.display_value END) chunk_count
    FROM slice s
    LEFT JOIN args a ON a.arg_set_id = s.arg_set_id
    WHERE s.name IN (${quotedNames})
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
      snapshotId: toString(row['snapshot_id']),
      snapshotVmId: toString(row['snapshot_vm_id']),
      totalLength: toNumber(row['total_length']),
      chunkCount: toNumber(row['chunk_count']),
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
      AND json_extract(a.string_value, '$.category') IS NOT NULL
    ORDER BY c.id
  `);
  for (const row of detailRows) {
    const sample = sampleById.get(toNumber(row['counter_id']));
    if (!sample) {
      continue;
    }
    const category = toString(row['category']);
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
    };
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
  const metadata = new Map<number, { name: RawPoolState['name']; tsMs: number }>();
  for (const row of rows) {
    const id = toNumber(row['id']);
    const args = grouped.get(id) ?? {};
    args[toString(row['flat_key'])] = toString(row['string_value'] ?? row['display_value']);
    grouped.set(id, args);
    metadata.set(id, {
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
    for (const [key, value] of Object.entries(args)) {
      if (!key.startsWith('debug.id_')) {
        continue;
      }
      try {
        const memory = JSON.parse(value) as Record<string, unknown>;
        accumulateBytes += toNumber(memory['acc_usage']);
        rssBytes += toNumber(memory['base_usage']) + toNumber(memory['page_rss_usage']);
      } catch {
        // Ignore malformed pool entries and retain the remaining valid entries.
      }
    }
    states.push({
      ...event,
      poolInstanceId: args['debug.pool_instance_id'] ?? 'bts',
      destroyed: args['debug.destroyed'] === '1',
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
      sharedBts: false,
      classification: preExisting ? 'pre-existing' : 'overlapping',
      selected,
      analysis: {
        sharedBtsLeaks: [],
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
      destroyed: page.destroyed,
      supportsMemory: supportsMemory(type),
    });
  }

  const activeByPtr = new Map<string, MemoryVm>();
  const activeByName = new Map<string, MemoryVm>();
  const nextGeneration = new Map<string, number>();
  const btsEvents = events
    .filter((event) => event.name === 'page_uses_bts_vm' || event.name === 'destroy_vm_instance')
    .sort((a, b) => a.tsMs - b.tsMs);
  for (const event of btsEvents) {
    if (event.name === 'destroy_vm_instance') {
      const active = activeByPtr.get(event.ptr);
      if (!active) {
        continue;
      }
      active.destroyTsMs = event.endTsMs;
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
      vm = {
        id: `bts_${name}_${generation}`,
        kind: 'bts',
        name,
        generation,
        ptr: event.ptr,
        type: normalizeVmEngineDesc(event.desc),
        shared,
        instanceIds: [],
        createTsMs: event.tsMs,
        destroyed: false,
        supportsMemory: supportsMemory(normalizeVmEngineDesc(event.desc)),
      };
      vms.push(vm);
      activeByName.set(name, vm);
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
      (track) => track.ptr === vm.ptr && track.firstTsMs >= vm.createTsMs && track.firstTsMs <= vmEndTsMs,
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

function buildSnapshots(events: RawEvent[], vms: MemoryVm[]): MemorySnapshot[] {
  const willById = new Map(
    events
      .filter((event) => event.name === 'will_capture_snapshot' && event.snapshotId)
      .map((event) => [event.snapshotId, event]),
  );
  const snapshots: MemorySnapshot[] = [];
  for (const capture of events.filter((event) => event.name === 'capture_snapshot' && event.snapshotId)) {
    const will = willById.get(capture.snapshotId);
    const willTsMs = will?.tsMs ?? capture.tsMs;
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
    const label = capture.snapshotVmId || will?.snapshotVmId || '';
    let assignedVm: MemoryVm | undefined;
    const sharedMatch = /^(.*)\(shared bts\)$/.exec(label);
    const singleMatch = /^instance_(\d+)\(single bts\)$/.exec(label);
    const mtsMatch = /^instance_(\d+)\(mts\)$/.exec(label);
    if (sharedMatch?.[1]) {
      assignedVm = vms.find(
        (vm) =>
          vm.kind === 'bts' &&
          vm.shared &&
          vm.name === sharedMatch[1] &&
          vm.createTsMs <= willTsMs &&
          (vm.destroyTsMs === undefined || willTsMs < vm.destroyTsMs),
      );
    } else if (singleMatch?.[1]) {
      const instanceId = Number(singleMatch[1]);
      assignedVm = vms.find((vm) => vm.kind === 'bts' && vm.instanceIds.includes(instanceId));
    } else if (mtsMatch?.[1]) {
      assignedVm = vms.find((vm) => vm.kind === 'mts' && vm.instanceIds.includes(Number(mtsMatch[1])));
    }
    snapshots.push({
      sliceId: capture.id,
      vmId: label,
      snapshotId: capture.snapshotId,
      index: 0,
      willTsMs,
      captureTsMs: capture.tsMs,
      dumpDurationMs: Math.max(0, capture.tsMs - willTsMs),
      totalLength: capture.totalLength,
      chunkCount: capture.chunkCount,
      vmType,
      memory,
      assignedVmId: assignedVm?.id,
    });
  }
  const byLabel = new Map<string, MemorySnapshot[]>();
  for (const snapshot of snapshots.sort((a, b) => a.willTsMs - b.willTsMs)) {
    const current = byLabel.get(snapshot.vmId) ?? [];
    current.push(snapshot);
    snapshot.index = current.length;
    byLabel.set(snapshot.vmId, current);
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
  leakEvents: SharedBtsLeakEvent[],
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
      const sampleTimes = new Set<number>([startTsMs, endTsMs]);
      for (const sample of memoryTrack.samples) {
        if (sample.tsMs >= startTsMs && sample.tsMs <= endTsMs) {
          sampleTimes.add(sample.tsMs);
        }
      }
      if (sampleTimes.size <= 1) {
        return;
      }
      const sortedSampleTimes = [...sampleTimes].sort((left, right) => left - right);
      const accumulatePoints = sortedSampleTimes.map((tsMs) => ({
        tsMs,
        value: vmMemoryAt(context, vm, tsMs).accumulateBytes,
        loadedInstanceIds: sharedBtsLoadedPagesAt(context, vm, tsMs),
      }));
      const rssPoints = sortedSampleTimes
        .sort((left, right) => left - right)
        .map((tsMs) => ({
          tsMs,
          value: vmMemoryAt(context, vm, tsMs).rssBytes,
          loadedInstanceIds: sharedBtsLoadedPagesAt(context, vm, tsMs),
        }));
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
            tsMs: event.tsMs,
            instanceId: event.instanceId,
            url: page?.url || event.url,
          };
        });
      const gcEvents: MemoryChartEvent[] = context.events
        .filter((event) => event.name === 'RunGC' && event.tsMs >= startTsMs && event.tsMs <= endTsMs)
        .map((event) => ({
          sliceId: event.id,
          name: event.name,
          tsMs: event.tsMs,
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
            snapshot.assignedVmId === vm.id && snapshot.willTsMs >= startTsMs && snapshot.willTsMs <= endTsMs,
        )
        .map((snapshot) => ({
          sliceId: snapshot.sliceId,
          name: 'will_capture_snapshot',
          tsMs: snapshot.willTsMs,
          snapshotId: snapshot.snapshotId,
        }));
      const events = [...lifecycleEvents, ...gcEvents, ...destroyEvents, ...snapshotEvents].sort(
        (left, right) => left.tsMs - right.tsMs || left.name.localeCompare(right.name),
      );
      const issueEvents: MemoryChartEvent[] = leakEvents
        .filter(
          (event) => event.issue && event.vmId === vm.id && event.gcEndTsMs >= startTsMs && event.gcEndTsMs <= endTsMs,
        )
        .map((event) => ({
          name: 'shared_bts_possible_leak',
          tsMs: event.gcEndTsMs,
          instanceIds: event.instanceIds,
          confidence: event.confidence,
          accumulateDeltaBytes: event.accumulateDeltaBytes,
          rssDeltaBytes: event.rssDeltaBytes,
        }));
      const chartEvents = [...events, ...issueEvents].sort(
        (left, right) => left.tsMs - right.tsMs || left.name.localeCompare(right.name),
      );
      const chartId = `shared_bts_heap_${index}`;
      const chart: MemoryChart = {
        id: chartId,
        title: `Shared BTS VM Heap Size: ${vm.name} (generation ${vm.generation})`,
        xStartTsMs: startTsMs,
        xEndTsMs: endTsMs,
        zeroBaseline: true,
        renderMode: 'interval-bars',
        events: chartEvents,
        series: [
          {
            name: 'BTS Accumulate',
            unit: 'bytes',
            renderMode: 'interval-bars',
            points: accumulatePoints,
          },
          {
            name: 'BTS RSS',
            unit: 'bytes',
            renderMode: 'line',
            points: rssPoints,
          },
        ],
      };
      const gcAccumulateSeries: MemoryChartSeries = {
        name: 'BTS Accumulate after GC',
        unit: 'bytes',
        points: context.gcEvents
          .map((event) => gcSettledTsMs(event))
          .filter((tsMs) => tsMs >= memoryTrack.firstTsMs && tsMs <= endTsMs)
          .map((tsMs) => ({
            tsMs,
            value: vmMemoryAt(context, vm, tsMs).accumulateBytes,
          })),
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
          message: `BTS 虚拟机各次 GC 完成后的 Accumulate 内存呈上涨趋势，首尾稳定水位增加 ${gcAccumulateTrend.delta} bytes。`,
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

function sharedBtsLoadedPagesBeforeBtsCreate(context: MemoryDataContext, vm: MemoryVm, tsMs: number): number[] {
  if (!vm.shared || tsMs < vm.createTsMs || (vm.destroyTsMs !== undefined && tsMs >= vm.destroyTsMs)) {
    return [];
  }
  return vm.instanceIds.filter((instanceId) => {
    const page = context.pages.find((item) => item.instanceId === instanceId);
    return (
      page?.btsCreateTsMs !== undefined &&
      page.btsCreateTsMs < tsMs &&
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
} {
  const btsState = [...context.poolStates]
    .filter((state) => state.name === 'bts_vm_pool_state' && state.tsMs <= tsMs)
    .sort((a, b) => b.tsMs - a.tsMs)[0];
  const latestMtsByPool = new Map<string, RawPoolState>();
  for (const state of context.poolStates.filter((item) => item.name === 'mts_vm_pool_state' && item.tsMs <= tsMs)) {
    latestMtsByPool.set(state.poolInstanceId, state);
  }
  const mts = [...latestMtsByPool.values()]
    .filter((state) => !state.destroyed)
    .reduce(
      (total, state) => ({
        accumulateBytes: total.accumulateBytes + state.memory.accumulateBytes,
        rssBytes: total.rssBytes + state.memory.rssBytes,
      }),
      { accumulateBytes: 0, rssBytes: 0 },
    );
  return {
    bts: btsState?.memory ?? { accumulateBytes: 0, rssBytes: 0 },
    mts,
  };
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
    if (context.forceGc) {
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

function analyzePageMetrics(context: MemoryDataContext, issues: MemoryIssue[]): void {
  const completedGroups = new Set<string>();
  for (const page of context.pages) {
    page.analysis.componentChart = createPageComponentChart(context, page);
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
      groupPage.analysis.mtsPool = {
        mtsPoolDeltaBytes,
        startTsMs: groupPage.realCreateTsMs,
        endTsMs: poolEndTsMs,
        confidence: 'high',
      };
      if (mtsPoolDeltaBytes > MTS_POOL_GROWTH_BYTES) {
        addIssue(issues, {
          code: 'mts_pool_growth',
          title: 'MTS 虚拟机缓存池增长过多',
          message: `页面生命期内 MTS VM Pool RSS 增长 ${mtsPoolDeltaBytes} bytes，超过 3 MiB。`,
          confidence: 'high',
          instanceIds: [groupPage.instanceId],
          valueBytes: mtsPoolDeltaBytes,
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
      if (context.forceGc) {
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
      const confidence = context.forceGc ? (deltaBytes < 0 ? 'low' : 'high') : 'low';
      let message = '';
      if (deltaBytes < 0) {
        message = '页面退出后 PSS 低于页面创建前水位，存在其它内存下降因素。';
      } else if (deltaBytes < PAGE_ROLLBACK_BYTES) {
        message = '页面创建并销毁后 PSS 上涨不明显，内存泄漏概率较低。';
      } else {
        message = context.forceGc
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
        forcedGc: context.forceGc,
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
}

function findSnapshotPairs(context: MemoryDataContext, event: SharedBtsLeakEvent, vm: MemoryVm): void {
  const snapshots = context.snapshots.filter((snapshot) => snapshot.assignedVmId === vm.id);
  const vmPages = context.pages.filter((page) => vm.instanceIds.includes(page.instanceId));
  const pre = snapshots
    .filter((snapshot) => {
      if (snapshot.willTsMs >= event.gcEndTsMs) {
        return false;
      }
      const created = vmPages.filter(
        (page) =>
          page.btsCreateTsMs !== undefined &&
          page.btsCreateTsMs >= snapshot.willTsMs &&
          page.btsCreateTsMs <= event.gcEndTsMs,
      );
      return created.every((page) => event.instanceIds.includes(page.instanceId));
    })
    .sort((a, b) => b.willTsMs - a.willTsMs)[0];
  const post = snapshots
    .filter((snapshot) => {
      if (snapshot.willTsMs <= event.gcEndTsMs) {
        return false;
      }
      return !vmPages.some(
        (page) =>
          page.btsCreateTsMs !== undefined &&
          page.btsCreateTsMs >= event.gcEndTsMs &&
          page.btsCreateTsMs <= snapshot.willTsMs,
      );
    })
    .sort((a, b) => a.willTsMs - b.willTsMs)[0];
  event.preSnapshotId = pre?.snapshotId;
  event.postSnapshotId = post?.snapshotId;
  event.analysable = pre !== undefined && post !== undefined;
}

function analyzeSharedBtsLeaks(
  context: MemoryDataContext,
  issues: MemoryIssue[],
): { events: SharedBtsLeakEvent[]; analysable: SharedBtsLeakEvent[] } {
  if (!context.forceGc) {
    return { events: [], analysable: [] };
  }
  const events: SharedBtsLeakEvent[] = [];
  const processedCycles = new Set<string>();
  for (const vm of context.vms.filter((item) => item.kind === 'bts' && item.shared && item.supportsMemory)) {
    const vmPages = context.pages.filter((page) => vm.instanceIds.includes(page.instanceId));
    const createPages = vmPages
      .filter((page): page is MemoryPage & { btsCreateTsMs: number } => page.btsCreateTsMs !== undefined)
      .sort((a, b) => b.btsCreateTsMs - a.btsCreateTsMs);
    for (const gcEvent of context.gcEvents) {
      const gcTsMs = gcEvent.endTsMs;
      const gcEndTsMs = gcSettledTsMs(gcEvent);
      if (gcEndTsMs > context.traceEndMs) {
        continue;
      }
      const endSet = sharedBtsLoadedPagesAt(context, vm, gcEndTsMs);
      const beginPage = createPages.find(
        (page) =>
          page.btsCreateTsMs < gcTsMs &&
          sameNumberSet(sharedBtsLoadedPagesBeforeBtsCreate(context, vm, page.btsCreateTsMs), endSet),
      );
      if (!beginPage) {
        continue;
      }
      const instanceIds = vmPages
        .filter(
          (page) =>
            page.btsCreateTsMs !== undefined &&
            page.btsDestroyTsMs !== undefined &&
            page.btsCreateTsMs >= beginPage.btsCreateTsMs &&
            page.btsDestroyTsMs <= gcEndTsMs,
        )
        .map((page) => page.instanceId)
        .sort((a, b) => a - b);
      if (instanceIds.length === 0) {
        continue;
      }
      const cycleKey = `${vm.id}:${instanceIds.join(',')}`;
      if (processedCycles.has(cycleKey)) {
        continue;
      }
      processedCycles.add(cycleKey);
      const beginMemory = vmMemoryAt(context, vm, beginPage.btsCreateTsMs);
      const endMemory = vmMemoryAt(context, vm, gcEndTsMs);
      const accumulateDeltaBytes = endMemory.accumulateBytes - beginMemory.accumulateBytes;
      const rssDeltaBytes = endMemory.rssBytes - beginMemory.rssBytes;
      const issue = accumulateDeltaBytes >= SHARED_BTS_LEAK_BYTES;
      const leakEvent: SharedBtsLeakEvent = {
        id: `${vm.id}_${Math.round(gcTsMs)}`,
        vmId: vm.id,
        instanceIds,
        beginTsMs: beginPage.btsCreateTsMs,
        gcTsMs,
        gcEndTsMs,
        accumulateDeltaBytes,
        rssDeltaBytes,
        confidence: 'medium',
        issue,
        analysable: false,
      };
      findSnapshotPairs(context, leakEvent, vm);
      events.push(leakEvent);
      for (const instanceId of instanceIds) {
        context.pages.find((page) => page.instanceId === instanceId)?.analysis.sharedBtsLeaks.push(leakEvent);
      }
      if (issue) {
        addIssue(issues, {
          code: 'shared_bts_possible_leak',
          title: '共享 BTS 虚拟机可能存在内存泄漏',
          message: `页面退出并完成 GC 后，共享 BTS Accumulate 增长 ${accumulateDeltaBytes} bytes。`,
          confidence: 'medium',
          instanceIds,
          vmId: vm.id,
          valueBytes: accumulateDeltaBytes,
        });
      }
    }
  }

  const singlePageIssueEvents = events.filter((event) => event.issue && event.instanceIds.length === 1);
  const byUrl = new Map<string, SharedBtsLeakEvent[]>();
  for (const event of singlePageIssueEvents) {
    const page = context.pages.find((item) => item.instanceId === event.instanceIds[0]);
    if (!page?.url || page.repeatedFocusTotal === undefined) {
      continue;
    }
    const current = byUrl.get(page.url) ?? [];
    current.push(event);
    byUrl.set(page.url, current);
  }
  for (const [url, urlEvents] of byUrl) {
    urlEvents.sort((a, b) => a.beginTsMs - b.beginTsMs);
    const first = urlEvents[0];
    if (!first) {
      continue;
    }
    const allPageRuns = context.pages
      .filter((page) => page.url === url && page.repeatedFocusTotal !== undefined)
      .sort((a, b) => a.realCreateTsMs - b.realCreateTsMs);
    const allEvents = allPageRuns
      .map((page) => events.find((event) => event.instanceIds.length === 1 && event.instanceIds[0] === page.instanceId))
      .filter((event): event is SharedBtsLeakEvent => event !== undefined);
    const firstDominates =
      allEvents.length > 1 &&
      first.issue &&
      allEvents
        .slice(1)
        .every((event) => Math.abs(first.accumulateDeltaBytes) >= 10 * Math.abs(event.accumulateDeltaBytes));
    if (firstDominates) {
      addIssue(issues, {
        code: 'shared_bts_first_load_leak',
        title: '共享 BTS 首次加载泄漏',
        message: `页面 ${url} 首次加载后的 Accumulate 增量为 ${first.accumulateDeltaBytes} bytes，至少是后续每次的 10 倍。`,
        confidence: 'high',
        instanceIds: first.instanceIds,
        vmId: first.vmId,
        valueBytes: first.accumulateDeltaBytes,
      });
    } else if (allEvents.length === allPageRuns.length && allEvents.every((event) => event.issue)) {
      addIssue(issues, {
        code: 'shared_bts_continuous_leak',
        title: '共享 BTS 连续泄漏',
        message: `页面 ${url} 每次加载后均出现 Accumulate 增长：${allEvents
          .map((event) => event.accumulateDeltaBytes)
          .join(', ')} bytes。`,
        confidence: 'high',
        instanceIds: allEvents.flatMap((event) => event.instanceIds),
        vmId: first.vmId,
      });
    }
  }
  return { events, analysable: events.filter((event) => event.issue && event.analysable) };
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
  const forceGc = ['1', 'true'].includes((traceArgs.get('debug.memory_trace_force_gc') ?? '').toLowerCase());
  const pages = buildPages(events, trackData.tracks, trackData.samples, bounds.startMs, bounds.endMs, options);
  const vms = buildVms(events, pages, bounds.startMs);
  const warnings: string[] = [];
  warnings.push(...assignBtsMemoryTracks(vms, btsMemoryTracks, bounds.endMs));
  classifyPages(pages, bounds.endMs);
  if (!forceGc) {
    warnings.push('当前 Trace 未开启 memory_trace_force_gc，页面退出后的回落分析仅为低置信度参考。');
  }
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
    forceGc,
    events,
    tracks: trackData.tracks,
    samples: trackData.samples,
    btsMemoryTracks,
    pages,
    vms,
    snapshots: buildSnapshots(events, vms),
    gcEvents: events.filter((event) => event.name === 'RunGC'),
    pssTracks,
    poolStates,
    warnings,
  };
}

export async function queryVMMemory(traceQuery: TraceQuery, request: VMMemoryQuery): Promise<MemoryValue> {
  const context = await loadMemoryData(traceQuery, {});
  const vm =
    request.kind === 'mts'
      ? context.vms.find((item) => item.kind === 'mts' && item.instanceIds.includes(request.instanceId ?? -1))
      : context.vms.find(
          (item) =>
            item.kind === 'bts' && item.name === request.vmName && item.generation === (request.generation ?? 0),
        );
  return vm ? vmMemoryAt(context, vm, request.tsMs) : { accumulateBytes: 0, rssBytes: 0 };
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
      schemaVersion: 2,
      valid: false,
      error,
      options,
      trace: {
        startTsMs: context.traceStartMs,
        endTsMs: context.traceEndMs,
        memoryTraceEnabled: false,
        forceGc: context.forceGc,
        processUpids,
      },
      pages: context.pages,
      vms: context.vms,
      snapshots: context.snapshots,
      sharedBtsHeapCharts: [],
      sharedBtsVmAnalyses: [],
      sharedBtsLeakEvents: [],
      analysableLeakEvents: [],
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
      },
    };
  }

  const supportedBtsVms = context.vms.filter((vm) => vm.kind === 'bts' && vm.supportsMemory);
  if (context.vms.some((vm) => vm.kind === 'bts') && supportedBtsVms.length === 0) {
    context.warnings.push('所有 BTS 虚拟机均没有可用的 bts_vm_acc_* 内存轨道，或 VM 类型不支持内存上报。');
  }
  const issues: MemoryIssue[] = [];
  analyzePageMetrics(context, issues);
  const leakAnalysis = analyzeSharedBtsLeaks(context, issues);
  const sharedBtsVmAnalysis = buildSharedBtsVmAnalyses(context, leakAnalysis.events, issues);
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
    schemaVersion: 2,
    valid: true,
    options,
    trace: {
      startTsMs: context.traceStartMs,
      endTsMs: context.traceEndMs,
      memoryTraceEnabled: true,
      forceGc: context.forceGc,
      processUpids,
    },
    pages: context.pages,
    vms: context.vms,
    snapshots: context.snapshots,
    sharedBtsHeapCharts: sharedBtsVmAnalysis.charts,
    sharedBtsVmAnalyses: sharedBtsVmAnalysis.analyses,
    sharedBtsLeakEvents: leakAnalysis.events,
    analysableLeakEvents: leakAnalysis.analysable,
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
    },
  };
}
