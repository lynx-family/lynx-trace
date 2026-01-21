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
import {IssueSummary} from './types';

export function addIssueTrackAboveVitalTimestamp(
  group: TrackNode,
  issueTrack: TrackNode,
  issues: IssueSummary[],
) {
  if (issues.length === 0) {
    return;
  }
  const vitalTimestampTrack = group.getTrackByUri(
    LYNX_VITAL_TIMESTAMP_PLUGIN_ID,
  );
  if (vitalTimestampTrack !== undefined) {
    group.addChildBefore(issueTrack, vitalTimestampTrack);
    return;
  }
  group.addChildInOrder(issueTrack);
}

export function getFirstIssueProcessGroup(
  issues: IssueSummary[],
  getProcessGroup: (upid: number) => TrackNode | undefined,
): TrackNode | undefined {
  for (const issue of issues) {
    if (issue.upid === null || issue.upid === undefined) {
      continue;
    }
    const group = getProcessGroup(issue.upid);
    if (group !== undefined) {
      return group;
    }
  }
  return undefined;
}
