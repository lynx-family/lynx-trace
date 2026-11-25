// Copyright (C) 2024 The Android Open Source Project
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
import {Time, Duration} from '../../base/time';
import {getColorForSlice} from '../../components/colorizer';
import {
  CounterTrack,
  CounterTrackAttrs,
} from '../../components/tracks/counter_track';
import {TrackEventDetails, TrackEventSelection} from '../../public/selection';
import {TrackEventDetailsPanel} from '../../public/details_panel';
import {TrackMouseEvent, TrackRenderContext} from '../../public/track';
import {LONG, LONG_NULL, NUM} from '../../trace_processor/query_result';
import {lynxPerfGlobals} from '../../lynx_perf/lynx_perf_globals';
import {
  formatMemoryBytes,
  formatMemoryCounterValue,
  isMemoryCounterTrackName,
} from '../../lynx_perf/common_components/memory/memory_format';
import {CounterDetailsPanel} from './counter_details_panel';
import {MemoryVitalsDetailsPanel} from '../lynx.memory/details';
import {openSnapshotViewer} from '../lynx.memory/snapshot_viewer_state';
import {
  MemorySnapshot,
  loadMemorySnapshots,
  memorySnapshotEventId,
  memorySnapshotAccumulateBytes,
  memorySnapshotKindLabel,
  memorySnapshotSliceId,
  memorySnapshotTrackName,
} from '../../lynx_perf/common_components/memory/memory_snapshots';
import {BtsVmMemoryTrack} from '../../lynx_perf/common_components/memory/bts_vm_memory_tracks';
import {
  MemoryVitalEventData,
  formatMemoryVitalEventName,
  isPageLifetimeEvent,
  loadMemoryVitalEvents,
} from '../../lynx_perf/common_components/memory/memory_vital_events';
import {
  MemoryPagePanel,
  MemoryPageUrlTooltip,
} from '../../lynx_perf/common_components/memory/memory_page_panel';

export interface TraceProcessorCounterTrackAttrs
  extends Omit<CounterTrackAttrs, 'sqlSource'> {
  /** The trace processor track id. */
  readonly trackId: number;

  /** The display name of the track. */
  readonly trackName: string;

  /** GC events belonging to this track's BTS VM. */
  readonly vmGcTimestamps?: ReadonlyArray<bigint>;

  /** The complete sample range of a BTS VM track. */
  readonly btsVmTrack?: BtsVmMemoryTrack;

  /** The root table to query. Defaults to 'counter'. */
  readonly rootTable?: string;

  /**
   * SQL source selecting the necessary data.
   * If omitted, defaults to selecting from rootTable where track_id = trackId.
   */
  readonly sqlSource?: string;
}

export class TraceProcessorCounterTrack extends CounterTrack {
  protected readonly trackId: number;
  protected readonly trackName: string;
  protected readonly rootTable: string;
  private readonly vmGcTimestamps: ReadonlyArray<bigint>;
  private readonly memoryInstanceId?: number;
  private snapshots: MemorySnapshot[] = [];
  private pageLifetimeEvents: MemoryVitalEventData[] = [];
  private memoryMarkersPromise?: Promise<void>;
  private hoveredSnapshot?: MemorySnapshot;
  private hoveredPageEvents: MemoryVitalEventData[] = [];
  readonly onTrackShellClick?: () => void;

  constructor(attrs: TraceProcessorCounterTrackAttrs) {
    const {trackId, trackName, rootTable = 'counter', sqlSource} = attrs;
    const resolvedSqlSource =
      sqlSource ??
      `
      select id, ts, value, arg_set_id
      from ${rootTable}
      where track_id = ${trackId}
    `;
    const memoryInstanceId = parseMemoryInstanceId(trackName);
    super({
      ...attrs,
      sqlSource: resolvedSqlSource,
      shouldHighlightData:
        memoryInstanceId === undefined
          ? undefined
          : () => lynxPerfGlobals.shouldHighlightMemoryTrack(memoryInstanceId),
      tooltipValueFormatter: isMemoryCounterTrackName(trackName)
        ? formatMemoryCounterValue
        : attrs.tooltipValueFormatter,
    });
    this.trackId = trackId;
    this.trackName = trackName;
    this.rootTable = rootTable;
    this.vmGcTimestamps = attrs.vmGcTimestamps ?? [];
    this.memoryInstanceId = memoryInstanceId;
    if (trackName.startsWith('bts_vm_acc_')) {
      this.onTrackShellClick = () => {
        void this.selectFullBtsVmTrack(attrs.btsVmTrack);
      };
    } else if (memoryInstanceId !== undefined) {
      this.onTrackShellClick = () => {
        this.trace.selection.selectTrack(this.uri);
      };
    }
  }

