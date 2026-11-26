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

import {time} from '../../../base/time';
import {Args} from '../../../components/sql_utils/args';

export interface BtsVmSlotMemoryRow {
  sampleId: number;
  ts: time;
  slotKey?: string;
  slotValue?: number;
}

export interface BtsVmSlotMemorySample {
  ts: time;
  slots: Readonly<Record<number, number>>;
}

export interface BtsVmSlotPageLifecycle {
  instanceId: number;
  createTs: bigint;
  destroyTs?: bigint;
}

export interface BtsVmSlotMemoryData {
  samples: ReadonlyArray<BtsVmSlotMemorySample>;
  slotIds: ReadonlyArray<number>;
  slotInstanceIds: Readonly<Record<number, ReadonlyArray<number>>>;
  slotPageLifecycles: Readonly<
    Record<number, ReadonlyArray<BtsVmSlotPageLifecycle>>
  >;
  vmGcTimestamps: ReadonlyArray<time>;
}

export function isBtsVmPageSlot(slotId: number | undefined): slotId is number {
  return (
    slotId !== undefined &&
    Number.isInteger(slotId) &&
    slotId >= 3 &&
    slotId <= 255
  );
}

export function parseBtsVmSlotId(slotKey: string): number | undefined {
  const match = /^(?:debug\.)?slot_(\d+)$/.exec(slotKey);
  if (match === null) {
    return undefined;
  }
  const slotId = Number(match[1]);
  return Number.isSafeInteger(slotId) ? slotId : undefined;
}

export function buildBtsVmSlotMemoryData(
  rows: ReadonlyArray<BtsVmSlotMemoryRow>,
): BtsVmSlotMemoryData {
  const samplesById = new Map<
    number,
    {ts: time; slots: Record<number, number>}
  >();
  const slotIds = new Set<number>();

  for (const row of rows) {
    let sample = samplesById.get(row.sampleId);
    if (sample === undefined) {
      sample = {ts: row.ts, slots: {}};
      samplesById.set(row.sampleId, sample);
    }
    if (row.slotKey === undefined || row.slotValue === undefined) {
      continue;
    }
    const slotId = parseBtsVmSlotId(row.slotKey);
    if (slotId === undefined || !Number.isFinite(row.slotValue)) {
      continue;
    }
    sample.slots[slotId] = Math.max(0, row.slotValue);
    slotIds.add(slotId);
  }

  return {
    samples: [...samplesById.entries()]
      .sort(([sampleIdA, sampleA], [sampleIdB, sampleB]) => {
        if (sampleA.ts !== sampleB.ts) {
          return sampleA.ts < sampleB.ts ? -1 : 1;
        }
        return sampleIdA - sampleIdB;
      })
      .map(([, sample]) => sample),
    slotIds: [...slotIds].sort((a, b) => a - b),
    slotInstanceIds: {},
    slotPageLifecycles: {},
    vmGcTimestamps: [],
  };
}

export function formatBtsVmSlotLabel(
  slotId: number,
  instanceIds: ReadonlyArray<number> = [],
  destroyedInstanceIds: ReadonlyArray<number> = [],
): string {
  if (slotId === 0) {
    return 'Unknown(slot 0)';
  }
  if (slotId === 1) {
    return 'Common(slot 1)';
  }
  if (slotId === 2) {
    return 'Overflow(slot 2)';
  }
  if (instanceIds.length === 1) {
    const destroyed = destroyedInstanceIds.includes(instanceIds[0])
      ? ', destroyed'
      : '';
    return `Instance ${instanceIds[0]}(slot ${slotId}${destroyed})`;
  }
  if (instanceIds.length > 1) {
    const destroyed =
      destroyedInstanceIds.length === 0
        ? ''
        : `, destroyed instances: ${destroyedInstanceIds.join(', ')}`;
    return `Instances ${instanceIds.join(', ')}(slot ${slotId}${destroyed})`;
  }
  return `Unknown(slot ${slotId})`;
}

export function buildBtsVmSlotInstanceIds(
  uses: ReadonlyArray<{
    instanceId: number;
    slot?: number;
    ts: bigint;
    url?: string;
  }>,
  end: time,
): Readonly<Record<number, ReadonlyArray<number>>> {
  const instanceIdsBySlot: Record<number, number[]> = {};
  for (const use of uses) {
    if (!isBtsVmPageSlot(use.slot) || use.ts > end) {
      continue;
    }
    const instanceIds = (instanceIdsBySlot[use.slot] ??= []);
    if (!instanceIds.includes(use.instanceId)) {
      instanceIds.push(use.instanceId);
      instanceIds.sort((a, b) => a - b);
    }
  }
  return instanceIdsBySlot;
}

