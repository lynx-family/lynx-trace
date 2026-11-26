// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import type {
  MemoryChart,
  MemoryChartSeries,
  MemoryPage,
  MemorySeriesPoint,
  MemoryText,
} from '../types/memory_analysis';
import type { TraceQuery } from '../utils/trace_query';

export interface GraphicComponent {
  category: string;
  sizeBytes: unknown;
  detail: Record<string, unknown>;
  appId: string;
}

export interface GraphicSample {
  id: number;
  tsMs: number;
  totalBytes: number;
  graphics: GraphicComponent[];
}

export function parseGraphicComponent(json: string, key: string): GraphicComponent | undefined {
  const raw = JSON.parse(json) as Record<string, unknown>;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const category =
    typeof raw['category'] === 'string'
      ? raw['category']
      : raw['category'] === undefined
        ? key.replace(/^debug\./, '')
        : '';
  if (!/canvas|animax/i.test(category)) return undefined;
  const detail =
    raw['detail'] && typeof raw['detail'] === 'object' && !Array.isArray(raw['detail'])
      ? (raw['detail'] as Record<string, unknown>)
      : {};
  return {
    category,
    sizeBytes: raw['sizeBytes'],
    detail,
    appId: String(detail['krypton.app_id'] ?? raw['canvasAppId'] ?? 'page'),
  };
}

function measurement(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+(?:\.0+)?$/.test(value))) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

function point(tsMs: number, counterId: number, rawValues: unknown[]): MemorySeriesPoint {
  const values = rawValues.map(measurement);
  const first = values[0];
  const unavailable =
    values.length === 0
      ? 'missing'
      : values.some((v) => v === undefined)
        ? 'invalid or missing'
        : values.some((v) => v !== first)
          ? 'conflicting duplicate reports'
          : undefined;
  return { tsMs, sourceTsMs: tsMs, counterId, value: unavailable ? 0 : first!, unavailable, rawValues };
}

const resources: Record<string, MemoryText> = {
  canvas_element: { zh: 'Canvas 元素', en: 'Canvas elements' },
  image_element: { zh: '图像元素', en: 'Image elements' },
  external_data: { zh: '外部数据', en: 'External data' },
  webgl_texture: { zh: 'WebGL 纹理', en: 'WebGL textures' },
  webgl_buffer: { zh: 'WebGL 缓冲区', en: 'WebGL buffers' },
  webgl_renderbuffer: { zh: 'WebGL 渲染缓冲区', en: 'WebGL renderbuffers' },
  webgl_generic: { zh: 'WebGL 对象', en: 'WebGL objects' },
  gl_surface: { zh: 'GL 表面', en: 'GL surfaces' },
  audio: { zh: '音频', en: 'Audio' },
  audio_buffer: { zh: '音频缓冲区', en: 'Audio buffers' },
  audio_sampler: { zh: '音频采样器', en: 'Audio samplers' },
  audio_node: { zh: '音频节点', en: 'Audio nodes' },
  video_element: { zh: '视频元素', en: 'Video elements' },
  video_context: { zh: '视频上下文', en: 'Video contexts' },
  total: { zh: '对象总数', en: 'Total objects' },
};
const globalResources: Record<string, string> = {
  Canvas: 'canvas_element',
  Image: 'image_element',
  ExternalData: 'external_data',
  WebGLTexture: 'webgl_texture',
  WebGLBuffer: 'webgl_buffer',
  WebGLRenderbuffer: 'webgl_renderbuffer',
  WebGLObject: 'webgl_generic',
  TotalSurface: 'gl_surface',
  TotalObj: 'total',
};
function label(name: string): MemoryText | undefined {
  const resource = name.startsWith('krypton.')
    ? name.split('.')[1]
    : globalResources[name.replace(/^Krypton|Mem$|Cnt$/g, '')];
  const text = resources[resource ?? ''];
  return text ? { zh: `${text.zh} · ${name}`, en: `${text.en} · ${name}` } : undefined;
}

