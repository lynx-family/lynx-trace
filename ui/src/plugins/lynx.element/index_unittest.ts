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

import {Workspace} from '../../public/workspace';
import {Trace} from '../../public/trace';
import {IssueRank} from '../../lynx_perf/types';
import {LYNX_PERF_ELEMENT_PLUGIN_ID} from '../../lynx_perf/constants';
import LynxElementPlugin from './index';
import {lynxPerfGlobals} from '../../lynx_perf/lynx_perf_globals';

class TestLynxElementPlugin extends LynxElementPlugin {
  async getIssueData() {
    return [
      {
        id: 1,
        ts: 10,
        trackUri: LYNX_PERF_ELEMENT_PLUGIN_ID,
        issueRank: IssueRank.MODERATE,
        upid: 100,
      },
    ];
  }
}

describe('LynxElementPlugin', () => {
  beforeEach(() => {
    lynxPerfGlobals.resetIssueStatus();
  });

  it('reports element issues without adding a visible Lynx Element Issues track', async () => {
    const workspace = new Workspace();
    const engine = {
      query: jest.fn().mockResolvedValue({numRows: () => 0}),
    };
    const trace = {
      engine,
      currentWorkspace: workspace,
      tracks: {registerTrack: jest.fn()},
      commands: {runCommand: jest.fn()},
    } as unknown as Trace;

    await new TestLynxElementPlugin().onTraceLoad(trace);

    expect(trace.tracks.registerTrack).toHaveBeenCalledWith({
      uri: LYNX_PERF_ELEMENT_PLUGIN_ID,
      renderer: expect.anything(),
    });
    expect(lynxPerfGlobals.state.issues).toHaveLength(1);
    expect(workspace.getTrackByUri(LYNX_PERF_ELEMENT_PLUGIN_ID)).toBeUndefined();
  });
});
