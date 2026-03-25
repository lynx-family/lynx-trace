// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { NS_TO_MS } from '../utils/constant';
import { TraceQuery } from '../utils/trace_query';

interface MetricsQueryResult {
  id: number;
  track_id: number;
  ts: number;
  event_name: string;
  thread_name: string;
  timing_flags: string;
  instance_id: string;
  metric_key: string;
  pipeline_id: string;
}

export interface Metrics {
  id: number;
  track_id: number;
  metrics_name: string;
  start_ts_ms: string;
  thread_name: string;
  end_ts_ms?: string;
  duration_ms: string;
  children?: Metrics[];
}

export interface PipelineMetrics {
  timing_flags: string;
  details: Metrics[];
  start_ts_ms: string;
  // total_cost_ms: string;
  origin?: string;
  // wait_to_trigger_cost_ms?: string;
  after_trigger_cost_ms?: string;
  warn?: string;
}

export interface MetricsResponse {
  url: string;
  metrics: PipelineMetrics[];
}

export async function queryMetrics(traceQuery: TraceQuery): Promise<MetricsResponse[]> {
  const sql = `
    SELECT 
      s.id, s.track_id, s.ts, s.dur, s.name as event_name, t.name as thread_name, t.tid as tid,
      GROUP_CONCAT(
        CASE 
          WHEN a.key = 'debug.timing_flags' THEN a.display_value 
          ELSE NULL 
        END
      ) as timing_flags,
      GROUP_CONCAT(
        CASE 
          WHEN a.key = 'debug.instance_id' THEN a.display_value 
          ELSE NULL 
        END
      ) as instance_id,
      GROUP_CONCAT(
        CASE 
          WHEN a.key = 'debug.timing_key' THEN a.display_value 
          ELSE NULL 
        END
      ) as metric_key,
      GROUP_CONCAT(
        CASE 
          WHEN a.key = 'debug.pipeline_id' THEN a.display_value 
          ELSE NULL 
        END
      ) as pipeline_id
    FROM slice s
    JOIN args a ON s.arg_set_id = a.arg_set_id
    JOIN thread_track tt ON s.track_id = tt.id JOIN thread t ON tt.utid = t.utid
    WHERE s.name LIKE 'Timing::Mark%'
    GROUP BY s.id, s.name, s.arg_set_id
    order by s.ts;
  `;

  const result = await traceQuery.query(sql);

  const instanceInfoMap = await getInstanceInfoMap(traceQuery);

  const transformedResults: MetricsQueryResult[] = result.map((item: any) => ({
    id: item.id,
    track_id: item.track_id,
    ts: item.ts,
    event_name: item.event_name,
    thread_name: item.thread_name ?? `Thread ${item.tid}`,
    timing_flags: item.timing_flags,
    instance_id: item.instance_id,
    metric_key: item.metric_key,
    pipeline_id: item.pipeline_id,
  }));

  const pipelineFlagMap = new Map<string, string>();

  for (const metric of transformedResults) {
    if (metric.pipeline_id && metric.timing_flags) {
      pipelineFlagMap.set(metric.pipeline_id, metric.timing_flags);
    }
  }

  const pipelineInstanceIdMap = new Map<string, string>();
  for (const metric of transformedResults) {
    if (metric.instance_id && metric.pipeline_id) {
      pipelineInstanceIdMap.set(metric.pipeline_id, metric.instance_id);
    }
  }

  for (const metric of transformedResults) {
    if (!metric.instance_id && metric.pipeline_id && pipelineInstanceIdMap.has(metric.pipeline_id)) {
      metric.instance_id = pipelineInstanceIdMap.get(metric.pipeline_id)!;
    }
  }

  const filteredResults = transformedResults.filter((metric) => metric.instance_id);

  if (filteredResults.length === 0) {
    throw new Error("Can't Get Metrics Info");
  }

  const aggregatedByInstance = new Map<string, Map<string, MetricsQueryResult[]>>();

  for (const metric of filteredResults) {
    const { instance_id, pipeline_id } = metric;

    if (!aggregatedByInstance.has(instance_id)) {
      aggregatedByInstance.set(instance_id, new Map<string, MetricsQueryResult[]>());
    }

    const instancePipelines = aggregatedByInstance.get(instance_id)!;

    if (!instancePipelines.has(pipeline_id)) {
      instancePipelines.set(pipeline_id, []);
    }

    instancePipelines.get(pipeline_id)!.push(metric);
  }
  const origins = await queryPipelineOrigins(traceQuery);
  const results: MetricsResponse[] = [];

  for (const [instanceId, instancePipelines] of aggregatedByInstance.entries()) {
    const metricsArray: PipelineMetrics[] = [];

    for (const [pipelineId, pipelineMetrics] of instancePipelines.entries()) {
      pipelineMetrics.sort((a, b) => a.ts - b.ts);
      const paintEnd = pipelineMetrics.find((metric) => metric.metric_key === 'paintEnd');
      const timing_flags = pipelineFlagMap.get(pipelineId) || '';
      if (pipelineMetrics.length <= 0 || pipelineMetrics[0] == undefined || !timing_flags) {
        continue;
      }
      const pipelineOrigin = origins.get(pipelineId);
      let start_ts = pipelineMetrics[0].ts;
      const analyzedPipeline = analyzeMetricKeys(pipelineMetrics);
      if (pipelineOrigin) {
        start_ts = pipelineOrigin.ts;
      }
      const start_ts_ms = start_ts / NS_TO_MS + 'ms';

      let metric: PipelineMetrics;
      let after_trigger_cost_ms: string;

      if (!paintEnd) {
        // Calculate cost using last event when no paintEnd is found
        const lastMetric = pipelineMetrics[pipelineMetrics.length - 1];
        const end_ts = lastMetric ? lastMetric.ts : start_ts;
        after_trigger_cost_ms = (end_ts - start_ts) / NS_TO_MS + 'ms';

        metric = {
          timing_flags,
          details: analyzedPipeline,
          start_ts_ms,
          after_trigger_cost_ms: after_trigger_cost_ms,
          origin: pipelineOrigin ? pipelineOrigin.origin : undefined,
          warn: 'Invaild timing flags, The pipeline corresponding to timing_flags did not cause UI update',
        };
      } else {
        // Normal case with paintEnd
        after_trigger_cost_ms = (paintEnd.ts - start_ts) / NS_TO_MS + 'ms';
        metric = {
          timing_flags,
          details: analyzedPipeline,
          start_ts_ms,
          after_trigger_cost_ms: after_trigger_cost_ms,
          origin: pipelineOrigin ? pipelineOrigin.origin : undefined,
        };
      }

      metricsArray.push(metric);
    }

    const url = `${instanceInfoMap[instanceId]} id: ${instanceId}`;
    results.push({ url, metrics: metricsArray });
  }

  return results;
}

