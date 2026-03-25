// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { queryById, queryDescendants, TraceQuery, getTreeStyleTraceEvents } from '@lynx-js/trace-query';
import { tool } from 'langchain';
import { z } from 'zod';

import { NS_TO_MS } from '../../utils/constant';

import { simplifyQueryResult } from './utils/simple_query_result';

export const queryDescendantsTool = tool(
  async ({ slice_id, index }, config) => {
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
      const event = await queryById(traceQuery, slice_id);
      if (!event || event.length === 0 || !event[0]) {
        return JSON.stringify({ error: 'slice_id not found' });
      }
      const start_ts = event[0].ts / NS_TO_MS;
      const end_ts = (event[0].ts + event[0].dur) / NS_TO_MS;
      const result = await queryDescendants(traceQuery, slice_id);
      const simplifiedResult = await simplifyQueryResult(result, start_ts, end_ts);
      const event_tree = getTreeStyleTraceEvents(simplifiedResult);
      return JSON.stringify(event_tree);
    } catch (error) {
      throw new Error((error as Error).message);
    }
  },
  {
    name: 'query_descendants',
    description:
      'Query all descendant (child) slices of a given slice. Returns the complete subtree of nested events, organized as a tree structure. Useful for understanding what sub-operations occurred within a parent event and their relative timing.',
    schema: z.object({
      slice_id: z.number().describe('The ID of the slice to query descendants for.'),
      index: z
        .number()
        .optional()
        .describe('Trace index to query, default is 0, only use for diff analysis')
        .default(0),
    }),
  },
);
