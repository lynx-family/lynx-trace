// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import type {MemorySnapshot} from '../../lynx_perf/common_components/memory/memory_snapshots';

export interface ExternalSnapshotProfile {
  sliceId: number;
  ts: bigint;
  id: string;
  snapshotId: string;
  file: File;
}

export type SnapshotProfile = MemorySnapshot | ExternalSnapshotProfile;

export function isExternalSnapshot(
  profile: SnapshotProfile,
): profile is ExternalSnapshotProfile {
  return 'file' in profile;
}
