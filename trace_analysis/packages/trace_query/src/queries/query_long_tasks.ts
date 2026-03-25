// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { TraceEvent } from '../types/trace_event';
import { NS_TO_MS } from '../utils/constant';
import { parseTraceEvent } from '../utils/parse_trace_event';
import { TraceQuery } from '../utils/trace_query';

export async function queryLongTasks(
  traceQuery: TraceQuery,
  track_id: number,
  min_duration_ms: number,
): Promise<TraceEvent[]> {
  const minDurationNs = min_duration_ms * NS_TO_MS;

  const sql =
    "SELECT s.id, s.track_id, s.ts, s.dur, s.name, s.depth, t.name as thread_name, '{' || GROUP_CONCAT( printf('\"%s\": \"%s\"', a.key, a.display_value), ', ') || '}' AS args " +
    'FROM slice s ' +
    'LEFT JOIN args a ON s.arg_set_id = a.arg_set_id ' +
    'JOIN thread_track tt ON s.track_id = tt.id JOIN thread t ON tt.utid = t.utid ' +
    `WHERE s.track_id = ${track_id} AND s.dur >= ${minDurationNs} ` +
    `GROUP BY s.id ORDER BY s.ts`;

  const queryResult = await traceQuery.query(sql);
  const traceEvents = parseTraceEvent(queryResult);
  return traceEvents;
}