function analyzeMetricKeys(metrics: MetricsQueryResult[]): Metrics[] {
  const startEvents = new Map<string, MetricsQueryResult>();
  const endEvents = new Map<string, MetricsQueryResult[]>();
  const analyzedMetrics: Metrics[] = [];

  for (const metric of metrics) {
    const metricKey = metric.metric_key;
    if (!metricKey) {
      continue;
    }

    const { normalizedKey, eventType } = normalizeMetricKey(metric.event_name, metricKey);

    if (eventType === 'start') {
      startEvents.set(normalizedKey, metric);
    } else if (eventType === 'end') {
      if (!endEvents.has(normalizedKey)) {
        endEvents.set(normalizedKey, []);
      }
      endEvents.get(normalizedKey)!.push(metric);
    } else {
      analyzedMetrics.push({
        id: metric.id,
        track_id: metric.track_id,
        thread_name: metric.thread_name,
        metrics_name: normalizedKey,
        start_ts_ms: metric.ts / NS_TO_MS + 'ms',
        duration_ms: '0ms',
      });
    }
  }

  for (const [normalizedKey, startEvent] of startEvents.entries()) {
    const endEventsForKey = endEvents.get(normalizedKey);
    if (endEventsForKey && endEventsForKey.length > 0 && endEventsForKey[0] !== undefined) {
      let latestEndEvent = endEventsForKey[0];
      for (const endEvent of endEventsForKey) {
        if (endEvent.ts > latestEndEvent.ts && endEvent.ts > startEvent.ts) {
          latestEndEvent = endEvent;
        }
      }

      if (latestEndEvent.ts > startEvent.ts) {
        const duration = latestEndEvent.ts - startEvent.ts;

        analyzedMetrics.push({
          id: startEvent.id,
          track_id: startEvent.track_id,
          thread_name: startEvent.thread_name,
          metrics_name: normalizedKey,
          start_ts_ms: startEvent.ts / NS_TO_MS + 'ms',
          end_ts_ms: latestEndEvent.ts / NS_TO_MS + 'ms',
          duration_ms: parseFloat((duration / NS_TO_MS).toFixed(1)) + 'ms',
        });
      }
    }
  }

  return buildMetricTree(analyzedMetrics);
}

