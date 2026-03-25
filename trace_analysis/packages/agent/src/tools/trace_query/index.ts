// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { aggregateQueryTool } from './query_aggregate';
import { queryAncestorsTool } from './query_ancestors';
import { queryByIdTool } from './query_by_id';
import { queryByTimeWindowTool } from './query_by_time_window';
import { queryDescendantsTool } from './query_descendants';
import { queryFlowEventsTool } from './query_flow_events';
import { queryLongTasksTool } from './query_long_task';
import { queryLynxViewTool } from './query_lynxviews';
import { queryMetricsTool } from './query_metrics';
import { queryPipelineIdsTool } from './query_pipeline_ids';
import { queryPipelineOverviewEventsTool } from './query_pipeline_overview_events';
import { queryThreadsTool } from './query_threads';
import { queryTraceMetadataTool } from './query_trace_metadata';

export const trace_query_tools = [
  queryByTimeWindowTool,
  queryFlowEventsTool,
  queryDescendantsTool,
  queryAncestorsTool,
  queryByIdTool,
  aggregateQueryTool,
  queryLynxViewTool,
  queryPipelineIdsTool,
  queryPipelineOverviewEventsTool,
  queryThreadsTool,
  queryTraceMetadataTool,
  queryMetricsTool,
  queryLongTasksTool,
];
