// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import m from 'mithril';
import {Duration} from '../../../base/time';
import {Trace} from '../../../public/trace';
import {Anchor} from '../../../widgets/anchor';
import {DetailsShell} from '../../../widgets/details_shell';
import {GridLayout, GridLayoutColumn} from '../../../widgets/grid_layout';
import {Section} from '../../../widgets/section';
import {Tree, TreeNode} from '../../../widgets/tree';
import {Tooltip} from '../../../widgets/tooltip';
import {formatMemoryBytes} from './memory_format';
import {
  MemoryPageDetails,
  loadMemoryPageDetails,
  loadMemoryPageUrl,
  memoryPageBtsVmType,
} from './memory_page_details';
import {selectMemorySnapshot} from './memory_snapshots';

export interface MemoryPagePanelAttrs {
  trace: Trace;
  trackId: number;
  instanceId: number;
}

export class MemoryPageUrlTooltip
  implements m.ClassComponent<MemoryPagePanelAttrs>
{
  private url?: string;
  private loading = true;
  private active = true;

  oninit({attrs}: m.Vnode<MemoryPagePanelAttrs>) {
    void loadMemoryPageUrl(attrs.trace.engine, attrs.trackId, attrs.instanceId)
      .then((url) => {
        this.url = url;
      })
      .catch(() => {
        this.url = undefined;
      })
      .finally(() => {
        this.loading = false;
        if (this.active) {
          attrs.trace.raf.scheduleFullRedraw();
        }
      });
  }

  onremove() {
    this.active = false;
  }

  view(): m.Children {
    return m(
      'span',
      {style: {overflowWrap: 'anywhere'}},
      this.loading
        ? 'Loading URL...'
        : this.url ?? 'URL unavailable in this trace',
    );
  }
}

export class MemoryPagePanel implements m.ClassComponent<MemoryPagePanelAttrs> {
  private details?: MemoryPageDetails;
  private error?: string;
  private active = true;

  oninit({attrs}: m.Vnode<MemoryPagePanelAttrs>) {
    const {trace, trackId, instanceId} = attrs;
    void loadMemoryPageDetails(
      trace.engine,
      trackId,
      instanceId,
      trace.traceInfo.start,
      trace.traceInfo.end,
    )
      .then((details) => {
        this.details = details;
      })
      .catch((error: unknown) => {
        this.error = String(error);
      })
      .finally(() => {
        if (this.active) {
          trace.raf.scheduleFullRedraw();
        }
      });
  }

  onremove() {
    this.active = false;
  }

  private formatPeak(value: number | undefined): string {
    return value === undefined
      ? 'Unavailable in this trace'
      : formatMemoryBytes(value);
  }

  private renderBtsPeakLabel(shared: boolean): m.Children {
    return shared
      ? m(
          Tooltip,
          {
            trigger: m(
              'span',
              {style: {cursor: 'help'}},
              'BTS VM peak (shared) ?',
            ),
          },
          'Peak of the entire shared BTS VM heap during this page’s observed lifetime. Other pages can contribute to this value.',
        )
      : 'BTS VM peak';
  }

  view({attrs}: m.Vnode<MemoryPagePanelAttrs>): m.Children {
    const details = this.details;
    if (details === undefined) {
      return m(
        DetailsShell,
        {title: 'Memory Track', description: `Instance ${attrs.instanceId}`},
        this.error ?? 'Loading...',
      );
    }
    const {page} = details;
    const {start, end} = attrs.trace.traceInfo;
    const observedStart =
      page.createTs === undefined
        ? start
        : page.createTs > start
          ? page.createTs
          : start;
    const observedEnd =
      page.destroyTs === undefined
        ? end
        : page.destroyTs < end
          ? page.destroyTs
          : end;
    const lifetime = Duration.humanise(
      observedEnd > observedStart ? observedEnd - observedStart : 0n,
    );
    const partial = page.createTs === undefined || page.destroyTs === undefined;
    const lifetimeNotes = [
      page.createTs === undefined
        ? 'created before trace or creation event missing'
        : undefined,
      page.destroyTs === undefined
        ? 'alive at trace end or destruction event missing'
        : undefined,
    ].filter((note) => note !== undefined);

    return m(
      DetailsShell,
      {title: 'Memory Track', description: `Instance ${page.instanceId}`},
      m(
        GridLayout,
        m(
          GridLayoutColumn,
          m(
            Section,
            {title: 'Page Instance'},
            m(Tree, [
              m(TreeNode, {
                left: 'URL',
                right: m(
                  'span',
                  {style: {overflowWrap: 'anywhere'}},
                  page.url ?? 'Unavailable in this trace',
                ),
              }),
              m(TreeNode, {left: 'Instance ID', right: page.instanceId}),
              m(TreeNode, {
                left: 'Page lifetime',
                right: partial
                  ? `${lifetime} observed (${lifetimeNotes.join('; ')})`
                  : lifetime,
              }),
              m(TreeNode, {
                left: 'MTS VM type',
                right: page.mtsVmType ?? 'Unavailable in this trace',
              }),
              m(TreeNode, {
                left: 'BTS VM type',
                right: memoryPageBtsVmType(page) ?? 'Unavailable in this trace',
              }),
              page.btsVm?.shared
                ? m(TreeNode, {
                    left: 'Shared BTS VM',
                    right: `${page.btsVm.name}#${page.btsVm.generation}`,
                  })
                : null,
            ]),
          ),
        ),
        m(
          GridLayoutColumn,
          m(
            Section,
            {title: 'Peaks in This Trace'},
            m(Tree, [
              m(TreeNode, {
                left: 'Total memory peak',
                right: this.formatPeak(details.totalPeakBytes),
              }),
              m(TreeNode, {
                left: 'MTS VM peak',
                right: this.formatPeak(details.mtsPeakBytes),
              }),
              m(TreeNode, {
                left: this.renderBtsPeakLabel(page.btsVm?.shared ?? false),
                right: this.formatPeak(details.btsPeakBytes),
              }),
              page.btsVm?.shared
                ? m(TreeNode, {
                    left: 'BTS page slot peak',
                    right: this.formatPeak(details.btsPageSlotPeakBytes),
                  })
                : null,
              m(TreeNode, {
                left: 'TASM Element count peak',
                right:
                  details.tasmElementPeakCount?.toLocaleString() ??
                  'Unavailable in this trace',
              }),
            ]),
          ),
        ),
        details.snapshots.length > 0
          ? m(
              GridLayoutColumn,
              m(
                Section,
                {title: 'Snapshots'},
                m(
                  Tree,
                  details.snapshots.map((snapshot, index) =>
                    m(TreeNode, {
                      left: `${snapshot.kind === 'mts_instance' ? 'MTS' : 'BTS'} snapshot ${index + 1}`,
                      right: m(
                        Anchor,
                        {
                          onclick: () =>
                            selectMemorySnapshot(attrs.trace, snapshot),
                        },
                        snapshot.snapshotId || snapshot.id,
                      ),
                    }),
                  ),
                ),
              ),
            )
          : null,
      ),
    );
  }
}
