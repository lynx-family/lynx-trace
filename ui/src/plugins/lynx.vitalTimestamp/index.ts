// Copyright (C) 2025 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import {Trace} from '../../public/trace';
import {PerfettoPlugin} from '../../public/plugin';
import {
  TIMING_PAINT_END,
  LYNX_ISSUES_PLUGIN_ID,
  LYNX_VITAL_TIMESTAMP_PLUGIN_ID,
  PIPELINE_ID,
  TIMING_FLAGS,
  TIMING_LOAD_BUNDLE_START,
} from '../../lynx_perf/constants';
import {VitalTimestampTrack} from './tracks';
import {TrackNode} from '../../public/workspace';
import {isLynxBackgroundScriptThreadGroup} from '../../lynx_perf/track_utils';
import {ThreadSortOrder} from '../lynx.ThreadGroups';
import {NUM} from '../../trace_processor/query_result';
import {
  getFirstStringArg,
  traceEventWithSpecificArgValue,
} from '../../lynx_perf/trace_utils';
import {getArgs} from '../../components/sql_utils/args';
import {asArgSetId} from '../../components/sql_utils/core_types';

export default class VitalTimestampPlugin implements PerfettoPlugin {
  static readonly id = LYNX_VITAL_TIMESTAMP_PLUGIN_ID;
  async onTraceLoad(ctx: Trace): Promise<void> {
    const drawEndTagsQuery = TIMING_PAINT_END.map((flag) => `'${flag}'`).join(
      ',',
    );

    const result = await ctx.engine.query(`
      select ts, id, name, dur, track_id as trackId, arg_set_id as argSetId from slice where slice.name in (${drawEndTagsQuery})`);
    if (result.numRows() <= 0) {
      return;
    }
    const it = result.iter({
      argSetId: NUM,
    });
    let containValidPipeline = false;
    for (; it.valid(); it.next()) {
      // Extract arguments from slice
      const args = await getArgs(ctx.engine, asArgSetId(it.argSetId));
      const timingFlags = getFirstStringArg(args, [
        `debug.${TIMING_FLAGS}`,
        `args.${TIMING_FLAGS}`,
      ]);

      // Check for pipeline identifier
      const pipelineId = getFirstStringArg(args, [
        `debug.${PIPELINE_ID}`,
        `args.${PIPELINE_ID}`,
      ]);

      // Validate standard pipeline configuration
      if (timingFlags !== '' && pipelineId !== '') {
        containValidPipeline = true;
        break;
      }

      // Check for FCP (First Contentful Paint) related pipeline
      if (pipelineId !== '') {
        const traceResults = await traceEventWithSpecificArgValue(
          ctx.engine,
          TIMING_LOAD_BUNDLE_START,
          pipelineId,
        );
        if (traceResults) {
          containValidPipeline = true;
          break;
        }
      }
    }
    if (!containValidPipeline) {
      return;
    }

    ctx.tracks.registerTrack({
      uri: VitalTimestampPlugin.id,
      renderer: new VitalTimestampTrack(ctx, LYNX_VITAL_TIMESTAMP_PLUGIN_ID),
    });

    // Create track node for workspace hierarchy
    const track = new TrackNode({
      name: 'Vital Timestamp',
      uri: LYNX_VITAL_TIMESTAMP_PLUGIN_ID,
      sortOrder: ThreadSortOrder.VITAL_TIMESTAMP,
    });

    // Add track to appropriate location in workspace
    const workspace = ctx.currentWorkspace;
    if (workspace.children.length > 0) {
      for (const item of workspace.children) {
        if (!isLynxBackgroundScriptThreadGroup(item)) {
          continue;
        }
        const perfTrack = workspace.getTrackByUri(LYNX_ISSUES_PLUGIN_ID);
        perfTrack
          ? item.addChildAfter(track, perfTrack)
          : item.addChildFirst(track);
        break;
      }
    }
  }
}
