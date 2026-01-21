// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import {ReactNode} from 'react';
import {LynxUI} from '../../lynx_perf/common_components/ui_tree/types';

export interface UIDetailAttr {
  details: LynxUI[];
}

export interface UIDetailState {
  showDialog: boolean;
  selectedUI: LynxUI | undefined;
}

export interface UITreeAttr {
  selectedUI: LynxUI | undefined;
  rootUI: LynxUI | undefined;
}

export interface IssuseUI {
  title: string;
  description: ReactNode;
  dataSource: LynxUI[];
  columns: Array<{
    title: ReactNode;
    dataIndex: string;
    key: string;
    render?: (value: unknown, record: LynxUI) => ReactNode;
  }>;
}
