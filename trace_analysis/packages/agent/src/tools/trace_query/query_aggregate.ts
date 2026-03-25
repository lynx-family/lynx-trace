// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { queryAggregate, TraceQuery } from '@lynx-js/trace-query';
import { tool } from 'langchain';
import { z } from 'zod';

export const aggregateQueryTool = tool(
  async ({ start_ts_ms, end_ts_ms, names, track_id, index }, config) => {
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
      const result = await queryAggregate(traceQuery, start_ts_ms, end_ts_ms, names || [], track_id);
      result.sort((a, b) => b.total_duration_ms - a.total_duration_ms);
      return JSON.stringify(result.slice(0, 200));
    } catch (error) {
      throw new Error((error as Error).message);
    }
  },
  {
    name: 'query_aggregate',
    description:
      'Aggregate trace events by name within a time window. Groups events with the same name and calculates total duration, count, and average duration. Useful for identifying which event types consume the most time. Results are sorted by total duration (descending).',
    schema: z.object({
      start_ts_ms: z.number().describe('Start timestamp in milliseconds.'),
      end_ts_ms: z.number().describe('End timestamp in milliseconds.'),
      names: z
        .array(z.string())
        .optional()
        .describe(
          'Event name patterns to match. Supports SQL LIKE wildcards: % matches any sequence of characters, _ matches any single character. Example: ["Timing::Mark%", "Lynx%"]',
        ),
      track_id: z.number().optional().describe('Track ID to filter by.'),
      index: z
        .number()
        .optional()
        .describe('Trace index to query, default is 0, only use for diff analysis')
        .default(0),
    }),
  },
);
