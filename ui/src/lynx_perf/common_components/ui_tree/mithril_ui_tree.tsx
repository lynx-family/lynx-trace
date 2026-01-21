// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { UITreeView } from "./ui_tree_view";
import m from 'mithril';
import { UITreeAttr } from "../../../plugins/lynx.UITree/types";
import {createRoot} from 'react-dom/client';

export class UITreeMithrilView implements m.ClassComponent<UITreeAttr> {
  private reactRoot?: ReturnType<typeof createRoot>;
  oncreate(vnode: m.CVnodeDOM<UITreeAttr>) {
    this.reactRoot = createRoot(vnode.dom);
    this.reactRoot.render(<UITreeView
                selectedUI={vnode.attrs.selectedUI}
                rootUI={vnode.attrs.rootUI}
              />);
  }

  onupdate(vnode: m.CVnodeDOM<UITreeAttr>) {
    if (!this.reactRoot) {
      this.reactRoot = createRoot(vnode.dom);
    }
    this.reactRoot.render(<UITreeView
                selectedUI={vnode.attrs.selectedUI}
                rootUI={vnode.attrs.rootUI}
              />);
  }

  onremove() {
    if (this.reactRoot) {
      this.reactRoot.unmount();
      this.reactRoot = undefined;
    }
  }

  view() {
    return m('.page');
  }
}
