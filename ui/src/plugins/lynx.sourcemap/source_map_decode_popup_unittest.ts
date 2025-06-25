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
  clearSourceMapState,
  sourceMapState,
} from '../../source_map/source_map_state';
import {getSourceMapDecodeUrls} from './source_map_decode_popup';

describe('SourceMapDecodePopup', () => {
  afterEach(() => {
    clearSourceMapState();
  });

  it('lists unique source map URLs from sourceMapInfoByUrl', () => {
    sourceMapState.edit((draft) => {
      draft.sourceMapInfoByUrl.set('runtime-1:https://example/a.js', {
        runtime_id: 'runtime-1',
        url: 'https://example/a.js',
        page_url: 'https://example/page',
        key: 'https://example/a.js.map',
      });
      draft.sourceMapInfoByUrl.set('runtime-2:https://example/a.js', {
        runtime_id: 'runtime-2',
        url: 'https://example/a.js',
        page_url: 'https://example/page',
        key: 'https://example/a.js.map',
      });
      draft.sourceMapInfoByUrl.set('runtime-3:https://example/b.js', {
        runtime_id: 'runtime-3',
        url: 'https://example/b.js',
        page_url: 'https://example/page',
        key: 'https://example/b.js.map',
      });
    });

    expect(getSourceMapDecodeUrls()).toEqual([
      'https://example/a.js.map',
      'https://example/b.js.map',
    ]);
  });
});
