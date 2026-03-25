// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { TraceEvent } from '../types/trace_event';
import { NS_TO_MS } from '../utils/constant';
import { parseTraceEvent } from '../utils/parse_trace_event';
import { TraceQuery } from '../utils/trace_query';

export async function queryByTimeWindow(
  traceQuery: TraceQuery,
  start_ts_ms: number,
  end_ts_ms: number,
  track_id?: number,
): Promise<TraceEvent[]> {
  const filters = [
    `s.ts >= ${start_ts_ms * NS_TO_MS}`,
    `s.ts <= ${end_ts_ms * NS_TO_MS}`,
    ...(track_id ? [`s.track_id = ${track_id}`] : []),
  ];
  const constraints = `WHERE ${filters.join(' and ')}`;

  const sql =
    "SELECT s.id, s.track_id, s.ts, s.dur, s.name, s.depth, t.name as thread_name, '{' || GROUP_CONCAT( printf('\"%s\": \"%s\"', a.key, a.display_value), ', ') || '}' AS args " +
    'FROM slice s ' +
    'LEFT JOIN args a ON s.arg_set_id = a.arg_set_id ' +
    'JOIN thread_track tt ON s.track_id = tt.id JOIN thread t ON tt.utid = t.utid ' +
    `${constraints} AND a.key != 'debug.url' AND s.category !=  'system'` +
    `GROUP BY s.id ORDER BY s.depth, s.ts`;

  const queryResult = await traceQuery.query(sql);
  const traceEvents = parseTraceEvent(queryResult);
  return traceEvents;
}
