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

import {registerUiMappingInfoResolver} from '../../base/ui_source_mapping';
import {Engine} from '../../trace_processor/engine';
import {getArgs} from './args';
import {asArgSetId} from './core_types';

function mockEngine(argsJson: string): Engine {
  return {
    query: jest.fn().mockResolvedValue({
      iter: () => ({
        valid: () => true,
        args_json: argsJson,
      }),
    }),
  } as unknown as Engine;
}

describe('getArgs', () => {
  afterEach(() => {
    registerUiMappingInfoResolver(() => null);
  });

  it('adds UI source mapping for Lynx element args', async () => {
    registerUiMappingInfoResolver((instanceId, nodeIndex) => {
      if (instanceId !== 'instance-1' || nodeIndex !== 7) {
        return null;
      }
      return {
        fileName: 'src/card.tsx',
        line: 12,
        column: 8,
      };
    });

    const args = await getArgs(
      mockEngine(
        JSON.stringify({
          debug: {
            instance_id: 'instance-1',
            nodeIndex: 7,
          },
        }),
      ),
      asArgSetId(1),
    );

    expect(args).toEqual({
      debug: {
        instance_id: 'instance-1',
        nodeIndex: 7,
        source: 'src/card.tsx:12:8',
      },
    });
  });
});
