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

import {lynxPerfGlobals} from '../../lynx_perf/lynx_perf_globals';
import {canFocusLynxViewArgument} from './slice_args';

describe('slice args LynxView actions', () => {
  afterEach(() => {
    lynxPerfGlobals.reset();
  });

  it('allows focusing non-empty LynxView instance args when instances exist', () => {
    lynxPerfGlobals.updateLynxViewInstances([
      {url: '', instanceId: '1'},
      {url: '', instanceId: '2'},
    ]);

    expect(canFocusLynxViewArgument('debug.instance_id', 1)).toBe(true);
    expect(canFocusLynxViewArgument('args.instance_id', '2')).toBe(true);
  });

  it('does not expose the focus action for unrelated or empty args', () => {
    lynxPerfGlobals.updateLynxViewInstances([{url: '', instanceId: '1'}]);

    expect(canFocusLynxViewArgument('debug.pipeline_id', 1)).toBe(false);
    expect(canFocusLynxViewArgument('debug.instance_id', '')).toBe(false);
    expect(canFocusLynxViewArgument('debug.instance_id', null)).toBe(false);
  });

  it('requires known LynxView instances before showing the focus action', () => {
    expect(canFocusLynxViewArgument('debug.instance_id', 1)).toBe(false);
  });
});
