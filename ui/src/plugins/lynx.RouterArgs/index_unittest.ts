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

import {App} from '../../public/app';
import {Trace} from '../../public/trace';
import LynxRouterArgsPlugin from './index';

describe('LynxRouterArgsPlugin', () => {
  it('selects slice id from initial route args', async () => {
    await LynxRouterArgsPlugin.onActivate({
      initialRouteArgs: {sliceId: '123'},
      sidebar: {visible: false, toggleVisibility: jest.fn()},
    } as unknown as App);

    const trace = {
      selection: {selectSqlEvent: jest.fn()},
      engine: {query: jest.fn()},
    } as unknown as Trace;

    await new LynxRouterArgsPlugin().onTraceLoad(trace);

    expect(trace.selection.selectSqlEvent).toHaveBeenCalledWith('slice', 123, {
      scrollToSelection: true,
    });
    expect(trace.engine.query).not.toHaveBeenCalled();
  });

  it('selects the first slice matching the initial event name', async () => {
    await LynxRouterArgsPlugin.onActivate({
      initialRouteArgs: {eventName: 'LynxLoadTemplate'},
      sidebar: {visible: false, toggleVisibility: jest.fn()},
    } as unknown as App);

    const trace = {
      selection: {selectSqlEvent: jest.fn()},
      engine: {
        query: jest.fn().mockResolvedValue({
          numRows: () => 1,
          firstRow: () => ({id: 456}),
        }),
      },
    } as unknown as Trace;

    await new LynxRouterArgsPlugin().onTraceLoad(trace);

    expect(trace.selection.selectSqlEvent).toHaveBeenCalledWith('slice', 456, {
      scrollToSelection: true,
    });
  });
});
