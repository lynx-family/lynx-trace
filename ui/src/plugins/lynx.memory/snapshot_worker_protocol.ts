// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import type {
  SnapshotComparisonFilter,
  SnapshotObjectSource,
} from './snapshot_comparison';
import type {SnapshotSourceLocation} from './snapshot_graph';
import type {SnapshotJsonPath} from './snapshot_raw';

export type SnapshotWorkerRequest =
  | {
      requestId: number;
      action: 'load';
      content: string;
      sourceLocations?: Record<string, SnapshotSourceLocation>;
    }
  | {requestId: number; action: 'size'; content: string}
  | {
      requestId: number;
      action: 'raw';
      content?: string;
      path: SnapshotJsonPath;
      offset: number;
    }
  | {requestId: number; action: 'clearRaw'}
  | {
      requestId: number;
      action: 'compare';
      content?: string;
      sourceLocations?: Record<string, SnapshotSourceLocation>;
    }
  | {requestId: number; action: 'clearComparison'}
  | {requestId: number; action: 'object'; index: number; expectedId: number}
  | {
      requestId: number;
      action: 'changes';
      key: string;
      filter: SnapshotComparisonFilter;
      offset: number;
      limit: number;
    }
  | {
      requestId: number;
      action: 'objects';
      key: string;
      offset: number;
      limit: number;
    }
  | {
      requestId: number;
      action: 'retainers' | 'references';
      source: SnapshotObjectSource;
      index: number;
      offset: number;
      limit: number;
    };

type WithoutRequestId<Request> = Request extends {requestId: number}
  ? Omit<Request, 'requestId'>
  : never;

export type SnapshotGraphRequest = WithoutRequestId<
  Exclude<SnapshotWorkerRequest, {action: 'size'}>
>;
