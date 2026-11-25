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
import {Trace} from '../../../public/trace';

export const CAPTURE_SNAPSHOT = 'capture_snapshot';

export interface PageMemorySnapshotIdentity {
  kind: 'mts_instance' | 'bts_instance' | 'bts_residual';
  instanceId: number;
  slot?: number;
}

export interface VmMemorySnapshotIdentity {
  kind: 'bts_vm' | 'bts_unknown' | 'bts_common' | 'bts_overflow';
  vmUniqueId: string;
}

export type MemorySnapshotIdentity =
  | PageMemorySnapshotIdentity
  | VmMemorySnapshotIdentity;

export type MemorySnapshot = MemorySnapshotIdentity & {
  sliceId: number;
  ts: bigint;
  id: string;
  snapshotId: string;
  /** Slot from capture metadata, independent of the identifier. */
  captureSlot?: number;
  triggerRetainedBytes?: number;
  retainedBytes?: number;
  postExitPageCount?: number;
  accumulateBytes?: number;
  rssBytes?: number;
};

export function isVmMemorySnapshot(
  snapshot: MemorySnapshotIdentity,
): snapshot is VmMemorySnapshotIdentity {
  return 'vmUniqueId' in snapshot;
}

export function memorySnapshotTrackName(
  snapshot: {instanceId: number} | {vmUniqueId: string},
): string {
  return 'vmUniqueId' in snapshot
    ? `bts_vm_acc_${snapshot.vmUniqueId}`
    : `memory_${snapshot.instanceId}`;
}

export function memorySnapshotAccumulateBytes(
  snapshot: MemorySnapshot,
): number | undefined {
  switch (snapshot.kind) {
    case 'mts_instance':
    case 'bts_vm':
      return snapshot.accumulateBytes;
    case 'bts_instance':
      return snapshot.triggerRetainedBytes;
    default:
      return snapshot.retainedBytes;
  }
}

export function memorySnapshotKindLabel(
  kind: MemorySnapshotIdentity['kind'],
): string {
  switch (kind) {
    case 'mts_instance':
      return 'MTS';
    case 'bts_instance':
      return 'BTS';
    case 'bts_residual':
      return 'BTS Residual';
    case 'bts_vm':
      return 'BTS VM';
    case 'bts_unknown':
      return 'BTS Unknown Slot';
    case 'bts_common':
      return 'BTS Common Slot';
    case 'bts_overflow':
      return 'BTS Overflow Slot';
  }
}

function parseSnapshotMemoryUsage(
  desc: string | null,
): Pick<MemorySnapshot, 'accumulateBytes' | 'rssBytes'> {
  if (desc === null) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(desc);
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed)
    ) {
      return {};
    }
    const record = parsed as Record<string, unknown>;
    const bytes = (value: unknown): number | undefined => {
      if (
        typeof value !== 'number' &&
        (typeof value !== 'string' || value.trim() === '')
      ) {
        return undefined;
      }
      const number = Number(value);
      return Number.isFinite(number) && number >= 0 ? number : undefined;
    };
    const base = bytes(record.base_usage);
    const page = bytes(record.page_rss_usage);
    return {
      accumulateBytes: bytes(record.acc_usage),
      rssBytes:
        base === undefined || page === undefined ? undefined : base + page,
    };
  } catch {
    return {};
  }
}

export function parseMemorySnapshotId(
  id: string,
): MemorySnapshotIdentity | undefined {
  const vm = /^(bts_vm|bts_unknown|bts_common|bts_overflow)\/(\d+)$/.exec(id);
  if (vm !== null) {
    return {
      kind: vm[1] as VmMemorySnapshotIdentity['kind'],
      // Keep the full identifier as a string; it is not a page ID.
      vmUniqueId: vm[2],
    };
  }
  const mts = /^mts_instance\/(\d+)$/.exec(id);
  const bts = /^(bts_instance|bts_residual)\/(\d+)\/slot_(\d+)$/.exec(id);
  if (mts === null && bts === null) {
    return undefined;
  }
  const instanceId = Number(mts?.[1] ?? bts?.[2]);
  const slot = bts === null ? undefined : Number(bts[3]);
  if (
    !Number.isSafeInteger(instanceId) ||
    (slot !== undefined && (!Number.isInteger(slot) || slot < 0 || slot > 255))
  ) {
    return undefined;
  }
  return {
    kind:
      mts !== null
        ? 'mts_instance'
        : bts?.[1] === 'bts_instance'
          ? 'bts_instance'
          : 'bts_residual',
    instanceId,
    slot,
  };
}

const snapshotsByEngine = new WeakMap<Engine, Promise<MemorySnapshot[]>>();

export function loadMemorySnapshots(engine: Engine): Promise<MemorySnapshot[]> {
  let snapshots = snapshotsByEngine.get(engine);
  if (snapshots === undefined) {
    snapshots = queryMemorySnapshots(engine);
    snapshotsByEngine.set(engine, snapshots);
  }
  return snapshots;
}

