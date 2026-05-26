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

import {focusModeFilterKey} from './filter_key';

describe('focusModeFilterKey', () => {
  it('is unchanged when the selected instance ids and no-instance flag are unchanged', () => {
    const key = focusModeFilterKey(
      [
        {instanceId: '1', url: 'first'},
        {instanceId: '2', url: 'second'},
      ],
      true,
    );

    expect(
      focusModeFilterKey(
        [
          {instanceId: '1', url: 'updated-first'},
          {instanceId: '2', url: 'updated-second'},
        ],
        true,
      ),
    ).toBe(key);
  });

  it('changes when the selected instance ids or no-instance flag changes', () => {
    const key = focusModeFilterKey([{instanceId: '1', url: ''}], true);

    expect(focusModeFilterKey([{instanceId: '2', url: ''}], true)).not.toBe(
      key,
    );
    expect(focusModeFilterKey([{instanceId: '1', url: ''}], false)).not.toBe(
      key,
    );
  });
});
