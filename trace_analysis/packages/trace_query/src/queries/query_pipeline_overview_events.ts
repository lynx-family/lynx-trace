// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { TraceEvent } from '../types/trace_event';
import { getReadableTrace } from '../utils/readable_trace';
import { TraceQuery } from '../utils/trace_query';

export async function queryPipelineOverviewEvents(
  traceQuery: TraceQuery,
  pipeline_id: string,
  keepNonTopUpdateEvent: boolean = false,
): Promise<Record<string, any>> {
  const paintEndWithPipelineIdSql = `
      SELECT
      s.id AS id,
      s.ts AS ts,
      MAX(CASE WHEN a2.key = 'debug.pipeline_id' THEN a2.display_value END) AS pipeline_id,
      MAX(CASE WHEN a1.key = 'debug.timing_flags' THEN a1.display_value END) AS timing_flags,
      MAX(CASE WHEN a3.key = 'debug.instance_id' THEN a3.display_value END) AS instance_id
      FROM slice s
      JOIN args a1 ON s.arg_set_id = a1.arg_set_id AND a1.key = 'debug.timing_flags' AND a1.display_value IS NOT NULL AND a1.display_value != ''
      JOIN args a2 ON s.arg_set_id = a2.arg_set_id AND a2.key = 'debug.pipeline_id' AND a2.display_value = '${pipeline_id}'
      JOIN args a3 ON s.arg_set_id = a3.arg_set_id AND a3.key = 'debug.instance_id'
      WHERE s.name = 'Timing::Mark.paintEnd'
      GROUP BY s.id
  `;
  const paintEndWithPipelineIdResult = await traceQuery.query(paintEndWithPipelineIdSql);
  if (paintEndWithPipelineIdResult.length === 0 || paintEndWithPipelineIdResult[0] === undefined) {
    return {};
  }
  const paintEndId = paintEndWithPipelineIdResult[0]['id'] as number;
  const timingFlags = paintEndWithPipelineIdResult[0]['timing_flags'] as string | undefined;
  const instance_id = paintEndWithPipelineIdResult[0]['instance_id'] as string;
  let flowIdRelatedTraces = await queryFlowIdRelatedTrace(traceQuery, paintEndId);
  flowIdRelatedTraces = await filterFlowIdRelatedTraces(flowIdRelatedTraces, pipeline_id, traceQuery);
  const pipelineOverviewEventIds = new Set<number>();
  pipelineOverviewEventIds.add(paintEndId);
  for (const flowIdRelatedTrace of flowIdRelatedTraces) {
    pipelineOverviewEventIds.add(flowIdRelatedTrace['id'] as number);
  }
  if (timingFlags && timingFlags.includes('Lynx FCP')) {
    const onAttachedToWindowsEvent = await queryEventByName(traceQuery, instance_id, 'LynxView.onAttachedToWindow');
    if (onAttachedToWindowsEvent.length > 0 && onAttachedToWindowsEvent[0] !== undefined) {
      pipelineOverviewEventIds.add(onAttachedToWindowsEvent[0]['id']);
    }
  }

  if (flowIdRelatedTraces.length > 0 && flowIdRelatedTraces[0] !== undefined) {
    const updateEventIds = await queryAncestorUpdateEvent(traceQuery, flowIdRelatedTraces[0]['id'] as number);
    for (const eventId of updateEventIds) {
      pipelineOverviewEventIds.add(eventId);
    }
    if (updateEventIds.size > 0 && lynxUpdateEvent(flowIdRelatedTraces[0]['name']) && !keepNonTopUpdateEvent) {
      pipelineOverviewEventIds.delete(flowIdRelatedTraces[0]['id'] as number);
    }
  }

  const track_id =
    flowIdRelatedTraces.length > 0 && flowIdRelatedTraces[0] !== undefined
      ? flowIdRelatedTraces[0]['track_id']
      : paintEndWithPipelineIdResult[0]['track_id'];
  const loadJsAppEventId = await firstJsUpdatePipelineWithLoadJSAppEvent(
    traceQuery,
    instance_id,
    paintEndWithPipelineIdResult[0]['ts'],
    track_id,
  );
  if (loadJsAppEventId) {
    pipelineOverviewEventIds.add(loadJsAppEventId);
  }

  const eventIdsStr = Array.from(pipelineOverviewEventIds).join(',');
  const overviewEventsSql = `
      SELECT s.*, t.name as thread_name, t.tid as thread_tid
      FROM slice s
      JOIN thread_track tt ON s.track_id = tt.id
      JOIN thread t ON tt.utid = t.utid
      WHERE s.id IN (${eventIdsStr})
      ORDER BY s.ts
  `;

  const overviewEvents = await traceQuery.query(overviewEventsSql);
  const readableTracesCrop = await getReadableTrace(traceQuery, overviewEvents as TraceEvent[]);
  const result: Record<string, any> = {};
  result[timingFlags || ''] = readableTracesCrop;
  const loadBundleEvents = await queryEventByName(traceQuery, instance_id, 'LynxLoadTemplate');
  if (loadBundleEvents.length > 0 && loadBundleEvents[0] !== undefined) {
    const loadBundleEvent = loadBundleEvents[0];
    result['total_cost'] = ((paintEndWithPipelineIdResult[0]['ts'] - loadBundleEvent.ts) / 1000000).toFixed(1) + 'ms';
  }

  return result;
}

