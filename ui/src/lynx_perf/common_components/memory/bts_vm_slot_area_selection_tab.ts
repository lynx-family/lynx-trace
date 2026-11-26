// Copyright (C) 2026 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import m from 'mithril';
import {AsyncLimiter} from '../../../base/async_limiter';
import {Time} from '../../../base/time';
import {
  AreaSelection,
  AreaSelectionTab,
  areaSelectionsEqual,
} from '../../../public/selection';
import {Trace} from '../../../public/trace';
import {Engine} from '../../../trace_processor/engine';
import {
  LONG,
  NUM,
  NUM_NULL,
  STR_NULL,
} from '../../../trace_processor/query_result';
import {EmptyState} from '../../../widgets/empty_state';
import {Section} from '../../../widgets/section';
import {Spinner} from '../../../widgets/spinner';
import {
  BtsVmSlotMemoryData,
  BtsVmSlotMemoryRow,
  buildBtsVmSlotInstanceIds,
  buildBtsVmSlotMemoryData,
  buildBtsVmSlotPageLifecycles,
} from './bts_vm_slot_memory';
import {loadBtsVmMemoryTrackAssignments} from './bts_vm_memory_tracks';
import {BtsVmSlotAreaPanel} from './memory_details_section';

export const COUNTER_TRACK_NAME_TAG = 'counterTrackName';
export const COUNTER_TRACK_DISPLAY_NAME_TAG = 'counterTrackDisplayName';

interface BtsVmSlotTrack {
  trackId: number;
  trackName: string;
  displayName: string;
}

function findBtsVmSlotTrack(
  selection: AreaSelection,
): BtsVmSlotTrack | undefined {
  const tracksById = new Map<number, BtsVmSlotTrack>();
  for (const track of selection.tracks) {
    const trackName = track.tags?.[COUNTER_TRACK_NAME_TAG];
    const trackIds = track.tags?.trackIds;
    if (
      typeof trackName !== 'string' ||
      !trackName.startsWith('bts_vm_acc_') ||
      trackIds?.length !== 1
    ) {
      continue;
    }
    const displayName = track.tags?.[COUNTER_TRACK_DISPLAY_NAME_TAG];
    tracksById.set(trackIds[0], {
      trackId: trackIds[0],
      trackName,
      displayName: typeof displayName === 'string' ? displayName : trackName,
    });
  }
  return tracksById.size === 1 ? [...tracksById.values()][0] : undefined;
}

async function loadBtsVmSlotMemoryData(
  engine: Engine,
  trackId: number,
  selection: AreaSelection,
): Promise<BtsVmSlotMemoryData> {
  const result = await engine.query(`
    WITH leading_sample AS (
      SELECT
        id AS sampleId,
        ${selection.start} AS ts,
        arg_set_id AS argSetId
      FROM counter
      WHERE track_id = ${trackId}
        AND ts <= ${selection.start}
      ORDER BY ts DESC, id DESC
      LIMIT 1
    ),
    selected_samples AS (
      SELECT * FROM leading_sample
      UNION ALL
      SELECT
        id AS sampleId,
        ts,
        arg_set_id AS argSetId
      FROM counter
      WHERE track_id = ${trackId}
        AND ts > ${selection.start}
        AND ts <= ${selection.end}
    )
    SELECT
      sample.sampleId,
      sample.ts,
      slot.flat_key AS slotKey,
      CAST(slot.display_value AS REAL) AS slotValue
    FROM selected_samples sample
    LEFT JOIN args slot
      ON slot.arg_set_id = sample.argSetId
      AND (
        slot.flat_key GLOB 'debug.slot_[0-9]*'
        OR slot.flat_key GLOB 'slot_[0-9]*'
      )
    ORDER BY sample.ts, sample.sampleId, slot.flat_key
  `);

  const rows: BtsVmSlotMemoryRow[] = [];
  for (
    const it = result.iter({
      sampleId: NUM,
      ts: LONG,
      slotKey: STR_NULL,
      slotValue: NUM_NULL,
    });
    it.valid();
    it.next()
  ) {
    rows.push({
      sampleId: it.sampleId,
      ts: Time.fromRaw(it.ts),
      slotKey: it.slotKey ?? undefined,
      slotValue: it.slotValue ?? undefined,
    });
  }
  return buildBtsVmSlotMemoryData(rows);
}

