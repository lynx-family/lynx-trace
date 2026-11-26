// Copyright (C) 2026 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import {
  BTS_RUNTIME_DESTROY,
  BtsVmLifecycleEvent,
  DESTROY_VM_INSTANCE,
  PAGE_USES_BTS_VM,
  VM_GC,
  buildBtsVmInstances,
  findBtsVmByNameAt,
  findBtsVmForPage,
  findDestroyedBtsVm,
  formatBtsVmInstanceName,
  getSharedBtsNameFromSnapshotId,
  getSingleBtsPageIdFromSnapshotId,
} from './bts_vm_generations';

function pageUses(
  sliceId: number,
  ts: bigint,
  instanceId: number,
  groupId: string,
  ptr: string,
  slot?: number,
): BtsVmLifecycleEvent {
  return {
    sliceId,
    ts,
    eventName: PAGE_USES_BTS_VM,
    ptr,
    groupId,
    instanceId,
    slot,
    desc: 'quickjs(gc)',
  };
}

function destroy(
  sliceId: number,
  ts: bigint,
  ptr: string,
): BtsVmLifecycleEvent {
  return {
    sliceId,
    ts,
    eventName: DESTROY_VM_INSTANCE,
    ptr,
  };
}

function destroyPage(
  sliceId: number,
  ts: bigint,
  instanceId: number,
): BtsVmLifecycleEvent {
  return {
    sliceId,
    ts,
    eventName: BTS_RUNTIME_DESTROY,
    instanceId,
  };
}

function vmGc(sliceId: number, ts: bigint, ptr: string): BtsVmLifecycleEvent {
  return {
    sliceId,
    ts,
    eventName: VM_GC,
    ptr,
  };
}

describe('BTS VM generations', () => {
  it('increments generation when a destroyed shared VM name is reused', () => {
    const instances = buildBtsVmInstances([
      pageUses(1, 10n, 100, 'engine0', 'ptr-0', 3),
      pageUses(2, 20n, 101, 'engine0', 'ptr-0', 4),
      destroy(3, 30n, 'ptr-0'),
      pageUses(4, 40n, 200, 'engine0', 'ptr-1'),
    ]);

    expect(instances).toHaveLength(2);
    expect(instances[0]).toMatchObject({
      name: 'engine0',
      generation: 0,
      destroyTs: 30n,
    });
    expect(instances[0].uses.map((use) => use.instanceId)).toEqual([100, 101]);
    expect(instances[0].uses.map((use) => use.slot)).toEqual([3, 4]);
    expect(instances[1]).toMatchObject({
      name: 'engine0',
      generation: 1,
      createTs: 40n,
    });
    expect(findBtsVmForPage(instances, 200)).toBe(instances[1]);
    expect(findBtsVmByNameAt(instances, 'engine0', 29n)).toBe(instances[0]);
    expect(findBtsVmByNameAt(instances, 'engine0', 30n)).toBeUndefined();
    expect(findBtsVmByNameAt(instances, 'engine0', 40n)).toBe(instances[1]);
    expect(findDestroyedBtsVm(instances, 'ptr-0', 30n)).toBe(instances[0]);
  });

  it('treats additional pointers for an active name as the same VM', () => {
    const instances = buildBtsVmInstances([
      pageUses(1, 10n, 100, 'engine0', 'ptr-0'),
      pageUses(2, 20n, 101, 'engine0', 'ptr-alias'),
      destroy(3, 30n, 'ptr-alias'),
    ]);

    expect(instances).toHaveLength(1);
    expect(instances[0].ptrs).toEqual(['ptr-0', 'ptr-alias']);
    expect(instances[0].destroyTs).toBe(30n);
  });

  it('records page destruction and GC on the active VM generation', () => {
    const instances = buildBtsVmInstances([
      pageUses(1, 10n, 100, 'engine0', 'ptr-0', 3),
      destroyPage(2, 20n, 100),
      vmGc(3, 30n, 'ptr-0'),
      destroy(4, 40n, 'ptr-0'),
      vmGc(5, 50n, 'ptr-0'),
      pageUses(6, 60n, 200, 'engine0', 'ptr-1', 4),
      vmGc(7, 70n, 'ptr-1'),
    ]);

    expect(instances).toHaveLength(2);
    expect(instances[0].uses[0].destroyTs).toBe(20n);
    expect(instances[0].gcTimestamps).toEqual([30n]);
    expect(instances[1].uses[0].destroyTs).toBeUndefined();
    expect(instances[1].gcTimestamps).toEqual([70n]);
  });

  it('uses the page id for standalone VM names', () => {
    const [instance] = buildBtsVmInstances([
      pageUses(1, 10n, 7, '-1', 'ptr-0'),
    ]);

    expect(instance.name).toBe('standalone_7');
    expect(instance.shared).toBe(false);
    expect(formatBtsVmInstanceName(instance.name, instance.generation)).toBe(
      'standalone_7(0)',
    );
  });

  it('parses shared and standalone BTS snapshot ids', () => {
    expect(getSharedBtsNameFromSnapshotId('engine0(shared bts)')).toBe(
      'engine0',
    );
    expect(getSingleBtsPageIdFromSnapshotId('instance_7(single bts)')).toBe(7);
    expect(getSharedBtsNameFromSnapshotId('instance_7(mts)')).toBeUndefined();
  });
});
