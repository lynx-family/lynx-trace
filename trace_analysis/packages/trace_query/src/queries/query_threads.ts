// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { TraceQuery } from '../utils/trace_query';

export interface ThreadInfo {
  track_id: number;
  tid: number;
  name: string;
  isMainThread: boolean;
}

export async function queryThreads(traceQuery: TraceQuery, lynxThreadOnly: boolean = true): Promise<ThreadInfo[]> {
  const sql = `SELECT
    tt.id,
    t.tid,
    t.name,
    CASE
      WHEN EXISTS (
          SELECT 1
          FROM process p
          WHERE p.pid = t.tid
            AND p.pid <> 0
      ) THEN 1
      ELSE 0
    END AS isMainThread
    FROM thread t
    INNER JOIN thread_track tt ON t.utid = tt.utid
    WHERE t.utid <> 0
    ORDER BY t.tid;
  `;

  let result = await traceQuery.query(sql);
  if (result.length === 0 || result[0] === undefined) {
    return [];
  }

  const mainThread = result.find((row: any) => row.isMainThread === 1);
  // If no main thread is found, set the first thread as the main thread.
  if (!mainThread) {
    result[0]['isMainThread'] = 1;
  }
  if (lynxThreadOnly) {
    result = result.filter(
      (row: any) => row.name && (row.name.startsWith('lynx') || row.name.startsWith('Lynx') || row.isMainThread === 1),
    );
  }
  return result.map((row: any) => ({
    track_id: row.id,
    tid: row.tid,
    name: row.name || `Thread ${row.tid}`,
    isMainThread: row.isMainThread === 1,
  }));
}
