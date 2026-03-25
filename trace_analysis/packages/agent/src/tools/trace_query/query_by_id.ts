// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { queryById, TraceQuery, getTreeStyleTraceEvents } from '@lynx-js/trace-query';
import { tool } from 'langchain';
import { z } from 'zod';

export const queryByIdTool = tool(
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
      const result = await queryById(traceQuery, slice_id);
      if (!result || result.length === 0) {
        return JSON.stringify({ error: 'slice_id not found' });
      }
      const event_tree = getTreeStyleTraceEvents(result);
      return JSON.stringify(event_tree);
    } catch (error) {
      throw new Error((error as Error).message);
    }
  },
  {
    name: 'query_by_id',
    description:
      'Query a single trace slice by its unique ID. Returns the complete event information including name, timestamps, duration, arguments, and thread info. Use this when you need detailed information about a specific event.',
    schema: z.object({
      slice_id: z.number().describe('The ID of the slice to query.'),
      index: z
        .number()
        .optional()
        .describe('Trace index to query, default is 0, only use for diff analysis')
        .default(0),
    }),
  },
);
