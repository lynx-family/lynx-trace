// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { TraceQuery } from '../utils/trace_query';

interface LynxViewInstance {
  instance_id: string;
  bundleUrl: string;
}

export async function queryLynxView(traceQuery: TraceQuery): Promise<LynxViewInstance[]> {
  const result: LynxViewInstance[] = [];
  const instanceInfoMap = await getInstanceInfoMap(traceQuery);
  for (const [key, value] of Object.entries(instanceInfoMap)) {
    result.push({
      bundleUrl: getBundleFromUrl(value),
      instance_id: key,
    });
  }
  return result;
}

async function getInstanceInfoMap(tp: TraceQuery): Promise<Record<string, string>> {
  const instanceInfoMap: Record<string, string> = {};
  const instanceInfoSql = `
      SELECT
      args.key as key,
      args.display_value as value
      FROM slice
      JOIN args ON slice.arg_set_id=args.arg_set_id
      WHERE slice.name='LynxLoadTemplate'
      ORDER BY slice.dur, slice.ts
  `;

  const instanceInfoResult = await tp.query(instanceInfoSql);
  let url = '';
  let instanceId = '';

  for (const instanceInfo of instanceInfoResult) {
    if (instanceInfo.key === 'debug.url') {
      url = instanceInfo.value as string;
    } else if (instanceInfo.key === 'debug.instance_id') {
      instanceId = instanceInfo.value as string;
    }

    if (url && instanceId) {
      instanceInfoMap[instanceId] = url;
      url = '';
      instanceId = '';
    }
  }

  return instanceInfoMap;
}

function getBundleFromUrl(url: string): string {
  const pattern1 = /\/([^/]+\/[^/]+)\/template\.js/;
  const match1 = url.match(pattern1);

  if (match1) {
    return match1[1];
  }
  const pattern2 = /bundle=([^&]+)/;
  const match2 = url.match(pattern2);
  if (match2) {
    return match2[1];
  }
  return url;
}
