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

import {duration, time} from '../../base/time';
import {START_FLUENCY_TRACE, STOP_FLUENCY_TRACE} from '../../lynx_perf/constants';
import {Trace} from '../../public/trace';
import {TimestampFormat} from '../../public/timeline';
import {LynxScrollTrack} from './track';

function iterRows<T extends object>(rows: T[]) {
  let index = 0;
  return {
    valid: () => index < rows.length,
    next: () => index++,
    get id() {
      return (rows[index] as T & {id: number}).id;
    },
    get name() {
      return (rows[index] as T & {name: string}).name;
    },
    get ts() {
      return (rows[index] as T & {ts: number}).ts;
    },
    get argSetId() {
      return (rows[index] as T & {argSetId: number | null}).argSetId;
    },
  };
}

describe('LynxScrollTrack null arg sets', () => {
  it('builds scroll sections when start events have null arg sets', async () => {
    const trace = {
      timeline: {
        timestampFormat: TimestampFormat.TraceNs,
      },
      engine: {
        query: jest.fn().mockImplementation((sql: string) => {
          if (sql.includes('ancestor_slice')) {
            return Promise.resolve({iter: () => iterRows([])});
          }
          return Promise.resolve({
            iter: () =>
              iterRows([
                {
                  id: 1,
                  name: START_FLUENCY_TRACE,
                  ts: 100,
                  argSetId: null,
                },
                {id: 2, name: STOP_FLUENCY_TRACE, ts: 180, argSetId: null},
              ]),
          });
        }),
      },
    } as unknown as Trace;

    const sections = await new LynxScrollTrack(
      trace,
      'lynx.ScrollDetect',
    ).fetchDataForBounds(0n as time, 1000n as time, 1n as duration);

    expect(trace.engine.query).not.toHaveBeenCalledWith(
      expect.stringContaining('__intrinsic_arg_set_to_json'),
    );
    expect(sections).toEqual([
      expect.objectContaining({
        id: 1,
        ts: 100,
        dur: 80,
        name: 'Scroll',
      }),
    ]);
  });
});
