// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { queryLynxView, TraceQuery } from '@lynx-js/trace-query';
import { tool } from 'langchain';
import { z } from 'zod';

export const queryLynxViewTool = tool(
  async ({ index }, config) => {
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
      const result = await queryLynxView(traceQuery);
      return JSON.stringify(result);
    } catch (error) {
      return JSON.stringify({ errorMessage: (error as Error).message });
    }
  },
  {
    name: 'query_lynxviews',
    description:
      'Query all LynxView instances in the trace. A LynxView represents a Lynx rendering context with its own template, data, and rendering pipeline. Returns view identifiers, URLs, and instance information. Use this to understand the scope of analysis.',
    schema: z.object({
      index: z
        .number()
        .optional()
        .describe('Trace index to query, default is 0, only use for diff analysis')
        .default(0),
    }),
  },
);
