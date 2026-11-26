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

import {Engine} from '../../../trace_processor/engine';
import {
  LONG,
  NUM,
  NUM_NULL,
  STR,
  STR_NULL,
} from '../../../trace_processor/query_result';

export const PAGE_USES_BTS_VM = 'page_uses_bts_vm';
export const BTS_RUNTIME_DESTROY = 'BTSRuntime::Destroy';
export const DESTROY_VM_INSTANCE = 'destroy_vm_instance';
export const VM_GC = 'VM_GC';

export interface BtsVmLifecycleEvent {
  sliceId: number;
  ts: bigint;
  eventName:
    | typeof PAGE_USES_BTS_VM
    | typeof BTS_RUNTIME_DESTROY
    | typeof DESTROY_VM_INSTANCE
    | typeof VM_GC;
  ptr?: string;
  groupId?: string;
  instanceId?: number;
  slot?: number;
  desc?: string;
  url?: string;
}

export interface BtsVmUse {
  instanceId: number;
  ts: bigint;
  slot?: number;
  desc: string;
  url?: string;
  destroyTs?: bigint;
}

export interface BtsVmInstance {
  name: string;
  generation: number;
  shared: boolean;
  ptrs: string[];
  desc: string;
  createTs: bigint;
  destroyTs?: bigint;
  uses: BtsVmUse[];
  gcTimestamps: bigint[];
}

export function formatBtsVmInstanceName(
  name: string,
  generation: number,
): string {
  return `${name}(${generation})`;
}

export function buildBtsVmInstances(
  lifecycleEvents: BtsVmLifecycleEvent[],
): BtsVmInstance[] {
  const instances: BtsVmInstance[] = [];
  const activeByPtr = new Map<string, BtsVmInstance>();
  const activeByName = new Map<string, BtsVmInstance>();
  const activeUseByInstanceId = new Map<number, BtsVmUse>();
  const nextGeneration = new Map<string, number>();
  const events = [...lifecycleEvents].sort((a, b) => {
    if (a.ts === b.ts) {
      return a.sliceId - b.sliceId;
    }
    return a.ts < b.ts ? -1 : 1;
  });

  for (const event of events) {
    if (event.eventName === BTS_RUNTIME_DESTROY) {
      if (event.instanceId === undefined) {
        continue;
      }
      const use = activeUseByInstanceId.get(event.instanceId);
      if (use !== undefined && event.ts >= use.ts) {
        use.destroyTs = event.ts;
        activeUseByInstanceId.delete(event.instanceId);
      }
      continue;
    }

    if (event.eventName === VM_GC) {
      if (event.ptr !== undefined) {
        activeByPtr.get(event.ptr)?.gcTimestamps.push(event.ts);
      }
      continue;
    }

    if (event.eventName === DESTROY_VM_INSTANCE) {
      if (event.ptr === undefined) {
        continue;
      }
      const active = activeByPtr.get(event.ptr);
      if (active === undefined) {
        continue;
      }

      active.destroyTs = event.ts;
      nextGeneration.set(active.name, active.generation + 1);
      for (const ptr of active.ptrs) {
        activeByPtr.delete(ptr);
      }
      if (activeByName.get(active.name) === active) {
        activeByName.delete(active.name);
      }
      for (const use of active.uses) {
        if (activeUseByInstanceId.get(use.instanceId) === use) {
          activeUseByInstanceId.delete(use.instanceId);
        }
      }
      continue;
    }

    if (
      event.ptr === undefined ||
      event.instanceId === undefined ||
      event.groupId === undefined
    ) {
      continue;
    }

    const shared = event.groupId !== '-1';
    const name = shared ? event.groupId : `standalone_${event.instanceId}`;
    let instance = activeByPtr.get(event.ptr) ?? activeByName.get(name);
    if (instance === undefined) {
      instance = {
        name,
        generation: nextGeneration.get(name) ?? 0,
        shared,
        ptrs: [],
        desc: event.desc ?? '',
        createTs: event.ts,
        uses: [],
        gcTimestamps: [],
      };
      instances.push(instance);
      activeByName.set(name, instance);
    }

    if (!instance.ptrs.includes(event.ptr)) {
      instance.ptrs.push(event.ptr);
    }
    activeByPtr.set(event.ptr, instance);
    if (instance.desc === '' && event.desc !== undefined) {
      instance.desc = event.desc;
    }

    const currentUse = instance.uses.find(
      (use) => use.instanceId === event.instanceId,
    );
    if (currentUse === undefined) {
      const use = {
        instanceId: event.instanceId,
        ts: event.ts,
        slot: event.slot,
        desc: event.desc ?? '',
        url: event.url,
      };
      instance.uses.push(use);
      activeUseByInstanceId.set(event.instanceId, use);
    } else {
      currentUse.slot ??= event.slot;
      currentUse.desc = currentUse.desc || event.desc || '';
      currentUse.url = currentUse.url || event.url;
      if (currentUse.destroyTs === undefined) {
        activeUseByInstanceId.set(event.instanceId, currentUse);
      }
    }
  }

  return instances;
}