  getTrackShellTooltip(): m.Children {
    return this.memoryInstanceId === undefined
      ? undefined
      : m(MemoryPageUrlTooltip, {
          key: this.uri,
          trace: this.trace,
          trackId: this.trackId,
          instanceId: this.memoryInstanceId,
        });
  }

  renderTrackDetails(): m.Children {
    return this.memoryInstanceId === undefined
      ? undefined
      : m(MemoryPagePanel, {
          key: this.uri,
          trace: this.trace,
          trackId: this.trackId,
          instanceId: this.memoryInstanceId,
        });
  }

  private async selectFullBtsVmTrack(bounds?: BtsVmMemoryTrack): Promise<void> {
    let firstTs = bounds?.firstTs;
    let lastTs = bounds?.lastTs;
    if (firstTs === undefined || lastTs === undefined) {
      const result = await this.engine.query(`
        SELECT MIN(ts) AS firstTs, MAX(ts) AS lastTs
        FROM ${this.rootTable}
        WHERE track_id = ${this.trackId}
      `);
      const row = result.firstRow({firstTs: LONG_NULL, lastTs: LONG_NULL});
      firstTs = row.firstTs ?? undefined;
      lastTs = row.lastTs ?? undefined;
    }
    if (firstTs !== undefined && lastTs !== undefined) {
      this.trace.selection.selectArea({
        start: Time.fromRaw(firstTs),
        end: Time.fromRaw(lastTs > firstTs ? lastTs : firstTs + 1n),
        trackUris: [this.uri],
      });
    }
  }

  render(ctx: TrackRenderContext): void {
    super.render(ctx);
    this.renderVmGcMarkers(ctx);
    if (
      this.memoryInstanceId === undefined &&
      !this.trackName.startsWith('bts_vm_acc_')
    ) {
      return;
    }
    this.memoryMarkersPromise ??= Promise.all([
      loadMemorySnapshots(this.engine),
      this.memoryInstanceId === undefined
        ? Promise.resolve([])
        : loadMemoryVitalEvents(this.engine),
    ]).then(([snapshots, events]) => {
      this.snapshots = snapshots.filter(
        (snapshot) => memorySnapshotTrackName(snapshot) === this.trackName,
      );
      this.pageLifetimeEvents = events.filter(
        (event) =>
          event.instanceId === this.memoryInstanceId &&
          isPageLifetimeEvent(event.name),
      );
      this.trace.raf.scheduleFullRedraw();
    });
    this.renderPageLifetimeMarkers(ctx);
    const selection = this.trace.selection.selection;
    const selectedId =
      selection.kind === 'track_event' && selection.trackUri === this.uri
        ? memorySnapshotSliceId(selection.eventId)
        : undefined;
    const top = this.getSnapshotMarkerTop();
    ctx.ctx.save();
    for (const snapshot of this.snapshots) {
      const x = ctx.timescale.timeToPx(Time.fromRaw(snapshot.ts));
      if (x < -8 || x > ctx.size.width + 8) {
        continue;
      }
      const selected = snapshot.sliceId === selectedId;
      const color =
        snapshot.kind === 'mts_instance'
          ? '#dc2626'
          : snapshot.kind === 'bts_residual'
            ? '#7c3aed'
            : '#16a34a';
      ctx.ctx.fillStyle = color;
      ctx.ctx.strokeStyle = selected ? '#f59e0b' : '#fff';
      ctx.ctx.lineWidth = selected ? 2 : 1;
      ctx.ctx.beginPath();
      ctx.ctx.moveTo(x, top - 3);
      ctx.ctx.lineTo(x - 3, top);
      ctx.ctx.lineTo(x + 3, top);
      ctx.ctx.closePath();
      ctx.ctx.fill();
      ctx.ctx.beginPath();
      ctx.ctx.roundRect(x - 7, top, 14, 10, 2);
      ctx.ctx.fill();
      ctx.ctx.stroke();
      ctx.ctx.strokeStyle = '#fff';
      ctx.ctx.lineWidth = 1;
      ctx.ctx.beginPath();
      ctx.ctx.arc(x, top + 5, 2.5, 0, Math.PI * 2);
      ctx.ctx.stroke();
      ctx.ctx.fillStyle = '#fff';
      ctx.ctx.fillRect(x - 5, top + 2, 2, 1);
      const bytes = memorySnapshotAccumulateBytes(snapshot);
      const label = bytes === undefined ? 'Unknown' : formatMemoryBytes(bytes);
      ctx.ctx.font = '8px Roboto Condensed';
      ctx.ctx.textAlign = 'center';
      ctx.ctx.textBaseline = 'top';
      ctx.ctx.fillStyle = color;
      const halfWidth = ctx.ctx.measureText(label).width / 2;
      const labelX = Math.min(
        ctx.size.width - halfWidth,
        Math.max(halfWidth, x),
      );
      ctx.ctx.fillText(label, labelX, top + 12);
    }
    ctx.ctx.restore();
  }

