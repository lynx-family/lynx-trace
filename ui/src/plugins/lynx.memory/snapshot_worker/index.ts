// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import {SnapshotGraph, snapshotTotalSize} from '../snapshot_graph';
import {SnapshotComparison} from '../snapshot_comparison';
import {SnapshotWorkerRequest} from '../snapshot_worker_protocol';
import {SnapshotRawData} from '../snapshot_raw';

let graph: SnapshotGraph | undefined;
let baseline: SnapshotGraph | undefined;
let comparison: SnapshotComparison | undefined;
let raw: SnapshotRawData | undefined;
self.onmessage = ({data}: MessageEvent<SnapshotWorkerRequest>) => {
  try {
    let result;
    switch (data.action) {
      case 'load':
        raw = undefined;
        baseline = undefined;
        comparison = undefined;
        graph = undefined;
        graph = new SnapshotGraph(data.content, data.sourceLocations);
        result = graph.summary;
        break;
      case 'size':
        result = snapshotTotalSize(data.content);
        break;
      case 'raw':
        if (data.content !== undefined) {
          raw = undefined;
          raw = new SnapshotRawData(data.content);
        }
        if (!raw) throw new Error('No raw snapshot is loaded.');
        result = raw.page(data.path, data.offset);
        break;
      case 'clearRaw':
        raw = undefined;
        break;
      case 'compare':
        if (!graph) throw new Error('No snapshot is loaded.');
        comparison = undefined;
        baseline = undefined;
        baseline =
          data.content === undefined
            ? graph
            : new SnapshotGraph(data.content, data.sourceLocations);
        comparison = new SnapshotComparison(graph, baseline);
        result = comparison.summary;
        break;
      case 'clearComparison':
        comparison = undefined;
        baseline = undefined;
        break;
      case 'changes':
        if (!comparison) throw new Error('No comparison is loaded.');
        result = comparison.objects(
          data.key,
          data.filter,
          data.offset,
          data.limit,
        );
        break;
      case 'object':
        if (!graph) throw new Error('No snapshot is loaded.');
        result = graph.locateObject(data.index);
        if (result.object.id !== data.expectedId) {
          throw new Error('The linked object does not match this snapshot.');
        }
        break;
      case 'objects':
        if (!graph) throw new Error('No snapshot is loaded.');
        result = graph.objects(data.key, data.offset, data.limit);
        break;
      case 'retainers':
      case 'references':
        {
          const source = data.source === 'baseline' ? baseline : graph;
          if (!source) throw new Error('No snapshot is loaded.');
          result =
            data.action === 'references'
              ? source.references(data.index, data.offset, data.limit)
              : source.retainers(data.index, data.offset, data.limit);
        }
        break;
    }
    self.postMessage({requestId: data.requestId, result});
  } catch (error) {
    self.postMessage({
      requestId: data.requestId,
      error: String(error instanceof Error ? error.message : error),
    });
  }
};
