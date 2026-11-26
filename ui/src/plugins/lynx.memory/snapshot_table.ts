// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import m from 'mithril';
import {ResizeHandle} from '../../widgets/resize_handle';
import {SnapshotViewerState} from './snapshot_viewer_state';

export interface SnapshotTableColumn {
  key: string;
  share: number;
  header: m.Children;
}

interface SnapshotTableAttrs {
  state: SnapshotViewerState;
  mode: SnapshotViewerState['mode'];
  columns: SnapshotTableColumn[];
  minWidth: number;
  filter?: string;
}

/** Resizes columns in pixels while keeping the table at least as wide as its viewport. */
export class SnapshotTable implements m.ClassComponent<SnapshotTableAttrs> {
  private table?: HTMLTableElement;

  oncreate(vnode: m.VnodeDOM<SnapshotTableAttrs>) {
    this.table = vnode.dom as HTMLTableElement;
  }

  private widthKey(attrs: SnapshotTableAttrs, column: SnapshotTableColumn) {
    return `${attrs.mode}:${column.key}`;
  }

  view({attrs, children}: m.Vnode<SnapshotTableAttrs>): m.Children {
    const {state, columns} = attrs;
    const resized = columns.some((column) =>
      state.columnWidths.has(this.widthKey(attrs, column)),
    );
    const available = Math.max(
      attrs.minWidth,
      this.table?.parentElement?.clientWidth ?? attrs.minWidth,
    );
    const widths = columns.map(
      (column) =>
        state.columnWidths.get(this.widthKey(attrs, column)) ??
        available * column.share,
    );
    const total = widths.reduce((sum, width) => sum + width, 0);
    return m(
      'table',
      {
        'className':
          attrs.mode === 'comparison'
            ? 'pf-snapshot-viewer__comparison-table'
            : undefined,
        'data-comparison-filter': attrs.filter,
        'style': {
          width: '100%',
          minWidth: `${resized ? total : attrs.minWidth}px`,
        },
      },
      [
        m(
          'colgroup',
          columns.map((column, index) =>
            m('col', {
              style: {
                width: resized
                  ? `${widths[index]}px`
                  : `${column.share * 100}%`,
              },
            }),
          ),
        ),
        m(
          'thead',
          m(
            'tr',
            columns.map((column) =>
              m('th', [
                column.header,
                m(ResizeHandle, {
                  'class':
                    'pf-resize-handle--horizontal pf-snapshot-viewer__column-resizer',
                  'direction': 'horizontal',
                  'title': 'Drag to resize column',
                  'data-column-key': column.key,
                  'onResizeStart': () => {
                    const headers = this.table?.querySelectorAll('th');
                    columns.forEach((item, index) => {
                      const width =
                        headers?.[index].getBoundingClientRect().width;
                      if (width !== undefined) {
                        state.columnWidths.set(
                          this.widthKey(attrs, item),
                          width,
                        );
                      }
                    });
                  },
                  'onResize': (delta: number) => {
                    const key = this.widthKey(attrs, column);
                    const width = state.columnWidths.get(key);
                    if (width !== undefined) {
                      state.columnWidths.set(
                        key,
                        Math.max(
                          column.key === 'name' ? 120 : 60,
                          width + delta,
                        ),
                      );
                      state.redraw();
                    }
                  },
                }),
              ]),
            ),
          ),
        ),
        children,
      ],
    );
  }
}
