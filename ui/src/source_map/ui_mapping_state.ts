// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import {createStore} from '../base/store';

export interface UiSourceMap {
  version: number;
  sources: string[];
  mappings: number[][];
  uiMaps: number[];
}

export interface UiMappingInfo {
  fileName: string;
  line: number;
  column: number;
}

interface State {
  uiMapping: Map<string, string>;
  uiSourceMapData: Map<string, UiSourceMap>;
}

const emptyState: State = {
  uiMapping: new Map(),
  uiSourceMapData: new Map(),
};

export const uiMappingState = createStore<State>(emptyState);

export function clearUiMappingState() {
  uiMappingState.edit((draft) => {
    Object.assign(draft, emptyState);
  });
}

export function getUiMappingInfo(
  instanceId: string,
  nodeIndex: number,
): UiMappingInfo | null {
  const uiSourceMap = uiMappingState.state.uiSourceMapData.get(instanceId);
  if (!uiSourceMap) {
    return null;
  }

  const index = uiSourceMap.uiMaps.indexOf(nodeIndex);
  if (index === -1) {
    return null;
  }

  const mapping = uiSourceMap.mappings[index];
  if (!mapping || mapping.length < 0) {
    return null;
  }

  const sourceIndex = mapping[0];
  const line = mapping[1];
  const column = mapping[2];

  if (sourceIndex < 0 || sourceIndex >= uiSourceMap.sources.length) {
    return null;
  }

  return {
    fileName: uiSourceMap.sources[sourceIndex],
    line,
    column,
  };
}