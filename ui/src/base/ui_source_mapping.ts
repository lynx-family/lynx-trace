// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

export interface UiMappingInfo {
  fileName: string;
  line: number;
  column: number;
}

export type UiMappingInfoResolver = (
  instanceId: string,
  nodeIndex: number,
) => UiMappingInfo | null;

let resolver: UiMappingInfoResolver | undefined;

export function registerUiMappingInfoResolver(
  uiMappingInfoResolver: UiMappingInfoResolver,
): void {
  resolver = uiMappingInfoResolver;
}

export function getUiMappingInfo(
  instanceId: string,
  nodeIndex: number,
): UiMappingInfo | null {
  return resolver?.(instanceId, nodeIndex) ?? null;
}
