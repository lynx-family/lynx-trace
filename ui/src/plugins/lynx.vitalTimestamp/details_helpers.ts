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
  CRUCIAL_TIMING_KEYS,
  TIMING_MARK_FRAMEWORK_PREFIX,
  TIMING_MARK_PREFIX,
} from '../../lynx_perf/constants';
import type {PipelineTimeStamp} from './details';

export const TIMING_START = 'Start';
const TIMING_END = 'End';
const FRAMEWORK_TIMING_START = '_start';
const FRAMEWORK_TIMING_END = '_end';

export function normalizeVitalTimestampName(name: string): string {
  if (name.startsWith(TIMING_MARK_FRAMEWORK_PREFIX)) {
    return name.replace(TIMING_MARK_FRAMEWORK_PREFIX, '');
  }
  if (name.startsWith(TIMING_MARK_PREFIX)) {
    return name.replace(TIMING_MARK_PREFIX, '');
  }
  if (name.endsWith(CRUCIAL_TIMING_KEYS[1])) {
    return name.replace('Timing::', '');
  }
  return name;
}

export function validPipelineBeginStage(name: string): boolean {
  return (
    name.endsWith(TIMING_START) ||
    name.endsWith(FRAMEWORK_TIMING_START) ||
    CRUCIAL_TIMING_KEYS.includes(name)
  );
}

export function matchedEndStage(
  vitalTimestamps: PipelineTimeStamp[],
  timestamp: PipelineTimeStamp,
): PipelineTimeStamp | undefined {
  if (CRUCIAL_TIMING_KEYS.includes(timestamp.name)) {
    return timestamp;
  }
  if (timestamp.name.endsWith(TIMING_START)) {
    return vitalTimestamps.find(
      (stamp) =>
        stamp.name === timestamp.name.replace(TIMING_START, TIMING_END) &&
        stamp.threadName === timestamp.threadName,
    );
  }
  if (timestamp.name.endsWith(FRAMEWORK_TIMING_START)) {
    return vitalTimestamps.find(
      (stamp) =>
        stamp.name ===
          timestamp.name.replace(FRAMEWORK_TIMING_START, FRAMEWORK_TIMING_END) &&
        stamp.threadName === timestamp.threadName,
    );
  }
  return undefined;
}
