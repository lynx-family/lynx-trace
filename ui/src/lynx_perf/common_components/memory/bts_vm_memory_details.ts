// Copyright (C) 2026 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import {Args, ArgsDict} from '../../../components/sql_utils/args';

export interface BtsVmMemorySample {
  accumulateBytes: number;
  rssBytes: number;
  annotations?: Args;
}

export function buildBtsVmMemorySample(
  counterValue: number,
  baseUsageBytes: number,
  pageRssUsageBytes: number,
  args?: ArgsDict,
  annotations?: Args,
): BtsVmMemorySample {
  return {
    accumulateBytes: finiteOrZero(counterValue),
    rssBytes: finiteOrZero(baseUsageBytes) + finiteOrZero(pageRssUsageBytes),
    annotations:
      annotations ??
      args?.['debug.annotations'] ??
      getArgValue(args, 'debug.annotations') ??
      args?.annotations ??
      getArgValue(args, 'annotations'),
  };
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function getArgValue(
  args: ArgsDict | undefined,
  path: string,
): Args | undefined {
  let value: Args | undefined = args;
  for (const key of path.split('.')) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }
    value = value[key];
  }
  return value;
}