async function queryMemorySnapshots(engine: Engine): Promise<MemorySnapshot[]> {
  const result = await engine.query(`
    SELECT
      s.id AS sliceId,
      s.ts,
      MAX(CASE WHEN a.flat_key IN ('id', 'debug.id', 'args.id')
        THEN a.display_value END) AS snapshotVmId,
      MAX(CASE WHEN a.flat_key IN ('snapshot_id', 'debug.snapshot_id', 'args.snapshot_id')
        THEN a.display_value END) AS snapshotId,
      MAX(CASE WHEN a.flat_key IN ('slot', 'debug.slot', 'args.slot')
        THEN a.display_value END) AS captureSlot,
      CAST(MAX(CASE WHEN a.flat_key IN (
        'trigger_retained_bytes', 'debug.trigger_retained_bytes', 'args.trigger_retained_bytes'
      ) THEN a.display_value END) AS REAL) AS triggerRetainedBytes,
      CAST(MAX(CASE WHEN a.flat_key IN (
        'retained_bytes', 'debug.retained_bytes', 'args.retained_bytes'
      ) THEN a.display_value END) AS REAL) AS retainedBytes,
      CAST(MAX(CASE WHEN a.flat_key IN (
        'post_exit_page_count', 'debug.post_exit_page_count', 'args.post_exit_page_count'
      ) THEN a.display_value END) AS INT) AS postExitPageCount,
      MAX(CASE WHEN a.flat_key IN ('desc', 'debug.desc', 'args.desc')
        THEN a.display_value END) AS desc
    FROM slice s
    JOIN args a ON a.arg_set_id = s.arg_set_id
    WHERE s.name = '${CAPTURE_SNAPSHOT}'
      AND a.flat_key IN (
        'id', 'debug.id', 'args.id',
        'snapshot_id', 'debug.snapshot_id', 'args.snapshot_id',
        'slot', 'debug.slot', 'args.slot',
        'trigger_retained_bytes', 'debug.trigger_retained_bytes', 'args.trigger_retained_bytes',
        'retained_bytes', 'debug.retained_bytes', 'args.retained_bytes',
        'post_exit_page_count', 'debug.post_exit_page_count', 'args.post_exit_page_count',
        'desc', 'debug.desc', 'args.desc'
      )
    GROUP BY s.id
    HAVING snapshotVmId IS NOT NULL
    ORDER BY s.ts, s.id
  `);
  const snapshots: MemorySnapshot[] = [];
  for (
    const row = result.iter({
      sliceId: NUM,
      ts: LONG,
      snapshotVmId: STR,
      snapshotId: STR_NULL,
      captureSlot: STR_NULL,
      triggerRetainedBytes: NUM_NULL,
      retainedBytes: NUM_NULL,
      postExitPageCount: NUM_NULL,
      desc: STR_NULL,
    });
    row.valid();
    row.next()
  ) {
    const identity = parseMemorySnapshotId(row.snapshotVmId);
    if (identity !== undefined) {
      const captureSlot =
        row.captureSlot === null || row.captureSlot.trim() === ''
          ? undefined
          : Number(row.captureSlot);
      snapshots.push({
        ...identity,
        ...parseSnapshotMemoryUsage(row.desc),
        sliceId: row.sliceId,
        ts: row.ts,
        id: row.snapshotVmId,
        snapshotId: row.snapshotId ?? '',
        captureSlot:
          captureSlot !== undefined &&
          Number.isInteger(captureSlot) &&
          captureSlot >= 0 &&
          captureSlot <= 255
            ? captureSlot
            : undefined,
        triggerRetainedBytes: row.triggerRetainedBytes ?? undefined,
        retainedBytes: row.retainedBytes ?? undefined,
        postExitPageCount: row.postExitPageCount ?? undefined,
      });
    }
  }
  return snapshots;
}

export function findLatestBtsSnapshot(
  snapshots: ReadonlyArray<MemorySnapshot>,
  instanceId: number,
  beforeTs: bigint,
  slot?: number,
): MemorySnapshot | undefined {
  // The index is ordered by timestamp and slice ID, including cleared residuals.
  for (let index = snapshots.length - 1; index >= 0; index--) {
    const snapshot = snapshots[index];
    if (
      snapshot.ts < beforeTs &&
      !isVmMemorySnapshot(snapshot) &&
      snapshot.instanceId === instanceId &&
      snapshot.kind !== 'mts_instance' &&
      (slot === undefined || snapshot.slot === slot)
    ) {
      return snapshot;
    }
  }
  return undefined;
}

// Counter IDs are nonnegative. Negative IDs identify snapshot slices on the
// same renderer without colliding with its counter samples.
export function memorySnapshotEventId(sliceId: number): number {
  return -sliceId - 1;
}

export function memorySnapshotSliceId(eventId: number): number | undefined {
  return eventId < 0 ? -eventId - 1 : undefined;
}

export function selectMemorySnapshot(
  trace: Trace,
  snapshot: {sliceId: number} & ({instanceId: number} | {vmUniqueId: string}),
): void {
  const trackName = memorySnapshotTrackName(snapshot);
  const track = trace.tracks.findTrack(
    (candidate) => candidate.tags?.counterTrackName === trackName,
  );
  if (track !== undefined) {
    trace.selection.selectTrackEvent(
      track.uri,
      memorySnapshotEventId(snapshot.sliceId),
      {scrollToSelection: true},
    );
  }
}

export function snapshotCaptureReasonDescription(reason: string): string {
  switch (reason) {
    case 'first_post_exit_full_gc':
      return 'First full GC after the page was destroyed.';
    case 'residual_cleared':
      return 'All memory in the destroyed page slot was released.';
    case 'residual_reappeared':
      return 'Memory reappeared in the destroyed page slot.';
    case 'residual_change_exceeds_20_percent':
      return 'Slot memory changed by more than 20% compared with the memory retained after the previous snapshot.';
    case 'post_exit_page_count_within_two':
      return 'Load other pages after page exit.';
    default:
      return 'Snapshot captured for an unknown reason.';
  }
}
