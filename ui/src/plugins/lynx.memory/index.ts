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
import {LYNX_MEMORY_PLUGIN_ID} from '../../lynx_perf/constants';
import {TrackNode} from '../../public/workspace';
import {isLynxBackgroundScriptThreadGroup} from '../../lynx_perf/track_utils';
import {ThreadSortOrder} from '../../lynx_perf/thread_order';
import {MEMORY_VITAL_EVENT_NAMES, MemoryVitalsTrack} from './tracks';

export default class LynxMemoryPlugin implements PerfettoPlugin {
  static readonly id = LYNX_MEMORY_PLUGIN_ID;
  async onTraceLoad(ctx: Trace): Promise<void> {
    const memoryVitalEventNames = MEMORY_VITAL_EVENT_NAMES.map(
      (name) => `'${name}'`,
    ).join(',');
    const result = await ctx.engine.query(`
      SELECT id
      FROM slice
      WHERE name IN (${memoryVitalEventNames})
      LIMIT 1
    `);
    if (result.numRows() <= 0) {
      return;
    }

    ctx.tracks.registerTrack({
      uri: LynxMemoryPlugin.id,
      renderer: new MemoryVitalsTrack(ctx, LYNX_MEMORY_PLUGIN_ID),
    });

    // Create track node for workspace hierarchy
    const track = new TrackNode({
      name: 'Memory Vitals',
      uri: LYNX_MEMORY_PLUGIN_ID,
      sortOrder: ThreadSortOrder.MEMORY_VITALS,
    });

    const workspace = ctx.currentWorkspace;
    for (let i = 0; i < workspace.children.length; i++) {
      const item: TrackNode = workspace.children[i];
      if (isLynxBackgroundScriptThreadGroup(item)) {
        const totalPssTrack = item.children.find(
          (child) => child.name === 'summary.total-pss',
        );
        if (totalPssTrack !== undefined) {
          item.addChildAfter(track, totalPssTrack);
        } else {
          item.addChildInOrder(track);
        }
        break;
      }
    }
  }
}
