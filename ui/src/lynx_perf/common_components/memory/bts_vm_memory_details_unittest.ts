// Copyright (C) 2026 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import {buildBtsVmMemorySample} from './bts_vm_memory_details';

describe('BTS VM memory details', () => {
  it('uses the counter value for Accumulate and sums RSS fields', () => {
    const annotations = {
      ptr: '0x1234',
      label: 'sample',
    };

    expect(
      buildBtsVmMemorySample(
        8 * 1024 * 1024,
        3 * 1024 * 1024,
        2 * 1024 * 1024,
        {
          debug: {
            annotations,
          },
        },
      ),
    ).toEqual({
      accumulateBytes: 8 * 1024 * 1024,
      rssBytes: 5 * 1024 * 1024,
      annotations,
    });
  });

  it('supports the literal debug.annotations argument key', () => {
    expect(
      buildBtsVmMemorySample(1024, 512, 256, {
        'debug.annotations': 'raw annotation',
      }),
    ).toEqual({
      accumulateBytes: 1024,
      rssBytes: 768,
      annotations: 'raw annotation',
    });
  });

  it('prefers annotations loaded directly from the args table', () => {
    expect(
      buildBtsVmMemorySample(
        1024,
        512,
        256,
        {'debug.annotations': 'parsed annotation'},
        {
          'debug.base_usage': '512',
          'debug.ptr': '0x1234',
        },
      ),
    ).toMatchObject({
      annotations: {
        'debug.base_usage': '512',
        'debug.ptr': '0x1234',
      },
    });
  });

  it('defaults missing or invalid memory values to zero', () => {
    expect(
      buildBtsVmMemorySample(Number.NaN, Number.NaN, Number.POSITIVE_INFINITY),
    ).toEqual({
      accumulateBytes: 0,
      rssBytes: 0,
      annotations: undefined,
    });
  });
});
