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

import {asSliceSqlId} from '../../components/sql_utils/core_types';
import {
  NATIVEMODULE_CALLBACK,
  NATIVEMODULE_INVOKE,
} from '../../lynx_perf/constants';
import {time} from '../../base/time';
import {Flow} from '../../core/flow_types';
import {isSpecialNativeModule} from './utils';

function flow(beginName: string, beginEndTs: number, endName = ''): Flow {
  return {
    id: 1,
    begin: {
      trackId: 1,
      sliceName: beginName,
      sliceCategory: '',
      sliceId: asSliceSqlId(1),
      sliceStartTs: 0n as time,
      sliceEndTs: BigInt(beginEndTs) as time,
      threadName: '',
      processName: '',
      depth: 0,
      pipelineId: null,
    },
    end: {
      trackId: 1,
      sliceName: endName,
      sliceCategory: '',
      sliceId: asSliceSqlId(2),
      sliceStartTs: 0n as time,
      sliceEndTs: BigInt(beginEndTs + 1) as time,
      threadName: '',
      processName: '',
      depth: 0,
      pipelineId: null,
    },
    dur: 0n,
    flowToDescendant: false,
  };
}

describe('NativeModule utils', () => {
  it('does not treat normal non-timing NativeModule flow as special', () => {
    expect(
      isSpecialNativeModule([
        flow(NATIVEMODULE_INVOKE, 10, NATIVEMODULE_CALLBACK),
      ]),
    ).toBe(false);
  });

  it('treats missing callback timing as special', () => {
    expect(isSpecialNativeModule([flow(NATIVEMODULE_INVOKE, 10)])).toBe(true);
  });
});
