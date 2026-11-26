// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import {assetSrc} from '../../base/assets';
import {DisposableStack} from '../../base/disposable_stack';
import {Trace} from '../../public/trace';
import {
  isVmMemorySnapshot,
  loadMemorySnapshots,
  memorySnapshotKindLabel,
  memorySnapshotTrackName,
} from '../../lynx_perf/common_components/memory/memory_snapshots';
import {
  BtsVmInstance,
  findBtsVmForPage,
  loadBtsVmInstances,
} from '../../lynx_perf/common_components/memory/bts_vm_generations';
import {
  assignBtsVmMemoryTracksForDisplay,
  loadBtsVmMemoryTracks,
} from '../../lynx_perf/common_components/memory/bts_vm_memory_tracks';
import {loadSnapshotProfileContent} from './snapshot_content';
import {SnapshotProfile, isExternalSnapshot} from './snapshot_profile';
import {
  SnapshotObjectLocation,
  SnapshotObjectPage,
  SnapshotReferencePage,
  SnapshotSummary,
  SnapshotSourceLocation,
} from './snapshot_graph';
import {
  SnapshotGraphRequest,
  SnapshotWorkerRequest,
} from './snapshot_worker_protocol';
import {
  SnapshotComparisonFilter,
  SnapshotComparisonSummary,
  SnapshotObjectChangePage,
  SnapshotObjectSource,
} from './snapshot_comparison';
import {SnapshotTreeDownloader} from './snapshot_download';
import {SnapshotJsonPage, SnapshotJsonPath} from './snapshot_raw';

export const VIEW_SNAPSHOTS_COMMAND = 'lynx.memory.viewSnapshots';
const WIDTH_KEY = 'lynx.memory.snapshotViewerWidth';
const GROUP_KEY = 'lynx.memory.snapshotViewerGrouping';

export interface SnapshotTreeNode {
  key: string;
  name: string;
  children?: SnapshotTreeNode[];
  snapshot?: SnapshotProfile;
  sequence?: {ordinal: number; count: number};
}

export interface SnapshotSelection {
  id: string;
  snapshotId: string;
  node?: {index: number; id: number};
}

export interface SnapshotVmAssignment {
  vm: BtsVmInstance;
  track: {name: string};
  /** A report can bind a capture to its already resolved VM generation. */
  snapshotSliceId?: number;
}

export function sortedSnapshotProfiles(
  snapshots: ReadonlyArray<SnapshotProfile>,
): SnapshotProfile[] {
  return [...snapshots].sort((a, b) =>
    a.ts === b.ts ? a.sliceId - b.sliceId : a.ts < b.ts ? -1 : 1,
  );
}

export function defaultComparisonBaseline(
  snapshots: ReadonlyArray<SnapshotProfile>,
  selected: SnapshotProfile,
): SnapshotProfile {
  let previous = selected;
  for (const snapshot of sortedSnapshotProfiles(snapshots)) {
    if (snapshot.sliceId === selected.sliceId) break;
    if (snapshot.id === selected.id) previous = snapshot;
  }
  return previous;
}

