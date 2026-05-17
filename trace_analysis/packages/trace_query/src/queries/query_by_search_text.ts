// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { TraceEvent } from '../types/trace_event';
import { parseTraceEvent } from '../utils/parse_trace_event';
import { TraceQuery } from '../utils/trace_query';

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function escapeGlobPattern(value: string): string {
  return value.replace(/([*?\[])/g, '[$1]');
}

export async function queryBySearchText(traceQuery: TraceQuery, searchText: string): Promise<TraceEvent[]> {
  const trimmedSearchText = searchText.trim();

  if (!trimmedSearchText) {
    return [];
  }

  const normalizedSearchText = trimmedSearchText.toLowerCase();
  const globPattern = `*${escapeSqlLiteral(escapeGlobPattern(normalizedSearchText))}*`;

  const sql =
    'WITH matched_slices AS ( ' +
    'SELECT s.id ' +
    'FROM slice s ' +
    'LEFT JOIN args a ON s.arg_set_id = a.arg_set_id ' +
    `WHERE lower(s.name) GLOB '${globPattern}' OR lower(a.string_value) GLOB '${globPattern}' OR lower(a.display_value) GLOB '${globPattern}' OR lower(a.key) GLOB '${globPattern}' ` +
    'GROUP BY s.id ' +
    ') ' +
    'SELECT s.id, s.track_id, s.ts, s.dur, s.name, s.depth, t.name as thread_name, json_group_object(a.key, a.display_value) AS args ' +
    'FROM matched_slices ms ' +
    'JOIN slice s ON ms.id = s.id ' +
    'LEFT JOIN args a ON s.arg_set_id = a.arg_set_id ' +
    'JOIN thread_track tt ON s.track_id = tt.id ' +
    'JOIN thread t ON tt.utid = t.utid ' +
    'GROUP BY s.id, s.track_id, s.ts, s.dur, s.name, s.depth, t.name ' +
    'ORDER BY s.ts';

  const queryResult = await traceQuery.query(sql);
  return parseTraceEvent(queryResult);
}