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

import {
  matchedEndStage,
  normalizeVitalTimestampName,
  validPipelineBeginStage,
} from './details_helpers';
import type {PipelineTimeStamp} from './details';

function timestamp(
  name: string,
  threadName: string,
  ts: number,
): PipelineTimeStamp {
  return {
    id: ts,
    name,
    threadName,
    ts,
  };
}

describe('VitalTimestamp details helpers', () => {
  it('normalizes timing mark prefixes used by pipeline slices', () => {
    expect(normalizeVitalTimestampName('Timing::Mark.fooStart')).toBe(
      'fooStart',
    );
    expect(
      normalizeVitalTimestampName('Timing::MarkFrameWorkTiming.bar_start'),
    ).toBe('bar_start');
    expect(normalizeVitalTimestampName('Timing::OnPipelineStart')).toBe(
      'OnPipelineStart',
    );
  });

  it('matches start and end stages on the same thread only', () => {
    const start = timestamp('layoutStart', 'main 1', 10);
    const end = timestamp('layoutEnd', 'main 1', 20);
    const wrongThreadEnd = timestamp('layoutEnd', 'worker 2', 30);

    expect(matchedEndStage([start, wrongThreadEnd, end], start)).toBe(end);
    expect(validPipelineBeginStage(start.name)).toBe(true);
  });

  it('matches framework timing start and end stages', () => {
    const start = timestamp('dataProcessor_start', 'main 1', 10);
    const end = timestamp('dataProcessor_end', 'main 1', 20);

    expect(matchedEndStage([start, end], start)).toBe(end);
  });
});
