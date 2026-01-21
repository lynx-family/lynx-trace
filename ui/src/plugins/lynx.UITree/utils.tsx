// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import {LynxUI} from '../../lynx_perf/common_components/ui_tree/types';

const DESCENDANTS_THRESHOLD = 20;

function childrenOf(current: LynxUI): LynxUI[] {
  current.children ??= [];
  return current.children;
}

export function isTwoElementOverlap(first: LynxUI, second: LynxUI): boolean {
  if (first === second) return true;
  // if 'first' and 'second' do not overlap, then 'first' may be left, top, right, bottom of 'second'

  return !(
    first.frame[0] + first.frame[2] < second.frame[0] ||
    first.frame[1] + first.frame[3] < second.frame[1] ||
    first.frame[0] > second.frame[0] + second.frame[2] ||
    first.frame[1] > second.frame[1] + second.frame[3]
  );
}

export function zeroSizeElement(current: LynxUI): boolean {
  return (
    Math.abs(current.frame[2]) <= 1e-5 && Math.abs(current.frame[3]) <= 1e-5
  );
}

/**
 * Recursively update the left and top of a LynxUI according to its parent element.
 *
 * @param current current UI element
 * @param parent parent UI element
 */
export function reConstructUITree(current: LynxUI, parent?: LynxUI) {
  if (parent) {
    current.frame[0] += parent.frame[0];
    current.frame[1] += parent.frame[1];
    current.root = parent.root;
  } else {
    current.root = current;
  }
  current.descendantCount = 1;
  const children = childrenOf(current);
  if (children.length > 0) {
    for (const child of children) {
      reConstructUITree(child, current);
      current.descendantCount += child.descendantCount;
    }
  }
}

export function findInvisibleNodesRecursively(
  root: LynxUI,
  current: LynxUI,
): LynxUI[] {
  const nodesList: LynxUI[] = [];
  if (
    (!isTwoElementOverlap(root, current) || zeroSizeElement(current)) &&
    current.descendantCount > DESCENDANTS_THRESHOLD
  ) {
    current.invisible = true;
    nodesList.push(current);
    return nodesList;
  }

  const children = childrenOf(current);
  for (let i = 0; i < children.length; i++) {
    const res = findInvisibleNodesRecursively(root, children[i]);
    nodesList.push(...res);
  }
  nodesList.sort((a, b) => b.descendantCount - a.descendantCount);
  return nodesList;
}
