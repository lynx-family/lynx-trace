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

import {TrackNode} from '../public/workspace';
import {LYNX_VITAL_TIMESTAMP_PLUGIN_ID} from './constants';
import {
  addIssueTrackAboveVitalTimestamp,
  getFirstIssueProcessGroup,
} from './issue_track_utils';
import {IssueRank, IssueSummary} from './types';

function issue(upid: number | null | undefined): IssueSummary {
  return {
    id: 1,
    ts: 10,
    issueRank: IssueRank.MODERATE,
    trackUri: 'lynx.Element',
    upid,
  };
}

describe('issue_track_utils', () => {
  it('does not add issue track when issue list is empty', () => {
    const group = new TrackNode({name: 'Process'});
    const issueTrack = new TrackNode({uri: 'lynx.Element'});

    addIssueTrackAboveVitalTimestamp(group, issueTrack, []);

    expect(group.children).toEqual([]);
  });

  it('adds issue track before Vital Timestamp', () => {
    const group = new TrackNode({name: 'Process'});
    const perfTrack = new TrackNode({uri: 'lynx.Perf'});
    const vitalTrack = new TrackNode({uri: LYNX_VITAL_TIMESTAMP_PLUGIN_ID});
    const issueTrack = new TrackNode({uri: 'lynx.Element'});
    group.addChildLast(perfTrack);
    group.addChildLast(vitalTrack);

    addIssueTrackAboveVitalTimestamp(group, issueTrack, [issue(1)]);

    expect(group.children).toEqual([perfTrack, issueTrack, vitalTrack]);
  });

  it('falls back to sort order when Vital Timestamp is absent', () => {
    const group = new TrackNode({name: 'Process'});
    const laterTrack = new TrackNode({uri: 'later', sortOrder: 10});
    const issueTrack = new TrackNode({uri: 'lynx.Element', sortOrder: 1});
    group.addChildLast(laterTrack);

    addIssueTrackAboveVitalTimestamp(group, issueTrack, [issue(1)]);

    expect(group.children).toEqual([issueTrack, laterTrack]);
  });

  it('finds the first process group with issue data', () => {
    const processOne = new TrackNode({uri: '/process_1'});
    const processTwo = new TrackNode({uri: '/process_2'});
    const processGroups = new Map([
      [1, processOne],
      [2, processTwo],
    ]);

    expect(
      getFirstIssueProcessGroup(
        [issue(undefined), issue(null), issue(2), issue(1)],
        (upid) => processGroups.get(upid),
      ),
    ).toBe(processTwo);
  });
});
