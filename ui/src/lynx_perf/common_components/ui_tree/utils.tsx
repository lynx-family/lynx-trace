// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import {LynxUI} from './types';

export function constructUIDetail(current: LynxUI): string {
  return `${current.tagName || current.name} frame:[${current.frame.join(',')}]`;
}

/**
 * Recursively update the left and top of a LynxUI according to its parent element.
 * 
 * @param current current UI element
 * @param parent parent UI element
 */
export function reConstructUITree(
  current: LynxUI,
  parent?: LynxUI,
) {
  if (parent) {
    current.frame[0] += parent.frame[0];
    current.frame[1] += parent.frame[1];
    current.root = parent.root;
  } else {
    current.root = current;
  }
  current.descendantCount = 1;
  if (current && current.children.length > 0) {
    for (const child of current.children) {
      reConstructUITree(child, current);
      current.descendantCount += child.descendantCount;
    }
  }
}