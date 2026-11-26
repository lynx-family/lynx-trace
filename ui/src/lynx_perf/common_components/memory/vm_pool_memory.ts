// Copyright (C) 2026 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {Args, ArgsDict} from '../../../components/sql_utils/args';

export interface VmPoolMemoryValue {
  instanceCount: number;
  sizeBytes: number;
  rssSizeBytes: number;
}

export function calculateVmPoolMemoryFromArgs(
  args: ArgsDict,
): VmPoolMemoryValue {
  const memory: VmPoolMemoryValue = {
    instanceCount: 0,
    sizeBytes: 0,
    rssSizeBytes: 0,
  };

  const visit = (value: Args, path: string) => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [key, child] of Object.entries(value)) {
        visit(child, path === '' ? key : `${path}.${key}`);
      }
      return;
    }
    if (!/^(?:debug\.)?id_[^.]+$/.test(path) || typeof value !== 'string') {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return;
    }

    const record = parsed as Record<string, unknown>;
    memory.instanceCount++;
    memory.sizeBytes += Number(record.acc_usage) || 0;
    memory.rssSizeBytes +=
      (Number(record.base_usage) || 0) + (Number(record.page_rss_usage) || 0);
  };

  visit(args, '');
  return memory;
}