export function createBtsVmSlotAreaSelectionTab(
  trace: Trace,
): AreaSelectionTab {
  const limiter = new AsyncLimiter();
  const assignmentsPromise = loadBtsVmMemoryTrackAssignments(
    trace.engine,
    true,
  );
  let previousSelection: AreaSelection | undefined;
  let selectedTrack: BtsVmSlotTrack | undefined;
  let data: BtsVmSlotMemoryData | undefined;
  let error: string | undefined;
  let isLoading = false;
  let requestId = 0;

  return {
    id: 'bts_vm_slot_memory',
    name: 'BTS VM Slots',
    priority: 100,
    render(selection: AreaSelection) {
      const nextTrack = findBtsVmSlotTrack(selection);
      const selectionChanged =
        previousSelection === undefined ||
        !areaSelectionsEqual(previousSelection, selection);
      const trackChanged = nextTrack?.trackId !== selectedTrack?.trackId;

      if (nextTrack === undefined) {
        requestId++;
        previousSelection = selection;
        selectedTrack = undefined;
        data = undefined;
        error = undefined;
        isLoading = false;
        return undefined;
      }

      if (selectionChanged || trackChanged) {
        const currentRequestId = ++requestId;
        previousSelection = selection;
        selectedTrack = nextTrack;
        data = undefined;
        error = undefined;
        isLoading = true;
        void limiter.schedule(async () => {
          try {
            const [nextData, assignments] = await Promise.all([
              loadBtsVmSlotMemoryData(
                trace.engine,
                nextTrack.trackId,
                selection,
              ),
              assignmentsPromise,
            ]);
            const assignment = assignments.find(
              ({track}) => track.id === nextTrack.trackId,
            );
            const slotInstanceIds = buildBtsVmSlotInstanceIds(
              assignment?.vm.uses ?? [],
              selection.end,
            );
            const slotPageLifecycles = buildBtsVmSlotPageLifecycles(
              assignment?.vm.uses ?? [],
              selection.end,
            );
            const vmGcTimestamps = (assignment?.vm.gcTimestamps ?? [])
              .filter((ts) => ts >= selection.start && ts <= selection.end)
              .map((ts) => Time.fromRaw(ts));
            if (currentRequestId === requestId) {
              data = {
                ...nextData,
                slotInstanceIds,
                slotPageLifecycles,
                vmGcTimestamps,
              };
            }
          } catch (e) {
            if (currentRequestId === requestId) {
              error = String(e);
            }
          } finally {
            if (currentRequestId === requestId) {
              isLoading = false;
              trace.raf.scheduleFullRedraw();
            }
          }
        });
      }

      if (isLoading) {
        return {
          isLoading: true,
          content: m(
            EmptyState,
            {title: 'Loading BTS VM slot memory...'},
            m(Spinner, {easing: true}),
          ),
        };
      }

      if (error !== undefined) {
        return {
          isLoading: false,
          content: m(
            EmptyState,
            {title: 'Failed to load BTS VM slot memory'},
            error,
          ),
        };
      }

      return {
        isLoading: false,
        content: m(
          Section,
          {title: 'BTS VM Slot Memory'},
          m(BtsVmSlotAreaPanel, {
            trackName: nextTrack.trackName,
            displayName: nextTrack.displayName,
            start: selection.start,
            end: selection.end,
            data: data ?? {
              samples: [],
              slotIds: [],
              slotInstanceIds: {},
              slotPageLifecycles: {},
              vmGcTimestamps: [],
            },
          }),
        ),
      };
    },
  };
}
