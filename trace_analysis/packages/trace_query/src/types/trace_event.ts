// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

/**
 * Interface for trace event
 */
export type TraceEvent = {
  id: number;
  ts: number;
  dur: number;
  track_id: number;
  name: string;
  depth?: number;
  arg_set_id?: number;
  thread_name?: string;
  thread_tid?: number;
  args?: { [key: string]: any } | string;
  description?: string;
  self_dur_ms?: string;
  metadata?: {
    filtered_children_count?: number;
  };
};

/**
 * Interface for readable trace event
 */
export type ReadableTraceEvent = {
  id: number;
  start_ts_ms: string;
  end_ts_ms: string;
  duration_ms: string;
  self_dur_ms?: string;
  track_id: number;
  name: string;
  args?: { [key: string]: any } | string;
  thread_name?: string;
  description?: string;
  depth?: number;
  metadata?: { [key: string]: any };
};

export type AggregateTraceEvent = {
  name: string;
  total_count: number;
  total_duration_ms: number;
  avg_duration_ms: number;
  max_duration_ms: number;
};
