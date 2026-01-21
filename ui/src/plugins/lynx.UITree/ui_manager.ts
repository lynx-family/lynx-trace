// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import {LynxUI} from '../../lynx_perf/common_components/ui_tree/types';

class UIManager {
  private issueUIMap: Map<number, LynxUI[]> = new Map(); // traceId -> LynxUI[]

  setTraceIssueUI(traceId: number, issueUI: LynxUI[]) {
    this.issueUIMap.set(traceId, issueUI);
  }

  getTraceIssueUI(traceId: number): LynxUI[] | undefined {
    return this.issueUIMap.get(traceId);
  }
}

export default new UIManager();