function colorKey(name: string): string {
  return name.startsWith('krypton.')
    ? name.split('.')[1]!
    : (globalResources[name.replace(/^Krypton|Mem$|Cnt$/g, '')] ?? name);
}

function summarizeMemory(chart: MemoryChart, traceStartMs: number): void {
  const areas = chart.series.filter((series) => (series.renderMode ?? chart.renderMode) === 'stacked-area');
  const times = areas[0]?.points.map((p) => p.tsMs) ?? [];
  let peak = -1;
  let peakTs = 0;
  let last = 0;
  let reportTs = Number.NEGATIVE_INFINITY;
  let partial = false;
  for (let i = 0; i < times.length; i += 1) {
    const points = areas.map((s) => s.points[i]).filter((p): p is MemorySeriesPoint => !!p && !p.unavailable);
    if (!points.length) continue;
    const sum = points.reduce((total, p) => total + p.value, 0);
    if (sum > peak) {
      peak = sum;
      peakTs = times[i]!;
      partial = points.length !== areas.length || points.some((p) => p.partial);
    }
    last = sum;
    reportTs = Math.max(reportTs, ...points.flatMap((p) => (p.sourceTsMs === undefined ? [] : [p.sourceTsMs])));
  }
  if (peak < 0) return;
  chart.graphics!.notes.unshift({
    zh: `已知分量合计峰值 ${(peak / 1048576).toFixed(2)} MiB（${peak.toLocaleString('en-US')} B），t=${((peakTs - traceStartMs) / 1000).toFixed(3)}s${partial ? '，此时分量覆盖不完整' : ''}；观察末尾保持值 ${(last / 1048576).toFixed(2)} MiB，最近来源上报 ${Number.isFinite(reportTs) ? `t=${((reportTs - traceStartMs) / 1000).toFixed(3)}s` : '未知'}。`,
    en: `Known-part peak ${(peak / 1048576).toFixed(2)} MiB (${peak.toLocaleString('en-US')} B) at t=${((peakTs - traceStartMs) / 1000).toFixed(3)}s${partial ? ', with partial coverage' : ''}; held value at observation end ${(last / 1048576).toFixed(2)} MiB, latest source report ${Number.isFinite(reportTs) ? `t=${((reportTs - traceStartMs) / 1000).toFixed(3)}s` : 'unknown'}.`,
  });
}

const estimateNote: MemoryText = {
  zh: '资源统计/估算不可与 PSS 或 VM 内存相加，也不能单独证明泄漏。首报前及缺失字段为未知；有效值保持至下次上报或观察结束。占比基于全部已知分量，不随图例隐藏而变化。',
  en: 'Resource statistics/estimates are not additive to PSS or VM memory and do not alone establish leaks. Values are unknown before first reporting and at missing fields; valid values are held until the next report or observation end. Percentages use all known parts regardless of hidden legends.',
};

/** Align each independent stream by LOCF; never borrow a future observation. */
export function alignGraphicSeries(series: MemoryChartSeries[], endTsMs: number): MemoryChartSeries[] {
  const times = [...new Set([...series.flatMap((s) => s.points.map((p) => p.tsMs)), endTsMs])].sort((a, b) => a - b);
  return series.map((s) => {
    let index = -1;
    return {
      ...s,
      points: times.map((tsMs) => {
        while (index + 1 < s.points.length && s.points[index + 1]!.tsMs <= tsMs) index += 1;
        const previous = s.points[index];
        return previous ? { ...previous, tsMs } : { tsMs, value: 0, unavailable: 'not yet reported' };
      }),
    };
  });
}

