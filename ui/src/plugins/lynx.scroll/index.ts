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
import {TrackNode} from '../../public/workspace';
import {isLynxBackgroundScriptThreadGroup} from '../../lynx_perf/track_utils';
import {
  LYNX_ISSUES_PLUGIN_ID,
  LYNX_SCROLL_PLUGIN_ID,
  LYNX_VITAL_TIMESTAMP_PLUGIN_ID,
  PARAMETER_SCENE,
  PARAMETER_SCROLL,
  SCROLL_TITLE,
  START_FLUENCY_TRACE,
  STOP_FLUENCY_TRACE,
} from '../../lynx_perf/constants';
import {NUM} from '../../trace_processor/query_result';
import {LynxScrollTrack} from './track';
import {getArgs} from '../../components/sql_utils/args';
import {asArgSetId} from '../../components/sql_utils/core_types';
import {ThreadSortOrder} from '../../lynx_perf/thread_order';
import {getFirstStringArg} from '../../lynx_perf/trace_utils';
import VitalTimestampPlugin from '../lynx.vitalTimestamp';

export default class LynxScroll implements PerfettoPlugin {
  static readonly id = LYNX_SCROLL_PLUGIN_ID;

  static readonly dependencies = [VitalTimestampPlugin];

  async onTraceLoad(ctx: Trace): Promise<void> {
    const showTrack = await this.containValidScollSection(ctx);
    if (!showTrack) {
      return;
    }

    ctx.tracks.registerTrack({
      uri: LYNX_SCROLL_PLUGIN_ID,
      renderer: new LynxScrollTrack(ctx, LYNX_SCROLL_PLUGIN_ID),
    });
    const track = new TrackNode({
      name: SCROLL_TITLE,
      uri: LYNX_SCROLL_PLUGIN_ID,
      sortOrder: ThreadSortOrder.SCOLL,
    });
    const workspace = ctx.currentWorkspace;
    if (workspace.children.length === 0) {
      return;
    }

    for (let i = 0; i < workspace.children.length; i++) {
      const item: TrackNode = workspace.children[i];
      if (isLynxBackgroundScriptThreadGroup(item)) {
        const vitalTimestampTrack = workspace.getTrackByUri(
          LYNX_VITAL_TIMESTAMP_PLUGIN_ID,
        );
        if (vitalTimestampTrack != undefined) {
          item.addChildAfter(track, vitalTimestampTrack);
        } else {
          const perfTrack = workspace.getTrackByUri(LYNX_ISSUES_PLUGIN_ID);
          if (perfTrack != undefined) {
            item.addChildAfter(track, perfTrack);
          } else {
            item.addChildFirst(track);
          }
        }
        break;
      }
    }
  }

  private async containValidScollSection(ctx: Trace) {
    const queryStart = await ctx.engine.query(
      `select arg_set_id as argSetId from slice where slice.name='${START_FLUENCY_TRACE}' limit 1`,
    );
    if (queryStart.numRows() <= 0) {
      return false;
    }
    const queryStop = await ctx.engine.query(
      `select arg_set_id as argSetId from slice where slice.name='${STOP_FLUENCY_TRACE}' limit 1`,
    );
    if (queryStop.numRows() <= 0) {
      return false;
    }
    const it = queryStart.iter({
      argSetId: NUM,
    });
    for (; it.valid(); it.next()) {
      const args = await getArgs(ctx.engine, asArgSetId(it.argSetId));
      const scene = getFirstStringArg(args, [
        `debug.${PARAMETER_SCENE}`,
        `args.${PARAMETER_SCENE}`,
      ]);
      if (scene === PARAMETER_SCROLL) {
        return true;
      }
    }
    return false;
  }
}
