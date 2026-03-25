// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { TraceEvent } from '../types/trace_event';

function isNotEmptyJson(jsonStr: string): boolean {
  try {
    const data = JSON.parse(jsonStr);
    if (
      !data ||
      (typeof data === 'object' && Object.keys(data).length === 0) ||
      (typeof data === 'object' && JSON.stringify(data) === JSON.stringify({ '': '' }))
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

const filterTraceEvents = [
  (s: string) => s.startsWith('LynxEngine::Invoke'),
  (s: string) => s.startsWith('LynxRuntime::Invoke'),
  (s: string) => s.startsWith('NativeFacade::Invoke'),
  (s: string) => s.startsWith('LayoutContext::Invoke'),
  (s: string) => s === 'QuickContext::GetAndCall',
  (s: string) => s === 'RunningInJS',
  (s: string) => s === 'GetStringEnv',
  (s: string) => s === 'GetBoolEnv',
  (s: string) => s === 'GetExternalEnv',
  (s: string) => s === 'LynxUpdateData',
];

function isFilterTraceEvents(eventName: string): boolean {
  for (const rule of filterTraceEvents) {
    if (rule(eventName)) {
      return true;
    }
  }
  return false;
}

export function parseTraceEvent(query: Record<string, any>[]): TraceEvent[] {
  let traceEvents: TraceEvent[] = [];

  for (const row of query) {
    const event: TraceEvent = {
      id: row['id'],
      name: row['name'],
      ts: row['ts'],
      dur: row['dur'] || 0,
      track_id: row['track_id'],
      depth: row['depth'] || 0,
      thread_name: row['thread_name'],
    };

    const args = row['args'];
    if (args) {
      if (typeof args === 'string' && isNotEmptyJson(args)) {
        try {
          // Try to parse JSON string to object for better type consistency
          const parsedArgs = JSON.parse(args.replace('debug.', ''));
          event.args = parsedArgs;
        } catch {
          // If parsing fails, keep as string
          event.args = args.replace('debug.', '');
        }
      } else if (typeof args === 'object') {
        event.args = args;
      }
    }

    // const desc = getTraceEventDesc(event.name);
    // if (desc) {
    //   event.description = desc;
    // }

    traceEvents.push(event);
  }

  // Group events by track_id and depth for faster lookup
  // const eventsByTrackAndDepth: Record<string, TraceEvent[]> = {};
  // for (const event of traceEvents) {
  //   const key = `${event.track_id}:${event.depth}`;
  //   if (!eventsByTrackAndDepth[key]) {
  //     eventsByTrackAndDepth[key] = [];
  //   }
  //   eventsByTrackAndDepth[key].push(event);
  // }

  // for (const event of traceEvents) {
  //   const childDepth = (event.depth || 0) + 1;
  //   const childKey = `${event.track_id}:${childDepth}`;
  //   const potentialChildren = eventsByTrackAndDepth[childKey] || [];

  //   const directChildren = potentialChildren.filter(
  //     (child) => child.ts >= event.ts && child.ts + child.dur <= event.ts + event.dur,
  //   );

  //   const sumChildDur = directChildren.reduce((sum, child) => sum + child.dur, 0);

  //   event.self_dur_ms = Math.round((event.dur - sumChildDur) / 1000000) + 'ms';
  // }

  traceEvents = traceEvents.filter((event) => !isFilterTraceEvents(event.name));
  return traceEvents;
}
