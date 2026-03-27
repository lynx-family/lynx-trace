// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { queryByRawSql, TraceQuery } from '@lynx-js/trace-query';
import { tool } from 'langchain';
import { z } from 'zod';

export const queryByRawSqlTool = tool(
  async ({ sql, index }, config) => {
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
      const result = await queryByRawSql(traceQuery, sql);
      return JSON.stringify(result);
    } catch (error) {
      return JSON.stringify({ errorMessage: (error as Error).message });
    }
  },
  {
    name: 'query_by_raw_sql',
    description:
      'Execute a raw SQL query directly on the trace database. Use this for advanced queries not covered by other tools. The trace uses Perfetto SQL syntax with tables like slice, args, thread, thread_track. Use sparingly as other tools are preferred for common operations.',
    schema: z.object({
      sql: z.string().describe('The SQL query to execute.'),
      index: z
        .number()
        .optional()
        .describe('Trace index to query, default is 0, only use for diff analysis')
        .default(0),
    }),
  },
);
