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

import {HighPrecisionTimeSpan} from '../base/high_precision_time_span';
import {Time} from '../base/time';
import {TimeScale} from '../base/time_scale';
import {TrackRenderContext} from '../public/track';
import {TrackNode} from '../public/workspace';
import {LynxBaseTrack} from './lynx_base_track';
import {BaseSlice} from './types';

class TestLynxTrack extends LynxBaseTrack<BaseSlice[]> {
  requests = 0;

  constructor() {
    super(
      {
        raf: {scheduleFullRedraw: jest.fn()},
        selection: {selectTrackEvent: jest.fn()},
        timeline: {},
      } as never,
      'test.Track',
    );
  }

  render(ctx: TrackRenderContext): void {
    this.getTrackData(ctx);
  }

  getHeight(): number {
    return 10;
  }

  async fetchDataForBounds(): Promise<BaseSlice[]> {
    this.requests++;
    return [{id: this.requests, ts: 0}];
  }
}

function makeRenderContext(): TrackRenderContext {
  const visibleWindow = HighPrecisionTimeSpan.fromTime(
    Time.fromRaw(0n),
    Time.fromRaw(100n),
  );
  return {
    trackUri: 'test.Track',
    trackNode: new TrackNode({uri: 'test.Track'}),
    visibleWindow,
    size: {width: 100, height: 10},
    resolution: 1n,
    ctx: document.createElement('canvas').getContext('2d')!,
    timescale: new TimeScale(visibleWindow, {left: 0, right: 100}),
    colors: {} as never,
    renderer: {} as never,
  };
}

describe('LynxBaseTrack', () => {
  it('requests data from render instead of old onUpdate lifecycle', async () => {
    const track = new TestLynxTrack();
    const ctx = makeRenderContext();

    track.render(ctx);
    track.render(ctx);
    await Promise.resolve();
    await Promise.resolve();

    expect(track.requests).toBe(1);
    expect(await track.getSelectionDetails(1)).toEqual({
      ts: 0n,
      dur: 0n,
    });
  });
});
