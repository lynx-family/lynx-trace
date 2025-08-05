// Copyright (C) 2025 The Android Open Source Project
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

// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import m from 'mithril';
import {Editor} from '../widgets/editor';
import {sourceMapState} from './source_map_state';
import {raf} from '../core/raf_scheduler';
import {eventLoggerState} from '../event_logger';

function getFullScreenWidth() {
  const page = document.querySelector('.page') as HTMLElement;
  if (page === null) {
    return 800;
  } else {
    return page.clientWidth;
  }
}

export interface DragHandleAttrs {
  // The current height of the panel.
  width: number;
  // Called when the panel is dragged.
  resize: (width: number) => void;
  onClose?: () => void;
}

class SourceFileDrawerHandler implements m.ClassComponent<DragHandleAttrs> {
  private dragStartX = 0;
  private width = 0;
  private resize: (height: number) => void = () => {};
  private dragStartWidth = 0;

  view() {
    return m('.source-file-handle', {
      oncontextmenu: (e: Event) => e.preventDefault(),
      onpointerdown: (e: PointerEvent) => {
        const target = e.currentTarget as HTMLElement;
        target.setPointerCapture(e.pointerId);
        this.dragStartX = e.clientX;
        this.dragStartWidth = this.width;
        e.stopPropagation();
      },
      onpointermove: (e: PointerEvent) => {
        const target = e.currentTarget as HTMLElement;
        if (!target.hasPointerCapture(e.pointerId)) {
          return;
        }
        this.resize(this.dragStartWidth + this.dragStartX - e.clientX);
      },
      onpointerup: (e: PointerEvent) => this.endDrag(e),
      onpointercancel: (e: PointerEvent) => this.endDrag(e),
      onpointercapturelost: (e: PointerEvent) => this.endDrag(e),
    });
  }

  oncreate({attrs}: m.CVnodeDOM<DragHandleAttrs>) {
    this.resize = attrs.resize;
    this.width = attrs.width;
  }

  onupdate({attrs}: m.VnodeDOM<DragHandleAttrs>) {
    this.width = attrs.width;
  }

  private endDrag(e: PointerEvent) {
    const target = e.currentTarget as HTMLElement;
    if (target.hasPointerCapture(e.pointerId)) {
      target.releasePointerCapture(e.pointerId);
    }
  }
}

export class SourceFileDrawer implements m.ClassComponent<{}> {
  private fillScreenWidth = getFullScreenWidth();
  private readonly defaultWidth = this.fillScreenWidth * 0.5;
  private currentWidth = this.defaultWidth;

  private onClose() {
    sourceMapState.edit((draft) => {
      draft.currentSourceFile = undefined;
      draft.sourceFileDrawerVisible = false;
    });
    raf.scheduleFullRedraw();
  }

  public view() {
    let isOpen = false;
    let content: string | undefined;
    let line = -1;
    let column = -1;
    if (sourceMapState.state.currentSourceFile) {
      eventLoggerState.state.eventLogger.logEvent('lynx_feature_usage', {
        type: 'SourceFile',
      });
      const sourceFiles = sourceMapState.state.currentSourceFile.split(':');
      if (sourceFiles.length >= 3) {
        const file = sourceFiles.slice(0, sourceFiles.length - 2).join(':');
        content = sourceMapState.state.sourceFile[file]?.content;
        line = parseInt(sourceFiles[sourceFiles.length - 2] ?? '-1');
        column = parseInt(sourceFiles[sourceFiles.length - 1] ?? '-1');
        if (column !== -1 && line !== -1 && content !== undefined) {
          isOpen = true;
        }
      }
    }
    if (!isOpen) {
      return null;
    }
    sourceMapState.edit((draft) => {
      draft.sourceFileDrawerVisible = true;
    });
    return m(
      '.source-file-drawer',
      {
        style: {width: `${this.currentWidth}px`},
        onkeydown: (e: KeyboardEvent) => {
          if (e.key === 'Escape') {
            this.onClose();
          }
        },
      },
      m(SourceFileDrawerHandler, {
        width: this.currentWidth,
        resize: (width: number) => {
          if (width > this.fillScreenWidth) {
            width = this.fillScreenWidth;
          }
          if (width < 100) {
            this.currentWidth = this.defaultWidth;
            this.onClose();
          } else {
            this.currentWidth = width;
          }
          raf.scheduleFullRedraw();
        },
      }),
      m(Editor, {
        text: content,
        line,
        language: 'javascript',
        readonly: true,
        fillHeight: true,
      }),
    );
  }
}
