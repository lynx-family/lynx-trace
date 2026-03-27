// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { queryPipelineOverviewEvents, TraceQuery } from '@lynx-js/trace-query';
import { tool } from 'langchain';
import { z } from 'zod';

export const queryPipelineOverviewEventsTool = tool(
  async ({ pipeline_id, keep_non_top_update_event, index }, config) => {
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
      const result = await queryPipelineOverviewEvents(traceQuery, pipeline_id, keep_non_top_update_event === true);
      return JSON.stringify(result);
    } catch (error) {
      return JSON.stringify({ errorMessage: (error as Error).message });
    }
  },
  {
    name: 'query_pipeline_overview_events',
    description:
      'Query top-level events for a specific rendering pipeline. Returns the main stages (loadBundle, parse, mtsrender, resolve, layout, paint for first frame; diffVdom, patchChanges for updates) with timing. Use this to get a high-level view of a pipeline before deep-diving into specific stages.',
    schema: z.object({
      pipeline_id: z.string().describe('The pipeline ID to query overview events for.'),
      keep_non_top_update_event: z.boolean().optional().describe('Whether to keep non-top update events.'),
      index: z
        .number()
        .optional()
        .describe('Trace index to query, default is 0, only use for diff analysis')
        .default(0),
    }),
  },
);
