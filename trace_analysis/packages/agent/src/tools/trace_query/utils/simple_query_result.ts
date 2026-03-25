// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { TraceEvent } from '@lynx-js/trace-query';

import { NS_TO_MS } from '../../../utils/constant';

const context_window_size_threshold = 4 * 1024;

function isVitalTraceEvent(eventName: string): boolean {
  const vitalTraceEvents = [
    (s: string) => s === 'evaluateJavaScriptBytecode',
    (s: string) => s === 'evaluateJavaScript',
    (s: string) => s.startsWith('LynxImageManager.tryFetchImageFromFresco'),
    (s: string) => s === 'Interceptor.shouldRedirectImageUrl',
  ];

  for (const rule of vitalTraceEvents) {
    if (rule(eventName)) {
      return true;
    }
  }
  return false;
}

function hasFlowId(event: TraceEvent): boolean {
  return (
    'args' in event &&
    !!event.args &&
    typeof event.args === 'object' &&
    ('flow_id' in event.args || 'terminateFlowId' in event.args)
  );
}

export async function simplifyQueryResult(
  traceEvent: TraceEvent[],
  start_ts_ms: number | null = null,
  end_ts_ms: number | null = null,
): Promise<TraceEvent[]> {
  if (start_ts_ms === null || end_ts_ms === null) {
    return traceEvent;
  }
  let jsonResult = JSON.stringify(traceEvent);
  const duration = end_ts_ms - start_ts_ms;
  let callStackDurationThreshold = duration * 0.01;
  let traceEventDurationThreshold = duration * 0.001;

  // Create a map of original events by ID for quick lookup
  const originalEventsMap = new Map<number, TraceEvent>();
  traceEvent.forEach((event) => {
    originalEventsMap.set(event.id, event);
  });

  // Create a map to track filtered events
  const filteredEventIds = new Set<number>();

  let prevTraceEventLen = traceEvent.length;
  while (jsonResult.length > context_window_size_threshold) {
    // Filter events based on duration and importance
    const filteredEvents = traceEvent.filter((event) => {
      const eventDuration = event.dur / NS_TO_MS;
      const isImportant = isVitalTraceEvent(event.name) || hasFlowId(event);
      const isShortCallStack = (event.depth === 0 || event.depth === 1) && eventDuration <= callStackDurationThreshold;
      const isShortEvent = eventDuration <= traceEventDurationThreshold;
      if (isShortCallStack || isShortEvent) {
        if (!isImportant) {
          filteredEventIds.add(event.id);
          return false;
        }
      }
      return true;
    });

    // Update traceEvent and jsonResult
    traceEvent = filteredEvents;
    jsonResult = JSON.stringify(traceEvent);

    if (jsonResult.length <= context_window_size_threshold) {
      break;
    }

    if (prevTraceEventLen === traceEvent.length) {
      // No more events can be removed
      console.debug('simplify trace tool can not remove any more trace events');
      throw new Error(
        'current query range is too large, simplify trace tool can not remove any more trace events, please narrow the query range',
      );
    }

    prevTraceEventLen = traceEvent.length;
    callStackDurationThreshold *= 2;
    traceEventDurationThreshold *= 2;
  }
  // Now, for each remaining event, check if it had any direct children that were filtered
  if (filteredEventIds.size > 0) {
    // Create a map of remaining events by ID
    const remainingEventsMap = new Map<number, TraceEvent>();
    traceEvent.forEach((event) => {
      remainingEventsMap.set(event.id, event);
      // Initialize metadata if not exists
      if (!event.metadata) {
        event.metadata = {};
      }
      event.metadata.filtered_children_count = 0;
    });

    // For each filtered event, find its parent in the original set
    filteredEventIds.forEach((filteredEventId) => {
      const filteredEvent = originalEventsMap.get(filteredEventId);
      if (filteredEvent?.depth !== undefined && filteredEvent.depth > 0) {
        // Find parent event: same track, depth = filteredEvent.depth - 1, time range contains filtered event
        const parentEvent = Array.from(originalEventsMap.values()).find(
          (event) =>
            event.track_id === filteredEvent.track_id &&
            event.depth === filteredEvent.depth! - 1 &&
            event.ts <= filteredEvent.ts &&
            event.ts + (event.dur || 0) >= filteredEvent.ts + (filteredEvent.dur || 0),
        );

        // If parent exists and is still in remaining events, update its metadata
        if (parentEvent && remainingEventsMap.has(parentEvent.id)) {
          const remainingParent = remainingEventsMap.get(parentEvent.id)!;
          if (!remainingParent.metadata) {
            remainingParent.metadata = {};
          }
          remainingParent.metadata.filtered_children_count =
            (remainingParent.metadata.filtered_children_count || 0) + 1;
        }
      }
    });
  }
  return traceEvent;
}