async function firstJsUpdatePipelineWithLoadJSAppEvent(
  traceQuery: TraceQuery,
  instance_id: string,
  timestamp: number,
  track_id: number,
) {
  const loadJSAppEvents = await queryEventByName(traceQuery, instance_id, 'LoadJSApp');
  if (loadJSAppEvents.length === 0 || loadJSAppEvents[0] === undefined) {
    return null;
  }
  const loadJSAppEvent = loadJSAppEvents[0];
  const paintEndWithPipelineIdSql = `
      SELECT
      s.id AS id,
      MAX(CASE WHEN a2.key = 'debug.pipeline_id' THEN a2.display_value END) AS pipeline_id,
      MAX(CASE WHEN a1.key = 'debug.timing_flags' THEN a1.display_value END) AS timing_flags,
      MAX(CASE WHEN a3.key = 'debug.instance_id' THEN a3.display_value END) AS instance_id
      FROM slice s
      JOIN args a1 ON s.arg_set_id = a1.arg_set_id AND a1.key = 'debug.timing_flags' AND a1.display_value IS NOT NULL AND a1.display_value != ''
      JOIN args a2 ON s.arg_set_id = a2.arg_set_id AND a2.key = 'debug.pipeline_id' AND a2.display_value IS NOT NULL AND a2.display_value != ''
      JOIN args a3 ON s.arg_set_id = a3.arg_set_id AND a3.key = 'debug.instance_id' AND a3.display_value = '${instance_id}'
      WHERE s.name = 'Timing::Mark.paintEnd' AND s.ts < ${timestamp}
      GROUP BY s.id
  `;
  const paintEndWithPipelineIdResult = await traceQuery.query(paintEndWithPipelineIdSql);

  for (const row of paintEndWithPipelineIdResult) {
    let flowIdRelatedTraces = await queryFlowIdRelatedTrace(traceQuery, row['id']);
    flowIdRelatedTraces = await filterFlowIdRelatedTraces(flowIdRelatedTraces, row['pipeline_id'], traceQuery);
    if (
      flowIdRelatedTraces.length > 0 &&
      flowIdRelatedTraces[0] !== undefined &&
      flowIdRelatedTraces[0]['track_id'] === loadJSAppEvent['track_id']
    ) {
      return null;
    }
  }
  if (loadJSAppEvent['track_id'] !== track_id) {
    return null;
  }
  return loadJSAppEvent['id'];
}

