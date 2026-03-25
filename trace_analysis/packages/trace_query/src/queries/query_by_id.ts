// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { TraceEvent } from '../types/trace_event';
import { parseTraceEvent } from '../utils/parse_trace_event';
import { TraceQuery } from '../utils/trace_query';

export async function queryById(traceQuery: TraceQuery, slice_id: number): Promise<TraceEvent[]> {
  const sql =
    "SELECT s.id, s.ts, s.dur, s.track_id, s.name, t.name as thread_name, '{' || GROUP_CONCAT( printf('\"%s\": \"%s\"', a.key, a.display_value), ', ') || '}' AS args " +
    `FROM slice s LEFT JOIN args a ON s.arg_set_id = a.arg_set_id JOIN thread_track tt ON s.track_id = tt.id JOIN thread t ON tt.utid = t.utid WHERE s.id = ${slice_id}`;

  const queryResult = await traceQuery.query(sql);
  const traceEvents = parseTraceEvent(queryResult);
  return traceEvents;
}
