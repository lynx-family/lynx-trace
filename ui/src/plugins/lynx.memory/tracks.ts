// Copyright (C) 2025 The Android Open Source Project
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

// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import m from 'mithril';
import {Time, duration, time} from '../../base/time';
import {getColorForSlice} from '../../components/colorizer';
import {featureFlags} from '../../core/feature_flags';
import {AppImpl} from '../../core/app_impl';
import {
  LYNX_MEMORY_PLUGIN_ID,
  SLICE_LAYOUT_FIT_CONTENT_DEFAULTS,
} from '../../lynx_perf/constants';
import {LynxBaseTrack} from '../../lynx_perf/lynx_base_track';
import {BaseSlice} from '../../lynx_perf/types';
import {TrackEventDetailsPanel} from '../../public/details_panel';
import {TrackEventSelection} from '../../public/selection';
import {TrackMouseEvent, TrackRenderContext} from '../../public/track';
import {NUM, STR, STR_NULL} from '../../trace_processor/query_result';
import {Button} from '../../widgets/button';
import {Icons} from '../../base/semantic_icons';
import {MemoryVitalsDetailsPanel} from './details';
import {
  BTS_RUNTIME_DESTROY,
  DESTROY_VM_INSTANCE,
  PAGE_USES_BTS_VM,
} from '../../lynx_perf/common_components/memory/bts_vm_generations';
import {lynxPerfGlobals} from '../../lynx_perf/lynx_perf_globals';

export const MEMORY_VITAL_EVENT_NAMES = [
  'LynxShell::Create',
  'LynxShell::~LynxShell',
  PAGE_USES_BTS_VM,
  BTS_RUNTIME_DESTROY,
  'LynxEnv.trimMemory',
  'RunGC',
  DESTROY_VM_INSTANCE,
  'capture_snapshot',
  'TRACE_END',
];

const DEFAULT_MARKER_Y_MULTIPLIER = 0.5;
const LOWER_LAYER_MARKER_Y_MULTIPLIER = 1.6;
const DEFAULT_MARKER_TIP_HEIGHT_MULTIPLIER = 0.5;
const LOWER_LAYER_MARKER_TIP_HEIGHT_MULTIPLIER = 1.45;
const MEMORY_VITALS_TRACK_HEIGHT_MULTIPLIER = 2.7;

interface MemoryVitalEvent extends BaseSlice {
  name: string;
  trackId: number;
  instanceId?: number;
  snapshotVmId?: string;
  widthPx?: number;
}

