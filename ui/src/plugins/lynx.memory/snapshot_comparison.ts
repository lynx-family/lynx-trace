// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import {SnapshotGraph, SnapshotObject} from './snapshot_graph';

export type SnapshotComparisonFilter = 'all' | 'new' | 'deleted';
export type SnapshotObjectSource = 'current' | 'baseline';

export interface SnapshotClassDelta {
  key: string;
  name: string;
  type: string;
  newCount: number;
  deletedCount: number;
  delta: number;
  allocatedSize: number;
  freedSize: number;
  sizeDelta: number;
}

export interface SnapshotClassChange {
  summary: SnapshotClassDelta;
  added: number[];
  deleted: number[];
}

export interface SnapshotComparisonSummary {
  classes: SnapshotClassDelta[];
  baselineTotalSize: number;
}

export interface SnapshotObjectChange {
  object: SnapshotObject;
  source: SnapshotObjectSource;
}

export interface SnapshotObjectChangePage {
  items: SnapshotObjectChange[];
  total: number;
}

/** Keeps object indexes in their source graph; only requested pages cross RPC. */
export class SnapshotComparison {
  readonly summary: SnapshotComparisonSummary;
  private readonly groups = new Map<string, SnapshotClassChange>();

  constructor(
    private readonly current: SnapshotGraph,
    private readonly baseline: SnapshotGraph,
  ) {
    const changes = current.changesFrom(baseline);
    for (const change of changes) this.groups.set(change.summary.key, change);
    this.summary = {
      classes: changes.map((change) => change.summary),
      baselineTotalSize: baseline.summary.totalSize,
    };
  }

  objects(
    key: string,
    filter: SnapshotComparisonFilter,
    offset: number,
    limit = 100,
  ): SnapshotObjectChangePage {
    const group = this.groups.get(key);
    const added = filter === 'deleted' ? [] : group?.added ?? [];
    const deleted = filter === 'new' ? [] : group?.deleted ?? [];
    const total = added.length + deleted.length;
    const items: SnapshotObjectChange[] = [];
    for (let i = offset; i < Math.min(total, offset + limit); i++) {
      const source = i < added.length ? 'current' : 'baseline';
      const index = source === 'current' ? added[i] : deleted[i - added.length];
      items.push({
        source,
        object: (source === 'current' ? this.current : this.baseline).object(
          index,
        ),
      });
    }
    return {items, total};
  }
}