export function createPageGraphicCharts(
  page: MemoryPage,
  rawSamples: GraphicSample[],
  traceEndMs: number,
  traceStartMs = 0,
): void {
  const start = page.realCreateTsMs;
  const end = Math.min(page.shellDestroyTsMs ?? traceEndMs, traceEndMs);
  const samples = rawSamples.filter((s) => s.tsMs >= start && s.tsMs <= end);
  const components = samples.flatMap((s) => s.graphics);
  if (!components.length) return;
  const canvas = components.filter((c) => /canvas/i.test(c.category));
  const keys = [...new Set(canvas.flatMap((c) => Object.keys(c.detail)))].sort();
  const animax = [...new Set(components.filter((c) => !/canvas/i.test(c.category)).map((c) => c.category))].sort();
  const notes: MemoryText[] = [estimateNote];
  if (canvas.length)
    notes.push({
      zh: 'Canvas 同一页面/App 的明细按资源键去重；不使用按组件重复累加的 sizeBytes，也不乘除 instanceCount。App estimated_bytes 仅作对照，不叠加。',
      en: 'Canvas detail is deduplicated per page/App and resource key. Aggregated sizeBytes and instanceCount are not used. App estimated_bytes is a comparison only, outside the stack.',
    });
  if (animax.length)
    notes.push({
      zh: 'AnimaX sizeBytes 已汇总各 Player，仅计一次。其值包含资源估算与固定开销，Player 缓存估算；已核实实现仅在渲染缩放变化时重算，初始零可能尚未估算。',
      en: 'AnimaX sizeBytes already sums Players and is counted once. It includes resource estimates and fixed overhead. Players cache estimates; the verified implementation recomputes on rendering scale changes. Initial zero may mean not yet estimated.',
    });
  notes.push({
    zh: '页面 counter 可重复携带缓存字段，时间表示上报时刻，不保证重新测量。退出 memory=0 且无明细是 reporter 清理，不能视作资源释放；单次有效上报只显示观察值，不判断趋势。',
    en: 'Page counters may repeat cached fields; timestamps are report times, not necessarily fresh measurements. Exit memory=0 without detail clears the reporter and does not measure resource release. A single observation does not establish a trend.',
  });
  const usable = samples.filter((s) => s.totalBytes !== 0 || s.graphics.length > 0);
  const appIds = [...new Set(canvas.map((c) => c.appId))];
  const makeSeries = (name: string, unit: 'bytes' | 'count', isAnimax = false): MemoryChartSeries => ({
    name,
    label: isAnimax ? undefined : label(name),
    colorKey: colorKey(name),
    unit,
    points: usable.map((s) => {
      if (isAnimax)
        return point(
          s.tsMs,
          s.id,
          s.graphics.filter((c) => c.category === name).map((c) => c.sizeBytes),
        );
      const apps = appIds.map((appId) =>
        point(
          s.tsMs,
          s.id,
          s.graphics
            .filter(
              (c) =>
                /canvas/i.test(c.category) && c.appId === appId && Object.prototype.hasOwnProperty.call(c.detail, name),
            )
            .map((c) => c.detail[name]),
        ),
      );
      const missing = apps.find((p) => p.unavailable);
      return {
        tsMs: s.tsMs,
        sourceTsMs: s.tsMs,
        counterId: s.id,
        value: missing ? 0 : apps.reduce((sum, p) => sum + p.value, 0),
        unavailable: missing?.unavailable,
        rawValues: apps.flatMap((p) => p.rawValues ?? []),
      };
    }),
  });
  const bytes = keys.filter((k) => k.startsWith('krypton.') && k.endsWith('.bytes')).map((k) => makeSeries(k, 'bytes'));
  bytes.push(...animax.map((k) => makeSeries(k, 'bytes', true)));
  const comparisons = keys.includes('krypton.total.estimated_bytes')
    ? [makeSeries('krypton.total.estimated_bytes', 'bytes')]
    : [];
  page.analysis.graphicMemoryChart = {
    id: `page_${page.instanceId}_graphics`,
    title: 'Graphic Component Memory Usage',
    xStartTsMs: start,
    xEndTsMs: end,
    zeroBaseline: true,
    renderMode: 'stacked-area',
    series: alignGraphicSeries(bytes, end),
    graphics: { notes, comparisons: alignGraphicSeries(comparisons, end) },
  };
  summarizeMemory(page.analysis.graphicMemoryChart, traceStartMs);
  if (canvas.length)
    page.analysis.canvasResourceChart = {
      id: `page_${page.instanceId}_canvas_counts`,
      title: 'Canvas Graphics Resource Counts',
      xStartTsMs: start,
      xEndTsMs: end,
      zeroBaseline: true,
      series: alignGraphicSeries(
        keys
          .filter((k) => k.startsWith('krypton.') && (k.endsWith('.count') || k === 'krypton.total.object_count'))
          .map((k) => makeSeries(k, 'count')),
        end,
      ),
      graphics: {
        notes: [
          estimateNote,
          {
            zh: '资源 count 与组件 instanceCount 不同。对象总数、WebGL 总类和子类存在包含关系，不能堆叠或求和。',
            en: 'Resource counts differ from UI instanceCount. Total objects, WebGL generic objects and subtypes overlap; they must not be stacked or summed.',
          },
        ],
      },
    };
}