export function buildSnapshotTree(
  snapshots: ReadonlyArray<SnapshotProfile>,
  vms: BtsVmInstance[],
  grouping: 'instance' | 'vm',
  vmAssignments: ReadonlyArray<SnapshotVmAssignment> = [],
): SnapshotTreeNode[] {
  const roots = new Map<string, SnapshotTreeNode>();
  const sorted = sortedSnapshotProfiles(snapshots);
  const counts = new Map<string, number>();
  const ordinals = new Map<string, number>();
  for (const snapshot of sorted) {
    counts.set(snapshot.id, (counts.get(snapshot.id) ?? 0) + 1);
  }
  for (const snapshot of sorted) {
    const ordinal = (ordinals.get(snapshot.id) ?? 0) + 1;
    ordinals.set(snapshot.id, ordinal);
    const leaf: SnapshotTreeNode = {
      key: `snapshot:${snapshot.sliceId}`,
      name: snapshot.id,
      snapshot,
      sequence: {ordinal, count: counts.get(snapshot.id)!},
    };
    if (isExternalSnapshot(snapshot)) {
      let unknown = roots.get('unknown');
      if (!unknown) {
        unknown = {key: 'unknown', name: 'Unknown', children: []};
        roots.set('unknown', unknown);
      }
      unknown.children!.push(leaf);
      continue;
    }
    const vmSnapshot = isVmMemorySnapshot(snapshot);
    const vm = vmSnapshot
      ? vmAssignments.find(
          ({track, snapshotSliceId}) =>
            track.name === memorySnapshotTrackName(snapshot) &&
            (snapshotSliceId === undefined ||
              snapshotSliceId === snapshot.sliceId),
        )?.vm
      : snapshot.kind === 'mts_instance'
        ? undefined
        : findBtsVmForPage(vms, snapshot.instanceId);
    const rootKey =
      grouping === 'instance' && !vmSnapshot
        ? `instance:${snapshot.instanceId}`
        : snapshot.kind === 'mts_instance'
          ? `mts:${snapshot.instanceId}`
          : vm
            ? `bts:${vm.name}:${vm.generation}`
            : vmSnapshot
              ? `unknown-vm:${snapshot.vmUniqueId}`
              : `unknown-bts:${snapshot.instanceId}`;
    const rootName =
      grouping === 'instance' && !vmSnapshot
        ? `Instance ${snapshot.instanceId}`
        : snapshot.kind === 'mts_instance'
          ? `MTS of Instance ${snapshot.instanceId}`
          : vm
            ? `${grouping === 'instance' ? 'VM: ' : ''}${vm.name}(${vm.generation})`
            : vmSnapshot
              ? `BTS VM ${snapshot.vmUniqueId} (unidentified)`
              : `BTS of Instance ${snapshot.instanceId} (unidentified)`;
    let root = roots.get(rootKey);
    if (!root) {
      root = {key: rootKey, name: rootName, children: []};
      roots.set(rootKey, root);
    }
    let parent = root;
    if (grouping === 'instance' && !vmSnapshot) {
      const key = `${rootKey}:${snapshot.kind}`;
      let child = root.children!.find((item) => item.key === key);
      if (!child) {
        child = {
          key,
          name: memorySnapshotKindLabel(snapshot.kind),
          children: [],
        };
        root.children!.push(child);
      }
      parent = child;
    }
    parent.children!.push(leaf);
  }
  const unknown = roots.get('unknown');
  roots.delete('unknown');
  const result = [...roots.values()];
  if (grouping === 'instance') {
    result.sort((a, b) => {
      const aInstance = a.key.startsWith('instance:');
      const bInstance = b.key.startsWith('instance:');
      if (aInstance && bInstance) {
        return Number(a.key.slice(9)) - Number(b.key.slice(9));
      }
      if (aInstance !== bInstance) return aInstance ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }
  if (unknown) result.push(unknown);
  return result;
}

function preference(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function savePreference(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Storage can be disabled. */
  }
}

type PendingSnapshotRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export interface SnapshotViewerHost {
  loadProfiles(): Promise<{
    profiles: SnapshotProfile[];
    vms: BtsVmInstance[];
    vmAssignments: SnapshotVmAssignment[];
  }>;
  loadContent(profile: SnapshotProfile): Promise<string>;
  sourceLocations?(
    profile: SnapshotProfile,
  ): Record<string, SnapshotSourceLocation> | undefined;
  redraw(): void;
  createWorker(): Worker;
}

export class SnapshotViewerState {
  open = false;
  selected?: SnapshotProfile;
  profiles: SnapshotProfile[] = [];
  vms: BtsVmInstance[] = [];
  vmAssignments: SnapshotVmAssignment[] = [];
  readonly profileSizes = new Map<number, number>();
  readonly profileSizeErrors = new Map<number, string>();
  readonly downloader: SnapshotTreeDownloader;
  summary?: SnapshotSummary;
  focusedObject?: SnapshotObjectLocation;
  mode: 'summary' | 'comparison' | 'scripts' | 'raw' = 'summary';
  classFilter = '';
  scriptFilter = '';
  baseline?: SnapshotProfile;
  comparison?: SnapshotComparisonSummary;
  comparisonFilter: SnapshotComparisonFilter = 'all';
  comparisonLoading = false;
  comparisonError?: string;
  comparisonVersion = 0;
  loading = false;
  error?: string;
  listLoading = false;
  listError?: string;
  grouping: 'instance' | 'vm' =
    preference(GROUP_KEY) === 'vm' ? 'vm' : 'instance';
  width?: number;
  readonly columnWidths = new Map<string, number>();
  private worker?: Worker;
  private requestId = 0;
  private nextExternalSliceId = -1;
  private version = 0;
  private listPromise?: Promise<void>;
  private destroyed = false;
  private sizeVersion = 0;
  private sizeWorker?: Worker;
  private sizePromise?: Promise<void>;
  private cancelSize?: () => void;
  private readonly pending = new Map<number, PendingSnapshotRequest>();

  constructor(private readonly host: SnapshotViewerHost) {
    this.downloader = new SnapshotTreeDownloader(
      (profile) => host.loadContent(profile),
      () => this.redraw(),
    );
    const saved = Number(preference(WIDTH_KEY));
    if (Number.isFinite(saved) && saved > 0) this.width = saved;
  }

  redraw() {
    if (!this.destroyed) this.host.redraw();
  }

  show(selector?: number | SnapshotSelection) {
    this.open = true;
    const ticket = ++this.version;
    this.redraw();
    void this.loadProfiles().then(() => {
      if (ticket !== this.version || this.destroyed) return;
      const snapshot =
        selector === undefined
          ? this.selected ?? this.profiles[0]
          : this.profiles.find((item) =>
              typeof selector === 'number'
                ? item.sliceId === selector
                : item.id === selector.id &&
                  item.snapshotId === selector.snapshotId,
            );
      if (snapshot) {
        void this.select(
          snapshot,
          typeof selector === 'object' ? selector.node : undefined,
        );
      } else if (selector !== undefined) {
        this.selected = undefined;
        this.summary = undefined;
        this.focusedObject = undefined;
        this.loading = false;
        this.resetComparison();
        this.stopWorker();
        this.stopProfileSizes();
        this.error = 'This snapshot is not available in the trace.';
        this.redraw();
      }
    });
  }

  close() {
    this.open = false;
    this.version++;
    this.loading = false;
    this.summary = undefined;
    this.focusedObject = undefined;
    this.resetComparison();
    this.stopWorker();
    this.stopProfileSizes();
    this.redraw();
  }

  setGrouping(value: 'instance' | 'vm') {
    this.grouping = value;
    savePreference(GROUP_KEY, value);
    this.redraw();
  }
  setWidth(width: number) {
    this.width = width;
    this.redraw();
  }
  saveWidth() {
    if (this.width !== undefined) savePreference(WIDTH_KEY, String(this.width));
  }

  async openFiles(files: ReadonlyArray<File>): Promise<void> {
    if (files.length === 0 || this.destroyed) return;
    await this.loadProfiles();
    if (this.destroyed) return;
    let ts = this.profiles.reduce(
      (latest, profile) => (profile.ts > latest ? profile.ts : latest),
      0n,
    );
    for (const file of files) {
      this.profiles.push({
        sliceId: this.nextExternalSliceId--,
        ts: ++ts,
        id: file.name.replace(/\.(heapsnapshot|json)$/i, '') || file.name,
        snapshotId: file.name,
        file,
      });
    }
    this.redraw();
    if (this.open) await this.select(this.profiles[this.profiles.length - 1]);
  }

  private async loadProfiles(): Promise<void> {
    if (this.listPromise) return this.listPromise;
    this.listLoading = true;
    this.listPromise = this.host
      .loadProfiles()
      .then(({profiles, vms, vmAssignments}) => {
        this.profiles = [...profiles];
        this.vms = vms;
        this.vmAssignments = vmAssignments;
      })
      .catch((error: unknown) => {
        this.listError = String(error);
      })
      .finally(() => {
        this.listLoading = false;
        this.redraw();
      });
    return this.listPromise;
  }

  async select(snapshot: SnapshotProfile, node?: SnapshotSelection['node']) {
    const ticket = ++this.version;
    this.selected = snapshot;
    this.summary = undefined;
    this.focusedObject = undefined;
    if (node) {
      this.mode = 'summary';
      this.classFilter = '';
    }
    this.resetComparison();
    this.baseline = defaultComparisonBaseline(this.profiles, snapshot);
    this.error = undefined;
    this.loading = true;
    this.stopWorker();
    this.stopProfileSizes();
    this.redraw();
    try {
      const content = await this.host.loadContent(snapshot);
      if (ticket !== this.version || !this.open || this.destroyed) return;
      this.worker = this.host.createWorker();
      this.worker.onmessage = ({
        data,
      }: MessageEvent<{
        requestId: number;
        result?: unknown;
        error?: string;
      }>) => {
        const pending = this.pending.get(data.requestId);
        if (!pending) return;
        this.pending.delete(data.requestId);
        if (data.error !== undefined) pending.reject(new Error(data.error));
        else pending.resolve(data.result);
      };
      this.worker.onerror = (event) => {
        const error = new Error(event.message || 'Snapshot worker failed.');
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
      };
      const summary = await this.request<SnapshotSummary>({
        action: 'load',
        content,
        sourceLocations: this.host.sourceLocations?.(snapshot),
      });
      if (ticket !== this.version || this.destroyed) return;
      const focusedObject = node
        ? await this.request<SnapshotObjectLocation>({
            action: 'object',
            index: node.index,
            expectedId: node.id,
          })
        : undefined;
      if (ticket === this.version && !this.destroyed) {
        this.focusedObject = focusedObject;
        this.summary = summary;
        this.profileSizes.set(snapshot.sliceId, summary.totalSize);
        this.profileSizeErrors.delete(snapshot.sliceId);
        if (this.mode === 'comparison') void this.loadComparison();
      }
    } catch (error) {
      if (ticket === this.version && !this.destroyed) {
        this.error = String(error instanceof Error ? error.message : error);
      }
    } finally {
      if (ticket === this.version) {
        this.loading = false;
        this.redraw();
        this.startProfileSizes();
      }
    }
  }

  setMode(mode: SnapshotViewerState['mode']) {
    if (this.mode === mode) return;
    if (this.mode === 'raw' && this.worker) {
      void this.request({action: 'clearRaw'}).catch(() => {});
    }
    this.mode = mode;
    this.resetComparison();
    if (mode === 'comparison') {
      if (this.selected) {
        this.baseline = defaultComparisonBaseline(this.profiles, this.selected);
      }
      void this.loadComparison();
    } else if (this.worker && this.summary) {
      void this.request({action: 'clearComparison'}).catch(() => {});
    }
    this.startProfileSizes();
    this.redraw();
  }

  setBaseline(sliceId: number) {
    const baseline = this.profiles.find(
      (profile) => profile.sliceId === sliceId,
    );
    if (!baseline || baseline.sliceId === this.baseline?.sliceId) return;
    this.baseline = baseline;
    this.resetComparison();
    void this.loadComparison();
    this.redraw();
  }

  setComparisonFilter(filter: SnapshotComparisonFilter) {
    this.comparisonFilter = filter;
    this.redraw();
  }

  private resetComparison() {
    this.comparisonVersion++;
    this.comparison = undefined;
    this.comparisonError = undefined;
    this.comparisonLoading = false;
  }

  private async loadComparison() {
    const baseline = this.baseline;
    const selected = this.selected;
    if (
      !baseline ||
      !selected ||
      !this.summary ||
      !this.open ||
      this.destroyed ||
      this.mode !== 'comparison'
    ) {
      return;
    }
    const ticket = ++this.comparisonVersion;
    this.comparisonLoading = true;
    this.comparison = undefined;
    this.comparisonError = undefined;
    this.stopProfileSizes();
    this.redraw();
    try {
      const content =
        baseline.sliceId === selected.sliceId
          ? undefined
          : await this.host.loadContent(baseline);
      if (ticket !== this.comparisonVersion || this.destroyed) return;
      const comparison = await this.request<SnapshotComparisonSummary>({
        action: 'compare',
        content,
        sourceLocations: this.host.sourceLocations?.(baseline),
      });
      if (ticket !== this.comparisonVersion || this.destroyed) return;
      this.comparison = comparison;
      this.profileSizes.set(baseline.sliceId, comparison.baselineTotalSize);
      this.profileSizeErrors.delete(baseline.sliceId);
    } catch (error) {
      if (ticket === this.comparisonVersion && !this.destroyed) {
        this.comparisonError = String(
          error instanceof Error ? error.message : error,
        );
      }
    } finally {
      if (ticket === this.comparisonVersion) {
        this.comparisonLoading = false;
        this.redraw();
        this.startProfileSizes();
      }
    }
  }

  private startProfileSizes() {
    if (
      !this.open ||
      this.destroyed ||
      this.loading ||
      this.comparisonLoading ||
      this.sizePromise ||
      !this.profiles.some(
        (profile) =>
          !this.profileSizes.has(profile.sliceId) &&
          !this.profileSizeErrors.has(profile.sliceId),
      )
    ) {
      return;
    }
    const ticket = this.sizeVersion;
    this.sizePromise = this.loadProfileSizes(ticket).finally(() => {
      this.sizePromise = undefined;
      this.startProfileSizes();
    });
  }

  private async loadProfileSizes(ticket: number) {
    for (const profile of this.profiles) {
      if (ticket !== this.sizeVersion || !this.open || this.destroyed) return;
      if (
        this.profileSizes.has(profile.sliceId) ||
        this.profileSizeErrors.has(profile.sliceId)
      ) {
        continue;
      }
      try {
        const content = await this.host.loadContent(profile);
        if (ticket !== this.sizeVersion || !this.open || this.destroyed) return;
        const size = await new Promise<number>((resolve, reject) => {
          const worker = this.host.createWorker();
          this.sizeWorker = worker;
          this.cancelSize = () =>
            reject(new Error('Snapshot viewer closed or selection changed.'));
          worker.onmessage = ({
            data,
          }: MessageEvent<{result: number; error?: string}>) => {
            if (data.error !== undefined) reject(new Error(data.error));
            else resolve(data.result);
          };
          worker.onerror = (event) =>
            reject(new Error(event.message || 'Snapshot worker failed.'));
          worker.postMessage({
            requestId: 0,
            action: 'size',
            content,
          } satisfies SnapshotWorkerRequest);
        });
        if (ticket === this.sizeVersion && !this.destroyed) {
          this.profileSizes.set(profile.sliceId, size);
          this.redraw();
        }
      } catch (error) {
        if (ticket === this.sizeVersion && !this.destroyed) {
          this.profileSizeErrors.set(profile.sliceId, String(error));
          this.redraw();
        }
      } finally {
        this.sizeWorker?.terminate();
        this.sizeWorker = undefined;
        this.cancelSize = undefined;
      }
    }
  }

  private stopProfileSizes() {
    this.sizeVersion++;
    this.sizeWorker?.terminate();
    this.sizeWorker = undefined;
    this.cancelSize?.();
    this.cancelSize = undefined;
  }

  objects(key: string, offset = 0, limit = 100) {
    return this.request<SnapshotObjectPage>({
      action: 'objects',
      key,
      offset,
      limit,
    });
  }
  async raw(path?: SnapshotJsonPath, offset = 0): Promise<SnapshotJsonPage> {
    const ticket = this.version;
    const selected = this.selected;
    if (!selected || this.mode !== 'raw') {
      throw new Error('No raw snapshot is selected.');
    }
    const content =
      path === undefined ? await this.host.loadContent(selected) : undefined;
    if (ticket !== this.version || this.mode !== 'raw' || this.destroyed) {
      throw new Error('Snapshot selection changed.');
    }
    return this.request<SnapshotJsonPage>({
      action: 'raw',
      content,
      path: path ?? [],
      offset,
    });
  }
  changes(
    key: string,
    filter: SnapshotComparisonFilter,
    offset = 0,
    limit = 100,
  ) {
    return this.request<SnapshotObjectChangePage>({
      action: 'changes',
      key,
      filter,
      offset,
      limit,
    });
  }
  retainers(
    index: number,
    offset = 0,
    limit = 100,
    source: SnapshotObjectSource = 'current',
  ) {
    return this.request<SnapshotReferencePage>({
      action: 'retainers',
      source,
      index,
      offset,
      limit,
    });
  }
  references(
    index: number,
    offset = 0,
    limit = 100,
    source: SnapshotObjectSource = 'current',
  ) {
    return this.request<SnapshotReferencePage>({
      action: 'references',
      source,
      index,
      offset,
      limit,
    });
  }

  private request<T>(request: SnapshotGraphRequest): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.worker) {
        reject(new Error('No snapshot is loaded.'));
        return;
      }
      const requestId = ++this.requestId;
      this.pending.set(requestId, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.worker.postMessage({...request, requestId});
    });
  }

  private stopWorker() {
    this.worker?.terminate();
    this.worker = undefined;
    for (const pending of this.pending.values()) {
      pending.reject(new Error('Snapshot selection changed.'));
    }
    this.pending.clear();
  }
  dispose() {
    this.destroyed = true;
    this.version++;
    this.resetComparison();
    this.stopWorker();
    this.stopProfileSizes();
    this.downloader.dispose();
  }
}

