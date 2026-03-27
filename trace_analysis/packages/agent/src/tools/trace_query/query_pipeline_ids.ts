// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { queryPipelineIds, TraceQuery } from '@lynx-js/trace-query';
import { tool } from 'langchain';
import { z } from 'zod';

export const queryPipelineIdsTool = tool(
  async ({ instance_id, index }, config) => {
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
      const result = await queryPipelineIds(traceQuery, instance_id);
      return JSON.stringify(result);
    } catch (error) {
      return JSON.stringify({ errorMessage: (error as Error).message });
    }
  },
  {
    name: 'query_pipeline_ids',
    description:
      'Query all pipeline IDs associated with a LynxView instance. A pipeline represents a single render pass (first frame or update). Use this to get pipeline IDs for a specific instance before querying detailed pipeline events.',
    schema: z.object({
      instance_id: z.string().describe('The instance ID to query pipeline IDs for.'),
      index: z
        .number()
        .optional()
        .describe('Trace index to query, default is 0, only use for diff analysis')
        .default(0),
    }),
  },
);
