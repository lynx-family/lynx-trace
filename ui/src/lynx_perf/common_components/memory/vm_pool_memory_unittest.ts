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

import {calculateVmPoolMemoryFromArgs} from './vm_pool_memory';

describe('VM pool memory', () => {
  it('aggregates engine count, accumulate, and resident memory', () => {
    expect(
      calculateVmPoolMemoryFromArgs({
        debug: {
          id_0: JSON.stringify({
            acc_usage: 100,
            base_usage: 200,
            page_rss_usage: 300,
          }),
          id_1: JSON.stringify({
            acc_usage: 400,
            base_usage: 500,
            page_rss_usage: 600,
          }),
          is_global_pool: '0',
          url: 'page://one',
        },
      }),
    ).toEqual({
      instanceCount: 2,
      sizeBytes: 500,
      rssSizeBytes: 1600,
    });
  });

  it('ignores malformed and unrelated annotations', () => {
    expect(
      calculateVmPoolMemoryFromArgs({
        'debug.id_0': 'invalid',
        'debug.url': 'page://one',
      }),
    ).toEqual({
      instanceCount: 0,
      sizeBytes: 0,
      rssSizeBytes: 0,
    });
  });
});
