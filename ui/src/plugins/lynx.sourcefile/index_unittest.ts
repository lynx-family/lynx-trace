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

import {Trace} from '../../public/trace';
import {clearSourceMapState, sourceMapState} from '../../source_map/source_map_state';
import LynxSourceFilePlugin from './index';

function iterRows<T extends object>(rows: T[]) {
  let index = 0;
  return {
    valid: () => index < rows.length,
    next: () => index++,
    get file() {
      return (rows[index] as T & {file: string}).file;
    },
    get content() {
      return (rows[index] as T & {content: string}).content;
    },
  };
}

describe('LynxSourceFilePlugin', () => {
  afterEach(() => {
    clearSourceMapState();
  });

  it('loads source_files rows into source map state', async () => {
    const trace = {
      engine: {
        query: jest.fn().mockResolvedValue({
          iter: () =>
            iterRows([
              {file: 'src/page.tsx', content: 'export const page = 1;'},
              {file: 'src/card.tsx', content: 'export const card = 2;'},
            ]),
        }),
      },
    } as unknown as Trace;

    await new LynxSourceFilePlugin().onTraceLoad(trace);

    expect(sourceMapState.state.sourceFile).toEqual({
      'src/page.tsx': {
        key: 'src/page.tsx',
        content: 'export const page = 1;',
      },
      'src/card.tsx': {
        key: 'src/card.tsx',
        content: 'export const card = 2;',
      },
    });
  });
});