function buildMetricTree(flatMetrics: Metrics[]): Metrics[] {
  const getStartTime = (m: Metrics) => parseFloat(m.start_ts_ms.replace('ms', ''));
  const getEndTime = (m: Metrics) => (m.end_ts_ms ? parseFloat(m.end_ts_ms.replace('ms', '')) : getStartTime(m));

  const sortedMetrics = [...flatMetrics].sort((a, b) => getStartTime(a) - getStartTime(b));

  const roots: Metrics[] = [];
  const stack: Metrics[] = [];

  for (const metric of sortedMetrics) {
    const metricEnd = getEndTime(metric);
    const metricWithChildren: Metrics = { ...metric, children: [] };

    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top === undefined) {
        break;
      }
      const topEnd = getEndTime(top!);

      if (metric.track_id === top.track_id && metricEnd <= topEnd) {
        top.children!.push(metricWithChildren);
        stack.push(metricWithChildren);
        break;
      }
      stack.pop();
    }

    if (stack.length === 0) {
      roots.push(metricWithChildren);
      stack.push(metricWithChildren);
    }
  }

  return roots;
}

function normalizeMetricKey(
  eventName: string,
  metricKey: string,
): { normalizedKey: string; eventType: 'start' | 'end' | 'single' } {
  let key = metricKey;
  if (eventName && eventName.startsWith('Timing::MarkHostPlatformTiming')) {
    key = 'platForm' + metricKey;
  }
  if (key === 'paintEnd') {
    return { normalizedKey: 'paintEnd', eventType: 'single' };
  }

  if (key.endsWith('Start')) {
    return {
      normalizedKey: key.slice(0, -5),
      eventType: 'start',
    };
  } else if (key.endsWith('End')) {
    return {
      normalizedKey: key.slice(0, -3),
      eventType: 'end',
    };
  }

  if (key.endsWith('_start')) {
    return {
      normalizedKey: key.slice(0, -6),
      eventType: 'start',
    };
  } else if (key.endsWith('_end')) {
    return {
      normalizedKey: key.slice(0, -4),
      eventType: 'end',
    };
  }

  return { normalizedKey: key, eventType: 'single' };
}

async function getInstanceInfoMap(traceQuery: TraceQuery): Promise<Record<string, string>> {
  const instanceInfoMap: Record<string, string> = {};
  const instanceInfoSql = `
      SELECT
      args.key as key,
      args.display_value as value
      FROM slice
      JOIN args ON slice.arg_set_id=args.arg_set_id
      WHERE slice.name='LynxLoadTemplate'
      ORDER BY slice.dur, slice.ts
  `;

  const instanceInfoResult = await traceQuery.query(instanceInfoSql);
  let url = '';
  let instanceId = '';

  for (const instanceInfo of instanceInfoResult) {
    if (instanceInfo['key'] === 'debug.url') {
      url = getBundleFromUrl(instanceInfo['value'] as string);
    } else if (instanceInfo['key'] === 'debug.instance_id') {
      instanceId = instanceInfo['value'] as string;
    }

    if (url && instanceId) {
      instanceInfoMap[instanceId] = url;
      url = '';
      instanceId = '';
    }
  }

  return instanceInfoMap;
}

async function queryPipelineOrigins(traceQuery: TraceQuery): Promise<Map<string, { ts: number; origin: string }>> {
  const sql = `
    SELECT 
      GROUP_CONCAT(
        CASE 
          WHEN a.key = 'debug.pipeline_id' THEN a.display_value 
          ELSE NULL 
        END
      ) as pipeline_id,
      GROUP_CONCAT(
        CASE 
          WHEN a.key = 'debug.pipeline_origin' THEN a.display_value 
          ELSE NULL 
        END
      ) as pipeline_origin,
      s.ts
    FROM slice s
    JOIN args a ON s.arg_set_id = a.arg_set_id
    WHERE s.name = 'Timing::OnPipelineStart'
    GROUP BY s.id, s.name, s.arg_set_id
    HAVING MAX(CASE WHEN a.key = 'debug.timing_flags' THEN 1 ELSE 0 END) = 1
    ORDER BY s.ts;
  `;

  const result = await traceQuery.query(sql);
  const pipelineToOrigin = new Map<string, { ts: number; origin: string }>();
  for (const item of result) {
    pipelineToOrigin.set(item['pipeline_id'], { ts: item['ts'], origin: item['pipeline_origin'] });
  }
  return pipelineToOrigin;
}

function getBundleFromUrl(url: string): string {
  const pattern1 = /\/([^/]+\/[^/]+)\/template\.js/;
  const match1 = url.match(pattern1);

  if (match1) {
    return match1[1] ?? '';
  }
  const pattern2 = /bundle=([^&]+)/;
  const match2 = url.match(pattern2);
  if (match2) {
    return match2[1] ?? '';
  }
  return url;
}
