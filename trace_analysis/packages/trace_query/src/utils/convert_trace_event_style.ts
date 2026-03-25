// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { ReadableTraceEvent, TraceEvent } from '../types/trace_event';

import { NS_TO_MS } from './constant';

export interface TreeStyleTraceEvent extends ReadableTraceEvent {
  children?: TreeStyleTraceEvent[];
  ts?: number;
  dur?: number;
}

export function getTreeStyleTraceEvents(traces: TraceEvent[]): TreeStyleTraceEvent[] {
  /**
   * Convert a list of trace events into a tree structure.
   *
   * @param traces - A list of trace events, where each trace event is an object
   *                 containing at least 'ts' (timestamp), 'dur' (duration), 'name' (event name),
   *                 and optionally 'children' (a list of child trace events).
   *
   * @returns A tree structure of trace events, where each event is an object with the same keys
   *          as the input events, but with an additional 'children' key containing a list of child events.
   */
  // Add 'end_time' field and 'children' for each trace
  const processedTraces: TreeStyleTraceEvent[] = [];
  for (const trace of traces) {
    const traceItem: TreeStyleTraceEvent = {
      id: trace.id,
      start_ts_ms: trace.ts / NS_TO_MS + 'ms',
      end_ts_ms: (trace.ts + trace.dur) / NS_TO_MS + 'ms',
      duration_ms: (trace.dur / NS_TO_MS).toFixed(1) + 'ms',
      self_dur_ms: trace.self_dur_ms,
      ts: trace.ts,
      dur: trace.dur,
      track_id: trace.track_id,
      name: trace.name,
      thread_name: trace.thread_name || '',
      children: [],
      args: trace.args || {},
      description: trace.description || '',
    };
    const args = trace.args;
    const description = trace.description;
    if (args) {
      traceItem.args = args;
    }
    if (description) {
      traceItem.description = description;
    }

    processedTraces.push(traceItem);
  }
  processedTraces.sort((a, b) => a.ts! - b.ts!);

  // Build tree structure
  function buildTree(tracesList: TreeStyleTraceEvent[]): TreeStyleTraceEvent[] {
    if (!tracesList.length) {
      return [];
    }

    const result: TreeStyleTraceEvent[] = [];
    const usedIndices = new Set<number>();

    for (let i = 0; i < tracesList.length; i++) {
      const parent = tracesList[i]!;
      if (usedIndices.has(i)) {
        continue;
      }

      // Find all possible child nodes
      const children: [number, TreeStyleTraceEvent][] = [];
      for (let j = 0; j < tracesList.length; j++) {
        const child = tracesList[j]!;
        if (j <= i || usedIndices.has(j)) {
          continue;
        }
        const childTs = child.ts!;
        const childDur = child.dur!;
        const parentTs = parent.ts!;
        const parentDur = parent.dur!;
        // Check if child is completely contained within parent's time range
        if (childTs > parentTs && childTs + childDur < parentTs + parentDur && child.track_id === parent.track_id) {
          children.push([j, child]);
        }
      }

      // If there are child nodes, need to further process nested relationships
      if (children.length > 0) {
        // Sort child nodes by start time
        children.sort((a, b) => a[1].ts! - b[1].ts!);

        // Recursively build child tree, ensuring correct nested levels
        const childTraces = children.map((child) => child[1]);
        const childIndices = children.map((child) => child[0]);

        // Mark these child nodes as used
        childIndices.forEach((index) => usedIndices.add(index));

        // Recursively build child tree, ensuring correct nested levels
        parent.children = buildTree(childTraces);
      }

      result.push(parent);
    }

    return result;
  }

  // Build tree structure
  const treeResult = buildTree(processedTraces);

  function cleanTempFields(node: TreeStyleTraceEvent): void {
    if ('thread_name' in node && !node.thread_name) {
      delete node.thread_name;
    }
    if ('description' in node && !node.description) {
      delete node.description;
    }
    if ('args' in node && node.args && Object.keys(node.args).length <= 0) {
      delete node.args;
    }

    if ('self_dur_ms' in node && node.self_dur_ms === undefined) {
      delete node.self_dur_ms;
    }

    if ('ts' in node) {
      delete node.ts;
    }
    if ('dur' in node) {
      delete node.dur;
    }
    if ('children' in node && node.children && node.children.length <= 0) {
      delete node.children;
    }

    for (const child of node.children || []) {
      cleanTempFields(child);
    }
  }

  for (const node of treeResult) {
    cleanTempFields(node);
  }

  return treeResult;
}
