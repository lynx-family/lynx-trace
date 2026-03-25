// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { TraceEvent } from '../types/trace_event';
import { parseTraceEvent } from '../utils/parse_trace_event';
import { TraceQuery } from '../utils/trace_query';

export async function queryDescendants(traceQuery: TraceQuery, sliceId: number): Promise<TraceEvent[]> {
  const sql =
    "SELECT d_s.id, d_s.ts, d_s.dur, d_s.track_id, d_s.name, d_s.depth, t.name as thread_name, '{' || GROUP_CONCAT( printf('\"%s\": \"%s\"', a.key, a.display_value), ', ') || '}' AS args " +
    `FROM descendant_slice(${sliceId}) d_s LEFT JOIN args a ON d_s.arg_set_id = a.arg_set_id ` +
    'JOIN thread_track tt ON d_s.track_id = tt.id JOIN thread t ON tt.utid = t.utid ' +
    'WHERE d_s.category != "system" ' +
    'GROUP BY d_s.id ORDER BY d_s.depth, d_s.ts';

  const queryResult = await traceQuery.query(sql);
  return parseTraceEvent(queryResult);
}
