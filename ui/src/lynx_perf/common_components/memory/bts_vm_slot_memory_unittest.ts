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

import {Time} from '../../../base/time';
import {
  buildBtsVmSlotDestroyedInstanceIds,
  buildBtsVmSlotInstanceIds,
  buildBtsVmSlotPageUrls,
  buildBtsVmSlotPageLifecycles,
  buildBtsVmSlotMemoryData,
  extractBtsVmSlotBytes,
  formatBtsVmSlotLabel,
  getBtsVmPageMemoryBytes,
  getBtsVmSlotPageStateAt,
  isBtsVmPageSlot,
  isBtsVmResidualAccurate,
  parseBtsVmSlotId,
} from './bts_vm_slot_memory';

describe('BTS VM slot memory', () => {
  it('parses supported slot keys', () => {
    expect(parseBtsVmSlotId('debug.slot_0')).toBe(0);
    expect(parseBtsVmSlotId('slot_12')).toBe(12);
    expect(parseBtsVmSlotId('debug.slot_invalid')).toBeUndefined();
    expect(parseBtsVmSlotId('debug.base_usage')).toBeUndefined();
  });

  it('recognizes only page-owned slot ids', () => {
    expect(isBtsVmPageSlot(undefined)).toBe(false);
    expect(isBtsVmPageSlot(2)).toBe(false);
    expect(isBtsVmPageSlot(3)).toBe(true);
    expect(isBtsVmPageSlot(255)).toBe(true);
    expect(isBtsVmPageSlot(256)).toBe(false);
  });

  it('groups samples and sorts slots by numeric id', () => {
    const data = buildBtsVmSlotMemoryData([
      {
        sampleId: 20,
        ts: Time.fromRaw(200n),
        slotKey: 'debug.slot_2',
        slotValue: 300,
      },
      {
        sampleId: 10,
        ts: Time.fromRaw(100n),
        slotKey: 'debug.slot_1',
        slotValue: 200,
      },
      {
        sampleId: 10,
        ts: Time.fromRaw(100n),
        slotKey: 'debug.slot_0',
        slotValue: -1,
      },
      {
        sampleId: 20,
        ts: Time.fromRaw(200n),
        slotKey: 'debug.invalid',
        slotValue: 900,
      },
      {
        sampleId: 30,
        ts: Time.fromRaw(300n),
      },
    ]);

    expect(data.slotIds).toEqual([0, 1, 2]);
    expect(data.slotInstanceIds).toEqual({});
    expect(data.slotPageLifecycles).toEqual({});
    expect(data.vmGcTimestamps).toEqual([]);
    expect(data.samples).toEqual([
      {
        ts: Time.fromRaw(100n),
        slots: {0: 0, 1: 200},
      },
      {
        ts: Time.fromRaw(200n),
        slots: {2: 300},
      },
      {
        ts: Time.fromRaw(300n),
        slots: {},
      },
    ]);
  });

  it('formats reserved and page slot labels', () => {
    expect(formatBtsVmSlotLabel(0)).toBe('Unknown(slot 0)');
    expect(formatBtsVmSlotLabel(1)).toBe('Common(slot 1)');
    expect(formatBtsVmSlotLabel(2)).toBe('Overflow(slot 2)');
    expect(formatBtsVmSlotLabel(3, [2])).toBe('Instance 2(slot 3)');
    expect(formatBtsVmSlotLabel(3, [2], [2])).toBe(
      'Instance 2(slot 3, destroyed)',
    );
    expect(formatBtsVmSlotLabel(4, [2, 7])).toBe('Instances 2, 7(slot 4)');
  });

  it('maps destroyed pages and resolves state at a sample timestamp', () => {
    const uses = [
      {instanceId: 1, slot: 2, ts: 10n, destroyTs: 20n},
      {instanceId: 7, slot: 3, ts: 20n, destroyTs: 35n},
      {instanceId: 9, slot: 4, ts: 50n},
    ];
    const end = Time.fromRaw(40n);

    expect(buildBtsVmSlotDestroyedInstanceIds(uses, end)).toEqual({
      3: [7],
    });
    const lifecycles = buildBtsVmSlotPageLifecycles(uses, end);
    expect(lifecycles).toEqual({
      3: [{instanceId: 7, createTs: 20n, destroyTs: 35n}],
    });
    expect(getBtsVmSlotPageStateAt(lifecycles[3], 34n)).toEqual({
      instanceIds: [7],
      destroyedInstanceIds: [],
    });
    expect(getBtsVmSlotPageStateAt(lifecycles[3], 35n)).toEqual({
      instanceIds: [7],
      destroyedInstanceIds: [7],
    });
  });

  it('maps only page slots assigned before the selection end', () => {
    expect(
      buildBtsVmSlotInstanceIds(
        [
          {instanceId: 1, slot: 2, ts: 10n},
          {instanceId: 7, slot: 3, ts: 20n},
          {instanceId: 2, slot: 3, ts: 30n},
          {instanceId: 9, slot: 4, ts: 50n},
        ],
        Time.fromRaw(40n),
      ),
    ).toEqual({
      3: [2, 7],
    });
  });

  it('maps page URLs for page slots only', () => {
    expect(
      buildBtsVmSlotPageUrls(
        [
          {instanceId: 1, slot: 2, ts: 10n, url: 'overflow'},
          {instanceId: 2, slot: 3, ts: 20n, url: 'page://two'},
          {instanceId: 3, slot: 4, ts: 50n, url: 'page://three'},
          {instanceId: 4, slot: 5, ts: 30n},
        ],
        Time.fromRaw(40n),
        {
          4: 'page://four',
        },
      ),
    ).toEqual({
      3: {
        2: 'page://two',
      },
      5: {
        4: 'page://four',
      },
    });
  });

  it('extracts slot bytes from nested and flat args', () => {
    expect(
      extractBtsVmSlotBytes(
        {
          debug: {
            slot_0: '128',
            slot_2: 512,
          },
        },
        {
          'debug.slot_2': '1024',
          'debug.slot_3': '2048',
          'debug.base_usage': '4096',
        },
      ),
    ).toEqual({
      0: 128,
      2: 1024,
      3: 2048,
    });
  });

  it('returns memory only for valid page slots with a sample value', () => {
    const slotBytes = {2: 100, 3: 200, 255: 300};

    expect(getBtsVmPageMemoryBytes(2, slotBytes)).toBeUndefined();
    expect(getBtsVmPageMemoryBytes(3, slotBytes)).toBe(200);
    expect(getBtsVmPageMemoryBytes(4, slotBytes)).toBeUndefined();
    expect(getBtsVmPageMemoryBytes(255, slotBytes)).toBe(300);
    expect(getBtsVmPageMemoryBytes(256, slotBytes)).toBeUndefined();
  });

  it('marks residual memory accurate only after a post-destroy GC sample', () => {
    const gcTimestamps = [10n, 30n, 50n];

    expect(isBtsVmResidualAccurate(undefined, 60n, gcTimestamps)).toBe(false);
    expect(isBtsVmResidualAccurate(30n, 50n, [10n, 30n])).toBe(false);
    expect(isBtsVmResidualAccurate(31n, 49n, gcTimestamps)).toBe(false);
    expect(isBtsVmResidualAccurate(31n, 50n, gcTimestamps)).toBe(true);
  });
});