// Plugin trace proxies create distinct EngineProxy objects. The disposal scope
// is shared by every proxy of the same trace.
const viewers = new WeakMap<DisposableStack, SnapshotViewerState>();
export function snapshotViewerState(trace: Trace): SnapshotViewerState {
  let state = viewers.get(trace.trash);
  if (!state) {
    state = new SnapshotViewerState({
      loadProfiles: async () => {
        const [profiles, vms, tracks] = await Promise.all([
          loadMemorySnapshots(trace.engine),
          loadBtsVmInstances(trace.engine),
          loadBtsVmMemoryTracks(trace.engine),
        ]);
        return {
          profiles,
          vms,
          vmAssignments: assignBtsVmMemoryTracksForDisplay(vms, tracks),
        };
      },
      loadContent: (profile) =>
        loadSnapshotProfileContent(trace.engine, profile),
      redraw: () => trace.raf.scheduleFullRedraw(),
      createWorker: () => new Worker(assetSrc('snapshot_worker_bundle.js')),
    });
    const ownedState = state;
    trace.trash.defer(() => ownedState.dispose());
    viewers.set(trace.trash, state);
  }
  return state;
}
export function openSnapshotViewer(trace: Trace, sliceId?: number) {
  snapshotViewerState(trace).show(sliceId);
}
