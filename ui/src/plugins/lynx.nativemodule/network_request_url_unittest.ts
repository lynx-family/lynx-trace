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

import {attachNetworkRequestUrlsToNativeModules} from './utils';

describe('NativeModule network request URL association', () => {
  it('attaches URL from a matching request inside the invoke range', () => {
    const calls = [
      {
        ts: 100,
        dur: 20,
        flowId: 0,
        moduleName: 'LynxFetchModule',
        methodName: 'fetch',
        url: '',
      },
    ];

    attachNetworkRequestUrlsToNativeModules(calls, [
      {
        ts: 110,
        flowId: 0,
        moduleName: 'LynxFetchModule',
        methodName: 'fetch',
        url: 'https://example.com/model',
      },
    ]);

    expect(calls[0].url).toBe('https://example.com/model');
  });

  it('prefers a same-flow request over a range match', () => {
    const calls = [
      {
        ts: 100,
        dur: 20,
        flowId: 7,
        moduleName: 'LynxFetchModule',
        methodName: 'fetch',
        url: '',
      },
    ];

    attachNetworkRequestUrlsToNativeModules(calls, [
      {
        ts: 110,
        flowId: 0,
        moduleName: 'LynxFetchModule',
        methodName: 'fetch',
        url: 'https://example.com/range',
      },
      {
        ts: 300,
        flowId: 7,
        moduleName: 'LynxFetchModule',
        methodName: 'fetch',
        url: 'https://example.com/flow',
      },
    ]);

    expect(calls[0].url).toBe('https://example.com/flow');
  });

  it('does not attach unrelated nearby URLs', () => {
    const calls = [
      {
        ts: 100,
        dur: 20,
        flowId: 0,
        moduleName: 'LynxFetchModule',
        methodName: 'fetch',
        url: '',
      },
    ];

    attachNetworkRequestUrlsToNativeModules(calls, [
      {
        ts: 110,
        flowId: 0,
        moduleName: 'runtimeBridge',
        methodName: 'call',
        url: 'https://example.com/app-fetch',
      },
    ]);

    expect(calls[0].url).toBe('');
  });
});
