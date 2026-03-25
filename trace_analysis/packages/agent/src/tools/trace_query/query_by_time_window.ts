// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { queryByTimeWindow, TraceQuery, getTreeStyleTraceEvents } from '@lynx-js/trace-query';
import { tool } from 'langchain';
import { z } from 'zod';

import { simplifyQueryResult } from './utils/simple_query_result';

export const queryByTimeWindowTool = tool(
  async ({ start_ts_ms, end_ts_ms, track_id, index }, config) => {
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
      const result = await queryByTimeWindow(traceQuery, start_ts_ms, end_ts_ms, track_id);
      const simplifiedResult = await simplifyQueryResult(result, start_ts_ms, end_ts_ms);
      const event_tree = getTreeStyleTraceEvents(simplifiedResult);
      return JSON.stringify(event_tree);
    } catch (error) {
      throw new Error((error as Error).message);
    }
  },
  {
    name: 'query_by_time_window',
    description:
      'Query all trace events within a specific time range. Returns events organized as a tree structure based on parent-child relationships. Optionally filter by track_id to limit results to a specific thread. Essential for investigating what happened during a specific period.',
    schema: z.object({
      start_ts_ms: z.number().describe('Start timestamp in milliseconds.'),
      end_ts_ms: z.number().describe('End timestamp in milliseconds.'),
      track_id: z.number().optional().describe('Track ID to filter by.'),
      index: z
        .number()
        .optional()
        .describe('Trace index to query, default is 0, only use for diff analysis')
        .default(0),
    }),
  },
);
