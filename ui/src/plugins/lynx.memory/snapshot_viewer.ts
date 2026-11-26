// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import m from 'mithril';
import {classNames} from '../../base/classnames';
import {Trace} from '../../public/trace';
import {Button} from '../../widgets/button';
import {CopyToClipboardButton} from '../../widgets/copy_to_clipboard_button';
import {Icon} from '../../widgets/icon';
import {MenuItem, PopupMenu} from '../../widgets/menu';
import {Portal} from '../../widgets/portal';
import {ResizeHandle} from '../../widgets/resize_handle';
import {Tooltip} from '../../widgets/tooltip';
import {formatMemoryBytes} from '../../lynx_perf/common_components/memory/memory_format';
import {
  SnapshotClass,
  SnapshotObject,
  SnapshotObjectLocation,
  SnapshotObjectPage,
  SnapshotReference,
  SnapshotSummary,
} from './snapshot_graph';
import {
  SnapshotTreeNode,
  SnapshotViewerState,
  buildSnapshotTree,
  snapshotViewerState,
  sortedSnapshotProfiles,
} from './snapshot_viewer_state';
import {snapshotDirectoryDownloadsSupported} from './snapshot_download';
import {
  SnapshotClassDelta,
  SnapshotComparisonFilter,
  SnapshotObjectChange,
  SnapshotObjectChangePage,
  SnapshotObjectSource,
} from './snapshot_comparison';
import {SnapshotTable} from './snapshot_table';
import {SnapshotRawView} from './snapshot_raw_view';
import {isExternalSnapshot} from './snapshot_profile';
import {sourceFunctionName} from './snapshot_source';

function isString(object: SnapshotObject): boolean {
  return ['string', 'concatenated string', 'sliced string'].includes(
    object.type,
  );
}

function slotAnnotation(name: string): RegExpExecArray | null {
  return / \[(?:holder )?slot=(\d+)\]$/.exec(name);
}

function captureSlot(
  state: SnapshotViewerState,
  source: SnapshotObjectSource = 'current',
): number | undefined {
  const profile = source === 'baseline' ? state.baseline : state.selected;
  return profile !== undefined && !isExternalSnapshot(profile)
    ? profile.captureSlot
    : undefined;
}

function isOtherSlot(name: string, slot: number | undefined): boolean {
  if (slot === undefined) return false;
  const annotation = slotAnnotation(name);
  return annotation !== null && Number(annotation[1]) !== slot;
}

function nodeNameLabel(name: string, string = false): m.Children {
  const annotation = slotAnnotation(name);
  return m(
    'span.pf-snapshot-viewer__object-name',
    {className: string ? 'pf-snapshot-viewer__string' : undefined},
    annotation
      ? [
          name.slice(0, annotation.index),
          m('span.pf-snapshot-viewer__node-slot', annotation[0]),
        ]
      : name,
  );
}

function objectLabel(object: SnapshotObject): m.Children {
  return [
    nodeNameLabel(object.name, isString(object)),
    m('span.pf-snapshot-viewer__object-id', ` @${object.id}`),
  ];
}

