// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

export interface LynxUI {
  tagName: string;
  name: string;
  frame: number[];
  children: LynxUI[];

  descendantCount: number;
  invisible: boolean;
  id: string;
  root: LynxUI;
}

export interface UITreeViewState {
  treeHeight: number;
  treeWidth: number;
  expandedKeys: string[];
  autoExpandParent: boolean;
  selectedKeys: string[];
  selectedUI: LynxUI | undefined;
}

export interface UITreeViewProps {
  selectedUI: LynxUI | undefined;
  rootUI: LynxUI | undefined;
}
