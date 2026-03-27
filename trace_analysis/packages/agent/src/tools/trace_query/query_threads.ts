// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { queryThreads, TraceQuery } from '@lynx-js/trace-query';
import { tool } from 'langchain';
import { z } from 'zod';

export const queryThreadsTool = tool(
  async ({ lynxThreadOnly, index }, config) => {
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
      const result = await queryThreads(traceQuery, lynxThreadOnly);
      return JSON.stringify(result);
    } catch (error) {
      return JSON.stringify({ errorMessage: (error as Error).message });
    }
  },
  {
    name: 'query_threads',
    description:
      'Query all threads in the trace with their track IDs. Key threads include: Main Thread (UI rendering), Lynx_JS (JavaScript execution). Returns track_id needed for other tools. Use lynxThreadOnly=true to filter only Lynx-related threads.',
    schema: z.object({
      lynxThreadOnly: z
        .boolean()
        .optional()
        .default(true)
        .describe('Whether to only return threads that are Lynx threads.'),
      index: z
        .number()
        .optional()
        .describe('Trace index to query, default is 0, only use for diff analysis')
        .default(0),
    }),
  },
);
