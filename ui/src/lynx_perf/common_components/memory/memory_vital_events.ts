// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import {Engine} from '../../../trace_processor/engine';
import {
  LONG,
  NUM,
  NUM_NULL,
  STR,
  STR_NULL,
} from '../../../trace_processor/query_result';
import {
  BTS_RUNTIME_DESTROY,
  DESTROY_VM_INSTANCE,
  PAGE_USES_BTS_VM,
  findDestroyedBtsVm,
  loadBtsVmInstances,
} from './bts_vm_generations';

export const MEMORY_VITAL_EVENT_NAMES = [
  'LynxShell::Create',
  'LynxShell::~LynxShell',
  PAGE_USES_BTS_VM,
  BTS_RUNTIME_DESTROY,
  'LynxEnv.trimMemory',
  DESTROY_VM_INSTANCE,
  'TRACE_END',
];

export interface MemoryVitalEventData {
  sliceId: number;
  ts: bigint;
  name: string;
  trackId: number;
  instanceId?: number;
  btsVmName?: string;
}

export function isPageLifetimeEvent(name: string): boolean {
  return (
    name === 'LynxShell::Create' ||
    name === 'LynxShell::~LynxShell' ||
    name === PAGE_USES_BTS_VM ||
    name === BTS_RUNTIME_DESTROY
  );
}

export function formatMemoryVitalEventName(
  event: Pick<MemoryVitalEventData, 'name' | 'instanceId' | 'btsVmName'>,
): string {
  const instanceId = event.instanceId ?? 'unknown';
  switch (event.name) {
    case PAGE_USES_BTS_VM:
      return `CreatePageBts(${instanceId})`;
    case 'LynxShell::Create':
      return `CreatePage(${instanceId})`;
    case 'LynxShell::~LynxShell':
      return `DestroyPage(${instanceId})`;
    case BTS_RUNTIME_DESTROY:
      return `DestroyPageBts(${instanceId})`;
    case 'LynxEnv.trimMemory':
      return 'TrimMemory';
    case DESTROY_VM_INSTANCE:
      return `DestroyBtsVM("${event.btsVmName ?? 'unknown'}")`;
    default:
      return event.name;
  }
}

const eventsByEngine = new WeakMap<Engine, Promise<MemoryVitalEventData[]>>();

export function loadMemoryVitalEvents(
  engine: Engine,
): Promise<MemoryVitalEventData[]> {
  let events = eventsByEngine.get(engine);
  if (events === undefined) {
    events = queryMemoryVitalEvents(engine);
    eventsByEngine.set(engine, events);
  }
  return events;
}

async function queryMemoryVitalEvents(
  engine: Engine,
): Promise<MemoryVitalEventData[]> {
  const names = MEMORY_VITAL_EVENT_NAMES.map((name) => `'${name}'`).join(',');
  const result = await engine.query(`
    SELECT
      s.id AS sliceId,
      s.ts,
      s.name,
      s.track_id AS trackId,
      CAST((
        SELECT display_value FROM args
        WHERE arg_set_id = s.arg_set_id
          AND flat_key IN ('instance_id', 'debug.instance_id', 'args.instance_id')
        LIMIT 1
      ) AS INT) AS instanceId,
      (
        SELECT display_value FROM args
        WHERE arg_set_id = s.arg_set_id
          AND flat_key IN ('ptr', 'debug.ptr', 'args.ptr')
        LIMIT 1
      ) AS ptr
    FROM slice s
    WHERE s.name IN (${names})
    ORDER BY s.ts, s.id
  `);
  const events: MemoryVitalEventData[] = [];
  const destroyedVms: Array<{event: MemoryVitalEventData; ptr: string}> = [];
  for (
    const row = result.iter({
      sliceId: NUM,
      ts: LONG,
      name: STR,
      trackId: NUM,
      instanceId: NUM_NULL,
      ptr: STR_NULL,
    });
    row.valid();
    row.next()
  ) {
    const event = {
      sliceId: row.sliceId,
      ts: row.ts,
      name: row.name,
      trackId: row.trackId,
      instanceId: row.instanceId ?? undefined,
    };
    events.push(event);
    if (row.name === DESTROY_VM_INSTANCE && row.ptr !== null) {
      destroyedVms.push({event, ptr: row.ptr});
    }
  }
  if (destroyedVms.length > 0) {
    const vms = await loadBtsVmInstances(engine);
    for (const {event, ptr} of destroyedVms) {
      const vm = findDestroyedBtsVm(vms, ptr, event.ts);
      if (vm !== undefined) {
        event.btsVmName = `${vm.name}#${vm.generation}`;
      }
    }
  }
  return events;
}
