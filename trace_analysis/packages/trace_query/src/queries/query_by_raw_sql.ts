// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { TraceQuery } from '../utils/trace_query';

export async function queryByRawSql(traceQuery: TraceQuery, sql: string): Promise<Record<string, any>[]> {
  const queryResult = await traceQuery.query(sql);
  return queryResult;
}
