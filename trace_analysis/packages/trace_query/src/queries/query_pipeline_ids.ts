// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { TraceQuery } from '../utils/trace_query';

export async function queryPipelineIds(traceQuery: TraceQuery, instance_id: string): Promise<string[]> {
  const result: string[] = [];
  const paintEndWithPipelineIdSql = `
      SELECT
      s.id AS id,
      MAX(CASE WHEN a2.key = 'debug.pipeline_id' THEN a2.display_value END) AS pipeline_id,
      MAX(CASE WHEN a1.key = 'debug.timing_flags' THEN a1.display_value END) AS timing_flags,
      MAX(CASE WHEN a3.key = 'debug.instance_id' THEN a3.display_value END) AS instance_id
      FROM slice s
      JOIN args a1 ON s.arg_set_id = a1.arg_set_id AND a1.key = 'debug.timing_flags' AND a1.display_value IS NOT NULL AND a1.display_value != ''
      JOIN args a2 ON s.arg_set_id = a2.arg_set_id AND a2.key = 'debug.pipeline_id'
      JOIN args a3 ON s.arg_set_id = a3.arg_set_id AND a3.key = 'debug.instance_id' AND a3.display_value = '${instance_id}'
      WHERE s.name = 'Timing::Mark.paintEnd'
      GROUP BY s.id
  `;
  const paintEndWithPipelineIdResult = await traceQuery.query(paintEndWithPipelineIdSql);

  const uniquePipelineIdSet = new Set<string>();
  const uniqueTimingFlagsSet = new Set<string>();
  for (const paintEndWithPipelineId of paintEndWithPipelineIdResult) {
    if (!paintEndWithPipelineId['pipeline_id'] || uniquePipelineIdSet.has(paintEndWithPipelineId['pipeline_id'] as string)) {
      continue;
    }
    uniquePipelineIdSet.add(paintEndWithPipelineId['pipeline_id'] as string);
    if (!uniqueTimingFlagsSet.has(paintEndWithPipelineId['timing_flags'] as string)) {
      uniqueTimingFlagsSet.add(paintEndWithPipelineId['timing_flags'] as string);
      result.push(paintEndWithPipelineId['pipeline_id'] as string);
    }
  }
  return result;
}