export function buildBtsVmSlotDestroyedInstanceIds(
  uses: ReadonlyArray<{
    instanceId: number;
    slot?: number;
    ts: bigint;
    destroyTs?: bigint;
  }>,
  end: time,
): Readonly<Record<number, ReadonlyArray<number>>> {
  const destroyedInstanceIdsBySlot: Record<number, number[]> = {};
  for (const use of uses) {
    if (
      !isBtsVmPageSlot(use.slot) ||
      use.ts > end ||
      use.destroyTs === undefined ||
      use.destroyTs > end
    ) {
      continue;
    }
    const instanceIds = (destroyedInstanceIdsBySlot[use.slot] ??= []);
    if (!instanceIds.includes(use.instanceId)) {
      instanceIds.push(use.instanceId);
      instanceIds.sort((a, b) => a - b);
    }
  }
  return destroyedInstanceIdsBySlot;
}

export function buildBtsVmSlotPageLifecycles(
  uses: ReadonlyArray<{
    instanceId: number;
    slot?: number;
    ts: bigint;
    destroyTs?: bigint;
  }>,
  end: time,
): Readonly<Record<number, ReadonlyArray<BtsVmSlotPageLifecycle>>> {
  const lifecyclesBySlot: Record<number, BtsVmSlotPageLifecycle[]> = {};
  for (const use of uses) {
    if (!isBtsVmPageSlot(use.slot) || use.ts > end) {
      continue;
    }
    (lifecyclesBySlot[use.slot] ??= []).push({
      instanceId: use.instanceId,
      createTs: use.ts,
      destroyTs: use.destroyTs,
    });
  }
  return lifecyclesBySlot;
}

export function getBtsVmSlotPageStateAt(
  lifecycles: ReadonlyArray<BtsVmSlotPageLifecycle>,
  ts: bigint,
): {
  instanceIds: ReadonlyArray<number>;
  destroyedInstanceIds: ReadonlyArray<number>;
} {
  const pages = lifecycles.filter((page) => page.createTs <= ts);
  return {
    instanceIds: pages.map((page) => page.instanceId),
    destroyedInstanceIds: pages
      .filter((page) => page.destroyTs !== undefined && page.destroyTs <= ts)
      .map((page) => page.instanceId),
  };
}

export function buildBtsVmSlotPageUrls(
  uses: ReadonlyArray<{
    instanceId: number;
    slot?: number;
    ts: bigint;
    url?: string;
  }>,
  end: time,
  fallbackUrls: Readonly<Record<number, string>> = {},
): Readonly<Record<number, Readonly<Record<number, string>>>> {
  const urlsBySlot: Record<number, Record<number, string>> = {};
  for (const use of uses) {
    const url = use.url?.trim() || fallbackUrls[use.instanceId];
    if (!isBtsVmPageSlot(use.slot) || use.ts > end || url === undefined) {
      continue;
    }
    (urlsBySlot[use.slot] ??= {})[use.instanceId] = url;
  }
  return urlsBySlot;
}

export function extractBtsVmSlotBytes(
  ...sources: ReadonlyArray<Args | undefined>
): Readonly<Record<number, number>> {
  const slotBytes: Record<number, number> = {};

  const visit = (value: Args, prefix: string) => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [key, child] of Object.entries(value)) {
        visit(child, prefix === '' ? key : `${prefix}.${key}`);
      }
      return;
    }

    const slotId = parseBtsVmSlotId(prefix);
    if (slotId === undefined) {
      return;
    }
    const numberValue = Number(value);
    if (Number.isFinite(numberValue)) {
      slotBytes[slotId] = Math.max(0, numberValue);
    }
  };

  for (const source of sources) {
    if (source !== undefined) {
      visit(source, '');
    }
  }
  return slotBytes;
}

export function getBtsVmPageMemoryBytes(
  slotId: number | undefined,
  slotBytes: Readonly<Record<number, number>>,
): number | undefined {
  return isBtsVmPageSlot(slotId) ? slotBytes[slotId] : undefined;
}

export function isBtsVmResidualAccurate(
  destroyTs: bigint | undefined,
  sampleTs: bigint | undefined,
  gcTimestamps: ReadonlyArray<bigint>,
): boolean {
  return (
    destroyTs !== undefined &&
    sampleTs !== undefined &&
    gcTimestamps.some((gcTs) => gcTs > destroyTs && gcTs <= sampleTs)
  );
}
