// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { NS_TO_MS } from '../utils/constant';
import { TraceQuery } from '../utils/trace_query';

export async function queryTraceMetadata(traceQuery: TraceQuery): Promise<Record<string, string>> {
  const infoSQL = ` SELECT
  MAX(CASE WHEN name = 'system_name' THEN str_value END) AS system_name,
  MAX(CASE WHEN name = 'system_machine' THEN str_value END) AS system_machine,
  MAX(CASE WHEN name = 'android_device_manufacturer' THEN str_value END) AS android_device_manufacturer,
  MAX(CASE WHEN name = 'android_ram_model' THEN str_value END) AS android_ram_model,
  MAX(CASE WHEN name = 'tracing_started_ns' THEN int_value END) AS tracing_started_ns,
  MAX(CASE WHEN name = 'tracing_disabled_ns' THEN int_value END) AS tracing_disabled_ns
  FROM metadata;`;
  const baseInfo: Record<string, string> = {};
  const infoIter = await traceQuery.query(infoSQL);
  if (infoIter.length < 1) {
    return {};
  } else {
    const info = infoIter[0];
    if (!info) {
      return {};
    }
    if (info['system_name'] === 'Linux') {
      baseInfo['os'] = 'Android';
      baseInfo['device_manufacturer'] = info['android_device_manufacturer'];
      baseInfo['ram_model'] = info['android_ram_model'];
    } else if (info['system_name'] === 'Darwin') {
      const system_machine = info['system_machine'] as string;
      baseInfo['os'] = system_machine.indexOf('iPhone') !== -1 ? 'iPhone' : 'Mac';
      baseInfo['system_machine'] = system_machine;
    } else if (info['system_name'] === 'HarmonyOS') {
      baseInfo['os'] = info['system_name'];
    } else {
      baseInfo['os'] = 'Windows';
    }
    baseInfo['tracing_started_ms'] = (info['tracing_started_ns'] / NS_TO_MS).toFixed(1);
    baseInfo['tracing_ended_ms'] = (info['tracing_disabled_ns'] / NS_TO_MS).toFixed(1);
  }
  const versionSQL =
    "SELECT a.display_value as value FROM slice s LEFT JOIN args a ON s.arg_set_id = a.arg_set_id WHERE (s.name = 'LynxEngineVersion' or s.name = 'Version') and (a.key = 'debug.version' or a.key = 'args.version')";
  const versionIter = await traceQuery.query(versionSQL);
  if (versionIter.length < 1 || versionIter[0] === undefined || versionIter[0]['value'] === undefined) {
    baseInfo['lynx_engine_version'] = 'Unknown';
  } else {
    baseInfo['lynx_engine_version'] = versionIter[0]['value'] ?? 'Unknown';
  }
  const profileSQL =
    "SELECT EXISTS (SELECT 1 FROM slice WHERE category IN ('jsprofile', 'jsprofile_decode')) AS has_jsprofile;";
  const profileIter = await traceQuery.query(profileSQL);
  if (profileIter.length < 1 || profileIter[0] === undefined || profileIter[0]['has_jsprofile'] === 0) {
    baseInfo['open_jsprofile'] = 'false';
  } else {
    baseInfo['open_jsprofile'] = 'true';
  }
  return baseInfo;
}