  private renderVmGcMarkers({ctx, timescale, size}: TrackRenderContext): void {
    if (this.vmGcTimestamps.length === 0) {
      return;
    }
    ctx.save();
    ctx.strokeStyle = '#dc2626';
    ctx.fillStyle = '#dc2626';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.font = '9px Roboto Condensed';
    ctx.textBaseline = 'top';
    for (const ts of this.vmGcTimestamps) {
      const x = timescale.timeToPx(Time.fromRaw(ts));
      if (x < 0 || x > size.width) {
        continue;
      }
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.getHeight() - 1);
      ctx.stroke();
      const alignRight = x > size.width - 20;
      ctx.textAlign = alignRight ? 'right' : 'left';
      ctx.fillText('GC', x + (alignRight ? -3 : 3), 2);
    }
    ctx.restore();
  }

  private renderPageLifetimeMarkers({
    ctx,
    timescale,
    size,
  }: TrackRenderContext): void {
    ctx.save();
    ctx.setLineDash([4, 3]);
    for (const event of this.pageLifetimeEvents) {
      const x = timescale.timeToPx(Time.fromRaw(event.ts));
      if (x < 0 || x > size.width) {
        continue;
      }
      ctx.strokeStyle = getColorForSlice(
        formatMemoryVitalEventName(event),
      ).base.cssString;
      ctx.lineWidth = this.hoveredPageEvents.includes(event) ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.getHeight() - 1);
      ctx.stroke();
    }
    ctx.restore();
  }

  private getSnapshotMarkerTop(): number {
    return this.getHeight() - 22;
  }

  private findSnapshot(event: TrackMouseEvent): MemorySnapshot | undefined {
    const top = this.getSnapshotMarkerTop();
    if (event.y < top - 3 || event.y > top + 10) {
      return undefined;
    }
    let nearest: MemorySnapshot | undefined;
    let nearestDistance = 8;
    for (const snapshot of this.snapshots) {
      const x = event.timescale.timeToPx(Time.fromRaw(snapshot.ts));
      const distance = Math.abs(x - event.x);
      if (distance <= nearestDistance) {
        nearest = snapshot;
        nearestDistance = distance;
      }
    }
    return nearest;
  }

  onMouseMove(event: TrackMouseEvent): void {
    const snapshot = this.findSnapshot(event);
    const pageEvents =
      snapshot !== undefined || event.y < 0 || event.y > this.getHeight()
        ? []
        : this.pageLifetimeEvents.filter(
            (pageEvent) =>
              Math.abs(
                event.timescale.timeToPx(Time.fromRaw(pageEvent.ts)) - event.x,
              ) <= 3,
          );
    if (
      snapshot !== this.hoveredSnapshot ||
      pageEvents.length !== this.hoveredPageEvents.length ||
      pageEvents.some((item, index) => item !== this.hoveredPageEvents[index])
    ) {
      this.hoveredSnapshot = snapshot;
      this.hoveredPageEvents = pageEvents;
      this.trace.raf.scheduleFullRedraw();
    }
    if (snapshot !== undefined || pageEvents.length > 0) {
      super.onMouseOut();
    } else {
      super.onMouseMove(event);
    }
  }

  onMouseOut(): void {
    if (
      this.hoveredSnapshot !== undefined ||
      this.hoveredPageEvents.length > 0
    ) {
      this.trace.raf.scheduleFullRedraw();
    }
    this.hoveredSnapshot = undefined;
    this.hoveredPageEvents = [];
    super.onMouseOut();
  }

  renderTooltip(): m.Children {
    const snapshot = this.hoveredSnapshot;
    if (snapshot !== undefined) {
      const formatBytes = (bytes: number | undefined) =>
        bytes === undefined ? 'Unknown' : formatMemoryBytes(bytes);
      if (snapshot.kind !== 'bts_residual') {
        return m('.pf-track__tooltip', [
          m('div', `${memorySnapshotKindLabel(snapshot.kind)} Snapshot`),
          m(
            'div',
            `Accumulate: ${formatBytes(memorySnapshotAccumulateBytes(snapshot))}`,
          ),
          snapshot.kind === 'mts_instance' || snapshot.kind === 'bts_vm'
            ? m('div', `RSS: ${formatBytes(snapshot.rssBytes)}`)
            : null,
        ]);
      }
      return m(
        '.pf-track__tooltip',
        `Residual ${formatBytes(snapshot.retainedBytes)} after ${snapshot.postExitPageCount ?? 'Unknown'} pages loaded on the same BTS VM.`,
      );
    }
    return this.hoveredPageEvents.length > 0
      ? m(
          '.pf-track__tooltip',
          this.hoveredPageEvents.map(formatMemoryVitalEventName).join('\n'),
        )
      : super.renderTooltip();
  }

  onMouseDoubleClick(event: TrackMouseEvent): boolean {
    const snapshot = this.findSnapshot(event);
    if (!snapshot) return false;
    openSnapshotViewer(this.trace, snapshot.sliceId);
    return true;
  }

  onMouseClick(event: TrackMouseEvent): boolean {
    const snapshot = this.findSnapshot(event);
    if (snapshot !== undefined) {
      this.trace.selection.selectTrackEvent(
        this.uri,
        memorySnapshotEventId(snapshot.sliceId),
      );
      return true;
    }
    const {x, timescale} = event;
    const time = timescale.pxToHpTime(x).toTime('floor');

    const query = `
      select
        id
      from ${this.rootTable}
      where
        track_id = ${this.trackId}
        and ts < ${time}
      order by ts DESC
      limit 1
    `;

    this.engine.query(query).then((result) => {
      const it = result.iter({
        id: NUM,
      });
      if (!it.valid()) {
        return;
      }
      const id = it.id;
      this.trace.selection.selectTrackEvent(this.uri, id);
    });

    return true;
  }

  // We must define this here instead of in `CounterTrack` because
  // `CounterTrack` does not require the query to have an id column. Here,
  // however, we make the assumption that `rootTable` has an id column, as we
  // need it ot make selections in `onMouseClick` above. Whether or not we
  // SHOULD assume `rootTable` has an id column is another matter...
  async getSelectionDetails(id: number): Promise<TrackEventDetails> {
    const sliceId = memorySnapshotSliceId(id);
    if (sliceId !== undefined) {
      const snapshot = (await loadMemorySnapshots(this.engine)).find(
        (item) =>
          item.sliceId === sliceId &&
          memorySnapshotTrackName(item) === this.trackName,
      );
      if (snapshot === undefined) {
        throw new Error(
          `Snapshot slice ${sliceId} is not on ${this.trackName}`,
        );
      }
      return {ts: Time.fromRaw(snapshot.ts), dur: Duration.ZERO};
    }
    const query = `
      WITH CTE AS (
        SELECT
          id,
          ts as leftTs
        FROM ${this.rootTable}
        WHERE track_id = ${this.trackId} AND id = ${id}
      )
      SELECT
        *,
        (
          SELECT
            ts
          FROM ${this.rootTable}
          WHERE track_id = ${this.trackId} AND ts > leftTs
          ORDER BY ts ASC
          LIMIT 1
        ) as rightTs
      FROM CTE
    `;

    const counter = await this.engine.query(query);
    const row = counter.iter({
      leftTs: LONG,
      rightTs: LONG_NULL,
    });
    const leftTs = Time.fromRaw(row.leftTs);
    const rightTs = row.rightTs !== null ? Time.fromRaw(row.rightTs) : leftTs;
    const duration = rightTs - leftTs;
    return {ts: leftTs, dur: duration};
  }

  detailsPanel(selection: TrackEventSelection): TrackEventDetailsPanel {
    if (
      selection.eventId < 0 &&
      (this.memoryInstanceId !== undefined ||
        this.trackName.startsWith('bts_vm_acc_'))
    ) {
      return new MemoryVitalsDetailsPanel(this.trace);
    }
    return new CounterDetailsPanel(
      this.trace,
      this.trackId,
      this.trackName,
      () => this.yMode,
      this.unit,
      this.rateUnit,
      this.sqlSource,
    );
  }
}

function parseMemoryInstanceId(trackName: string): number | undefined {
  const instanceId = /^memory_(\d+)$/.exec(trackName)?.[1];
  if (instanceId === undefined) {
    return undefined;
  }
  const value = Number(instanceId);
  return Number.isFinite(value) ? value : undefined;
}