function isAnimaxSeries(series: MemoryChartSeries): boolean {
  return /animax/i.test(series.name) && !series.name.startsWith('krypton.');
}

/** Sum each category across active pages; page exit removes its contribution, not a measured release. */
function aggregateAnimaxSeries(pages: MemoryPage[], start: number, end: number): MemoryChartSeries[] {
  const categories = new Set(
    pages.flatMap((page) =>
      (page.analysis.graphicMemoryChart?.series ?? []).filter(isAnimaxSeries).map((series) => series.name),
    ),
  );
  return [...categories].sort().map((name) => {
    const inputs = pages.flatMap((page) => {
      const series = page.analysis.graphicMemoryChart?.series.find((s) => s.name === name);
      return series
        ? [
            {
              page,
              series,
              index: -1,
              start: Math.max(start, page.createTsMs ?? start),
              end: Math.min(end, page.shellDestroyTsMs ?? end),
            },
          ]
        : [];
    });
    const times = [
      ...new Set([
        start,
        end,
        ...inputs.flatMap((input) => [input.start, input.end, ...input.series.points.map((p) => p.tsMs)]),
      ]),
    ]
      .filter((ts) => ts >= start && ts <= end)
      .sort((a, b) => a - b);
    return {
      name,
      colorKey: name,
      unit: 'bytes',
      points: times.map((tsMs) => {
        const active = inputs.filter(
          (input) =>
            tsMs >= input.start && (tsMs < input.end || (tsMs === end && input.page.shellDestroyTsMs === undefined)),
        );
        const observations = active.map((input) => {
          while (input.index + 1 < input.series.points.length && input.series.points[input.index + 1]!.tsMs <= tsMs)
            input.index += 1;
          return input.series.points[input.index];
        });
        const known = observations.filter((p): p is MemorySeriesPoint => !!p && !p.unavailable);
        const missing = known.length !== active.length;
        return {
          tsMs,
          value: known.reduce((sum, p) => sum + p.value, 0),
          unavailable: active.length > 0 && known.length === 0 ? 'active page estimates unavailable' : undefined,
          partial: missing || known.some((p) => p.partial),
          instanceIds: active.map((input) => input.page.instanceId),
          ...(known.length ? { sourceTsMs: Math.max(...known.map((p) => p.sourceTsMs ?? p.tsMs)) } : {}),
        };
      }),
    };
  });
}

function graphicComparison(krypton: MemoryChartSeries, animax: MemoryChartSeries[], end: number): MemoryChartSeries {
  const aligned = alignGraphicSeries([krypton, ...animax], end);
  return {
    name: 'Graphic Total Estimate',
    label: { zh: 'Graphic总估算（Krypton + AnimaX）', en: 'Graphic total estimate (Krypton + AnimaX)' },
    unit: 'bytes',
    points: aligned[0]!.points.map((_, index) => {
      const points = aligned.map((series) => series.points[index]!);
      const known = points.filter((p) => !p.unavailable);
      return {
        tsMs: points[0]!.tsMs,
        value: known.reduce((sum, p) => sum + p.value, 0),
        unavailable: known.length === 0 ? 'estimates unavailable' : undefined,
        partial: known.length !== points.length || known.some((p) => p.partial),
      };
    }),
  };
}

