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

import {Args, ArgsDict, getArgs} from '../../../components/sql_utils/args';
import {asArgSetId} from '../../../components/sql_utils/core_types';
import {Engine} from '../../../trace_processor/engine';
import {LONG, NUM, STR} from '../../../trace_processor/query_result';

export const PAGE_USES_BTS_VM = 'page_uses_bts_vm';
export const BTS_RUNTIME_DESTROY = 'BTSRuntime::Destroy';
export const DESTROY_VM_INSTANCE = 'destroy_vm_instance';

export interface BtsVmLifecycleEvent {
  sliceId: number;
  ts: bigint;
  eventName: typeof PAGE_USES_BTS_VM | typeof DESTROY_VM_INSTANCE;
  ptr: string;
  groupId?: string;
  instanceId?: number;
  desc?: string;
  url?: string;
}

export interface BtsVmUse {
  instanceId: number;
  ts: bigint;
  desc: string;
  url?: string;
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
  const nextGeneration = new Map<string, number>();
  const events = [...lifecycleEvents].sort((a, b) => {
    if (a.ts === b.ts) {
      return a.sliceId - b.sliceId;
    }
    return a.ts < b.ts ? -1 : 1;
  });

  for (const event of events) {
    if (event.eventName === DESTROY_VM_INSTANCE) {
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
      continue;
    }

    if (event.instanceId === undefined || event.groupId === undefined) {
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
      instance.uses.push({
        instanceId: event.instanceId,
        ts: event.ts,
        desc: event.desc ?? '',
        url: event.url,
      });
    } else {
      currentUse.desc = currentUse.desc || event.desc || '';
      currentUse.url = currentUse.url || event.url;
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
      id,
      ts,
      name,
      arg_set_id AS argSetId
    FROM slice
    WHERE name IN ('${PAGE_USES_BTS_VM}', '${DESTROY_VM_INSTANCE}')
      AND arg_set_id IS NOT NULL
    ORDER BY ts ASC, id ASC
  `);
  const events: BtsVmLifecycleEvent[] = [];
  for (
    const it = result.iter({
      id: NUM,
      ts: LONG,
      name: STR,
      argSetId: NUM,
    });
    it.valid();
    it.next()
  ) {
    const args = await getArgs(engine, asArgSetId(it.argSetId));
    const ptr = getArgDisplayValue(args, 'ptr');
    if (ptr === undefined) {
      continue;
    }

    const eventName =
      it.name === PAGE_USES_BTS_VM ? PAGE_USES_BTS_VM : DESTROY_VM_INSTANCE;
    events.push({
      sliceId: it.id,
      ts: it.ts,
      eventName,
      ptr,
      groupId: getArgDisplayValue(args, 'group_id'),
      instanceId: getArgNumber(args, 'instance_id'),
      desc: getArgDisplayValue(args, 'desc'),
      url: getArgDisplayValue(args, 'url'),
    });
  }
  return buildBtsVmInstances(events);
}

function getArgNumber(args: ArgsDict, key: string): number | undefined {
  const value = getArgDisplayValue(args, key);
  if (value === undefined) {
    return undefined;
  }
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

function getArgDisplayValue(args: ArgsDict, key: string): string | undefined {
  const value =
    getValueByPath(args, key) ?? getValueByPath(args, `debug.${key}`);
  if (value === undefined) {
    return undefined;
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return String(value);
  }
  return JSON.stringify(value);
}

function getValueByPath(args: ArgsDict, path: string): Args | undefined {
  let value: Args | undefined = args;
  for (const key of path.split('.')) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }
    value = value[key];
  }
  return value;
}
