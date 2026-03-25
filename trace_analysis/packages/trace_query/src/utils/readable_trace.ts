// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { TraceEvent } from '../types/trace_event';

import { getTreeStyleTraceEvents, TreeStyleTraceEvent } from './convert_trace_event_style';

/**
 * Process traces array and return simplified format with args
 * @param tp Trace processor instance
 * @param traces Array of trace events with fields like id, ts, dur, track_id, name, depth, arg_set_id, etc.
 * @returns Array with simplified trace events containing id, ts, dur, track_id, name, depth, and args
 */
export async function getReadableTrace(tp: any, traces: TraceEvent[]): Promise<TreeStyleTraceEvent[]> {
  if (!traces || traces.length === 0) {
    return [];
  }

  // Get all arg_set_id values from traces
  const argSetIds = traces.filter((trace) => trace.arg_set_id !== null).map((trace) => trace.arg_set_id!);

  if (argSetIds.length === 0) {
    // No args to fetch, return basic info
    return Promise.all(
      traces.map(async (trace) => {
        return {
          id: trace.id,
          start_ts_ms: trace.ts / 1000000 + 'ms',
          end_ts_ms: (trace.ts + trace.dur) / 1000000 + 'ms',
          duration_ms: (trace.dur / 1000000).toFixed(1) + 'ms',
          track_id: trace.track_id,
          name: trace.name,
          args: {},
          thread_name: trace.thread_name || `Thread ${trace.thread_tid || ''}`,
          // description: (await getTraceEventDesc(trace.name)) || '',
        } as TreeStyleTraceEvent;
      }),
    );
  }

  // Query args for all arg_set_ids
  const argSetIdsStr = argSetIds.join(',');
  const argsSql = `
    SELECT arg_set_id, key, display_value
    FROM args
    WHERE arg_set_id IN (${argSetIdsStr})
      AND key LIKE 'debug.%'
  `;

  const argsResult = await tp.query(argsSql);

  // Group args by arg_set_id
  const argsBySetId: { [key: number]: { [key: string]: any } } = {};
  for (const arg of argsResult) {
    const argSetId = arg.arg_set_id as number;
    const key = arg.key as string;
    const value = arg.display_value;

    if (!(argSetId in argsBySetId)) {
      argsBySetId[argSetId] = {};
    }

    // Remove 'debug.' prefix from key
    const cleanKey = key && key.startsWith('debug.') ? key.substring(6) : key;
    if (cleanKey === 'url') {
      continue;
    }
    if (argsBySetId[argSetId]) {
      argsBySetId[argSetId][cleanKey] = value;
    }
  }

  // Build result array
  const result: TraceEvent[] = [];
  for (const trace of traces) {
    const argSetId = trace.arg_set_id;
    const args = argSetId ? argsBySetId[argSetId] || {} : {};
    let threadName = trace.thread_name || '';
    if (!threadName) {
      threadName = `Thread ${trace.thread_tid || ''}`;
    }

    result.push({
      id: trace.id,
      ts: trace.ts,
      dur: trace.dur,
      track_id: trace.track_id,
      name: trace.name,
      args: args,
      thread_name: threadName,
      // description: getTraceEventDesc(trace.name) || undefined,
    });
  }

  // Apply tree styling
  const styledResult = getTreeStyleTraceEvents(result);

  return styledResult;
}
