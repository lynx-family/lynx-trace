// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { TraceEvent } from '../types/trace_event';
import { parseTraceEvent } from '../utils/parse_trace_event';
import { TraceQuery } from '../utils/trace_query';

export async function queryFlowEvents(traceQuery: TraceQuery, slice_id: number): Promise<TraceEvent[]> {
  const sql =
    'WITH connected_flows AS ( ' +
    `SELECT slice_out AS slice_id FROM directly_connected_flow(${slice_id}) ` +
    'UNION ALL ' +
    `SELECT slice_in AS slice_id FROM directly_connected_flow(${slice_id}) ` +
    'UNION ALL ' +
    `SELECT slice_out AS slice_id FROM preceding_flow(${slice_id}) ` +
    'UNION ALL ' +
    `SELECT slice_in AS slice_id FROM preceding_flow(${slice_id}) ` +
    '), ' +
    'unique_slice_ids AS ( SELECT DISTINCT slice_id FROM connected_flows ) ' +
    "SELECT s.id,  s.track_id,  s.ts,  s.dur,  s.depth, s.name, t.name as thread_name, '{' || GROUP_CONCAT(printf('\"%s\": \"%s\"', a.key, a.display_value), ', ') || '}' AS args " +
    'FROM unique_slice_ids usi ' +
    'JOIN slice s ON usi.slice_id = s.id ' +
    "LEFT JOIN args a ON s.arg_set_id = a.arg_set_id AND a.key != 'debug.url' " +
    'JOIN thread_track tt ON s.track_id = tt.id JOIN thread t ON tt.utid = t.utid ' +
    'GROUP BY s.id ORDER BY s.ts';

  const queryResult = await traceQuery.query(sql);
  const traceEvents = parseTraceEvent(queryResult);
  return traceEvents;
}
