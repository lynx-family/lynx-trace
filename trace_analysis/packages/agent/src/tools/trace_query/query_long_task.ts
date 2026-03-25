// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { getTreeStyleTraceEvents, queryLongTasks, TraceQuery } from '@lynx-js/trace-query';
import { tool } from 'langchain';
import { z } from 'zod';

import { NS_TO_MS } from '../../utils/constant';

import { simplifyQueryResult } from './utils/simple_query_result';

export const queryLongTasksTool = tool(
  async ({ track_id, min_duration_ms, index }, config) => {
    try {
      const traceQuerys = config.configurable?.traceQuerys as TraceQuery[];
      if (!traceQuerys || traceQuerys.length === 0) {
        throw new Error('TraceQuerys not found in config');
      }
      if (index < 0 || index >= traceQuerys.length) {
        throw new Error('Invalid trace index');
      }
      const traceQuery = traceQuerys[index];
      if (!traceQuery) {
        throw new Error('TraceQuery not found in config');
      }
      const result = await queryLongTasks(traceQuery, track_id, min_duration_ms);
      if (result.length > 0) {
        const firstEvent = result[0]!;
        const lastEvent = result[result.length - 1]!;
        const start_ts_ms = firstEvent.ts / NS_TO_MS;
        const end_ts_ms = (lastEvent.ts + lastEvent.dur) / NS_TO_MS;
        const simplifiedResult = await simplifyQueryResult(result, start_ts_ms, end_ts_ms);
        const event_tree = getTreeStyleTraceEvents(simplifiedResult);
        return JSON.stringify(event_tree);
      } else {
        return JSON.stringify({ error: 'No long tasks found' });
      }
    } catch (error) {
      throw new Error((error as Error).message);
    }
  },
  {
    name: 'query_long_tasks',
    description:
      'Query trace slices that exceed a minimum duration threshold on a specific track. Essential for identifying jank and performance bottlenecks. Default threshold is 16ms (one frame at 60fps). Returns events sorted by timestamp.',
    schema: z.object({
      track_id: z.number().describe('Track ID to query.'),
      min_duration_ms: z.number().describe('Minimum duration in milliseconds to filter.').default(16),
      index: z
        .number()
        .optional()
        .describe('Trace index to query, default is 0, only use for diff analysis')
        .default(0),
    }),
  },
);
