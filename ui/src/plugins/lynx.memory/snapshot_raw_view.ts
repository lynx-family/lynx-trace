// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import m from 'mithril';
import {SnapshotJsonPath, SnapshotJsonValue} from './snapshot_raw';
import {SnapshotViewerState} from './snapshot_viewer_state';

interface RawBranch {
  path: SnapshotJsonPath;
  key?: string | number;
  value: SnapshotJsonValue;
  children?: RawBranch[];
  fullText?: string;
  expanded?: boolean;
  loading?: boolean;
  error?: string;
}

interface RawAttrs {
  state: SnapshotViewerState;
}

export class SnapshotRawView implements m.ClassComponent<RawAttrs> {
  private root?: RawBranch;
  private error?: string;
  private active = true;

  oninit({attrs: {state}}: m.Vnode<RawAttrs>) {
    void state.raw().then(
      (page) => {
        if (!this.active) return;
        this.root = {
          path: [],
          value: page.value,
          expanded: true,
          children: page.entries.map(({key, value}) => ({
            path: [key],
            key,
            value,
          })),
        };
        state.redraw();
      },
      (error) => {
        if (!this.active) return;
        this.error = String(error instanceof Error ? error.message : error);
        state.redraw();
      },
    );
  }

  onremove() {
    this.active = false;
  }

  private async load(state: SnapshotViewerState, branch: RawBranch) {
    if (branch.loading) return;
    branch.loading = true;
    branch.error = undefined;
    try {
      const page = await state.raw(branch.path, branch.children?.length ?? 0);
      if (!this.active) return;
      if (page.value.type === 'value') {
        branch.fullText = page.value.text;
      } else {
        const children = page.entries.map(({key, value}) => ({
          path: [...branch.path, key],
          key,
          value,
        }));
        branch.children = [...(branch.children ?? []), ...children];
      }
    } catch (error) {
      if (this.active) {
        branch.error = String(error instanceof Error ? error.message : error);
      }
    } finally {
      branch.loading = false;
      if (this.active) state.redraw();
    }
  }

  private renderBranch(
    state: SnapshotViewerState,
    branch: RawBranch,
    depth = 0,
    comma = '',
  ): m.Children {
    const {value} = branch;
    const container = value.type !== 'value';
    const expandable = container ? value.size > 0 : value.truncated;
    const open = container ? (value.type === 'array' ? '[' : '{') : '';
    const close = container ? (value.type === 'array' ? ']' : '}') : '';
    const label =
      branch.key === undefined
        ? 'root'
        : typeof branch.key === 'number'
          ? `[${branch.key}]`
          : branch.key;
    const indent = {paddingLeft: `${depth * 16}px`};
    return [
      m('.pf-snapshot-viewer__raw-line', {style: indent}, [
        expandable
          ? m(
              'button.pf-snapshot-viewer__raw-toggle',
              {
                'aria-label': `${branch.expanded ? 'Collapse' : 'Expand'} ${label}`,
                'aria-expanded': String(!!branch.expanded),
                'onclick': () => {
                  branch.expanded = !branch.expanded;
                  if (
                    branch.expanded &&
                    branch.children === undefined &&
                    branch.fullText === undefined
                  ) {
                    void this.load(state, branch);
                  }
                },
              },
              branch.expanded ? '−' : '+',
            )
          : m('span.pf-snapshot-viewer__raw-toggle'),
        m('span.pf-snapshot-viewer__raw-content', [
          typeof branch.key === 'string'
            ? m(
                'span.pf-snapshot-viewer__raw-key',
                `${JSON.stringify(branch.key)}: `,
              )
            : null,
          container
            ? [
                open,
                branch.expanded && expandable
                  ? ''
                  : `${value.size ? ' … ' : ''}${close}${comma}`,
                value.size > 0
                  ? m(
                      'span.pf-snapshot-viewer__raw-count',
                      ` ${value.size.toLocaleString()} ${value.type === 'array' ? 'items' : 'properties'}`,
                    )
                  : null,
              ]
            : [
                m(
                  'span.pf-snapshot-viewer__raw-value',
                  branch.expanded && branch.fullText !== undefined
                    ? branch.fullText
                    : value.text,
                ),
                value.truncated &&
                (!branch.expanded || branch.fullText === undefined)
                  ? m(
                      'span.pf-snapshot-viewer__raw-count',
                      ' … (expand to view full string)',
                    )
                  : null,
                comma,
              ],
        ]),
      ]),
      branch.expanded
        ? [
            branch.children?.map((child, index) =>
              this.renderBranch(
                state,
                child,
                depth + 1,
                container && index + 1 < value.size ? ',' : '',
              ),
            ),
            branch.loading
              ? m(
                  '.pf-snapshot-viewer__raw-status',
                  {style: indent},
                  'Loading…',
                )
              : branch.error
                ? m(
                    '.pf-snapshot-viewer__raw-status.pf-snapshot-viewer__error',
                    {style: indent},
                    [
                      branch.error,
                      m(
                        'button',
                        {onclick: () => void this.load(state, branch)},
                        'Retry',
                      ),
                    ],
                  )
                : container && (branch.children?.length ?? 0) < value.size
                  ? m(
                      '.pf-snapshot-viewer__raw-status',
                      {style: indent},
                      m(
                        'button',
                        {onclick: () => void this.load(state, branch)},
                        `Show next 100 (${(branch.children?.length ?? 0).toLocaleString()}/${value.size.toLocaleString()})`,
                      ),
                    )
                  : null,
            container && expandable
              ? m('.pf-snapshot-viewer__raw-line', {style: indent}, [
                  m('span.pf-snapshot-viewer__raw-toggle'),
                  `${close}${comma}`,
                ])
              : null,
          ]
        : null,
    ];
  }

  view({attrs: {state}}: m.Vnode<RawAttrs>): m.Children {
    if (this.error) {
      return m(
        '.pf-snapshot-viewer__message.pf-snapshot-viewer__error',
        this.error,
      );
    }
    if (!this.root) {
      return m('.pf-snapshot-viewer__message', 'Loading raw JSON…');
    }
    return m(
      '.pf-snapshot-viewer__raw',
      {'aria-label': 'Snapshot raw JSON', 'tabindex': 0},
      this.renderBranch(state, this.root),
    );
  }
}
