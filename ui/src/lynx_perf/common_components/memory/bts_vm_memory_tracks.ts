// Copyright (C) 2026 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import {Engine} from '../../../trace_processor/engine';
import {LONG, NUM, STR} from '../../../trace_processor/query_result';
import {BtsVmInstance, loadBtsVmInstances} from './bts_vm_generations';

export interface BtsVmMemoryTrack {
  id: number;
  name: string;
  ptr: string;
  firstTs: bigint;
  lastTs: bigint;
}

export interface BtsVmMemoryTrackAssignment {
  vm: BtsVmInstance;
  track: BtsVmMemoryTrack;
}

export function isBtsVmMemoryTrackCandidate(
  track: BtsVmMemoryTrack,
  vm: BtsVmInstance,
): boolean {
  return (
    vm.ptrs.includes(track.ptr) &&
    (vm.destroyTs === undefined || track.firstTs <= vm.destroyTs) &&
    track.lastTs >= vm.createTs
  );
}

export function assignBtsVmMemoryTracks(
  vms: BtsVmInstance[],
  tracks: BtsVmMemoryTrack[],
): BtsVmMemoryTrackAssignment[] {
  return vms.flatMap((vm) => {
    const matchingTracks = tracks.filter((track) =>
      isBtsVmMemoryTrackCandidate(track, vm),
    );
    return matchingTracks.length === 1 ? [{vm, track: matchingTracks[0]}] : [];
  });
}

export function assignBtsVmMemoryTracksForDisplay(
  vms: BtsVmInstance[],
  tracks: BtsVmMemoryTrack[],
): BtsVmMemoryTrackAssignment[] {
  const assignments = assignBtsVmMemoryTracks(vms, tracks);
  const bestByTrackId = new Map<
    number,
    BtsVmMemoryTrackAssignment & {distance: bigint}
  >();
  for (const assignment of assignments) {
    const vmEndTs = assignment.vm.destroyTs ?? assignment.track.lastTs;
    const distance =
      absoluteDifference(assignment.track.firstTs, assignment.vm.createTs) +
      absoluteDifference(assignment.track.lastTs, vmEndTs);
    const current = bestByTrackId.get(assignment.track.id);
    if (current === undefined || distance < current.distance) {
      bestByTrackId.set(assignment.track.id, {...assignment, distance});
    }
  }
  return [...bestByTrackId.values()].map(({vm, track}) => ({vm, track}));
}

function absoluteDifference(left: bigint, right: bigint): bigint {
  return left >= right ? left - right : right - left;
}

export async function loadBtsVmMemoryTracks(
  engine: Engine,
): Promise<BtsVmMemoryTrack[]> {
  const result = await engine.query(`
    SELECT
      ct.id AS trackId,
      ct.name,
      MIN(c.ts) AS firstTs,
      MAX(c.ts) AS lastTs,
      COALESCE((
        SELECT ptr_arg.display_value
        FROM counter first_counter
        JOIN args ptr_arg ON ptr_arg.arg_set_id = first_counter.arg_set_id
          AND ptr_arg.flat_key IN ('ptr', 'debug.ptr')
        WHERE first_counter.track_id = ct.id
        ORDER BY first_counter.ts ASC, first_counter.id ASC
        LIMIT 1
      ), '') AS ptr
    FROM counter_track ct
    JOIN counter c ON c.track_id = ct.id
    WHERE ct.name GLOB 'bts_vm_acc_*'
    GROUP BY ct.id
    ORDER BY ct.id
  `);
  const tracks: BtsVmMemoryTrack[] = [];
  for (
    const it = result.iter({
      trackId: NUM,
      name: STR,
      firstTs: LONG,
      lastTs: LONG,
      ptr: STR,
    });
    it.valid();
    it.next()
  ) {
    tracks.push({
      id: it.trackId,
      name: it.name,
      ptr: it.ptr,
      firstTs: it.firstTs,
      lastTs: it.lastTs,
    });
  }
  return tracks;
}

export async function loadBtsVmMemoryTrackAssignments(
  engine: Engine,
  forDisplay = false,
): Promise<BtsVmMemoryTrackAssignment[]> {
  const tracks = await loadBtsVmMemoryTracks(engine);
  if (tracks.length === 0) {
    return [];
  }
  const vms = await loadBtsVmInstances(engine);
  const assignments = forDisplay
    ? assignBtsVmMemoryTracksForDisplay(vms, tracks)
    : assignBtsVmMemoryTracks(vms, tracks);
  return assignments;
}