export async function queryKryptonCharts(traceQuery: TraceQuery, start: number, end: number, pages: MemoryPage[] = []) {
  const rows = await traceQuery.query(`
    SELECT ct.id track_id, ct.name, pct.upid, c.id counter_id, c.ts, c.value
    FROM counter_track ct
    LEFT JOIN process_counter_track pct ON pct.id = ct.id
    LEFT JOIN counter c ON c.track_id = ct.id
    WHERE ct.name GLOB 'Krypton*' OR ct.name = 'summary.graphics'
    ORDER BY ct.id, c.ts, c.id
  `);
  const groups = new Map<
    string,
    { processUpid?: number; tracks: Map<number, MemoryChartSeries>; pages: MemoryPage[] }
  >();
  const graphicsTracks = new Map<number, MemoryChartSeries[]>();
  for (const row of rows) {
    const name = String(row['name']);
    if (name === 'summary.graphics') {
      if (row['upid'] == null) continue;
      const upid = Number(row['upid']);
      const tracks = graphicsTracks.get(upid) ?? [];
      graphicsTracks.set(upid, tracks);
      const trackId = Number(row['track_id']);
      let series = tracks.find((s) => s.trackId === trackId);
      if (!series) {
        series = {
          name,
          label: { zh: '系统图形内存 · summary.graphics', en: 'System graphics memory · summary.graphics' },
          trackId,
          unit: 'bytes',
          renderMode: 'line',
          interpolation: 'linear',
          color: '#dc2626',
          points: [],
        };
        tracks.push(series);
      }
      if (row['ts'] != null)
        series.points.push(point(Number(row['ts']) / 1e6, Number(row['counter_id']), [row['value']]));
      continue;
    }
    if (!/(Mem|Cnt)$/.test(name) && name !== 'KryptonTotalMemEst') continue;
    const processUpid = row['upid'] == null ? undefined : Number(row['upid']);
    // Unknown process tracks are not safe to merge.
    const key = processUpid === undefined ? `unknown_${row['track_id']}` : String(processUpid);
    const group = groups.get(key) ?? { processUpid, tracks: new Map<number, MemoryChartSeries>(), pages: [] };
    groups.set(key, group);
    const trackId = Number(row['track_id']);
    const series = group.tracks.get(trackId) ?? {
      name,
      label: label(name),
      colorKey: colorKey(name),
      trackId,
      unit: name.endsWith('Cnt') ? 'count' : 'bytes',
      points: [],
    };
    group.tracks.set(trackId, series);
    if (row['ts'] != null)
      series.points.push(point(Number(row['ts']) / 1e6, Number(row['counter_id']), [row['value']]));
  }
  // Page estimates are independent of page selection, but require a matching global Krypton group.
  for (const page of pages) {
    if (!page.analysis.graphicMemoryChart?.series.some(isAnimaxSeries)) continue;
    if (page.processUpid !== undefined) groups.get(String(page.processUpid))?.pages.push(page);
  }
  return [...groups].map(([key, group]) => {
    const tracks = [...group.tracks.values()].sort((a, b) => a.name.localeCompare(b.name));
    const names = tracks.map((s) => s.name);
    const ambiguous = [...new Set(names.filter((name, i) => names.indexOf(name) !== i))];
    const unique = tracks.filter((s) => !ambiguous.includes(s.name));
    const animax = aggregateAnimaxSeries(group.pages, start, end);
    const notes: MemoryText[] = [
      estimateNote,
      {
        zh: '各轨道独立异步上报，按各自最近一次观测对齐；KryptonTotalMemEst 仅作独立对照。进程全局记录独立于页面/App，不要求等于页面之和；生命周期气泡仅作背景，不提供页面归因。',
        en: 'Tracks report asynchronously and are aligned by their own latest observations. KryptonTotalMemEst is an independent comparison. Process recording is separate from page/App bookkeeping and need not equal page sums. Lifecycle bubbles provide context, not page attribution.',
      },
    ];
    if (ambiguous.length)
      notes.push({
        zh: `同进程同名轨道归属不明，以下资源不可用：${ambiguous.join(', ')}`,
        en: `Ambiguous same-name tracks in this process are unavailable: ${ambiguous.join(', ')}`,
      });
    const memoryNotes = [...notes];
    if (animax.length)
      memoryNotes.push({
        zh: 'Graphic 合计与占比包含 Krypton 内存分量及同进程 AnimaX 页面估算。同名 AnimaX 类别按存活页面求和，每页 sizeBytes 只计一次；首报前及缺失值为未知，页面退出后不再计入该页估算，这不代表已测得实际释放。Graphic 总估算对照为 KryptonTotalMemEst 加 AnimaX；部分来源缺失时只显示已知部分。AnimaX 值可能来自 Player 缓存。',
        en: 'Graphic sums and shares include Krypton memory components and AnimaX page estimates in the same process. Each AnimaX category sums active pages, counting each page sizeBytes once. Values are unknown before reporting or when missing; page exit removes its estimate without measuring actual release. The Graphic total estimate comparison adds AnimaX to KryptonTotalMemEst; missing sources yield known-part values only. AnimaX values may be cached by Players.',
      });
    const comparisons = unique.filter((s) => s.name === 'KryptonTotalMemEst');
    if (animax.length && comparisons[0]) comparisons.push(graphicComparison(comparisons[0], animax, end));
    const base = { xStartTsMs: start, xEndTsMs: end, zeroBaseline: true, events: [] };
    const memoryChart: MemoryChart = {
      ...base,
      id: `krypton_${key}_memory`,
      title: 'Graphic Resource Memory',
      renderMode: 'stacked-area',
      series: alignGraphicSeries([...unique.filter((s) => s.name.endsWith('Mem')), ...animax], end),
      graphics: {
        notes: memoryNotes,
        filterPageEvents: true,
        comparisons: alignGraphicSeries(comparisons, end),
      },
    };
    const overlays = group.processUpid === undefined ? [] : (graphicsTracks.get(group.processUpid) ?? []);
    if (overlays.length === 1) {
      memoryChart.series.push(...alignGraphicSeries(overlays, end));
      memoryNotes.push({
        zh: '红色细折线 summary.graphics 为系统上报的进程图形内存，独立于资源估算；使用相同 bytes 纵轴，不计入面积合计、占比、资源峰值或 Graphic 总估算。折线随原始采样连接，首报前未知。',
        en: 'The thin red summary.graphics line is system-reported process graphics memory, independent of resource estimates. It shares the bytes axis but is excluded from area sums, shares, resource peaks and the Graphic total estimate. The line connects observed samples and is unknown before the first report.',
      });
    } else if (overlays.length > 1) {
      memoryNotes.push({
        zh: '同进程存在多条 summary.graphics 轨道，无法唯一匹配，未叠加系统图形内存折线。',
        en: 'Multiple summary.graphics tracks in this process prevent unique matching; the system graphics line is omitted.',
      });
    }
    const countChart: MemoryChart = {
      ...base,
      id: `krypton_${key}_counts`,
      title: 'Krypton Graphics Resource Counts',
      series: alignGraphicSeries(
        unique.filter((s) => s.unit === 'count'),
        end,
      ),
      graphics: {
        notes: [...notes, { zh: '计数范围存在重叠，不求和。', en: 'Count scopes overlap and are not summed.' }],
        filterPageEvents: true,
      },
    };
    summarizeMemory(memoryChart, start);
    return { processUpid: group.processUpid, memoryChart, countChart };
  });
}
