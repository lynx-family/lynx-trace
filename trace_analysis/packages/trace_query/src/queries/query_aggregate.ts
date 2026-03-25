// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { AggregateTraceEvent } from '../types/trace_event';
import { TraceQuery } from '../utils/trace_query';

const NS_TO_MS = 1000000;

export async function queryAggregate(
  traceQuery: TraceQuery,
  start_ts_ms: number,
  end_ts_ms: number,
  names: string[],
  track_id?: number,
): Promise<AggregateTraceEvent[]> {
  try {
    const nameFilters = names
      .filter((name) => !!name)
      .map((name) => [`s.name LIKE '${name}'`])
      .join(' or ');
    if (!nameFilters) {
      throw new Error('At least one name is required.');
    }
    const filters = [
      `s.ts >= ${start_ts_ms * NS_TO_MS}`,
      `s.ts <= ${end_ts_ms * NS_TO_MS}`,
      ...(track_id ? [`s.track_id = ${track_id}`] : []),
    ];
    const constraints = `WHERE ${filters.join(' and ')} AND (${nameFilters})`;

    const sql =
      'SELECT s.name, COUNT(*) AS total_count, SUM(dur) AS total_duration, AVG(dur) AS avg_duration, MAX(dur) AS max_duration ' +
      'FROM slice s ' +
      `${constraints} GROUP By s.name ` +
      `ORDER BY total_duration`;

    const qr_it = await traceQuery.query(sql);
    const trace_event: AggregateTraceEvent[] = [];
    for (const event of qr_it) {
      trace_event.push({
        name: event['name'],
        total_count: event['total_count'],
        total_duration_ms: parseFloat((event['total_duration'] / NS_TO_MS).toFixed(1)),
        avg_duration_ms: parseFloat((event['avg_duration'] / NS_TO_MS).toFixed(1)),
        max_duration_ms: parseFloat((event['max_duration'] / NS_TO_MS).toFixed(1)),
      });
    }

    return trace_event;
  } catch {
    return [];
  }
}
