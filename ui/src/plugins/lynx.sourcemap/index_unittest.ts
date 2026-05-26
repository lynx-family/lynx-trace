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

import {getSourceMapRuntimeId, getSourceMapUrl} from './index';

describe('LynxSourceMap args lookup', () => {
  it('reads nested v55 args for source map metadata', () => {
    const args = {
      debug: {
        url: 'lynx://bundle.js',
        runtime_id: 'runtime-1',
      },
    };

    expect(getSourceMapUrl(args)).toBe('lynx://bundle.js');
    expect(getSourceMapRuntimeId(args)).toBe('runtime-1');
  });

  it('normalizes numeric runtime ids from v55 evaluateJavaScript args', () => {
    const args = {
      debug: {
        url: 'lynx://bundle.js',
        runtime_id: 12345,
      },
    };

    expect(getSourceMapRuntimeId(args)).toBe('12345');
  });
});
