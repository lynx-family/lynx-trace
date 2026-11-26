// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0.

import m from 'mithril';
import {BtsVmInstance} from '../../lynx_perf/common_components/memory/bts_vm_generations';
import {
  isVmMemorySnapshot,
  memorySnapshotTrackName,
  parseMemorySnapshotId,
} from '../../lynx_perf/common_components/memory/memory_snapshots';
import {isExternalSnapshot, SnapshotProfile} from './snapshot_profile';
import {SnapshotViewerPanel} from './snapshot_viewer';
import type {SnapshotSourceLocation} from './snapshot_graph';
import {
  SnapshotViewerState,
  SnapshotSelection,
  SnapshotVmAssignment,
} from './snapshot_viewer_state';

// Serialized by trace-query's MemoryReportSnapshotData. Content stays out of
// analysis.json; only report.html carries the original snapshot strings.
interface ReportSnapshot {
  sourceLocations?: {nodes: Record<string, SnapshotSourceLocation>};
  sliceId: number;
  vmId: string;
  snapshotId: string;
  captureTsMs: number;
  assignedVmId?: string;
  slotId?: number;
  retainedBytes?: number;
  triggerRetainedBytes?: number;
  postExitPageCount?: number;
  memory: {accumulateBytes: number; rssBytes: number};
  content?: string;
  contentError?: string;
}
interface ReportData {
  snapshots: ReportSnapshot[];
  vms: Array<{
    id: string;
    kind: string;
    name: string;
    generation: number;
    shared: boolean;
    ptr?: string;
    type: string;
    instanceIds: number[];
    createTsMs: number;
    destroyTsMs?: number;
    gcEvents: Array<{tsMs: number}>;
  }>;
}
interface ReportRequest {
  selection?: SnapshotSelection;
  language: string;
  data?: ReportData;
}
declare global {
  interface Window {
    memoryReportRuntime: {snapshot: string};
  }
}

function worker(): Worker {
  const url = URL.createObjectURL(
    new Blob([window.memoryReportRuntime.snapshot], {type: 'text/javascript'}),
  );
  const result = new Worker(url);
  URL.revokeObjectURL(url);
  return result;
}

function createState(data: ReportData): SnapshotViewerState {
  const ns = (ms: number) => BigInt(Math.round(ms * 1e6));
  const vmsById = new Map<string, BtsVmInstance>();
  for (const vm of data.vms) {
    if (vm.kind !== 'bts') continue;
    vmsById.set(vm.id, {
      name: vm.name,
      generation: vm.generation,
      shared: vm.shared,
      ptrs: vm.ptr ? [vm.ptr] : [],
      desc: vm.type,
      createTs: ns(vm.createTsMs),
      destroyTs: vm.destroyTsMs === undefined ? undefined : ns(vm.destroyTsMs),
      uses: vm.instanceIds.map((instanceId) => ({
        instanceId,
        ts: ns(vm.createTsMs),
        desc: '',
      })),
      gcTimestamps: vm.gcEvents.map(({tsMs}) => ns(tsMs)),
    });
  }
  const profiles: SnapshotProfile[] = [];
  const vmAssignments: SnapshotVmAssignment[] = [];
  const snapshots = new Map<number, ReportSnapshot>();
  for (const snapshot of data.snapshots) {
    const identity = parseMemorySnapshotId(snapshot.vmId);
    if (!identity) continue;
    const profile = {
      ...identity,
      ...snapshot.memory,
      sliceId: snapshot.sliceId,
      ts: ns(snapshot.captureTsMs),
      id: snapshot.vmId,
      snapshotId: snapshot.snapshotId,
      captureSlot: snapshot.slotId,
      retainedBytes: snapshot.retainedBytes,
      triggerRetainedBytes: snapshot.triggerRetainedBytes,
      postExitPageCount: snapshot.postExitPageCount,
    };
    profiles.push(profile);
    snapshots.set(snapshot.sliceId, snapshot);
    const vm = vmsById.get(snapshot.assignedVmId ?? '');
    if (vm && isVmMemorySnapshot(profile)) {
      vmAssignments.push({
        vm,
        track: {name: memorySnapshotTrackName(profile)},
        snapshotSliceId: snapshot.sliceId,
      });
    }
  }
  return new SnapshotViewerState({
    sourceLocations: (profile) =>
      snapshots.get(profile.sliceId)?.sourceLocations?.nodes,
    loadProfiles: async () => ({
      profiles,
      vms: [...vmsById.values()],
      vmAssignments,
    }),
    loadContent: async (profile) => {
      if (isExternalSnapshot(profile)) return profile.file.text();
      const snapshot = snapshots.get(profile.sliceId);
      if (snapshot?.content === undefined) {
        throw new Error(
          snapshot?.contentError ??
            'No snapshot content was captured in this trace.',
        );
      }
      return snapshot.content;
    },
    redraw: render,
    createWorker: worker,
  });
}

let request: ReportRequest;
let state: SnapshotViewerState | undefined;
let opened = false;
let error = '';

function copy(zh: string, en: string) {
  return request?.language === 'en' ? en : zh;
}
function close() {
  opened = false;
  state?.close();
  parent.postMessage({type: 'memory-snapshot-closed'}, '*');
  m.redraw();
}
function render() {
  if (state && !state.open && opened) close();
  if (state) {
    state.width = Math.min(state.width ?? innerWidth * 0.76, innerWidth - 48);
  }
  m.redraw();
}

m.mount(document.body, {
  view: () =>
    !opened
      ? null
      : [
          m('.pf-memory-report-backdrop', {
            'onclick': close,
            'aria-label': copy('收起快照详情', 'Close snapshot details'),
          }),
          state
            ? m(SnapshotViewerPanel, {state})
            : m('aside.pf-memory-report-loader', [
                m(
                  'button.pf-memory-report-close',
                  {onclick: close},
                  copy('关闭 ×', 'Close ×'),
                ),
                m('h2', copy('快照详情', 'Snapshot details')),
                m('p', error),
              ]),
        ],
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') close();
});
window.addEventListener('message', ({source, data}) => {
  if (source !== parent || data?.type !== 'memory-snapshot-open') return;
  request = data.request;
  opened = true;
  try {
    if (!state) {
      if (!request.data) throw new Error('Embedded snapshot data is missing.');
      state = createState(request.data);
      // The host owns the content now; later messages contain only a selection.
      request.data = undefined;
    }
    state.show(request.selection);
  } catch (reason) {
    error = String(reason instanceof Error ? reason.message : reason);
  }
  m.redraw();
});
window.addEventListener('pagehide', () => state?.dispose());
parent.postMessage({type: 'memory-snapshot-ready'}, '*');
