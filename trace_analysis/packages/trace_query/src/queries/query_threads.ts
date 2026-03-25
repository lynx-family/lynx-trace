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
  const sql = `
    SELECT tt.id, t.tid, t.name
    FROM thread t
    LEFT JOIN thread_track tt ON t.utid = tt.utid
    WHERE t.utid != 0 and tt.id is not NULL
    ORDER BY t.tid
  `;

  let result = await traceQuery.query(sql);
  if (result.length === 0 || result[0] == undefined) {
    return [];  
  }
  const mainThread = result[0];
  if (lynxThreadOnly) {
    result = result.filter((row: any) => row.name && (row.name.startsWith('lynx') || row.name.startsWith('Lynx')));
  }
  result.push(mainThread);
  return result.map((row: any) => ({
    track_id: row.id,
    tid: row.tid,
    name: row.name || `Thread ${row.tid}`,
    isMainThread: row.id === mainThread['id'],
   }));
}
