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
import {Trace} from '../../public/trace';
import {START_FLUENCY_TRACE, STOP_FLUENCY_TRACE} from '../../lynx_perf/constants';
import {lynxPerfGlobals} from '../../lynx_perf/lynx_perf_globals';
import {LynxScrollTrack} from './track';
import {TimestampFormat} from '../../public/timeline';

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
    get args_json() {
      return (rows[index] as T & {args_json: string | null}).args_json;
    },
  };
}

function traceForRows(
  rows: Array<{
    id: number;
    name: string;
    ts: number;
    argSetId: number | null;
  }>,
): Trace {
  return {
    timeline: {
      timestampFormat: TimestampFormat.TraceNs,
    },
    engine: {
      query: jest.fn().mockImplementation((sql: string) => {
        if (sql.includes('ancestor_slice')) {
          return Promise.resolve({iter: () => iterRows([])});
        }
        if (sql.includes('__intrinsic_arg_set_to_json')) {
          return Promise.resolve({
            iter: () =>
              iterRows([
                {
                  args_json: JSON.stringify({debug: {tag: 'feed'}}),
                },
              ]),
          });
        }
        return Promise.resolve({iter: () => iterRows(rows)});
      }),
    },
  } as unknown as Trace;
}

describe('LynxScrollTrack', () => {
  afterEach(() => {
    lynxPerfGlobals.reset();
  });

  it('uses scroll tag args in section names and global lookup', async () => {
    const trace = traceForRows([
      {id: 10, name: START_FLUENCY_TRACE, ts: 100, argSetId: 7},
      {id: 11, name: STOP_FLUENCY_TRACE, ts: 220, argSetId: null},
    ]);

    const sections = await new LynxScrollTrack(
      trace,
      'lynx.ScrollDetect',
    ).fetchDataForBounds(0n as time, 1000n as time, 1n as duration);

    expect(sections[0]).toEqual(
      expect.objectContaining({
        id: 10,
        name: 'Scroll feed',
      }),
    );
    expect(lynxPerfGlobals.state.traceIdToScrollName.get(10)).toBe(
      'Scroll feed',
    );
  });
});