function sourceLinkLabel(object: SnapshotObject): string {
  const source = object.sourceLocation;
  if (source?.file) {
    return `${source.file.split(/[\\/]/).pop()}:${source.line}:${source.column}`;
  }
  if (!source || source.script.startsWith('script_id:')) return 'Source';
  const filename = source.script
    .replace(/[?#].*$/, '')
    .split(/[\\/]/)
    .pop();
  if (!filename) return 'Source';
  try {
    return decodeURIComponent(filename);
  } catch {
    return filename;
  }
}

function sourceLabel(object: SnapshotObject, link: m.Children): m.Children {
  const name = object.sourceLocation
    ? sourceFunctionName(object.sourceLocation)
    : undefined;
  return m('.pf-snapshot-viewer__source-label', [
    link,
    name
      ? m('span.pf-snapshot-viewer__source-function', {title: name}, name)
      : null,
  ]);
}

function sourceDetails(object: SnapshotObject): m.Children {
  const source = object.sourceLocation;
  if (!source) return null;
  const title = source.file
    ? `${source.file}:${source.line}:${source.column}`
    : source.script;
  const safeUrl =
    source.url && /^(?:https?:\/\/|file:\/\/\/)/.test(source.url)
      ? source.url
      : undefined;
  const generatedUrl = source.generatedUrl?.startsWith('file:///')
    ? source.generatedUrl
    : undefined;
  const scriptLink = () =>
    generatedUrl
      ? m(
          'a.pf-snapshot-viewer__generated-source-link',
          {
            href: generatedUrl,
            title: generatedUrl,
            target: '_blank',
            rel: 'noopener noreferrer',
          },
          source.script,
        )
      : m('span', source.script);
  return m(
    '.pf-snapshot-viewer__source-details',
    {
      className: source.file
        ? 'pf-snapshot-viewer__source-details--mapped'
        : undefined,
    },
    [
      source.file
        ? ['original', 'code', 'generated'].map((part) =>
            m('span.pf-snapshot-viewer__source-connector', {
              'className': `pf-snapshot-viewer__source-connector--${part}`,
              'aria-hidden': 'true',
            }),
          )
        : null,
      source.file
        ? safeUrl
          ? m(
              'a.pf-snapshot-viewer__original-source-link',
              {href: safeUrl, target: '_blank', rel: 'noopener noreferrer'},
              title,
            )
          : m('span.pf-snapshot-viewer__original-source-link', title)
        : null,
      source.snippet !== undefined
        ? m(
            'pre',
            source.snippet.split('\n').map((line, index) =>
              m(
                'div',
                {
                  className:
                    source.snippetStartLine! + index === source.line
                      ? 'pf-snapshot-viewer__source-line'
                      : undefined,
                },
                `${source.snippetStartLine! + index}  ${line}`,
              ),
            ),
          )
        : null,
      m('div.pf-snapshot-viewer__generated-location', [
        scriptLink(),
        ` · ${source.offset !== undefined ? `byte offset ${source.offset}` : `generated ${source.generatedLine}:${source.generatedColumn}`}`,
      ]),
      source.generatedSnippet
        ? m('pre.pf-snapshot-viewer__generated-source', [
            source.generatedSnippet.truncatedBefore ? '…' : '',
            source.generatedSnippet.before,
            m(
              'mark.pf-snapshot-viewer__source-offset',
              {
                'title': `Byte offset ${source.offset}`,
                'aria-label': `Generated code from byte offset ${source.offset}`,
              },
              source.generatedSnippet.after || '│',
            ),
            source.generatedSnippet.truncatedAfter ? '…' : '',
          ])
        : null,
      source.error ? m('div', source.error) : null,
      source.generatedSnippet
        ? m(
            'div',
            `Generated JavaScript · ${source.generatedLine}:${source.generatedColumn! + 1}`,
          )
        : null,
    ],
  );
}

function referenceLabel(reference: SnapshotReference): m.Children {
  let className: string | undefined;
  switch (reference.type) {
    case 'context':
      className = 'pf-snapshot-viewer__edge--context';
      break;
    case 'internal':
    case 'hidden':
    case 'weak':
      className = 'pf-snapshot-viewer__edge--muted';
      break;
  }
  return m(
    'span.pf-snapshot-viewer__edge',
    {
      className,
      title: `${reference.type}${reference.weak ? ' (weak / non-retaining)' : ''}`,
    },
    reference.name || '(empty)',
  );
}

function objectEntry(
  object: SnapshotObject,
  select: () => void,
  prefix?: m.Children,
  locateSource: () => void = select,
): m.Children {
  return m('.pf-snapshot-viewer__object-entry', [
    m(
      'button.pf-snapshot-viewer__object-label',
      {
        title: `${isString(object) ? '' : `${object.type}: `}${object.name} @${object.id}`,
        onclick: (event: MouseEvent) => {
          event.stopPropagation();
          select();
        },
      },
      [prefix, objectLabel(object)],
    ),
    object.sourceLocation
      ? sourceLabel(
          object,
          m(
            'a.pf-snapshot-viewer__source-link',
            {
              href: '#snapshot-source',
              title: `Locate source: ${object.sourceLocation.file ?? object.sourceLocation.script}`,
              onclick: (event: MouseEvent) => {
                event.preventDefault();
                event.stopPropagation();
                locateSource();
              },
            },
            sourceLinkLabel(object),
          ),
        )
      : null,
    isString(object)
      ? m(
          'span',
          {onclick: (event: MouseEvent) => event.stopPropagation()},
          m(CopyToClipboardButton, {
            className: 'pf-snapshot-viewer__copy-string',
            textToCopy: object.name,
            title: 'Copy string',
            compact: true,
          }),
        )
      : null,
  ]);
}

interface ObjectBranch {
  key: string;
  object: SnapshotObject;
  reference?: SnapshotReference;
  ancestry: number[];
  children?: ObjectBranch[];
  expanded?: boolean;
  loading?: boolean;
  error?: string;
}

interface ObjectRowsAttrs {
  state: SnapshotViewerState;
  object: SnapshotObject;
  source?: SnapshotObjectSource;
  selectedIndex?: number;
  reveal?: boolean;
  select: (object: SnapshotObject) => void;
  metrics: (object: SnapshotObject, root: boolean) => m.Children;
  columnCount: number;
}

/** Expands outgoing references in place, while selection drives Retainers. */
class SnapshotObjectRows implements m.ClassComponent<ObjectRowsAttrs> {
  private root!: ObjectBranch;
  private active = true;
  private scrollPending = false;

  oninit({attrs}: m.Vnode<ObjectRowsAttrs>) {
    this.root = {key: 'root', object: attrs.object, ancestry: []};
    if (attrs.reveal) this.reveal(attrs);
  }
  onbeforeupdate(
    {attrs}: m.Vnode<ObjectRowsAttrs>,
    previous: m.Vnode<ObjectRowsAttrs>,
  ) {
    if (attrs.reveal && !previous.attrs.reveal) this.reveal(attrs);
  }
  oncreate(vnode: m.VnodeDOM<ObjectRowsAttrs>) {
    this.scrollToRoot(vnode);
  }
  onupdate(vnode: m.VnodeDOM<ObjectRowsAttrs>) {
    this.scrollToRoot(vnode);
  }
  onremove() {
    this.active = false;
  }

  private reveal(attrs: ObjectRowsAttrs) {
    this.scrollPending = true;
    if (this.root.object.referenceCount > 0) {
      this.root.expanded = true;
      if (this.root.children === undefined) void this.load(attrs, this.root);
    }
  }

  private scrollToRoot({dom}: m.VnodeDOM<ObjectRowsAttrs>) {
    if (!this.scrollPending) return;
    this.scrollPending = false;
    const row = dom as HTMLElement;
    const table = row.closest<HTMLElement>(
      '.pf-snapshot-viewer__summary-table',
    );
    if (table) {
      table.scrollTop +=
        row.getBoundingClientRect().top -
        table.getBoundingClientRect().top -
        table.clientHeight / 3;
    }
  }

  private async load(
    attrs: ObjectRowsAttrs,
    branch: ObjectBranch,
    all = false,
  ) {
    if (branch.loading) return;
    branch.loading = true;
    branch.error = undefined;
    const offset = branch.children?.length ?? 0;
    try {
      const page = await attrs.state.references(
        branch.object.index,
        offset,
        all ? branch.object.referenceCount - offset : 100,
        attrs.source,
      );
      if (!this.active) return;
      branch.children = [
        ...(branch.children ?? []),
        ...page.items.map((reference) => ({
          key: `${branch.key}:${reference.edgeIndex}`,
          object: reference.object,
          reference,
          ancestry: [...branch.ancestry, branch.object.index],
        })),
      ];
    } catch (error) {
      if (this.active) branch.error = String(error);
    } finally {
      branch.loading = false;
      if (this.active) attrs.state.redraw();
    }
  }

  private rows(
    attrs: ObjectRowsAttrs,
    branch: ObjectBranch,
    depth = 0,
  ): m.Children {
    const {object, reference} = branch;
    const cycle = branch.ancestry.includes(object.index);
    const canExpand = object.referenceCount > 0 && !cycle && depth < 32;
    const toggle = () => {
      if (!canExpand) return;
      branch.expanded = !branch.expanded;
      if (branch.expanded && branch.children === undefined) {
        void this.load(attrs, branch);
      }
    };
    const selectAndToggle = () => {
      attrs.select(object);
      toggle();
    };
    return [
      m(
        'tr.pf-snapshot-viewer__object',
        {
          'data-object-id': object.id,
          'data-object-source': attrs.source ?? 'current',
          'data-object-root': depth === 0 ? 'true' : undefined,
          'data-reference-name': reference?.name,
          'data-reference-cycle': cycle ? 'true' : undefined,
          'className': classNames(
            attrs.selectedIndex === object.index &&
              'pf-snapshot-viewer__object--selected',
            isOtherSlot(object.name, captureSlot(attrs.state, attrs.source)) &&
              'pf-snapshot-viewer__other-slot',
          ),
          'onclick': selectAndToggle,
        },
        [
          m(
            'td',
            {style: {paddingLeft: `${24 + depth * 16}px`}},
            m('.pf-snapshot-viewer__object-tree-entry', [
              m(
                'button.pf-snapshot-viewer__object-toggle',
                {
                  'disabled': !canExpand,
                  'aria-label': `${branch.expanded ? 'Collapse' : 'Expand'} references of ${object.name} @${object.id}`,
                  'aria-expanded': canExpand
                    ? String(branch.expanded ?? false)
                    : undefined,
                  'onclick': (event: MouseEvent) => {
                    event.stopPropagation();
                    toggle();
                  },
                },
                cycle ? '↩' : canExpand ? (branch.expanded ? '▾' : '▸') : '',
              ),
              objectEntry(
                object,
                selectAndToggle,
                reference
                  ? [
                      referenceLabel(reference),
                      m('span.pf-snapshot-viewer__reference-separator', ' :: '),
                    ]
                  : undefined,
                () => attrs.select(object),
              ),
              cycle || depth >= 32
                ? m('small', cycle ? '(cycle)' : '(depth limit)')
                : null,
            ]),
          ),
          attrs.metrics(object, depth === 0),
        ],
      ),
      branch.expanded
        ? [
            branch.children?.map((child) => this.rows(attrs, child, depth + 1)),
            branch.loading || branch.error
              ? m(
                  'tr',
                  m(
                    'td',
                    {colspan: attrs.columnCount},
                    branch.error ?? 'Loading references...',
                  ),
                )
              : null,
            branch.children && branch.children.length < object.referenceCount
              ? m(
                  'tr',
                  m(
                    'td',
                    {colspan: attrs.columnCount},
                    pagingControls(
                      branch.children.length,
                      object.referenceCount,
                      () => void this.load(attrs, branch),
                      () => void this.load(attrs, branch, true),
                      branch.loading,
                    ),
                  ),
                )
              : null,
          ]
        : null,
    ];
  }

  view({attrs}: m.Vnode<ObjectRowsAttrs>): m.Children {
    return this.rows(attrs, this.root);
  }
}

function snapshotToolbar(state: SnapshotViewerState): m.Children {
  const scriptsMode = state.mode === 'scripts';
  const profiles = sortedSnapshotProfiles(state.profiles);
  const counts = new Map<string, number>();
  const ordinals = new Map<string, number>();
  for (const profile of profiles) {
    counts.set(profile.id, (counts.get(profile.id) ?? 0) + 1);
  }
  return m('.pf-snapshot-viewer__toolbar', [
    m(
      'select',
      {
        'aria-label': 'Snapshot mode',
        'value': state.mode,
        'onchange': (event: Event) =>
          state.setMode(
            (event.target as HTMLSelectElement)
              .value as SnapshotViewerState['mode'],
          ),
      },
      [
        m('option', {value: 'summary'}, 'Summary'),
        m('option', {value: 'comparison'}, 'Comparison'),
        m('option', {value: 'scripts'}, 'Scripts'),
        m('option', {value: 'raw'}, 'Raw'),
      ],
    ),
    state.mode === 'comparison'
      ? [
          m(
            'select.pf-snapshot-viewer__baseline',
            {
              'aria-label': 'Comparison baseline',
              'value': state.baseline?.sliceId,
              'disabled': state.loading,
              'onchange': (event: Event) =>
                state.setBaseline(
                  Number((event.target as HTMLSelectElement).value),
                ),
            },
            profiles.map((profile) => {
              const ordinal = (ordinals.get(profile.id) ?? 0) + 1;
              ordinals.set(profile.id, ordinal);
              return m(
                'option',
                {value: profile.sliceId},
                `${profile.id} (${ordinal}/${counts.get(profile.id)})`,
              );
            }),
          ),
          m(
            'select',
            {
              'aria-label': 'Comparison filter',
              'value': state.comparisonFilter,
              'onchange': (event: Event) =>
                state.setComparisonFilter(
                  (event.target as HTMLSelectElement)
                    .value as SnapshotComparisonFilter,
                ),
            },
            [
              m('option', {value: 'new'}, 'Only new'),
              m('option', {value: 'deleted'}, 'Only deleted'),
              m('option', {value: 'all'}, 'All'),
            ],
          ),
        ]
      : null,
    state.mode !== 'raw'
      ? m('input', {
          'type': 'search',
          'placeholder': scriptsMode ? 'Filter by script' : 'Filter by class',
          'aria-label': scriptsMode
            ? 'Filter by script or ID'
            : 'Filter by class',
          'value': scriptsMode ? state.scriptFilter : state.classFilter,
          'oninput': (event: Event) => {
            const value = (event.target as HTMLInputElement).value;
            if (scriptsMode) {
              state.scriptFilter = value;
            } else {
              state.classFilter = value;
            }
          },
        })
      : null,
    state.summary
      ? m(
          'span',
          scriptsMode
            ? `${state.summary.scripts.length.toLocaleString()} scripts`
            : `${state.summary.nodeCount.toLocaleString()} nodes · ${formatMemoryBytes(state.summary.totalSize)}`,
        )
      : null,
  ]);
}

function pagingControls(
  loaded: number,
  total: number,
  more: () => void,
  all: () => void,
  loading = false,
): m.Children {
  return m('.pf-snapshot-viewer__paging', [
    m(
      'button',
      {disabled: loading, onclick: more},
      `Show more (${loaded.toLocaleString()}/${total.toLocaleString()})`,
    ),
    m(
      'button',
      {disabled: loading, onclick: all},
      `Show all ${total.toLocaleString()}`,
    ),
  ]);
}

export class SnapshotViewer implements m.ClassComponent<{trace: Trace}> {
  view({attrs}: m.Vnode<{trace: Trace}>): m.Children {
    const state = snapshotViewerState(attrs.trace);
    return state.open
      ? m(
          Portal,
          {
            onBeforeContentMount: (dom: Element) => ({
              container:
                dom.closest('.pf-overlay-container') ??
                dom.closest('.pf-theme-provider') ??
                document.body,
            }),
          },
          m(SnapshotViewerPanel, {key: attrs.trace.engine.engineId, state}),
        )
      : null;
  }
}

export class SnapshotViewerPanel
  implements m.ClassComponent<{state: SnapshotViewerState}>
{
  private treeSelection?: number;
  private treeGrouping?: string;
  private revealVersion = 0;
  private readonly collapsed = new Set<string>();
  private readonly contextMenus = new Set<string>();
  private fileInput?: HTMLInputElement;
  private resize = () => m.redraw();

  oncreate() {
    window.addEventListener('resize', this.resize);
  }
  onremove() {
    window.removeEventListener('resize', this.resize);
  }

  private renderTree(
    state: SnapshotViewerState,
    nodes: SnapshotTreeNode[],
    depth = 0,
  ): m.Children {
    return nodes.map((node) => {
      const selected =
        node.snapshot !== undefined &&
        node.snapshot.sliceId === state.selected?.sliceId;
      const collapsed = this.collapsed.has(node.key);
      const size =
        node.snapshot && state.profileSizes.get(node.snapshot.sliceId);
      const sizeError =
        node.snapshot && state.profileSizeErrors.get(node.snapshot.sliceId);
      const sizeLabel = node.snapshot
        ? ` (${size !== undefined ? formatMemoryBytes(size) : sizeError ? 'unavailable' : '…'})`
        : '';
      return [
        m(
          PopupMenu,
          {
            isContextMenu: true,
            showArrow: false,
            onChange: (open: boolean) => {
              if (open) this.contextMenus.add(node.key);
              else this.contextMenus.delete(node.key);
            },
            onPopupUnMount: () => this.contextMenus.delete(node.key),
            trigger: m(
              '.pf-snapshot-viewer__profile-context',
              m(
                'button.pf-snapshot-viewer__profile',
                {
                  'className': selected
                    ? 'pf-snapshot-viewer__profile--selected'
                    : undefined,
                  'style': {paddingLeft: `${10 + depth * 15}px`},
                  'aria-expanded': node.children ? !collapsed : undefined,
                  'aria-current': selected ? 'true' : undefined,
                  'title': node.snapshot
                    ? `${node.snapshot.id}${sizeLabel}\n${node.snapshot.snapshotId}${sizeError ? `\n${sizeError}` : ''}`
                    : node.name,
                  'data-snapshot-slice-id': node.snapshot?.sliceId,
                  'data-snapshot-tree-key': node.key,
                  'onclick': () => {
                    if (node.snapshot) {
                      void state.select(node.snapshot);
                    } else {
                      if (collapsed) this.collapsed.delete(node.key);
                      else this.collapsed.add(node.key);
                    }
                  },
                  'oncreate': (vnode: m.VnodeDOM) => {
                    if (selected) this.revealSelected(vnode.dom as HTMLElement);
                  },
                  'onupdate': (vnode: m.VnodeDOM) => {
                    if (selected) this.revealSelected(vnode.dom as HTMLElement);
                  },
                },
                [
                  node.snapshot
                    ? m(Icon, {
                        'icon': 'photo_camera',
                        'className': 'pf-snapshot-viewer__camera',
                        'aria-hidden': 'true',
                      })
                    : m(
                        'span.pf-snapshot-viewer__arrow',
                        collapsed ? '▸' : '▾',
                      ),
                  m('span.pf-snapshot-viewer__profile-label', [
                    m('span.pf-snapshot-viewer__profile-id', node.name),
                    node.snapshot
                      ? m('span.pf-snapshot-viewer__profile-size', sizeLabel)
                      : null,
                  ]),
                  node.sequence
                    ? m(
                        'span.pf-snapshot-viewer__profile-sequence',
                        `${node.sequence.ordinal}/${node.sequence.count}`,
                      )
                    : null,
                ],
              ),
            ),
          },
          m(MenuItem, {
            label: node.snapshot
              ? 'Download snapshot'
              : 'Download snapshots to directory',
            icon: node.snapshot ? 'download' : 'folder',
            disabled:
              state.downloader.busy ||
              (!node.snapshot && !snapshotDirectoryDownloadsSupported()),
            title:
              !node.snapshot && !snapshotDirectoryDownloadsSupported()
                ? 'Directory selection is not available in this browser.'
                : undefined,
            onclick: () => void state.downloader.download(node),
          }),
        ),
        node.children && !collapsed
          ? this.renderTree(state, node.children, depth + 1)
          : null,
      ];
    });
  }

  private revealSelected(element: HTMLElement) {
    if (element.dataset.snapshotRevealVersion !== String(this.revealVersion)) {
      element.dataset.snapshotRevealVersion = String(this.revealVersion);
      element.scrollIntoView({block: 'nearest'});
    }
  }

  view({attrs}: m.Vnode<{state: SnapshotViewerState}>): m.Children {
    const state = attrs.state;
    const maxWidth = window.innerWidth;
    const width = Math.min(
      maxWidth,
      Math.max(Math.min(480, maxWidth), state.width ?? maxWidth / 2),
    );
    const tree = buildSnapshotTree(
      state.profiles,
      state.vms,
      state.grouping,
      state.vmAssignments,
    );
    if (
      this.treeSelection !== state.selected?.sliceId ||
      this.treeGrouping !== state.grouping
    ) {
      this.treeSelection = state.selected?.sliceId;
      this.treeGrouping = state.grouping;
      this.revealVersion++;
      const reveal = (nodes: SnapshotTreeNode[]): boolean => {
        let found = false;
        for (const node of nodes) {
          if (
            node.snapshot?.sliceId === state.selected?.sliceId &&
            node.snapshot
          ) {
            found = true;
          }
          if (node.children && reveal(node.children)) {
            this.collapsed.delete(node.key);
            found = true;
          }
        }
        return found;
      };
      reveal(tree);
    }
    return m(
      'aside.pf-snapshot-viewer.pf-overlay-container',
      {
        'style': {width: `${width}px`},
        'aria-label': 'Snapshot viewer',
        'onkeydown': (event: KeyboardEvent) => {
          if (event.key === 'Escape' && this.contextMenus.size > 0) return;
          // Prevent timeline shortcuts from acting on the covered trace.
          event.stopPropagation();
          if (event.key === 'Escape') state.close();
        },
      },
      [
        m(ResizeHandle, {
          class: 'pf-resize-handle--horizontal pf-snapshot-viewer__resizer',
          style: {left: `${maxWidth - width - 4}px`},
          direction: 'horizontal',
          onResize: (delta: number) =>
            state.setWidth(
              Math.max(
                Math.min(480, maxWidth),
                Math.min(maxWidth, (state.width ?? width) - delta),
              ),
            ),
          onResizeEnd: () => state.saveWidth(),
        }),
        m('header.pf-snapshot-viewer__header', [
          m(Button, {
            icon: 'close',
            title: 'Close snapshot viewer',
            compact: true,
            onclick: () => state.close(),
          }),
          m('strong', 'Heap Snapshots'),
          m(
            'span.pf-snapshot-viewer__profile-count',
            `${state.profiles.length} profiles`,
          ),
          m(Button, {
            icon: 'close',
            title: 'Close snapshot viewer',
            compact: true,
            onclick: () => state.close(),
          }),
        ]),
        m('.pf-snapshot-viewer__body', [
          m(
            'nav.pf-snapshot-viewer__profiles',
            {'aria-label': 'Snapshot profiles'},
            [
              m('.pf-snapshot-viewer__grouping', [
                m('label', {for: 'snapshot-grouping'}, 'Group by'),
                m(
                  'select',
                  {
                    id: 'snapshot-grouping',
                    value: state.grouping,
                    onchange: (event: Event) =>
                      state.setGrouping(
                        (event.target as HTMLSelectElement).value as
                          | 'instance'
                          | 'vm',
                      ),
                  },
                  [
                    m('option', {value: 'instance'}, 'Instance'),
                    m('option', {value: 'vm'}, 'Virtual machine'),
                  ],
                ),
                m(Button, {
                  label: 'Open ...',
                  title: 'Open heap snapshot files',
                  className: 'pf-snapshot-viewer__open-snapshot',
                  compact: true,
                  onclick: () => this.fileInput?.click(),
                }),
                m('input.pf-snapshot-viewer__file-input', {
                  type: 'file',
                  accept: '.heapsnapshot,.json',
                  multiple: true,
                  hidden: true,
                  oncreate: (vnode: m.VnodeDOM) => {
                    this.fileInput = vnode.dom as HTMLInputElement;
                  },
                  onchange: (event: Event) => {
                    const input = event.target as HTMLInputElement;
                    const files = Array.from(input.files ?? []);
                    input.value = '';
                    void state.openFiles(files);
                  },
                }),
              ]),
              m('.pf-snapshot-viewer__tree', [
                state.listLoading
                  ? m('.pf-snapshot-viewer__message', 'Loading profiles...')
                  : null,
                state.listError
                  ? m('.pf-snapshot-viewer__message', state.listError)
                  : null,
                !state.listLoading && !state.listError && tree.length === 0
                  ? m(
                      '.pf-snapshot-viewer__message',
                      'No heap snapshots in this trace.',
                    )
                  : this.renderTree(state, tree),
              ]),
              state.downloader.status || state.downloader.error
                ? m(
                    '.pf-snapshot-viewer__download-status',
                    {
                      role: 'status',
                      className: state.downloader.error
                        ? 'pf-snapshot-viewer__error'
                        : undefined,
                    },
                    state.downloader.error ?? state.downloader.status,
                  )
                : null,
            ],
          ),
          m('main.pf-snapshot-viewer__detail', [
            state.selected ? snapshotToolbar(state) : null,
            state.loading
              ? m(
                  '.pf-snapshot-viewer__message',
                  'Loading snapshot and computing retained sizes...',
                )
              : null,
            state.error && state.mode !== 'raw'
              ? m(
                  '.pf-snapshot-viewer__message.pf-snapshot-viewer__error',
                  state.error,
                )
              : null,
            state.mode === 'raw' && state.selected && !state.loading
              ? m.fragment({}, [
                  m(SnapshotRawView, {key: state.selected.sliceId, state}),
                ])
              : state.mode === 'comparison' && state.summary
                ? [
                    state.comparisonLoading
                      ? m(
                          '.pf-snapshot-viewer__message',
                          'Comparing snapshots...',
                        )
                      : null,
                    state.comparisonError
                      ? m(
                          '.pf-snapshot-viewer__message.pf-snapshot-viewer__error',
                          state.comparisonError,
                        )
                      : null,
                    state.comparison
                      ? m.fragment({}, [
                          m(SnapshotComparisonView, {
                            key: `${state.comparisonVersion}:${state.comparisonFilter}`,
                            state,
                          }),
                        ])
                      : null,
                  ]
                : state.summary
                  ? m.fragment({}, [
                      m(
                        state.mode === 'scripts'
                          ? SnapshotScriptsView
                          : SnapshotSummaryView,
                        {
                          key: state.selected!.sliceId,
                          state,
                          summary: state.summary,
                        },
                      ),
                    ])
                  : !state.loading && !state.error
                    ? m(
                        '.pf-snapshot-viewer__message',
                        'Select a snapshot to inspect its objects.',
                      )
                    : null,
          ]),
        ]),
      ],
    );
  }
}

interface SummaryAttrs {
  state: SnapshotViewerState;
  summary: SnapshotSummary;
}

class SnapshotScriptsView implements m.ClassComponent<SummaryAttrs> {
  view({attrs: {state, summary}}: m.Vnode<SummaryAttrs>): m.Children {
    if (summary.scripts.length === 0) {
      return m(
        '.pf-snapshot-viewer__message',
        'No scripts available in primjs_sources.',
      );
    }
    const filter = state.scriptFilter.trim().toLowerCase();
    const scripts = summary.scripts.filter(
      (script) =>
        script.name.toLowerCase().includes(filter) ||
        String(script.scriptId).includes(filter),
    );
    return m('.pf-snapshot-viewer__summary-table.pf-snapshot-viewer__scripts', [
      m(
        SnapshotTable,
        {
          state,
          mode: 'scripts',
          minWidth: 470,
          columns: [
            {key: 'id', share: 0.2, header: 'Script ID'},
            {key: 'name', share: 0.8, header: 'Script'},
          ],
        },
        m(
          'tbody',
          scripts.length > 0
            ? scripts.map((script) =>
                m('tr', [
                  m('td', script.scriptId),
                  m('td', {title: script.name}, script.name || '(anonymous)'),
                ]),
              )
            : m('tr', m('td', {colspan: 2}, 'No matching scripts.')),
        ),
      ),
    ]);
  }
}

type SortColumn = 'name' | 'distance' | 'shallowSize' | 'retainedSize';

interface SummaryObjectPage extends SnapshotObjectPage {
  offset: number;
}

class SnapshotSummaryView implements m.ClassComponent<SummaryAttrs> {
  private sort: SortColumn = 'retainedSize';
  private descending = true;
  private visibleClasses = 200;
  private readonly expanded = new Set<string>();
  private readonly objects = new Map<string, SummaryObjectPage>();
  private readonly loading = new Set<string>();
  private readonly errors = new Map<string, string>();
  private selected?: SnapshotObject;
  private active = true;
  private retainerHeight = 230;
  private focusedObject?: SnapshotObjectLocation;
  private focusVersion = 0;
  oninit({attrs}: m.Vnode<SummaryAttrs>) {
    this.focus(attrs);
  }
  onbeforeupdate({attrs}: m.Vnode<SummaryAttrs>) {
    if (this.focusedObject !== attrs.state.focusedObject) {
      this.focus(attrs);
    }
  }
  onremove() {
    this.active = false;
  }

  private focus({state, summary}: SummaryAttrs) {
    this.focusVersion++;
    this.focusedObject = state.focusedObject;
    this.selected = this.focusedObject?.object;
    this.expanded.clear();
    this.objects.clear();
    this.loading.clear();
    this.errors.clear();
    const location = this.focusedObject?.group;
    if (!location) return;
    const group = summary.classes.find((item) => item.key === location.key);
    if (!group) return;
    this.expanded.add(group.key);
    void this.loadObjects(state, group);
  }

  private async loadObjects(
    state: SnapshotViewerState,
    group: SnapshotClass,
    direction: 'next' | 'previous' | 'all' = 'next',
  ) {
    if (this.loading.has(group.key)) return;
    this.loading.add(group.key);
    this.errors.delete(group.key);
    const version = this.focusVersion;
    const current = this.objects.get(group.key);
    const location = this.focusedObject?.group;
    const start =
      current?.offset ??
      (location?.key === group.key
        ? Math.floor(location.position / 100) * 100
        : 0);
    const offset =
      direction === 'all'
        ? 0
        : direction === 'previous'
          ? Math.max(0, start - 100)
          : current
            ? start + current.items.length
            : start;
    const limit =
      direction === 'all'
        ? group.count
        : direction === 'previous'
          ? start - offset
          : 100;
    try {
      const page = await state.objects(group.key, offset, limit);
      if (this.active && version === this.focusVersion) {
        this.objects.set(group.key, {
          offset: direction === 'next' ? start : offset,
          items:
            direction === 'all'
              ? page.items
              : direction === 'previous'
                ? [...page.items, ...(current?.items ?? [])]
                : [...(current?.items ?? []), ...page.items],
          total: page.total,
        });
      }
    } catch (error) {
      if (this.active && version === this.focusVersion) {
        this.errors.set(group.key, String(error));
      }
    } finally {
      if (this.active && version === this.focusVersion) {
        this.loading.delete(group.key);
        state.redraw();
      }
    }
  }

  private objectPaging(
    state: SnapshotViewerState,
    group: SnapshotClass,
    page: SummaryObjectPage,
  ): m.Children {
    const end = page.offset + page.items.length;
    const loading = this.loading.has(group.key);
    return m('.pf-snapshot-viewer__paging', [
      m(
        'span',
        `Objects ${(page.offset + 1).toLocaleString()}–${end.toLocaleString()} of ${page.total.toLocaleString()}`,
      ),
      page.offset > 0
        ? m(
            'button',
            {
              disabled: loading,
              onclick: () => void this.loadObjects(state, group, 'previous'),
            },
            'Show previous',
          )
        : null,
      end < page.total
        ? m(
            'button',
            {
              disabled: loading,
              onclick: () => void this.loadObjects(state, group),
            },
            'Show more',
          )
        : null,
      m(
        'button',
        {
          disabled: loading,
          onclick: () => void this.loadObjects(state, group, 'all'),
        },
        `Show all ${page.total.toLocaleString()}`,
      ),
    ]);
  }

  private sortHeader(
    column: SortColumn,
    title: string,
    description: string,
  ): m.Children {
    return m(
      Tooltip,
      {
        trigger: m(
          'button',
          {
            onclick: () => {
              if (this.sort === column) this.descending = !this.descending;
              else {
                this.sort = column;
                this.descending = column !== 'name' && column !== 'distance';
              }
            },
          },
          `${title}${this.sort === column ? (this.descending ? ' ▾' : ' ▴') : ''}`,
        ),
      },
      description,
    );
  }

  private metrics(
    object: {distance: number; shallowSize: number; retainedSize: number},
    total: number,
  ): m.Children {
    return [
      m('td', object.distance < 0 ? '–' : object.distance.toLocaleString()),
      m('td', {title: `${object.shallowSize.toLocaleString()} bytes`}, [
        formatMemoryBytes(object.shallowSize),
        m(
          'small',
          ` ${total ? Math.round((object.shallowSize / total) * 100) : 0}%`,
        ),
      ]),
      m('td', {title: `${object.retainedSize.toLocaleString()} bytes`}, [
        formatMemoryBytes(object.retainedSize),
        m(
          'small',
          ` ${total ? Math.round((object.retainedSize / total) * 100) : 0}%`,
        ),
      ]),
    ];
  }

  view({attrs}: m.Vnode<SummaryAttrs>): m.Children {
    const {state, summary} = attrs;
    const groups = summary.classes
      .filter((group) =>
        `${group.name} ${group.type}`
          .toLowerCase()
          .includes(state.classFilter.toLowerCase()),
      )
      .sort((a, b) => {
        const comparison =
          this.sort === 'name'
            ? a.name.localeCompare(b.name)
            : (a[this.sort] < 0 ? Infinity : a[this.sort]) -
              (b[this.sort] < 0 ? Infinity : b[this.sort]);
        return (
          (this.descending ? -comparison : comparison) ||
          a.name.localeCompare(b.name)
        );
      });
    const focusedGroupIndex = groups.findIndex(
      (group) => group.key === this.focusedObject?.group?.key,
    );
    const visibleClasses = Math.max(this.visibleClasses, focusedGroupIndex + 1);
    return [
      summary.unreachableCount
        ? m(
            '.pf-snapshot-viewer__notice',
            `${summary.unreachableCount.toLocaleString()} nodes have no strong path to a root. Their Distance is unavailable; their Retained Size shows only their own size.`,
          )
        : null,
      m(
        '.pf-snapshot-viewer__summary-table',
        m(
          SnapshotTable,
          {
            state,
            mode: 'summary',
            minWidth: 470,
            columns: [
              {
                key: 'name',
                share: 0.44,
                header: this.sortHeader(
                  'name',
                  'Constructor / Type',
                  'Expand a class to inspect individual heap objects. Synthetic and zero-size holder nodes are available through Retainers.',
                ),
              },
              {
                key: 'distance',
                share: 0.12,
                header: this.sortHeader(
                  'distance',
                  'Distance',
                  'Shortest non-weak reference path from the snapshot root. A class shows its minimum object distance. A dash means no strong root path.',
                ),
              },
              {
                key: 'shallowSize',
                share: 0.22,
                header: this.sortHeader(
                  'shallowSize',
                  'Shallow Size',
                  'Bytes occupied by the object itself, excluding referenced objects. A class shows the sum of its objects’ shallow sizes.',
                ),
              },
              {
                key: 'retainedSize',
                share: 0.22,
                header: this.sortHeader(
                  'retainedSize',
                  'Retained Size',
                  'Bytes released if this object and objects exclusively retained through it become unreachable. Calculated using dominators. Class totals exclude overlapping subtrees of the same class.',
                ),
              },
            ],
          },
          [
            m('tbody', [
              this.focusedObject && !this.focusedObject.group
                ? [
                    m(SnapshotObjectRows, {
                      key: this.focusedObject.object.index,
                      state,
                      object: this.focusedObject.object,
                      reveal: true,
                      selectedIndex: this.selected?.index,
                      select: (selected: SnapshotObject) => {
                        this.selected = selected;
                      },
                      metrics: (item: SnapshotObject) =>
                        this.metrics(item, summary.totalSize),
                      columnCount: 4,
                    }),
                  ]
                : null,
              groups.slice(0, visibleClasses).map((group) => {
                const expanded = this.expanded.has(group.key);
                const page = this.objects.get(group.key);
                return m.fragment({key: group.key}, [
                  m(
                    'tr.pf-snapshot-viewer__class',
                    {
                      'data-class-key': group.key,
                      'className': isOtherSlot(group.name, captureSlot(state))
                        ? 'pf-snapshot-viewer__other-slot'
                        : undefined,
                    },
                    [
                      m(
                        'td',
                        m(
                          'button.pf-snapshot-viewer__object-label',
                          {
                            'aria-expanded': String(expanded),
                            'title': `${group.name} (${group.type})`,
                            'onclick': () => {
                              if (expanded) this.expanded.delete(group.key);
                              else {
                                this.expanded.add(group.key);
                                if (!page) void this.loadObjects(state, group);
                              }
                            },
                          },
                          [
                            expanded ? '▾ ' : '▸ ',
                            nodeNameLabel(group.name),
                            m('small', ` ×${group.count.toLocaleString()}`),
                          ],
                        ),
                      ),
                      this.metrics(group, summary.totalSize),
                    ],
                  ),
                  expanded
                    ? [
                        page?.items.map((object) =>
                          m(SnapshotObjectRows, {
                            key: object.index,
                            state,
                            object,
                            reveal:
                              object.index === this.focusedObject?.object.index,
                            selectedIndex: this.selected?.index,
                            select: (selected: SnapshotObject) => {
                              this.selected = selected;
                            },
                            metrics: (item: SnapshotObject) =>
                              this.metrics(item, summary.totalSize),
                            columnCount: 4,
                          }),
                        ),
                        this.loading.has(group.key) ||
                        this.errors.has(group.key)
                          ? m(
                              'tr',
                              m(
                                'td',
                                {colspan: 4},
                                this.errors.get(group.key) ??
                                  'Loading objects...',
                              ),
                            )
                          : null,
                        page && page.items.length < page.total
                          ? m(
                              'tr',
                              m(
                                'td',
                                {colspan: 4},
                                this.objectPaging(state, group, page),
                              ),
                            )
                          : null,
                      ]
                    : null,
                ]);
              }),
              groups.length > visibleClasses
                ? m(
                    'tr',
                    m(
                      'td',
                      {colspan: 4},
                      pagingControls(
                        visibleClasses,
                        groups.length,
                        () => {
                          this.visibleClasses = visibleClasses + 200;
                        },
                        () => {
                          this.visibleClasses = groups.length;
                        },
                      ),
                    ),
                  )
                : null,
              groups.length === 0
                ? m('tr', m('td', {colspan: 4}, 'No matching classes.'))
                : null,
            ]),
          ],
        ),
      ),
      m(ResizeHandle, {
        onResize: (delta: number) => {
          this.retainerHeight = Math.max(
            100,
            Math.min(window.innerHeight * 0.65, this.retainerHeight - delta),
          );
          state.redraw();
        },
      }),
      m(
        '.pf-snapshot-viewer__retainers',
        {style: {height: `${this.retainerHeight}px`}},
        [
          m('.pf-snapshot-viewer__retainer-title', [
            m('strong', 'Retainers'),
            this.selected
              ? m(
                  'span',
                  {
                    className: isOtherSlot(
                      this.selected.name,
                      captureSlot(state),
                    )
                      ? 'pf-snapshot-viewer__other-slot'
                      : undefined,
                  },
                  objectLabel(this.selected),
                )
              : null,
          ]),
          this.selected
            ? m('.pf-snapshot-viewer__retainer-body', {tabindex: 0}, [
                m.fragment({key: 'source'}, [sourceDetails(this.selected)]),
                m(RetainerTree, {
                  key: this.selected.index,
                  state,
                  object: this.selected,
                }),
              ])
            : m(
                '.pf-snapshot-viewer__message',
                'Select an individual object to inspect its holders.',
              ),
        ],
      ),
    ];
  }
}

type ComparisonColumn = Exclude<keyof SnapshotClassDelta, 'key' | 'type'>;

const comparisonColumns: Array<{
  key: ComparisonColumn;
  title: string;
  description: string;
  filter?: 'new' | 'deleted';
}> = [
  {
    key: 'name',
    title: 'Constructor / Type',
    description: 'Expand a class to inspect its added and deleted objects.',
  },
  {
    key: 'newCount',
    title: 'New',
    description:
      'Objects present in the current snapshot and absent from the baseline.',
    filter: 'new',
  },
  {
    key: 'deletedCount',
    title: 'Deleted',
    description:
      'Objects present in the baseline and absent from the current snapshot.',
    filter: 'deleted',
  },
  {
    key: 'delta',
    title: 'Delta',
    description: 'New object count minus deleted object count.',
  },
  {
    key: 'allocatedSize',
    title: 'Allocate Size',
    description:
      'Sum of the shallow sizes of added objects in the current snapshot.',
    filter: 'new',
  },
  {
    key: 'freedSize',
    title: 'Freed Size',
    description:
      'Sum of the shallow sizes of deleted objects in the baseline snapshot.',
    filter: 'deleted',
  },
  {
    key: 'sizeDelta',
    title: 'Size Delta',
    description: 'Allocated size minus freed size.',
  },
];

function deltaSize(size: number): string {
  return `${size < 0 ? '−' : ''}${formatMemoryBytes(Math.abs(size))}`;
}

class SnapshotComparisonView
  implements m.ClassComponent<{state: SnapshotViewerState}>
{
  private sort: ComparisonColumn = 'allocatedSize';
  private descending = true;
  private visibleClasses = 200;
  private readonly expanded = new Set<string>();
  private readonly objects = new Map<string, SnapshotObjectChangePage>();
  private readonly loading = new Set<string>();
  private readonly errors = new Map<string, string>();
  private selected?: SnapshotObjectChange;
  private active = true;
  private retainerHeight = 230;

  oninit({attrs}: m.Vnode<{state: SnapshotViewerState}>) {
    if (attrs.state.comparisonFilter === 'deleted') this.sort = 'freedSize';
  }
  onremove() {
    this.active = false;
  }

  private async loadObjects(
    state: SnapshotViewerState,
    group: SnapshotClassDelta,
    all = false,
  ) {
    if (this.loading.has(group.key)) return;
    this.loading.add(group.key);
    this.errors.delete(group.key);
    const filter = state.comparisonFilter;
    const total =
      filter === 'new'
        ? group.newCount
        : filter === 'deleted'
          ? group.deletedCount
          : group.newCount + group.deletedCount;
    try {
      const offset = this.objects.get(group.key)?.items.length ?? 0;
      const page = await state.changes(
        group.key,
        filter,
        offset,
        all ? total - offset : 100,
      );
      if (this.active) {
        this.objects.set(group.key, {
          items: [...(this.objects.get(group.key)?.items ?? []), ...page.items],
          total: page.total,
        });
      }
    } catch (error) {
      if (this.active) this.errors.set(group.key, String(error));
    } finally {
      this.loading.delete(group.key);
      if (this.active) state.redraw();
    }
  }

  private groupMetric(group: SnapshotClassDelta, column: ComparisonColumn) {
    const value = group[column];
    return m(
      'td',
      {
        title:
          typeof value === 'number' && column.endsWith('Size')
            ? `${value.toLocaleString()} bytes`
            : undefined,
      },
      column === 'allocatedSize' ||
        column === 'freedSize' ||
        column === 'sizeDelta'
        ? deltaSize(value as number)
        : typeof value === 'number'
          ? value.toLocaleString()
          : value,
    );
  }

  private objectMetric(
    change: SnapshotObjectChange,
    column: ComparisonColumn,
    root: boolean,
  ) {
    const added = change.source === 'current';
    const marker =
      (column === 'newCount' && added) || (column === 'deletedCount' && !added);
    const size =
      (column === 'allocatedSize' && added) ||
      (column === 'freedSize' && !added);
    return m(
      'td',
      marker && root
        ? m(
            'span.pf-snapshot-viewer__change-marker',
            {title: added ? 'New object' : 'Deleted object'},
            '•',
          )
        : size
          ? m(
              'span',
              {title: `${change.object.shallowSize.toLocaleString()} bytes`},
              formatMemoryBytes(change.object.shallowSize),
            )
          : '',
    );
  }

  view({attrs}: m.Vnode<{state: SnapshotViewerState}>): m.Children {
    const {state} = attrs;
    const filter = state.comparisonFilter;
    const columns = comparisonColumns.filter(
      (column) =>
        column.key === 'name' || filter === 'all' || column.filter === filter,
    );
    const groups = state
      .comparison!.classes.filter(
        (group) =>
          (filter !== 'new' || group.newCount > 0) &&
          (filter !== 'deleted' || group.deletedCount > 0) &&
          `${group.name} ${group.type}`
            .toLowerCase()
            .includes(state.classFilter.toLowerCase()),
      )
      .sort((a, b) => {
        const comparison =
          this.sort === 'name'
            ? a.name.localeCompare(b.name)
            : a[this.sort] - b[this.sort];
        return (
          (this.descending ? -comparison : comparison) ||
          a.name.localeCompare(b.name)
        );
      });
    return [
      m(
        '.pf-snapshot-viewer__summary-table',
        m(
          SnapshotTable,
          {
            state,
            mode: 'comparison',
            minWidth: filter === 'all' ? 1000 : 470,
            filter,
            columns: columns.map((column) => ({
              key: column.key,
              share:
                column.key === 'name'
                  ? filter === 'all'
                    ? 0.34
                    : 0.6
                  : filter === 'all'
                    ? 0.11
                    : 0.2,
              header: m(
                Tooltip,
                {
                  trigger: m(
                    'button',
                    {
                      onclick: () => {
                        if (this.sort === column.key) {
                          this.descending = !this.descending;
                        } else {
                          this.sort = column.key;
                          this.descending = column.key !== 'name';
                        }
                      },
                    },
                    `${column.title}${this.sort === column.key ? (this.descending ? ' ▾' : ' ▴') : ''}`,
                  ),
                },
                column.description,
              ),
            })),
          },
          [
            m('tbody', [
              groups.slice(0, this.visibleClasses).map((group) => {
                const expanded = this.expanded.has(group.key);
                const page = this.objects.get(group.key);
                return [
                  m(
                    'tr.pf-snapshot-viewer__class',
                    {
                      className: isOtherSlot(
                        group.name,
                        captureSlot(
                          state,
                          group.newCount > 0 ? 'current' : 'baseline',
                        ),
                      )
                        ? 'pf-snapshot-viewer__other-slot'
                        : undefined,
                    },
                    [
                      m(
                        'td',
                        m(
                          'button.pf-snapshot-viewer__object-label',
                          {
                            'title': `${group.name} (${group.type})`,
                            'aria-expanded': expanded,
                            'onclick': () => {
                              if (expanded) this.expanded.delete(group.key);
                              else {
                                this.expanded.add(group.key);
                                if (!page) void this.loadObjects(state, group);
                              }
                            },
                          },
                          [expanded ? '▾ ' : '▸ ', nodeNameLabel(group.name)],
                        ),
                      ),
                      columns
                        .slice(1)
                        .map((column) => this.groupMetric(group, column.key)),
                    ],
                  ),
                  expanded
                    ? [
                        page?.items.map((change) =>
                          m.fragment({}, [
                            m(SnapshotObjectRows, {
                              key: `${change.source}:${change.object.index}`,
                              state,
                              object: change.object,
                              source: change.source,
                              selectedIndex:
                                this.selected?.source === change.source
                                  ? this.selected.object.index
                                  : undefined,
                              select: (object: SnapshotObject) => {
                                this.selected = {object, source: change.source};
                              },
                              metrics: (
                                object: SnapshotObject,
                                root: boolean,
                              ) =>
                                columns
                                  .slice(1)
                                  .map((column) =>
                                    this.objectMetric(
                                      {object, source: change.source},
                                      column.key,
                                      root,
                                    ),
                                  ),
                              columnCount: columns.length,
                            }),
                          ]),
                        ),
                        this.loading.has(group.key) ||
                        this.errors.has(group.key)
                          ? m(
                              'tr',
                              m(
                                'td',
                                {colspan: columns.length},
                                this.errors.get(group.key) ??
                                  'Loading objects...',
                              ),
                            )
                          : null,
                        page && page.items.length < page.total
                          ? m(
                              'tr',
                              m(
                                'td',
                                {colspan: columns.length},
                                pagingControls(
                                  page.items.length,
                                  page.total,
                                  () => void this.loadObjects(state, group),
                                  () =>
                                    void this.loadObjects(state, group, true),
                                  this.loading.has(group.key),
                                ),
                              ),
                            )
                          : null,
                      ]
                    : null,
                ];
              }),
              groups.length > this.visibleClasses
                ? m(
                    'tr',
                    m(
                      'td',
                      {colspan: columns.length},
                      pagingControls(
                        this.visibleClasses,
                        groups.length,
                        () => {
                          this.visibleClasses += 200;
                        },
                        () => {
                          this.visibleClasses = groups.length;
                        },
                      ),
                    ),
                  )
                : null,
              groups.length === 0
                ? m(
                    'tr',
                    m('td', {colspan: columns.length}, 'No matching changes.'),
                  )
                : null,
            ]),
          ],
        ),
      ),
      m(ResizeHandle, {
        onResize: (delta: number) => {
          this.retainerHeight = Math.max(
            100,
            Math.min(window.innerHeight * 0.65, this.retainerHeight - delta),
          );
          state.redraw();
        },
      }),
      m(
        '.pf-snapshot-viewer__retainers',
        {style: {height: `${this.retainerHeight}px`}},
        [
          m('.pf-snapshot-viewer__retainer-title', [
            m('strong', 'Retainers'),
            this.selected
              ? m(
                  'span',
                  {
                    className: isOtherSlot(
                      this.selected.object.name,
                      captureSlot(state, this.selected.source),
                    )
                      ? 'pf-snapshot-viewer__other-slot'
                      : undefined,
                  },
                  [
                    objectLabel(this.selected.object),
                    this.selected.source === 'baseline' ? ' (baseline)' : '',
                  ],
                )
              : null,
          ]),
          this.selected
            ? m('.pf-snapshot-viewer__retainer-body', {tabindex: 0}, [
                m.fragment({key: 'source'}, [
                  sourceDetails(this.selected.object),
                ]),
                m(RetainerTree, {
                  key: `${this.selected.source}:${this.selected.object.index}`,
                  state,
                  object: this.selected.object,
                  source: this.selected.source,
                }),
              ])
            : m(
                '.pf-snapshot-viewer__message',
                'Select an individual object to inspect its holders.',
              ),
        ],
      ),
    ];
  }
}

interface RetainerBranch {
  key: string;
  reference: SnapshotReference;
  ancestry: number[];
  children?: RetainerBranch[];
  total?: number;
  loading?: boolean;
  expanded?: boolean;
  sourceExpanded?: boolean;
  error?: string;
}

interface RetainerAttrs {
  state: SnapshotViewerState;
  object: SnapshotObject;
  source?: SnapshotObjectSource;
}

class RetainerTree implements m.ClassComponent<RetainerAttrs> {
  private branches: RetainerBranch[] = [];
  private total = 0;
  private error?: string;
  private loading = false;
  private active = true;
  private source: SnapshotObjectSource = 'current';
  oninit({attrs}: m.Vnode<RetainerAttrs>) {
    this.source = attrs.source ?? 'current';
    void this.load(attrs.state, attrs.object);
  }
  onremove() {
    this.active = false;
  }

  private async load(
    state: SnapshotViewerState,
    object: SnapshotObject,
    branch?: RetainerBranch,
    all = false,
  ) {
    if (branch?.loading || (!branch && this.loading)) return;
    const offset = branch ? branch.children?.length ?? 0 : this.branches.length;
    const ancestry = branch
      ? [...branch.ancestry, object.index]
      : [object.index];
    if (branch) branch.loading = true;
    else this.loading = true;
    try {
      const total = branch ? branch.total ?? 0 : this.total;
      const page = await state.retainers(
        object.index,
        offset,
        all ? total - offset : 100,
        this.source,
      );
      if (!this.active) return;
      const items = page.items.map((reference) => ({
        key: `${branch?.key ?? 'root'}:${reference.edgeIndex}`,
        reference,
        ancestry,
      }));
      if (branch) {
        branch.children = [...(branch.children ?? []), ...items];
        branch.total = page.total;
      } else {
        this.branches.push(...items);
        this.total = page.total;
      }
    } catch (error) {
      if (this.active) {
        if (branch) branch.error = String(error);
        else this.error = String(error);
      }
    } finally {
      if (branch) branch.loading = false;
      else this.loading = false;
      if (this.active) state.redraw();
    }
  }

  private renderBranches(
    state: SnapshotViewerState,
    branches: RetainerBranch[],
    depth = 0,
  ): m.Children {
    return branches.map((branch) => {
      const {reference} = branch;
      const object = reference.object;
      const cycle = branch.ancestry.includes(object.index);
      return [
        m(
          'div.pf-snapshot-viewer__retainer-row',
          {
            style: {paddingLeft: `${8 + depth * 16}px`},
            className: isOtherSlot(object.name, captureSlot(state, this.source))
              ? 'pf-snapshot-viewer__other-slot'
              : undefined,
          },
          [
            m(
              'button',
              {
                'disabled': cycle || depth >= 32,
                'aria-expanded': branch.expanded ?? false,
                'title': `${reference.type}: ${reference.name}`,
                'onclick': () => {
                  branch.expanded = !branch.expanded;
                  if (branch.expanded && branch.children === undefined) {
                    void this.load(state, object, branch);
                  }
                },
              },
              [
                cycle ? '↩ ' : branch.expanded ? '▾ ' : '▸ ',
                referenceLabel(reference),
                m('span.pf-snapshot-viewer__reference-separator', ' in '),
                objectLabel(object),
                reference.weak ? ' (weak / non-retaining)' : '',
                cycle ? ' (cycle)' : depth >= 32 ? ' (depth limit)' : '',
              ],
            ),
            object.sourceLocation
              ? sourceLabel(
                  object,
                  m(
                    'button.pf-snapshot-viewer__source-link',
                    {
                      'title':
                        object.sourceLocation.file ??
                        object.sourceLocation.script,
                      'aria-expanded': String(branch.sourceExpanded ?? false),
                      'onclick': () => {
                        branch.sourceExpanded = !branch.sourceExpanded;
                      },
                    },
                    [
                      branch.sourceExpanded ? '▾ ' : '▸ ',
                      sourceLinkLabel(object),
                    ],
                  ),
                )
              : null,
            m(
              'span.pf-snapshot-viewer__retainer-metrics',
              {title: 'Distance · Shallow Size · Retained Size'},
              `${object.distance < 0 ? '–' : object.distance} · ${formatMemoryBytes(object.shallowSize)} · ${formatMemoryBytes(object.retainedSize)}`,
            ),
            branch.sourceExpanded
              ? m('.pf-snapshot-viewer__retainer-source', sourceDetails(object))
              : null,
          ],
        ),
        branch.expanded
          ? [
              branch.children
                ? this.renderBranches(state, branch.children, depth + 1)
                : null,
              branch.loading || branch.error
                ? m(
                    '.pf-snapshot-viewer__message',
                    branch.error ?? 'Loading retainers...',
                  )
                : null,
              branch.children?.length === 0 && !branch.loading
                ? m(
                    '.pf-snapshot-viewer__message',
                    'No incoming references (root or untracked holder).',
                  )
                : null,
              branch.children && branch.total! > branch.children.length
                ? pagingControls(
                    branch.children.length,
                    branch.total!,
                    () => void this.load(state, object, branch),
                    () => void this.load(state, object, branch, true),
                    branch.loading,
                  )
                : null,
            ]
          : null,
      ];
    });
  }

  view({attrs}: m.Vnode<RetainerAttrs>): m.Children {
    return m('.pf-snapshot-viewer__retainer-tree', [
      this.renderBranches(attrs.state, this.branches),
      this.loading || this.error
        ? m(
            '.pf-snapshot-viewer__message',
            this.error ?? 'Loading retainers...',
          )
        : null,
      !this.loading && !this.error && this.total === 0
        ? m(
            '.pf-snapshot-viewer__message',
            'No incoming references (root or untracked holder).',
          )
        : null,
      this.branches.length < this.total
        ? pagingControls(
            this.branches.length,
            this.total,
            () => void this.load(attrs.state, attrs.object),
            () => void this.load(attrs.state, attrs.object, undefined, true),
            this.loading,
          )
        : null,
    ]);
  }
}