function parseOptionalNumber(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

export class MemoryVitalsTrack extends LynxBaseTrack<MemoryVitalEvent[]> {
  protected maxSliceDepth = 0;
  private selectedMarker: MemoryVitalEvent | undefined;
  private besselControlX = 3 * SLICE_LAYOUT_FIT_CONTENT_DEFAULTS.padding;
  readonly rootTableName = 'slice';

  getHeight(): number {
    return (
      SLICE_LAYOUT_FIT_CONTENT_DEFAULTS.padding +
      SLICE_LAYOUT_FIT_CONTENT_DEFAULTS.sliceHeight *
        MEMORY_VITALS_TRACK_HEIGHT_MULTIPLIER
    );
  }

  async fetchDataForBounds(
    _start: time,
    _end: time,
    _resolution: duration,
  ): Promise<MemoryVitalEvent[]> {
    const eventNames = MEMORY_VITAL_EVENT_NAMES.map((name) => `'${name}'`).join(
      ',',
    );
    const result = await this.trace.engine.query(`
      SELECT
        ts,
        id,
        name,
        track_id AS trackId,
        (
          SELECT display_value
          FROM args
          WHERE arg_set_id = slice.arg_set_id
            AND flat_key IN ('id', 'debug.id')
          LIMIT 1
        ) AS snapshotVmId,
        (
          SELECT display_value
          FROM args
          WHERE arg_set_id = slice.arg_set_id
            AND flat_key IN ('instance_id', 'debug.instance_id', 'args.instance_id')
          LIMIT 1
        ) AS instanceId
      FROM slice
      WHERE name IN (${eventNames})
      ORDER BY ts ASC
    `);

    const events: MemoryVitalEvent[] = [];
    for (
      const it = result.iter({
        ts: NUM,
        id: NUM,
        name: STR,
        trackId: NUM,
        snapshotVmId: STR_NULL,
        instanceId: STR_NULL,
      });
      it.valid();
      it.next()
    ) {
      events.push({
        ts: it.ts,
        id: it.id,
        name: it.name,
        trackId: it.trackId,
        instanceId: parseOptionalNumber(it.instanceId),
        snapshotVmId: it.snapshotVmId ?? undefined,
      });
    }
    return events;
  }

  render(ctx: TrackRenderContext): void {
    const renderCtx = ctx.ctx;
    const data = this.getTrackData(ctx);
    if (data === undefined) return;
    const visibleData = this.getVisibleEvents(data);

    const selection = AppImpl.instance.trace?.selection.selection;
    const selectedId =
      selection &&
      selection.kind === 'track_event' &&
      selection.trackUri === this.uri
        ? selection.eventId
        : undefined;
    if (selectedId === undefined) {
      this.selectedMarker = undefined;
    } else {
      this.selectedMarker = visibleData.find(
        (event) => event.id === selectedId,
      );
    }

    const oldStyle = renderCtx.fillStyle;
    const oldStrokeStyle = renderCtx.strokeStyle;
    const oldLineWidth = renderCtx.lineWidth;
    for (const event of visibleData.filter((event) =>
      this.isLowerLayerMarker(event),
    )) {
      this.drawMarker(ctx, event, false);
    }
    for (const event of visibleData.filter(
      (event) => !this.isLowerLayerMarker(event),
    )) {
      this.drawMarker(ctx, event, false);
    }

    if (this.selectedMarker !== undefined) {
      this.drawMarker(ctx, this.selectedMarker, true);
      this.drawThickBubbleBorder(ctx, this.selectedMarker);
    }

    renderCtx.fillStyle = oldStyle;
    renderCtx.strokeStyle = oldStrokeStyle;
    renderCtx.lineWidth = oldLineWidth;
  }

  private drawMarker(
    ctx: TrackRenderContext,
    marker: MemoryVitalEvent,
    selected: boolean,
  ) {
    const sliceHeight = SLICE_LAYOUT_FIT_CONTENT_DEFAULTS.sliceHeight;
    const padding = SLICE_LAYOUT_FIT_CONTENT_DEFAULTS.padding;
    const renderCtx = ctx.ctx;
    const x = ctx.timescale.timeToPx(Time.fromRaw(BigInt(marker.ts)));
    const y = this.getMarkerY(marker);
    const tipHeight = this.getMarkerTipHeight(marker);

    renderCtx.font = this.getTitleFont();
    const markerName = this.getMarkerName(marker);
    const width = renderCtx.measureText(markerName).width;
    marker.widthPx = width;
    const colorSchema = getColorForSlice(markerName);
    const color = selected
      ? colorSchema.variant.cssString
      : colorSchema.base.cssString;

    renderCtx.fillStyle = color;
    this.drawUpwardBubblePath(
      renderCtx,
      x,
      y,
      width,
      sliceHeight,
      padding,
      tipHeight,
    );
    renderCtx.fill();
    renderCtx.closePath();

    renderCtx.fillStyle = 'white';
    renderCtx.textBaseline = 'middle';
    renderCtx.fillText(markerName, x + padding, y + sliceHeight * 0.5);
  }

  private drawThickBubbleBorder(
    ctx: TrackRenderContext,
    marker: MemoryVitalEvent,
  ) {
    const sliceHeight = SLICE_LAYOUT_FIT_CONTENT_DEFAULTS.sliceHeight;
    const padding = SLICE_LAYOUT_FIT_CONTENT_DEFAULTS.padding;
    const renderCtx = ctx.ctx;
    const x = ctx.timescale.timeToPx(Time.fromRaw(BigInt(marker.ts)));
    const y = this.getMarkerY(marker);
    const tipHeight = this.getMarkerTipHeight(marker);
    const markerName = this.getMarkerName(marker);
    const width = renderCtx.measureText(markerName).width;
    const colorSchema = getColorForSlice(markerName);

    marker.widthPx = width;
    renderCtx.lineWidth = 3;
    renderCtx.strokeStyle = colorSchema.base.setHSL({s: 100, l: 10}).cssString;
    this.drawUpwardBubblePath(
      renderCtx,
      x,
      y,
      width,
      sliceHeight,
      padding,
      tipHeight,
    );
    renderCtx.stroke();
    renderCtx.closePath();
  }

  private getMarkerName(marker: MemoryVitalEvent): string {
    if (marker.name !== 'capture_snapshot') {
      return marker.name;
    }

    return marker.snapshotVmId?.includes('(mts)')
      ? 'MTS Snapshot'
      : 'BTS Snapshot';
  }

  private isSnapshotMarker(marker: MemoryVitalEvent): boolean {
    return marker.name === 'capture_snapshot';
  }

  private isLowerLayerMarker(marker: MemoryVitalEvent): boolean {
    return (
      this.isSnapshotMarker(marker) ||
      marker.name === 'RunGC' ||
      marker.name === 'LynxEnv.trimMemory'
    );
  }

  private isPageLifetimeMarker(marker: MemoryVitalEvent): boolean {
    return (
      marker.name === 'LynxShell::Create' ||
      marker.name === 'LynxShell::~LynxShell' ||
      marker.name === PAGE_USES_BTS_VM ||
      marker.name === BTS_RUNTIME_DESTROY
    );
  }

  private getVisibleEvents(data: MemoryVitalEvent[]): MemoryVitalEvent[] {
    if (!lynxPerfGlobals.isMemoryTrackFocusActive()) {
      return data;
    }

    return data.filter((event) => {
      if (!this.isPageLifetimeMarker(event)) {
        return true;
      }
      return (
        event.instanceId !== undefined &&
        lynxPerfGlobals.shouldHighlightMemoryTrack(event.instanceId)
      );
    });
  }

  private getMarkerY(marker: MemoryVitalEvent): number {
    const sliceHeight = SLICE_LAYOUT_FIT_CONTENT_DEFAULTS.sliceHeight;
    const padding = SLICE_LAYOUT_FIT_CONTENT_DEFAULTS.padding;
    const multiplier = this.isLowerLayerMarker(marker)
      ? LOWER_LAYER_MARKER_Y_MULTIPLIER
      : DEFAULT_MARKER_Y_MULTIPLIER;
    return padding + sliceHeight * multiplier;
  }

  private getMarkerTipHeight(marker: MemoryVitalEvent): number {
    const sliceHeight = SLICE_LAYOUT_FIT_CONTENT_DEFAULTS.sliceHeight;
    const multiplier = this.isLowerLayerMarker(marker)
      ? LOWER_LAYER_MARKER_TIP_HEIGHT_MULTIPLIER
      : DEFAULT_MARKER_TIP_HEIGHT_MULTIPLIER;
    return sliceHeight * multiplier;
  }

  private drawUpwardBubblePath(
    renderCtx: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    padding: number,
    tipHeight: number,
  ) {
    renderCtx.beginPath();
    renderCtx.moveTo(x + padding, y);
    renderCtx.lineTo(x, y - tipHeight);
    renderCtx.lineTo(x + padding * 4, y);
    renderCtx.lineTo(x + width + padding, y);
    renderCtx.quadraticCurveTo(
      x + width + padding + this.besselControlX,
      y + height * 0.5,
      x + width + padding,
      y + height,
    );
    renderCtx.lineTo(x + padding, y + height);
    renderCtx.quadraticCurveTo(
      x + padding - this.besselControlX,
      y + height * 0.5,
      x + padding,
      y,
    );
  }

  onMouseClick(event: TrackMouseEvent): boolean {
    const marker = this.findMarker(event);
    if (marker === undefined) {
      this.selectedMarker = undefined;
      return false;
    }

    this.selectedMarker = marker;
    this.trace.selection.selectTrackEvent(LYNX_MEMORY_PLUGIN_ID, marker.id);
    return true;
  }

  private findMarker({
    x,
    y,
    timescale,
  }: TrackMouseEvent): MemoryVitalEvent | undefined {
    const data = this.getCachedData();
    if (data === undefined) return undefined;
    const visibleData = this.getVisibleEvents(data);

    const padding = SLICE_LAYOUT_FIT_CONTENT_DEFAULTS.padding;
    const sliceHeight = SLICE_LAYOUT_FIT_CONTENT_DEFAULTS.sliceHeight;

    for (const event of visibleData) {
      const sliceX = timescale.timeToPx(Time.fromRaw(BigInt(event.ts)));
      const width = event.widthPx ?? 20;
      const markerY = this.getMarkerY(event);
      const markerTop = markerY - this.getMarkerTipHeight(event);
      const markerBottom = markerY + sliceHeight;
      if (
        x >= sliceX &&
        x <= sliceX + width + padding * 2 &&
        y >= markerTop &&
        y <= markerBottom
      ) {
        return event;
      }
    }
    return undefined;
  }

  getTrackShellButtons(): m.Children {
    if (
      featureFlags
        .allFlags()
        .find((flag) => flag.id === 'defaultWorkspaceEditable')
        ?.get()
    ) {
      return null;
    }
    return m(Button, {
      onclick: () => {
        this.trace.currentWorkspace
          .getTrackByUri(LYNX_MEMORY_PLUGIN_ID)
          ?.remove();
      },
      icon: Icons.Close,
      title: 'Close',
      compact: true,
    });
  }

  detailsPanel?(_selection: TrackEventSelection): TrackEventDetailsPanel {
    return new MemoryVitalsDetailsPanel(this.trace);
  }
}
