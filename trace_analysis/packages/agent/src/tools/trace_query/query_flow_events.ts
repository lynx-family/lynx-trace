// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { queryFlowEvents, TraceQuery, getTreeStyleTraceEvents } from '@lynx-js/trace-query';
import { tool } from 'langchain';
import { z } from 'zod';

import { simplifyQueryResult } from './utils/simple_query_result';

export const queryFlowEventsTool = tool(
  async ({ slice_id, index }, config) => {
    try {
      const traceQuerys = config.configurable?.traceQuerys as TraceQuery[];
      if (!traceQuerys || traceQuerys.length === 0) {
        return JSON.stringify({ errorMessage: 'TraceQuerys not found in config' });
      }
      if (index < 0 || index >= traceQuerys.length) {
        return JSON.stringify({ errorMessage: 'Invalid trace index' });
      }
      const traceQuery = traceQuerys[index];
      if (!traceQuery) {
        return JSON.stringify({ errorMessage: 'TraceQuery not found in config' });
      }
      const result = await queryFlowEvents(traceQuery, slice_id);
      const simplifiedResult = await simplifyQueryResult(result);
      const event_tree = getTreeStyleTraceEvents(simplifiedResult);
      return JSON.stringify(event_tree);
    } catch (error) {
      return JSON.stringify({ errorMessage: (error as Error).message });
    }
  },
  {
    name: 'query_flow_events',
    description:
      'Query flow events connected to a given slice. Flow events show cross-thread communication and causal relationships between events on different threads. Use this to trace how work flows between threads (e.g., from Lynx_JS to main thread).',
    schema: z.object({
      slice_id: z.number().describe('The ID of the slice to query flow events for.'),
      index: z
        .number()
        .optional()
        .describe('Trace index to query, default is 0, only use for diff analysis')
        .default(0),
    }),
  },
);