async function queryFlowIdRelatedTrace(tp: TraceQuery, sliceId: number): Promise<Array<Record<string, any>>> {
  const sql = `
      WITH connected_flows AS (
      SELECT slice_out AS slice_id FROM directly_connected_flow(${sliceId})
      UNION ALL
      SELECT slice_in AS slice_id FROM directly_connected_flow(${sliceId})
      UNION ALL
      SELECT slice_out AS slice_id FROM preceding_flow(${sliceId})
      UNION ALL
      SELECT slice_in AS slice_id FROM preceding_flow(${sliceId})
      ),
      unique_slice_ids AS ( 
      SELECT DISTINCT slice_id FROM connected_flows 
      )
      SELECT s.id, s.track_id, s.ts, s.dur, s.name,
      json_group_object(a.key, a.display_value) AS args,
      extract_arg(s.arg_set_id, 'debug.pipeline_id') as pipelineId
      FROM unique_slice_ids usi
      JOIN slice s ON usi.slice_id = s.id
      LEFT JOIN args a ON s.arg_set_id = a.arg_set_id AND a.key != 'debug.url'
      GROUP BY s.id ORDER BY s.ts
  `;
  return tp.query(sql);
}

async function filterFlowIdRelatedTraces(
  flowidRelatedTraces: Array<Record<string, any>>,
  pipelineId: string,
  tp: TraceQuery,
) {
  const filterPipelineTraceIds = new Set<string>();
  for (const trace of flowidRelatedTraces) {
    if (trace['pipelineId'] && trace['pipelineId'] !== pipelineId) {
      filterPipelineTraceIds.add(trace['id']);
    }
  }
  const filterProcedingTraceIds = new Set<string>();
  for (const id of filterPipelineTraceIds) {
    const query = `
  INCLUDE PERFETTO MODULE slices.flow;
  select
  f.slice_out as beginSliceId,
  f.slice_in as endSliceId
  from preceding_flow(${id}) f
  `;
    const results = await tp.query(query);
    for (const result of results) {
      filterProcedingTraceIds.add(result['beginSliceId']);
      filterProcedingTraceIds.add(result['endSliceId']);
    }
  }
  return flowidRelatedTraces.filter(
    (trace) => !filterProcedingTraceIds.has(trace['id']) && !filterPipelineTraceIds.has(trace['id']),
  );
}

async function queryAncestorUpdateEvent(tp: TraceQuery, sliceId: number): Promise<Set<number>> {
  const ancestorUpdateDataSql = `
      select *
      FROM ancestor_slice(${sliceId})
      WHERE dur > 0
  `;
  const eventIds = new Set<number>();
  const ancestorUpdateDatas = await tp.query(ancestorUpdateDataSql);
  for (const updateData of ancestorUpdateDatas) {
    if (lynxUpdateEvent(updateData['name'] as string)) {
      eventIds.add(updateData['id'] as number);
    }
  }
  return eventIds;
}

async function queryEventByName(tp: TraceQuery, instance_id: string, eventName: string): Promise<TraceEvent[]> {
  const query = `select s.*, MAX(CASE WHEN a.key = 'debug.instance_id' THEN a.display_value END) AS instance_id, t.name as thread_name, t.tid as thread_tid
      from slice s 
      JOIN args a ON s.arg_set_id = a.arg_set_id AND a.key = 'debug.instance_id' 
      JOIN thread_track tt ON s.track_id = tt.id 
      JOIN thread t ON tt.utid = t.utid 
      where s.name = '${eventName}' 
      GROUP BY s.id 
      ORDER BY s.ts`;
  const iter = await tp.query(query);
  const events: TraceEvent[] = [];
  for (let i = iter.length - 1; i >= 0; i--) {
    const event = iter[i];
    if (event && String(event['instance_id']) === instance_id) {
      events.push({
        id: event['id'],
        ts: event['ts'],
        dur: event['dur'],
        track_id: event['track_id'],
        name: event['name'],
        depth: event['depth'],
        arg_set_id: event['arg_set_id'],
        thread_name: event['thread_name'],
        thread_tid: event['thread_tid'],
      } as TraceEvent);
    }
  }
  return events;
}

function lynxUpdateEvent(eventName: string): boolean {
  return (
    eventName === 'TemplateAssembler::CallLepusMethod' ||
    eventName === 'LynxUpdateData' ||
    eventName === 'UpdateComponentData' ||
    eventName === 'LynxLoadTemplate' ||
    eventName === 'UpdateData'
  );
}