export function findBtsVmForPage(
  instances: BtsVmInstance[],
  instanceId: number,
): BtsVmInstance | undefined {
  return instances.find((instance) =>
    instance.uses.some((use) => use.instanceId === instanceId),
  );
}

export function findBtsVmByNameAt(
  instances: BtsVmInstance[],
  name: string,
  ts: bigint,
): BtsVmInstance | undefined {
  return instances.find(
    (instance) =>
      instance.name === name &&
      instance.createTs <= ts &&
      (instance.destroyTs === undefined || ts < instance.destroyTs),
  );
}

export function findDestroyedBtsVm(
  instances: BtsVmInstance[],
  ptr: string,
  destroyTs: bigint,
): BtsVmInstance | undefined {
  return instances.find(
    (instance) =>
      instance.ptrs.includes(ptr) && instance.destroyTs === destroyTs,
  );
}

export function getSharedBtsNameFromSnapshotId(
  snapshotVmId: string,
): string | undefined {
  return /^(.*)\(shared bts\)$/.exec(snapshotVmId)?.[1];
}

export function getSingleBtsPageIdFromSnapshotId(
  snapshotVmId: string,
): number | undefined {
  const value = /^instance_(\d+)\(single bts\)$/.exec(snapshotVmId)?.[1];
  if (value === undefined) {
    return undefined;
  }
  return Number(value);
}

export async function loadBtsVmInstances(
  engine: Engine,
): Promise<BtsVmInstance[]> {
  const result = await engine.query(`
    SELECT
      slice.id,
      CASE
        WHEN slice.name IN ('${BTS_RUNTIME_DESTROY}', '${VM_GC}')
          THEN slice.ts + slice.dur
        ELSE slice.ts
      END AS eventTs,
      slice.name,
      (
        SELECT arg.display_value
        FROM args arg
        WHERE arg.arg_set_id = slice.arg_set_id
          AND arg.flat_key IN ('ptr', 'debug.ptr')
        LIMIT 1
      ) AS ptr,
      (
        SELECT arg.display_value
        FROM args arg
        WHERE arg.arg_set_id = slice.arg_set_id
          AND arg.flat_key IN ('group_id', 'debug.group_id')
        LIMIT 1
      ) AS groupId,
      CAST((
        SELECT arg.display_value
        FROM args arg
        WHERE arg.arg_set_id = slice.arg_set_id
          AND arg.flat_key IN ('instance_id', 'debug.instance_id')
        LIMIT 1
      ) AS INT) AS instanceId,
      CAST((
        SELECT arg.display_value
        FROM args arg
        WHERE arg.arg_set_id = slice.arg_set_id
          AND arg.flat_key IN ('slot', 'debug.slot')
        LIMIT 1
      ) AS INT) AS slot,
      (
        SELECT arg.display_value
        FROM args arg
        WHERE arg.arg_set_id = slice.arg_set_id
          AND arg.flat_key IN ('desc', 'debug.desc')
        LIMIT 1
      ) AS desc,
      (
        SELECT arg.display_value
        FROM args arg
        WHERE arg.arg_set_id = slice.arg_set_id
          AND arg.flat_key IN ('url', 'debug.url')
        LIMIT 1
      ) AS url
    FROM slice
    WHERE name IN (
      '${PAGE_USES_BTS_VM}',
      '${BTS_RUNTIME_DESTROY}',
      '${DESTROY_VM_INSTANCE}',
      '${VM_GC}'
    )
      AND NOT (
        name IN ('${BTS_RUNTIME_DESTROY}', '${VM_GC}')
        AND dur < 0
      )
    ORDER BY eventTs ASC, id ASC
  `);
  const events: BtsVmLifecycleEvent[] = [];
  for (
    const it = result.iter({
      id: NUM,
      eventTs: LONG,
      name: STR,
      ptr: STR_NULL,
      groupId: STR_NULL,
      instanceId: NUM_NULL,
      slot: NUM_NULL,
      desc: STR_NULL,
      url: STR_NULL,
    });
    it.valid();
    it.next()
  ) {
    const eventName =
      it.name === PAGE_USES_BTS_VM
        ? PAGE_USES_BTS_VM
        : it.name === BTS_RUNTIME_DESTROY
          ? BTS_RUNTIME_DESTROY
          : it.name === VM_GC
            ? VM_GC
            : DESTROY_VM_INSTANCE;
    events.push({
      sliceId: it.id,
      ts: it.eventTs,
      eventName,
      ptr: it.ptr ?? undefined,
      groupId: it.groupId ?? undefined,
      instanceId: it.instanceId ?? undefined,
      slot: it.slot ?? undefined,
      desc: it.desc ?? undefined,
      url: it.url ?? undefined,
    });
  }
  return buildBtsVmInstances(events);
}
