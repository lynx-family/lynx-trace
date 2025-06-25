// Copyright (C) 2026 The Android Open Source Project
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

import {time} from '../../base/time';
import {AreaSelection} from '../../public/selection';
import {Track} from '../../public/track';
import {DROP_FRAME_THRESHOLD} from '../constants';
import {lynxPerfGlobals} from '../lynx_perf_globals';
import {queryFrameRenderingAggregation} from './query_aggregation_frame';

function areaSelection(): AreaSelection {
  return {
    kind: 'area',
    start: 0n as time,
    end: 100n as time,
    trackUris: ['/slice_1'],
    tracks: [{uri: '/slice_1'} as Track],
  };
}

describe('queryFrameRenderingAggregation', () => {
  afterEach(() => {
    lynxPerfGlobals.reset();
  });

  it('aggregates only visible frames for selected main thread tracks', () => {
    lynxPerfGlobals.updateSliceThreadMap(
      new Map([
        [
          '/slice_1',
          {
            utid: 1,
            upid: 1,
            tid: 10,
            trackName: 'main',
            trackId: 1,
            isMainThread: true,
            isKernelThread: false,
            threadName: 'main',
          },
        ],
      ]),
    );
    lynxPerfGlobals.updateFrameDurationMap(
      new Map([
        [10, {id: 100, dur: DROP_FRAME_THRESHOLD / 2, trackId: 1}],
        [20, {id: 200, dur: DROP_FRAME_THRESHOLD, trackId: 1}],
        [30, {id: 300, dur: DROP_FRAME_THRESHOLD * 2, trackId: 1}],
      ]),
    );
    lynxPerfGlobals.updateFilteredTraceSet(new Set([200]));

    expect(queryFrameRenderingAggregation(areaSelection())).toEqual([
      {
        name: 'Frame Rendering: Red',
        totalDuration: DROP_FRAME_THRESHOLD * 2,
        averageDuration: DROP_FRAME_THRESHOLD * 2,
        occurrences: 1,
        frameDurations: [DROP_FRAME_THRESHOLD * 2],
      },
      {
        name: 'Frame Rendering: Green',
        totalDuration: DROP_FRAME_THRESHOLD / 2,
        averageDuration: Math.round(DROP_FRAME_THRESHOLD / 2),
        occurrences: 1,
        frameDurations: [DROP_FRAME_THRESHOLD / 2],
      },
    ]);
  });

  it('returns no frame aggregation for non-main-thread selections', () => {
    lynxPerfGlobals.updateSliceThreadMap(
      new Map([
        [
          '/slice_1',
          {
            utid: 1,
            upid: 1,
            tid: 10,
            trackName: 'worker',
            trackId: 1,
            isMainThread: false,
            isKernelThread: false,
            threadName: 'worker',
          },
        ],
      ]),
    );

    expect(queryFrameRenderingAggregation(areaSelection())).toEqual([]);
  });
});
