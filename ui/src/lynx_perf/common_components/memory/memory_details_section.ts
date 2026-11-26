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
import Chart, {
  ActiveElement,
  ChartEvent,
  Plugin,
  TooltipItem,
} from 'chart.js/auto';
import {Args, ArgsDict} from '../../../components/sql_utils/args';
import {Button} from '../../../widgets/button';
import {Checkbox} from '../../../widgets/checkbox';
import {Icons} from '../../../base/semantic_icons';
import {HTMLAttrs} from '../../../widgets/common';
import {TextInput} from '../../../widgets/text_input';
import {Tooltip} from '../../../widgets/tooltip';
import {Trace} from '../../../public/trace';
import {Duration, time, Time} from '../../../base/time';
import {lynxPerfGlobals} from '../../lynx_perf_globals';
import {MemoryTrackFocusFilter} from '../../types';
import {
  BtsVmSlotMemoryData,
  BtsVmSlotMemorySample,
  formatBtsVmSlotLabel,
  getBtsVmSlotPageStateAt,
} from './bts_vm_slot_memory';
import {formatMemoryBytes, formatMemoryDeltaBytes} from './memory_format';
import {selectMemorySnapshot} from './memory_snapshots';

interface Component {
  name: string;
  sizeBytes: number;
  instanceCount?: number;
  detail?: object;
}

interface Category {
  label: string;
  sizeBytes: number;
  components: Array<Component>;
}

interface MemoryDashboardAttrs {
  data?: ArgsDict;
}

const ComponentDetailContent: m.Component<{detail: object}> = {
  view({attrs}) {
    return m(
      'pre.pf-memory-component-detail',
      JSON.stringify(attrs.detail, null, 2),
    );
  },
};

function argToDisplayValue(value: Args): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value === null) {
    return '';
  }
  return JSON.stringify(value);
}

function renderResidualAccuracyHint(): m.Children {
  return m(
    Tooltip,
    {
      trigger: m(
        'span',
        {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '14px',
            height: '14px',
            borderRadius: '50%',
            border: '1px solid rgba(0, 0, 0, 0.35)',
            fontSize: '10px',
            cursor: 'help',
            opacity: '0.8',
          },
        },
        '?',
      ),
    },
    'Residual memory is inaccurate before GC.',
  );
}

function flattenTopLevelArgs(args: ArgsDict): Array<[string, Args]> {
  const flattened: Array<[string, Args]> = [];
  for (const [key, value] of Object.entries(args)) {
    if (value !== null && !Array.isArray(value) && typeof value === 'object') {
      for (const [childKey, childValue] of Object.entries(value)) {
        flattened.push([`${key}.${childKey}`, childValue]);
      }
    } else {
      flattened.push([key, value]);
    }
  }
  return flattened;
}

interface MemoryPssTotalPanelAttrs {
  data?: ArgsDict;
  trace: Trace;
}

interface BtsVmMemoryPanelAttrs {
  trace: Trace;
  vmName: string;
  vmType: string;
  accumulateBytes: number;
  rssBytes: number;
  slotBytes: Readonly<Record<number, number>>;
  slotInstanceIds: Readonly<Record<number, ReadonlyArray<number>>>;
  slotDestroyedInstanceIds: Readonly<Record<number, ReadonlyArray<number>>>;
  slotResidualAccurate: Readonly<Record<number, boolean>>;
  slotPageUrls: Readonly<Record<number, Readonly<Record<number, string>>>>;
  slotSnapshotSliceIds: Readonly<
    Record<number, Readonly<Record<number, number>>>
  >;
  annotations?: Args;
}

interface BtsVmSlotAreaPanelAttrs {
  trackName: string;
  displayName: string;
  start: time;
  end: time;
  data: BtsVmSlotMemoryData;
}

interface SectionWithRightContentAttrs extends HTMLAttrs {
  title: string;
  rightContent?: m.Children;
  extraContent?: m.Children;
}

interface MemoryPssFocusControlsAttrs {
  data?: ArgsDict;
  trace: Trace;
}

interface BtsVmPageMemorySummary {
  instanceId: number;
  url: string;
  btsMemoryBytes?: number;
}

interface DestroyedBtsVmPageMemorySummary extends BtsVmPageMemorySummary {
  isResidualAccurate: boolean;
  snapshotSliceId?: number;
}

interface MtsVmPoolMemoryDetails {
  url: string;
  instanceCount: number;
  sizeBytes: number;
  rssSizeBytes: number;
}

interface AliveMemorySummary {
  componentCounts: Record<string, number>;
  elementCount: number;
  mainThreadScriptingEngines: Array<{
    instanceId: number;
    desc: string;
    sizeBytes: number;
    rssSizeBytes: number;
    url: string;
  }>;
  backgroundThreadScriptingEngines: Record<
    string,
    {
      // The unique display name has the form "name(generation)".
      btsEngineName: string;
      desc: string;
      sizeBytes: number;
      rssSizeBytes: number;
      instanceIds: number[];
      instances: BtsVmPageMemorySummary[];
      destroyedInstances: DestroyedBtsVmPageMemorySummary[];
    }
  >;
  totalEngineSizeBytes: number;
  totalEngineRssSizeBytes: number;
  btsVmPoolSizeBytes: number;
  btsVmPoolRssSizeBytes: number;
  mtsVmPoolSizeBytes: number;
  mtsVmPoolRssSizeBytes: number;
  mtsVmPools: MtsVmPoolMemoryDetails[];
  totalVmPoolSizeBytes: number;
  totalVmPoolRssSizeBytes: number;
}

interface MemoryFocusTarget {
  instanceId: number;
  btsEngineName: string;
  url: string;
}

interface PssMemoryDeltas {
  physicalMemorySizeBytes: number;
  totalEngineSizeBytes: number;
  totalEngineRssSizeBytes: number;
  totalBtsEngineSizeBytes: number;
  totalBtsEngineRssSizeBytes: number;
  totalMtsEngineSizeBytes: number;
  totalMtsEngineRssSizeBytes: number;
  btsEngineSizeBytes: Record<string, number>;
  btsEngineRssSizeBytes: Record<string, number>;
}

type MemoryPssTotalMode = 'acc' | 'rss';

let memoryPssTotalMode: MemoryPssTotalMode = 'acc';
let showDestroyedBtsPages = true;

interface HoverTableRow {
  cells: m.Children[];
  dimmed?: boolean;
  sectionHeader?: boolean;
}

interface HoverTableOptions {
  hideHeader?: boolean;
  marginBottom?: string;
}

class SectionWithRightContent
  implements m.ClassComponent<SectionWithRightContentAttrs>
{
  view({attrs, children}: m.CVnode<SectionWithRightContentAttrs>) {
    const {title, rightContent, extraContent, ...htmlAttrs} = attrs;
    return m(
      'section.pf-section',
      htmlAttrs,
      [
        m(
          'header',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '8px',
            },
          },
          [m('h1', title), rightContent],
        ),
        extraContent === undefined
          ? null
          : m(
              'div',
              {
                style: {
                  margin: '0 0 12px',
                },
              },
              extraContent,
            ),
      ],
      m('article', children),
    );
  }
}

class MemoryPssFocusControls
  implements m.ClassComponent<MemoryPssFocusControlsAttrs>
{
  private lastData?: ArgsDict;
  private matchedInstanceIds: Set<number> = new Set();

  oninit(vnode: m.Vnode<MemoryPssFocusControlsAttrs>) {
    this.updateFocusedTracks(vnode.attrs);
  }

  onupdate(vnode: m.Vnode<MemoryPssFocusControlsAttrs>) {
    if (this.lastData !== vnode.attrs.data) {
      this.updateFocusedTracks(vnode.attrs);
    }
  }

  private getDebugArgValue(
    data: ArgsDict | undefined,
    key: string,
  ): string | undefined {
    const value = data?.debug;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }
    const arg = value[key];
    if (typeof arg === 'string') {
      return arg;
    }
    return arg === undefined ? undefined : argToDisplayValue(arg);
  }

  private getAliveMemorySummary(
    data?: ArgsDict,
  ): AliveMemorySummary | undefined {
    const summaryValue = this.getDebugArgValue(data, 'alive_memory_summary');
    if (summaryValue === undefined) {
      return undefined;
    }

    try {
      return JSON.parse(summaryValue) as AliveMemorySummary;
    } catch {
      return undefined;
    }
  }

  private getAllMemoryFocusTargets(data?: ArgsDict): MemoryFocusTarget[] {
    const targetsValue = this.getDebugArgValue(
      data,
      'all_memory_focus_targets',
    );
    if (targetsValue === undefined) {
      return [];
    }

    try {
      const targets = JSON.parse(targetsValue) as unknown;
      if (!Array.isArray(targets)) {
        return [];
      }
      return targets
        .map((target) => {
          if (typeof target !== 'object' || target === null) {
            return undefined;
          }
          const record = target as Record<string, unknown>;
          const instanceId = Number(record.instanceId);
          if (!Number.isFinite(instanceId)) {
            return undefined;
          }
          return {
            instanceId,
            btsEngineName:
              typeof record.btsEngineName === 'string'
                ? record.btsEngineName
                : '',
            url: typeof record.url === 'string' ? record.url : '',
          };
        })
        .filter((target): target is MemoryFocusTarget => target !== undefined);
    } catch {
      return [];
    }
  }

  private filtersActive(filter: MemoryTrackFocusFilter): boolean {
    return filter.btsEngine.trim() !== '' || filter.url.trim() !== '';
  }

  private computeMatchedInstanceIds(
    data: ArgsDict | undefined,
    filter: MemoryTrackFocusFilter,
  ): Set<number> {
    const btsFilter = filter.btsEngine.trim().toLowerCase();
    const urlFilter = filter.url.trim().toLowerCase();
    if (btsFilter === '' && urlFilter === '') {
      return new Set();
    }

    return filter.focusAlive
      ? this.computeAliveMatchedInstanceIds(data, btsFilter, urlFilter)
      : this.computeAllMatchedInstanceIds(data, btsFilter, urlFilter);
  }

  private computeAliveMatchedInstanceIds(
    data: ArgsDict | undefined,
    btsFilter: string,
    urlFilter: string,
  ): Set<number> {
    const summary = this.getAliveMemorySummary(data);
    if (summary === undefined) {
      return new Set();
    }

    const matched = new Set<number>();
    for (const engineInfo of Object.values(
      summary.backgroundThreadScriptingEngines,
    )) {
      if (
        btsFilter !== '' &&
        !engineInfo.btsEngineName.toLowerCase().includes(btsFilter)
      ) {
        continue;
      }

      if (urlFilter === '') {
        engineInfo.instanceIds.forEach((instanceId) => matched.add(instanceId));
        continue;
      }

      for (const instance of engineInfo.instances) {
        if (instance.url.toLowerCase().includes(urlFilter)) {
          matched.add(instance.instanceId);
        }
      }
    }
    if (btsFilter === '' && urlFilter !== '') {
      for (const engineInfo of summary.mainThreadScriptingEngines) {
        if (engineInfo.url.toLowerCase().includes(urlFilter)) {
          matched.add(engineInfo.instanceId);
        }
      }
    }
    return matched;
  }

  private computeAllMatchedInstanceIds(
    data: ArgsDict | undefined,
    btsFilter: string,
    urlFilter: string,
  ): Set<number> {
    const matched = new Set<number>();
    for (const target of this.getAllMemoryFocusTargets(data)) {
      if (
        btsFilter !== '' &&
        !target.btsEngineName.toLowerCase().includes(btsFilter)
      ) {
        continue;
      }
      if (urlFilter !== '' && !target.url.toLowerCase().includes(urlFilter)) {
        continue;
      }
      matched.add(target.instanceId);
    }
    return matched;
  }

  private updateFocusedTracks(attrs: MemoryPssFocusControlsAttrs) {
    this.lastData = attrs.data;
    this.matchedInstanceIds = this.computeMatchedInstanceIds(
      attrs.data,
      lynxPerfGlobals.memoryTrackFocusFilter,
    );
    lynxPerfGlobals.updateFocusedMemoryTrackInstanceIds(
      this.matchedInstanceIds,
    );
    attrs.trace.raf.scheduleFullRedraw();
  }

  private updateFilter(
    attrs: MemoryPssFocusControlsAttrs,
    filter: Partial<MemoryTrackFocusFilter>,
  ) {
    lynxPerfGlobals.updateMemoryTrackFocusFilter(filter);
    this.updateFocusedTracks(attrs);
  }

  private renderFocusAliveCheckbox(
    attrs: MemoryPssFocusControlsAttrs,
    filter: MemoryTrackFocusFilter,
  ): m.Children {
    return m(
      'div',
      {
        style: {
          display: 'flex',
          alignItems: 'center',
          flex: '0 0 auto',
          minHeight: '32px',
        },
      },
      m(Checkbox, {
        label: 'Focus Alive',
        checked: filter.focusAlive,
        onclick: () => {
          this.updateFilter(attrs, {focusAlive: !filter.focusAlive});
        },
      }),
    );
  }

  private renderInput(
    label: string,
    value: string,
    placeholder: string,
    onInput: (value: string) => void,
  ): m.Children {
    return m(
      'label',
      {
        style: {
          display: 'flex',
          flex: '1 1 380px',
          alignItems: 'center',
          gap: '8px',
          minWidth: '360px',
          fontSize: '12px',
          fontWeight: '600',
        },
      },
      [
        m('span', {style: {flex: '0 0 auto', whiteSpace: 'nowrap'}}, label),
        m(TextInput, {
          value,
          placeholder,
          onInput,
          style: {flex: '1 1 260px', minWidth: '240px'},
        }),
      ],
    );
  }

  view(vnode: m.Vnode<MemoryPssFocusControlsAttrs>): m.Children {
    const filter = lynxPerfGlobals.memoryTrackFocusFilter;
    const matchedCount = this.matchedInstanceIds.size;
    const filtersActive = this.filtersActive(filter);
    return m(
      'div',
      {
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
          margin: '8px 12px 0',
        },
      },
      [
        m(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '10px',
            },
          },
          [
            this.renderFocusAliveCheckbox(vnode.attrs, filter),
            this.renderInput(
              'Focus BTS Engine',
              filter.btsEngine,
              'engine group name',
              (value) => {
                this.updateFilter(vnode.attrs, {btsEngine: value});
              },
            ),
            this.renderInput(
              'Focus URL',
              filter.url,
              'URL substring',
              (value) => {
                this.updateFilter(vnode.attrs, {url: value});
              },
            ),
          ],
        ),
        filtersActive
          ? m(
              'div',
              {
                style: {
                  color: '#64748b',
                  fontSize: '12px',
                },
              },
              `Matched memory tracks: ${matchedCount} (${
                filter.focusAlive ? 'alive pages' : 'all pages'
              })`,
            )
          : null,
      ],
    );
  }
}

class MemoryDashboard implements m.ClassComponent<MemoryDashboardAttrs> {
  private totalMemory: number = 0;
  private currentCategory: Category | undefined;
  private chartInstance: Chart | null = null;
  private categories: Map<string, Category> = new Map();
  private currentImageDetail: Component | null = null;
  private url: string = '';

  oninit(vnode: m.Vnode<MemoryDashboardAttrs>) {
    this.totalMemory = 0;
    this.chartInstance = null;

    if (vnode.attrs.data !== undefined) {
      this.processData(vnode.attrs.data);
      this.currentCategory = this.categories.get('UI');
      this.currentImageDetail = null;
    }
  }

  onupdate(vnode: m.Vnode<MemoryDashboardAttrs>) {
    if (vnode.attrs.data !== undefined) {
      this.processData(vnode.attrs.data);
    }
  }

  onremove() {
    if (this.chartInstance !== null) {
      this.chartInstance.destroy();
    }
  }

  private processData(data: ArgsDict) {
    this.url = '';
    const mainCategoriesKeys = [
      'backgroundThreadScriptingEngine',
      'mainThreadScriptingEngine',
      'lynxTasmElement',
    ];
    const categories: Map<string, Category> = new Map([
      [
        'backgroundThreadScriptingEngine',
        {label: 'BTS Engine', sizeBytes: 0, components: []},
      ],
      [
        'mainThreadScriptingEngine',
        {label: 'MTS Engine', sizeBytes: 0, components: []},
      ],
      [
        'lynxTasmElement',
        {label: 'Lynx TASM Element', sizeBytes: 0, components: []},
      ],
      ['UI', {label: 'UI Components', sizeBytes: 0, components: []}],
    ]);
    for (const [flatKey, argValue] of flattenTopLevelArgs(data)) {
      const displayValue = argToDisplayValue(argValue);
      if (
        flatKey === 'legacy_event.passthrough_utid' ||
        flatKey === 'debug.instance_id'
      ) {
        continue;
      }
      if (flatKey === 'debug.sizeBytes') {
        this.totalMemory = parseInt(displayValue, 10) || 0;
        continue;
      }
      if (flatKey === 'debug.url') {
        this.url = displayValue;
        continue;
      }
      const key = flatKey.slice(6);
      try {
        const item = JSON.parse(displayValue);

        if (
          typeof item === 'object' &&
          item !== null &&
          Object.prototype.hasOwnProperty.call(item, 'sizeBytes')
        ) {
          const size = parseInt(item.sizeBytes, 10) || 0;
          let category: Category | undefined;
          if (mainCategoriesKeys.includes(key)) {
            category = categories.get(key);
          } else {
            category = categories.get('UI');
          }
          if (category) {
            category.sizeBytes += size;
            category.components.push({name: key, sizeBytes: size, ...item});
          }
        }
      } catch (e) {
        // Skip invalid JSON
        continue;
      }
    }

    this.categories = categories;
  }

  private renderChart(): m.Vnode {
    if (this.categories.size === 0) {
      return m(
        'div.chart-placeholder',
        {
          style: {
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#666',
            fontSize: '14px',
          },
        },
        'No Data',
      );
    }

    const categoriesArray = Array.from(this.categories.values());
    const colors = ['#3e95cd', '#8e5ea2', '#3cba9f', '#e8c3b9', '#c45850'];

    const chartData = {
      labels: categoriesArray.map((c) => c.label),
      datasets: [
        {
          data: categoriesArray.map((c) => c.sizeBytes),
          backgroundColor: colors.slice(0, categoriesArray.length),
          borderWidth: 0,
          hoverBorderWidth: 2,
          hoverBorderColor: '#fff',
        },
      ],
    };

    return m('canvas', {
      style: {
        width: '100%',
        height: '100%',
      },
      oncreate: (vnode: m.VnodeDOM) => {
        const canvas = vnode.dom as HTMLCanvasElement;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          // Destroy previous chart instance
          if (this.chartInstance !== null) {
            this.chartInstance.destroy();
          }

          this.chartInstance = new Chart(ctx, {
            type: 'doughnut',
            data: chartData,
            options: {
              responsive: true,
              maintainAspectRatio: true,
              cutout: '70%',
              animation: {
                animateRotate: true,
                duration: 1000,
              },
              plugins: {
                legend: {display: false},
                tooltip: {
                  backgroundColor: 'rgba(0, 0, 0, 0.8)',
                  titleColor: '#fff',
                  bodyColor: '#fff',
                  borderColor: '#333',
                  borderWidth: 1,
                  callbacks: {
                    label: (tooltipItem: TooltipItem<'doughnut'>) => {
                      const label = tooltipItem.label ?? '';
                      const value = Number(tooltipItem.raw) || 0;
                      const percentage =
                        this.totalMemory > 0
                          ? ((value / this.totalMemory) * 100).toFixed(2)
                          : '0';
                      return `${label}: ${formatMemoryBytes(value)} (${percentage}%)`;
                    },
                  },
                },
              },
              onClick: (_: ChartEvent, elements: ActiveElement[]) => {
                if (elements.length > 0) {
                  const index = elements[0].index;
                  const category = categoriesArray[index];
                  this.currentCategory = category;
                  this.currentImageDetail = null;
                  m.redraw();
                }
              },
            },
          });
        }
      },
      onupdate: (_: m.VnodeDOM) => {
        if (this.chartInstance !== null) {
          // Update chart data
          this.chartInstance.data = chartData;
          this.chartInstance.update('none');
        }
      },
    });
  }

  private renderLegend(): m.Vnode[] {
    if (this.categories.size === 0) return [];

    const colors = ['#3e95cd', '#8e5ea2', '#3cba9f', '#e8c3b9', '#c45850'];

    return Array.from(this.categories.values()).map((category, index) => {
      const percentage =
        this.totalMemory > 0
          ? ((category.sizeBytes / this.totalMemory) * 100).toFixed(2)
          : '0';
      const isSelected = this.currentCategory?.label === category.label;

      return m(
        '.legend-item',
        {
          onclick: () => {
            this.currentImageDetail = null;
            this.currentCategory = category;
          },
          style: {
            display: 'flex',
            alignItems: 'center',
            cursor: 'pointer',
            padding: '8px',
            borderRadius: '4px',
            backgroundColor: isSelected ? 'rgba(0, 0, 0, 0.1)' : 'transparent',
            transition: 'background-color 0.2s ease',
          },
          onmouseover: (e: Event) => {
            if (!isSelected) {
              (e.currentTarget as HTMLElement).style.backgroundColor =
                'rgba(0, 0, 0, 0.05)';
            }
          },
          onmouseout: (e: Event) => {
            if (!isSelected) {
              (e.currentTarget as HTMLElement).style.backgroundColor =
                'transparent';
            }
          },
        },
        [
          m('.legend-color', {
            style: {
              width: '12px',
              height: '12px',
              borderRadius: '2px',
              marginRight: '8px',
              backgroundColor: colors[index % colors.length],
              flexShrink: 0,
            },
          }),
          m(
            '.legend-label',
            {
              style: {
                flex: 1,
                fontSize: '14px',
                // fontWeight: isSelected ? '500' : '400',
              },
            },
            category.label,
          ),
          m(
            '.legend-value',
            {
              style: {
                fontSize: '12px',
                opacity: '0.8',
                fontWeight: '400',
                whiteSpace: 'nowrap',
              },
            },
            `${formatMemoryBytes(category.sizeBytes)} (${percentage}%)`,
          ),
        ],
      );
    });
  }

  private renderUITable(components: Category['components']): m.Vnode {
    const sortedComponents = [...components].sort(
      (a, b) => b.sizeBytes - a.sizeBytes,
    );

    return m(
      'table',
      {
        style: {
          width: '100%',
          tableLayout: 'fixed',
        },
      },
      [
        m('thead', [
          m('tr', [
            m(
              'th',
              {
                style: {
                  width: '40%',
                },
              },
              'Component',
            ),
            m(
              'th',
              {
                style: {
                  width: '15%',
                },
              },
              'Count',
            ),
            m(
              'th',
              {
                style: {
                  width: '25%',
                },
              },
              'MemorySize',
            ),
            m(
              'th',
              {
                style: {
                  width: '20%',
                },
              },
              'Percentage',
            ),
          ]),
        ]),
        m(
          'tbody',
          sortedComponents.map((component) => {
            const percentage =
              this.totalMemory > 0
                ? ((component.sizeBytes / this.totalMemory) * 100).toFixed(2)
                : 0;

            return m(
              'tr.ui-component-item',
              {
                style: {cursor: 'pointer'},
                onclick: () => {
                  if (component.name === 'image') {
                    this.currentImageDetail = component;
                    m.redraw();
                  }
                },
              },
              [
                m(
                  'td',
                  component.detail !== undefined && component.detail !== null
                    ? m(
                        Tooltip,
                        {
                          trigger: m(
                            'span.pf-memory-component-name',
                            component.name,
                          ),
                          className: 'pf-memory-component-detail-tooltip',
                        },
                        m(ComponentDetailContent, {
                          detail: component.detail,
                        }),
                      )
                    : component.name,
                ),
                m('td', component.instanceCount ?? 'N/A'),
                m('td', formatMemoryBytes(component.sizeBytes)),
                m('td', `${percentage}%`),
              ],
            );
          }),
        ),
      ],
    );
  }

  private renderGenericTable(detail: object): m.Vnode {
    return m('table', [
      m('thead', [m('tr', [m('th', 'Key'), m('th', 'Value')])]),
      m(
        'tbody',
        Object.entries(detail).map(([key, value]) =>
          m('tr', [m('td', key), m('td', String(value))]),
        ),
      ),
    ]);
  }

  private renderImageDetails(image: Component) {
    if (!image.detail) {
      return [m('p', 'No image data')];
    }

    const images = Object.entries(image.detail)
      .map(([url, size]) => ({
        url,
        size: parseInt(String(size), 10),
      }))
      .sort((a, b) => b.size - a.size);

    return [
      m(
        '.details-header',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: '16px',
          },
        },
        [
          m(
            'h3',
            {
              style: {
                margin: '0',
                fontSize: '1.1em',
              },
            },
            'Image Component Details',
          ),
          m(Button, {
            icon: Icons.GoBack,
            onclick: () => {
              this.currentImageDetail = null;
              this.currentCategory = this.categories.get('UI')!;
              m.redraw();
            },
            label: 'Back',
          }),
        ],
      ),
      m(
        'table',
        {
          style: {
            width: '100%',
            tableLayout: 'fixed',
          },
        },
        [
          m('thead', [
            m('tr', [
              m(
                'th',
                {
                  style: {
                    width: '50%',
                  },
                },
                'URL',
              ),
              m(
                'th',
                {
                  style: {
                    width: '30%',
                  },
                },
                'Memory Usage',
              ),
              m(
                'th',
                {
                  style: {
                    width: '20%',
                  },
                },
                '% of Total',
              ),
            ]),
          ]),
          m(
            'tbody',
            images.map((image) => {
              const percentage =
                this.totalMemory > 0
                  ? ((image.size / this.totalMemory) * 100).toFixed(2)
                  : 0;
              return m('tr', [
                m(
                  'td',
                  {
                    style: {
                      maxWidth: '300px',
                      wordBreak: 'break-all',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    },
                    title: image.url, // Show full URL on hover
                  },
                  image.url,
                ),
                m('td', formatMemoryBytes(image.size)),
                m('td', `${percentage}%`),
              ]);
            }),
          ),
        ],
      ),
    ];
  }

  private renderDetails(): m.Children {
    // If there are image details to display, prioritize showing image details
    if (this.currentImageDetail) {
      return this.renderImageDetails(this.currentImageDetail);
    }

    if (!this.currentCategory) {
      return m(
        'p',
        'Please click on a module in the chart or legend to view detailed information.',
      );
    }

    let content: m.Children;
    if (this.currentCategory.label === 'UI Components') {
      content = this.renderUITable(this.currentCategory.components);
    } else if (
      this.currentCategory.components.length > 0 &&
      this.currentCategory.components[0].detail !== undefined
    ) {
      content = this.renderGenericTable(
        this.currentCategory.components[0].detail,
      );
    } else {
      content = m(
        'p',
        'No detailed component information available for this module.',
      );
    }

    return [
      m(
        '.details-header',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: '16px',
          },
        },
        [
          m(
            'h3',
            {
              style: {
                margin: '0',
                fontSize: '1.1em',
              },
            },
            `${this.currentCategory.label} Details`,
          ),
        ],
      ),
      content,
    ];
  }

  view(_vnode: m.Vnode<MemoryDashboardAttrs>): m.Children {
    return m(
      'div',
      {
        style: {
          width: '100%',
          fontFamily: '"Roboto Condensed", sans-serif',
          fontSize: '14px',
        },
      },
      [
        // URL display row
        this.url
          ? m(
              '.url-display',
              {
                style: {
                  marginBottom: '16px',
                  padding: '8px 12px',
                  backgroundColor: 'rgba(0, 0, 0, 0.02)',
                  borderRadius: '4px',
                  fontSize: '12px',
                  color: '#666',
                  display: 'flex',
                  alignItems: 'flex-start',
                },
              },
              [
                m(
                  'span',
                  {
                    style: {
                      fontWeight: '500',
                      marginRight: '8px',
                      flex: 'none',
                    },
                  },
                  'URL:',
                ),
                m(
                  'span',
                  {
                    style: {
                      flex: '1',
                      minWidth: '0',
                      whiteSpace: 'normal',
                      overflowWrap: 'anywhere',
                      wordBreak: 'break-word',
                    },
                    title: this.url,
                  },
                  this.url,
                ),
              ],
            )
          : null,
        // Main content with dashboard and details panel
        m(
          'div',
          {
            style: {
              display: 'flex',
              gap: '16px',
              width: '100%',
            },
          },
          [
            m(
              '.dashboard',
              {
                style: {
                  flex: '1',
                  display: 'flex',
                  flexDirection: 'column',
                  minWidth: '250px',
                },
              },
              [
                m(
                  '.chart-container.pf-memory-doughnut-chart',
                  {
                    style: {
                      margin: '0 auto 16px auto',
                    },
                  },
                  [
                    this.renderChart(),
                    this.totalMemory > 0
                      ? m(
                          '.total-memory',
                          {
                            style: {
                              position: 'absolute',
                              top: '50%',
                              left: '50%',
                              transform: 'translate(-50%, -50%)',
                              textAlign: 'center',
                            },
                          },
                          [
                            m(
                              '.value',
                              {
                                style: {
                                  fontSize: '1.5em',
                                  fontWeight: 'bold',
                                },
                              },
                              formatMemoryBytes(this.totalMemory),
                            ),
                            m(
                              '.label',
                              {
                                style: {
                                  fontSize: '0.8em',
                                  opacity: '0.7',
                                },
                              },
                              'Total Memory',
                            ),
                          ],
                        )
                      : null,
                  ],
                ),
                m(
                  '.legend-container',
                  {
                    style: {
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '8px',
                    },
                  },
                  this.renderLegend(),
                ),
              ],
            ),
            m(
              '.details-panel',
              {
                style: {
                  flex: '1',
                  minWidth: '300px',
                },
              },
              [m('.details-content', this.renderDetails())],
            ),
          ],
        ),
      ],
    );
  }
}

class MemoryPssTotalModeSelector implements m.ClassComponent {
  private showMemoryModeTooltip = false;

  view(): m.Children {
    return m(
      'div',
      {
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: '6px',
          fontSize: '12px',
        },
      },
      [
        m('span', {style: {fontWeight: 'bold'}}, 'Memory Mode'),
        m(
          'span',
          {
            style: {
              position: 'relative',
              display: 'inline-flex',
            },
            onmouseover: () => {
              this.showMemoryModeTooltip = true;
              m.redraw();
            },
            onmouseout: () => {
              this.showMemoryModeTooltip = false;
              m.redraw();
            },
          },
          [
            m(
              'span',
              {
                style: {
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: '14px',
                  height: '14px',
                  borderRadius: '50%',
                  border: '1px solid rgba(0, 0, 0, 0.35)',
                  fontSize: '10px',
                  cursor: 'help',
                  opacity: '0.8',
                },
              },
              '?',
            ),
            this.showMemoryModeTooltip
              ? m(
                  'div',
                  {
                    style: {
                      position: 'absolute',
                      top: '20px',
                      right: '0',
                      zIndex: '10',
                      width: '360px',
                      padding: '8px 10px',
                      borderRadius: '4px',
                      backgroundColor: 'rgba(32, 32, 32, 0.95)',
                      color: '#fff',
                      fontSize: '12px',
                      lineHeight: '1.4',
                      boxShadow: '0 2px 8px rgba(0, 0, 0, 0.25)',
                    },
                  },
                  [
                    m(
                      'div',
                      {
                        style: {
                          fontWeight: 'bold',
                          fontSize: '13px',
                        },
                      },
                      'Accumulate',
                    ),
                    m(
                      'div',
                      {
                        style: {
                          marginBottom: '16px',
                        },
                      },
                      'Accumulated memory usage of all surviving JavaScript objects.',
                    ),
                    m(
                      'div',
                      {
                        style: {
                          fontWeight: 'bold',
                          fontSize: '13px',
                        },
                      },
                      'Resident Set',
                    ),
                    m(
                      'div',
                      'Engine-related memory page usage resident in physical memory.',
                    ),
                  ],
                )
              : null,
          ],
        ),
        m(
          'select',
          {
            value: memoryPssTotalMode,
            onchange: (e: Event) => {
              memoryPssTotalMode = (e.currentTarget as HTMLSelectElement)
                .value as MemoryPssTotalMode;
              m.redraw();
            },
            style: {
              fontSize: '12px',
              padding: '2px 6px',
            },
          },
          [
            m('option', {value: 'acc'}, 'Accumulate'),
            m('option', {value: 'rss'}, 'Resident Set'),
          ],
        ),
      ],
    );
  }
}

class BtsVmMemoryPanel implements m.ClassComponent<BtsVmMemoryPanelAttrs> {
  private slotChartInstance: Chart<'doughnut'> | null = null;
  private slotTooltipElement: HTMLDivElement | null = null;
  private renderedSlotBytes?: Readonly<Record<number, number>>;
  private renderedSlotInstanceIds?: Readonly<
    Record<number, ReadonlyArray<number>>
  >;
  private renderedSlotDestroyedInstanceIds?: Readonly<
    Record<number, ReadonlyArray<number>>
  >;
  private renderedSlotResidualAccurate?: Readonly<Record<number, boolean>>;
  private renderedSlotPageUrls?: Readonly<
    Record<number, Readonly<Record<number, string>>>
  >;

  onremove() {
    this.destroySlotChart();
  }

  private destroySlotChart() {
    this.slotChartInstance?.destroy();
    this.slotChartInstance = null;
    this.slotTooltipElement?.remove();
    this.slotTooltipElement = null;
  }

  private renderSummaryCard(
    label: string,
    value: m.Children,
    exactBytes?: number,
  ): m.Children {
    return m(
      'div',
      {
        style: {
          minWidth: '0',
          padding: '12px',
          border: '1px solid rgba(0, 0, 0, 0.08)',
          borderRadius: '4px',
          backgroundColor: 'rgba(0, 0, 0, 0.02)',
        },
      },
      [
        m(
          'div',
          {
            style: {
              marginBottom: '6px',
              color: '#666',
              fontSize: '11px',
              fontWeight: '500',
              textTransform: 'uppercase',
            },
          },
          label,
        ),
        m(
          'div',
          {
            style: {
              fontSize: '16px',
              fontWeight: '500',
              overflowWrap: 'anywhere',
            },
          },
          value,
        ),
        exactBytes === undefined
          ? null
          : m(
              'div',
              {
                style: {
                  marginTop: '4px',
                  color: '#777',
                  fontSize: '11px',
                  overflowWrap: 'anywhere',
                },
              },
              `${exactBytes.toLocaleString()} bytes`,
            ),
      ],
    );
  }

  private formatAnnotations(annotations: Args): string {
    if (
      annotations === null ||
      typeof annotations === 'string' ||
      typeof annotations === 'number' ||
      typeof annotations === 'boolean' ||
      typeof annotations === 'bigint'
    ) {
      return argToDisplayValue(annotations);
    }

    return JSON.stringify(
      annotations,
      (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      2,
    );
  }

  private getSlotTooltipElement(): HTMLDivElement {
    if (this.slotTooltipElement !== null) {
      return this.slotTooltipElement;
    }
    const element = document.createElement('div');
    Object.assign(element.style, {
      position: 'fixed',
      display: 'none',
      maxWidth: 'min(460px, calc(100vw - 24px))',
      padding: '10px 12px',
      borderRadius: '4px',
      backgroundColor: 'rgba(0, 0, 0, 0.82)',
      boxShadow: '0 2px 8px rgba(0, 0, 0, 0.24)',
      color: '#fff',
      fontFamily: '"Roboto Condensed", sans-serif',
      fontSize: '12px',
      lineHeight: '1.4',
      overflowWrap: 'anywhere',
      pointerEvents: 'none',
      whiteSpace: 'normal',
      zIndex: '10000',
    });
    document.body.appendChild(element);
    this.slotTooltipElement = element;
    return element;
  }

  private renderSlotTooltip(
    canvas: HTMLCanvasElement,
    opacity: number,
    caretX: number,
    caretY: number,
    dataIndex: number | undefined,
    slotIds: ReadonlyArray<number>,
    values: ReadonlyArray<number>,
    total: number,
    attrs: BtsVmMemoryPanelAttrs,
  ) {
    const element = this.getSlotTooltipElement();
    if (opacity === 0 || dataIndex === undefined) {
      element.style.display = 'none';
      return;
    }
    const slotId = slotIds[dataIndex];
    if (slotId === undefined) {
      element.style.display = 'none';
      return;
    }

    const value = values[dataIndex] ?? 0;
    const percentage = total === 0 ? 0 : (value / total) * 100;
    const destroyedInstanceIds = attrs.slotDestroyedInstanceIds[slotId] ?? [];
    const destroyedInstanceIdSet = new Set(destroyedInstanceIds);
    const isDestroyed = destroyedInstanceIds.length > 0;
    const isResidualAccurate = attrs.slotResidualAccurate[slotId] ?? false;
    const title = document.createElement('div');
    title.style.fontWeight = '600';
    title.style.marginBottom = '6px';
    title.textContent = formatBtsVmSlotLabel(
      slotId,
      attrs.slotInstanceIds[slotId],
      destroyedInstanceIds,
    );

    const valueRow = document.createElement('div');
    Object.assign(valueRow.style, {
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: '6px',
    });
    const color = document.createElement('span');
    Object.assign(color.style, {
      width: '10px',
      height: '10px',
      flexShrink: '0',
      border: `1px solid ${btsVmSlotColor(slotId).border}`,
      backgroundColor: btsVmSlotColor(slotId).fill,
    });
    const memory = document.createElement('span');
    memory.textContent = isDestroyed
      ? formatMemoryBytes(value)
      : `${formatMemoryBytes(value)} (${percentage.toFixed(1)}%)`;
    valueRow.append(color, memory);
    if (isDestroyed && !isResidualAccurate) {
      const warning = document.createElement('span');
      warning.textContent = 'Residual memory is inaccurate before GC.';
      valueRow.append(warning);
    }

    const content: HTMLElement[] = [title, valueRow];
    for (const instanceId of attrs.slotInstanceIds[slotId] ?? []) {
      const instance = document.createElement('div');
      instance.style.marginTop = '8px';

      const instanceIdLine = document.createElement('div');
      const destroyed = destroyedInstanceIdSet.has(instanceId)
        ? ', destroyed'
        : '';
      instanceIdLine.textContent = `instance_id=${instanceId}${destroyed}`;

      const urlLine = document.createElement('div');
      urlLine.style.overflowWrap = 'anywhere';
      urlLine.textContent = `URL: ${
        attrs.slotPageUrls[slotId]?.[instanceId] ?? 'Unknown URL'
      }`;

      instance.append(instanceIdLine, urlLine);
      content.push(instance);
    }

    const footer = document.createElement('div');
    Object.assign(footer.style, {
      marginTop: '8px',
      paddingTop: '6px',
      borderTop: '1px solid rgba(255, 255, 255, 0.24)',
      fontWeight: '600',
    });
    footer.textContent = `Total: ${formatMemoryBytes(total)}`;
    content.push(footer);

    element.replaceChildren(...content);
    element.style.display = 'block';

    const canvasRect = canvas.getBoundingClientRect();
    const tooltipRect = element.getBoundingClientRect();
    const viewportMargin = 8;
    const anchorGap = 12;
    const anchorX = canvasRect.left + caretX;
    const anchorY = canvasRect.top + caretY;
    let left = anchorX + anchorGap;
    if (left + tooltipRect.width > window.innerWidth - viewportMargin) {
      left = anchorX - tooltipRect.width - anchorGap;
    }
    left = Math.max(
      viewportMargin,
      Math.min(left, window.innerWidth - tooltipRect.width - viewportMargin),
    );
    const top = Math.max(
      viewportMargin,
      Math.min(
        anchorY - tooltipRect.height / 2,
        window.innerHeight - tooltipRect.height - viewportMargin,
      ),
    );
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
  }

  private createSlotChart(
    canvas: HTMLCanvasElement,
    attrs: BtsVmMemoryPanelAttrs,
  ) {
    if (
      this.slotChartInstance !== null &&
      this.renderedSlotBytes === attrs.slotBytes &&
      this.renderedSlotInstanceIds === attrs.slotInstanceIds &&
      this.renderedSlotDestroyedInstanceIds ===
        attrs.slotDestroyedInstanceIds &&
      this.renderedSlotResidualAccurate === attrs.slotResidualAccurate &&
      this.renderedSlotPageUrls === attrs.slotPageUrls
    ) {
      return;
    }
    const context = canvas.getContext('2d');
    if (context === null) {
      return;
    }
    this.destroySlotChart();

    const slotIds = Object.keys(attrs.slotBytes)
      .map(Number)
      .sort((a, b) => a - b);
    const values = slotIds.map((slotId) => attrs.slotBytes[slotId] ?? 0);
    const total = values.reduce((sum, value) => sum + value, 0);
    this.slotChartInstance = new Chart(context, {
      type: 'doughnut',
      data: {
        labels: slotIds.map((slotId) =>
          formatBtsVmSlotLabel(
            slotId,
            attrs.slotInstanceIds[slotId],
            attrs.slotDestroyedInstanceIds[slotId],
          ),
        ),
        datasets: [
          {
            data: values,
            backgroundColor: slotIds.map(
              (slotId) => btsVmSlotColor(slotId).fill,
            ),
            borderColor: slotIds.map((slotId) => btsVmSlotColor(slotId).border),
            borderWidth: 1,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        cutout: '70%',
        animation: {
          animateRotate: true,
          duration: 500,
        },
        plugins: {
          legend: {
            display: false,
          },
          tooltip: {
            enabled: false,
            external: ({chart, tooltip}) => {
              this.renderSlotTooltip(
                chart.canvas,
                tooltip.opacity,
                tooltip.caretX,
                tooltip.caretY,
                tooltip.dataPoints[0]?.dataIndex,
                slotIds,
                values,
                total,
                attrs,
              );
            },
          },
        },
      },
    });
    this.renderedSlotBytes = attrs.slotBytes;
    this.renderedSlotInstanceIds = attrs.slotInstanceIds;
    this.renderedSlotDestroyedInstanceIds = attrs.slotDestroyedInstanceIds;
    this.renderedSlotResidualAccurate = attrs.slotResidualAccurate;
    this.renderedSlotPageUrls = attrs.slotPageUrls;
  }

  private renderSlotChart(attrs: BtsVmMemoryPanelAttrs): m.Children {
    const hasSlotMemory = Object.values(attrs.slotBytes).some(
      (value) => value > 0,
    );
    if (!hasSlotMemory) {
      return m(
        'div',
        {
          style: {
            display: 'flex',
            height: '100%',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#777',
            fontSize: '12px',
          },
        },
        'No slot memory data.',
      );
    }

    return m(
      'div',
      {
        style: {
          width: '100%',
          height: '100%',
        },
      },
      m('canvas', {
        style: {
          width: '100%',
          height: '100%',
        },
        oncreate: (vnode: m.VnodeDOM) => {
          this.createSlotChart(vnode.dom as HTMLCanvasElement, attrs);
        },
        onupdate: (vnode: m.VnodeDOM) => {
          this.createSlotChart(vnode.dom as HTMLCanvasElement, attrs);
        },
      }),
    );
  }

  private renderSlotLegend(attrs: BtsVmMemoryPanelAttrs): m.Children {
    const slotIds = Object.keys(attrs.slotBytes)
      .map(Number)
      .sort((a, b) => a - b);
    const total = slotIds.reduce(
      (sum, slotId) => sum + (attrs.slotBytes[slotId] ?? 0),
      0,
    );
    return slotIds.map((slotId) => {
      const value = attrs.slotBytes[slotId] ?? 0;
      const percentage = total === 0 ? 0 : (value / total) * 100;
      const destroyedInstanceIds = attrs.slotDestroyedInstanceIds[slotId] ?? [];
      const isDestroyed = destroyedInstanceIds.length > 0;
      const isResidualAccurate = attrs.slotResidualAccurate[slotId] ?? false;
      const memory = isDestroyed
        ? formatMemoryBytes(value)
        : `${formatMemoryBytes(value)} (${percentage.toFixed(2)}%)`;
      return m(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '6px 8px',
            opacity: isDestroyed ? '0.7' : undefined,
          },
        },
        [
          m('span', {
            style: {
              width: '12px',
              height: '12px',
              flexShrink: '0',
              borderRadius: '2px',
              backgroundColor: btsVmSlotColor(slotId).fill,
            },
          }),
          m(
            'span',
            {
              style: {
                flex: '1',
                minWidth: '0',
                overflowWrap: 'anywhere',
              },
            },
            formatBtsVmSlotLabel(
              slotId,
              attrs.slotInstanceIds[slotId],
              destroyedInstanceIds,
            ),
          ),
          m(
            'span',
            {
              style: {
                flexShrink: '0',
                color: '#666',
                fontSize: '12px',
                whiteSpace: 'nowrap',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
              },
            },
            [
              memory,
              isDestroyed && !isResidualAccurate
                ? renderResidualAccuracyHint()
                : null,
              destroyedInstanceIds.map((instanceId) => {
                const sliceId =
                  attrs.slotSnapshotSliceIds[slotId]?.[instanceId];
                return sliceId === undefined
                  ? null
                  : m(Button, {
                      icon: 'photo_camera',
                      compact: true,
                      title: `Open latest BTS snapshot for instance ${instanceId} before this time`,
                      onclick: (event: MouseEvent) => {
                        event.stopPropagation();
                        selectMemorySnapshot(attrs.trace, {
                          sliceId,
                          instanceId,
                        });
                      },
                    });
              }),
            ],
          ),
        ],
      );
    });
  }

  private renderAnnotations(annotations?: Args): m.Children {
    return annotations === undefined
      ? m(
          'div',
          {
            style: {
              color: '#777',
              fontSize: '12px',
            },
          },
          'No debug.annotations data.',
        )
      : m(
          'pre',
          {
            style: {
              maxHeight: '260px',
              margin: '0',
              padding: '10px 12px',
              overflow: 'auto',
              borderRadius: '4px',
              backgroundColor: 'rgba(0, 0, 0, 0.035)',
              fontFamily: '"Roboto Mono", monospace',
              fontSize: '11px',
              lineHeight: '1.5',
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
            },
          },
          this.formatAnnotations(annotations),
        );
  }

  view({attrs}: m.Vnode<BtsVmMemoryPanelAttrs>): m.Children {
    const totalSlotBytes = Object.values(attrs.slotBytes).reduce(
      (sum, value) => sum + value,
      0,
    );
    return m(
      'div',
      {
        style: {
          width: '100%',
          fontFamily: '"Roboto Condensed", sans-serif',
          fontSize: '13px',
        },
      },
      [
        m(
          'div',
          {
            style: {
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: '10px',
            },
          },
          [
            this.renderSummaryCard('BTS VM', attrs.vmName),
            this.renderSummaryCard('VM Type', attrs.vmType || 'Unknown'),
            this.renderSummaryCard(
              'Accumulate',
              formatMemoryBytes(attrs.accumulateBytes),
              attrs.accumulateBytes,
            ),
            this.renderSummaryCard(
              'RSS',
              formatMemoryBytes(attrs.rssBytes),
              attrs.rssBytes,
            ),
          ],
        ),
        m(
          'div',
          {
            style: {
              marginTop: '12px',
            },
          },
          [
            m(
              'div',
              {
                style: {
                  marginBottom: '6px',
                  fontWeight: '500',
                },
              },
              'Slot memory distribution',
            ),
            m('.pf-bts-slot-distribution', [
              m('.pf-memory-doughnut-chart', [
                this.renderSlotChart(attrs),
                totalSlotBytes > 0
                  ? m(
                      'div',
                      {
                        style: {
                          position: 'absolute',
                          top: '50%',
                          left: '50%',
                          transform: 'translate(-50%, -50%)',
                          textAlign: 'center',
                          pointerEvents: 'none',
                        },
                      },
                      [
                        m(
                          'div',
                          {
                            style: {
                              fontSize: '1.5em',
                              fontWeight: 'bold',
                            },
                          },
                          formatMemoryBytes(totalSlotBytes),
                        ),
                        m(
                          'div',
                          {
                            style: {
                              fontSize: '0.8em',
                              opacity: '0.7',
                            },
                          },
                          'Total Memory',
                        ),
                      ],
                    )
                  : null,
              ]),
              m('.pf-bts-slot-legend', this.renderSlotLegend(attrs)),
            ]),
          ],
        ),
        m(
          'div',
          {
            style: {
              marginTop: '12px',
            },
          },
          [
            m(
              'div',
              {
                style: {
                  marginBottom: '6px',
                  fontWeight: '500',
                },
              },
              'debug.annotations',
            ),
            this.renderAnnotations(attrs.annotations),
          ],
        ),
      ],
    );
  }
}

function btsVmSlotColor(slotId: number): {
  border: string;
  fill: string;
} {
  const colors = [
    {border: '#64748b', fill: 'rgba(100, 116, 139, 0.72)'},
    {border: '#2563eb', fill: 'rgba(37, 99, 235, 0.72)'},
    {border: '#0891b2', fill: 'rgba(8, 145, 178, 0.72)'},
    {border: '#16a34a', fill: 'rgba(22, 163, 74, 0.72)'},
    {border: '#ca8a04', fill: 'rgba(202, 138, 4, 0.72)'},
    {border: '#dc2626', fill: 'rgba(220, 38, 38, 0.72)'},
    {border: '#9333ea', fill: 'rgba(147, 51, 234, 0.72)'},
    {border: '#db2777', fill: 'rgba(219, 39, 119, 0.72)'},
  ];
  if (slotId < colors.length) {
    return colors[slotId];
  }
  const hue = (slotId * 47 + 19) % 360;
  return {
    border: `hsl(${hue}, 68%, 42%)`,
    fill: `hsla(${hue}, 68%, 52%, 0.72)`,
  };
}

class BtsVmSlotAreaPanel implements m.ClassComponent<BtsVmSlotAreaPanelAttrs> {
  private chartInstance: Chart<'line'> | null = null;
  private renderedData?: BtsVmSlotMemoryData;
  private renderedStart?: time;
  private renderedEnd?: time;

  onremove() {
    this.destroyChart();
    this.renderedData = undefined;
    this.renderedStart = undefined;
    this.renderedEnd = undefined;
  }

  private destroyChart() {
    this.chartInstance?.destroy();
    this.chartInstance = null;
  }

  private buildChartSamples(
    attrs: BtsVmSlotAreaPanelAttrs,
  ): Array<{x: number; ts: time; sample: BtsVmSlotMemorySample}> {
    const durationSeconds = Math.max(
      0,
      Duration.toSeconds(attrs.end - attrs.start),
    );
    const samples = attrs.data.samples.map((sample) => ({
      x: Math.min(
        durationSeconds,
        Math.max(0, Duration.toSeconds(sample.ts - attrs.start)),
      ),
      ts: sample.ts,
      sample,
    }));
    const lastSample = samples[samples.length - 1];
    if (lastSample !== undefined && lastSample.x < durationSeconds) {
      samples.push({
        x: durationSeconds,
        ts: attrs.end,
        sample: lastSample.sample,
      });
    }
    return samples;
  }

  private createChart(
    canvas: HTMLCanvasElement,
    attrs: BtsVmSlotAreaPanelAttrs,
  ) {
    if (
      this.chartInstance !== null &&
      this.renderedData === attrs.data &&
      this.renderedStart === attrs.start &&
      this.renderedEnd === attrs.end
    ) {
      return;
    }
    const context = canvas.getContext('2d');
    if (context === null) {
      return;
    }
    this.destroyChart();

    const chartSamples = this.buildChartSamples(attrs);
    const totals = chartSamples.map(({sample}) =>
      attrs.data.slotIds.reduce(
        (total, slotId) => total + (sample.slots[slotId] ?? 0),
        0,
      ),
    );
    const datasets = attrs.data.slotIds.map((slotId, index) => {
      const color = btsVmSlotColor(slotId);
      return {
        label: formatBtsVmSlotLabel(slotId, attrs.data.slotInstanceIds[slotId]),
        data: chartSamples.map(({x, sample}) => ({
          x,
          y: sample.slots[slotId] ?? 0,
        })),
        borderColor: color.border,
        backgroundColor: color.fill,
        borderWidth: 1,
        pointRadius: 0,
        pointHoverRadius: 4,
        fill: index === 0 ? 'origin' : '-1',
        stack: 'bts-vm-slots',
        // Counter values remain valid until the next sample arrives.
        stepped: 'before' as const,
      };
    });
    const durationSeconds = Math.max(
      0.001,
      Duration.toSeconds(attrs.end - attrs.start),
    );
    const vmGcOffsets = attrs.data.vmGcTimestamps.map((ts) =>
      Math.min(
        durationSeconds,
        Math.max(0, Duration.toSeconds(ts - attrs.start)),
      ),
    );
    const vmGcMarkerPlugin: Plugin<'line'> = {
      id: 'bts-vm-gc-markers',
      afterDatasetsDraw: (chart) => {
        const xScale = chart.scales.x;
        const {ctx, chartArea} = chart;
        ctx.save();
        ctx.strokeStyle = '#dc2626';
        ctx.fillStyle = '#dc2626';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.font = '600 10px "Roboto Condensed", sans-serif';
        ctx.textBaseline = 'top';
        for (const [index, offset] of vmGcOffsets.entries()) {
          const x = xScale.getPixelForValue(offset);
          ctx.beginPath();
          ctx.moveTo(x, chartArea.top);
          ctx.lineTo(x, chartArea.bottom);
          ctx.stroke();

          const alignRight = x > chartArea.right - 44;
          ctx.textAlign = alignRight ? 'right' : 'left';
          ctx.fillText(
            'GC',
            x + (alignRight ? -4 : 4),
            chartArea.top + 4 + (index % 2) * 12,
          );
        }
        ctx.restore();
      },
    };

    this.chartInstance = new Chart(context, {
      type: 'line',
      data: {datasets},
      plugins: [vmGcMarkerPlugin],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        normalized: true,
        interaction: {
          mode: 'index',
          intersect: false,
        },
        scales: {
          x: {
            type: 'linear',
            min: 0,
            max: durationSeconds,
            title: {
              display: true,
              text: 'Time from selection start',
            },
            ticks: {
              callback: (value) => `+${Number(value).toFixed(3)}s`,
            },
          },
          y: {
            stacked: true,
            beginAtZero: true,
            title: {
              display: true,
              text: 'Memory',
            },
            ticks: {
              callback: (value) => formatMemoryBytes(Number(value)),
            },
          },
        },
        plugins: {
          legend: {
            position: 'bottom',
            labels: {
              boxWidth: 12,
              boxHeight: 12,
            },
          },
          tooltip: {
            callbacks: {
              title: (items: TooltipItem<'line'>[]) => {
                const x = items[0]?.parsed.x ?? 0;
                return `Time: +${x.toFixed(3)}s`;
              },
              label: (item: TooltipItem<'line'>) => {
                const value = item.parsed.y ?? 0;
                const total = totals[item.dataIndex] ?? 0;
                const percentage = total === 0 ? 0 : (value / total) * 100;
                const slotId = attrs.data.slotIds[item.datasetIndex];
                const lifecycles = attrs.data.slotPageLifecycles[slotId] ?? [];
                const pageState = getBtsVmSlotPageStateAt(
                  lifecycles,
                  chartSamples[item.dataIndex]?.ts ?? attrs.start,
                );
                const instanceIds =
                  lifecycles.length === 0
                    ? attrs.data.slotInstanceIds[slotId]
                    : pageState.instanceIds;
                const label = formatBtsVmSlotLabel(
                  slotId,
                  instanceIds,
                  pageState.destroyedInstanceIds,
                );
                return `${label}: ${formatMemoryBytes(
                  value,
                )} (${percentage.toFixed(1)}%)`;
              },
              footer: (items: TooltipItem<'line'>[]) => {
                const total = totals[items[0]?.dataIndex ?? -1];
                return total === undefined
                  ? ''
                  : `Total: ${formatMemoryBytes(total)}`;
              },
            },
          },
        },
      },
    });
    this.renderedData = attrs.data;
    this.renderedStart = attrs.start;
    this.renderedEnd = attrs.end;
  }

  private renderMetric(label: string, value: string): m.Children {
    return m(
      'div',
      {
        style: {
          minWidth: '150px',
        },
      },
      [
        m(
          'div',
          {
            style: {
              color: '#666',
              fontSize: '11px',
              fontWeight: '500',
              textTransform: 'uppercase',
            },
          },
          label,
        ),
        m(
          'div',
          {
            style: {
              marginTop: '3px',
              fontSize: '13px',
              fontWeight: '500',
              overflowWrap: 'anywhere',
            },
          },
          value,
        ),
      ],
    );
  }

  view({attrs}: m.Vnode<BtsVmSlotAreaPanelAttrs>): m.Children {
    if (attrs.data.slotIds.length === 0) {
      return m(
        'div',
        {
          style: {
            padding: '28px 12px',
            color: '#666',
            textAlign: 'center',
          },
        },
        'No slot memory data in the selected range.',
      );
    }

    return m(
      'div',
      {
        style: {
          width: '100%',
          fontFamily: '"Roboto Condensed", sans-serif',
        },
      },
      [
        m(
          'div',
          {
            style: {
              display: 'flex',
              flexWrap: 'wrap',
              gap: '12px 24px',
              marginBottom: '14px',
            },
          },
          [
            this.renderMetric('BTS VM', attrs.displayName),
            this.renderMetric('Track', attrs.trackName),
            this.renderMetric(
              'Selected range',
              `${Time.toSeconds(attrs.start).toFixed(3)}s - ${Time.toSeconds(
                attrs.end,
              ).toFixed(3)}s`,
            ),
            this.renderMetric(
              'Samples',
              attrs.data.samples.length.toLocaleString(),
            ),
            this.renderMetric(
              'Slots',
              attrs.data.slotIds
                .map((slotId) =>
                  formatBtsVmSlotLabel(
                    slotId,
                    attrs.data.slotInstanceIds[slotId],
                  ),
                )
                .join(', '),
            ),
          ],
        ),
        m(
          'div',
          {
            style: {
              width: '100%',
              height: '360px',
              minHeight: '300px',
            },
          },
          m('canvas', {
            style: {
              width: '100%',
              height: '100%',
            },
            oncreate: (vnode: m.VnodeDOM) => {
              this.createChart(vnode.dom as HTMLCanvasElement, attrs);
            },
            onupdate: (vnode: m.VnodeDOM) => {
              this.createChart(vnode.dom as HTMLCanvasElement, attrs);
            },
          }),
        ),
      ],
    );
  }
}

class MemoryPssTotalPanel
  implements m.ClassComponent<MemoryPssTotalPanelAttrs>
{
  private collapsedBtsEngines: Set<string> = new Set();
  private collapsedMtsEngines: Set<number> = new Set();
  private mtsPoolsCollapsed = false;

  private getAliveMemorySummary(
    data?: ArgsDict,
  ): AliveMemorySummary | undefined {
    const summaryValue = this.getDebugArgValue(data, 'alive_memory_summary');
    if (summaryValue === undefined) {
      return undefined;
    }

    try {
      return JSON.parse(summaryValue) as AliveMemorySummary;
    } catch {
      return undefined;
    }
  }

  private getPssMemoryDeltas(data?: ArgsDict): PssMemoryDeltas | undefined {
    const deltasValue = this.getDebugArgValue(data, 'pss_memory_deltas');
    if (deltasValue === undefined) {
      return undefined;
    }

    try {
      return JSON.parse(deltasValue) as PssMemoryDeltas;
    } catch {
      return undefined;
    }
  }

  private getDebugArgValue(
    data: ArgsDict | undefined,
    key: string,
  ): string | undefined {
    const debugArgs = data?.debug;
    if (
      debugArgs === null ||
      debugArgs === undefined ||
      typeof debugArgs !== 'object' ||
      Array.isArray(debugArgs)
    ) {
      return undefined;
    }

    const value = debugArgs[key];
    return value === undefined ? undefined : argToDisplayValue(value);
  }

  private renderSinceTraceStartHint(): m.Children {
    return m(
      'span',
      {
        style: {
          marginLeft: '4px',
          fontSize: '10px',
          opacity: '0.7',
        },
      },
      '(Since Trace Start)',
    );
  }

  private getModeSize(accSizeBytes: number, rssSizeBytes?: number): number {
    return memoryPssTotalMode === 'rss' ? rssSizeBytes ?? 0 : accSizeBytes;
  }

  private formatBtsInstanceMemory(
    sizeBytes: number | undefined,
    totalSizeBytes: number,
  ): string {
    if (sizeBytes === undefined) {
      return '-';
    }
    const percentage =
      totalSizeBytes === 0 ? 0 : (sizeBytes / totalSizeBytes) * 100;
    return `${formatMemoryBytes(sizeBytes)} (${percentage.toFixed(2)}%)`;
  }

  private renderSizeWithSuffix(sizeBytes: number, suffix: string): m.Children {
    return [
      formatMemoryBytes(sizeBytes),
      ' ',
      m(
        'span',
        {
          style: {
            fontSize: '10px',
            opacity: '0.7',
          },
        },
        suffix,
      ),
    ];
  }

  private renderActiveAndPoolSize(
    activeSizeBytes: number,
    poolSizeBytes: number,
  ): m.Children {
    return [
      this.renderSizeWithSuffix(activeSizeBytes, '(active)'),
      poolSizeBytes > 0
        ? [' ', this.renderSizeWithSuffix(poolSizeBytes, '(in pool)')]
        : null,
    ];
  }

  private renderHoverTable(
    columns: Array<{title: string; width: string}>,
    rows: Array<m.Children[] | HoverTableRow>,
    options: HoverTableOptions = {},
  ): m.Children {
    const tableStyle = {
      width: '100%',
      tableLayout: 'fixed',
      borderCollapse: 'collapse',
      marginBottom: options.marginBottom ?? '16px',
    };
    const cellStyle = {
      padding: '4px 8px',
      fontSize: '12px',
      textAlign: 'left',
      verticalAlign: 'top',
    };
    const headerCellStyle = {
      ...cellStyle,
      fontWeight: 'bold',
    };

    return m('table', {style: tableStyle}, [
      m(
        'colgroup',
        columns.map((column) =>
          m('col', {
            style: {
              width: column.width,
            },
          }),
        ),
      ),
      options.hideHeader
        ? null
        : m('thead', [
            m(
              'tr',
              columns.map((column) =>
                m(
                  'th',
                  {
                    style: headerCellStyle,
                  },
                  column.title,
                ),
              ),
            ),
          ]),
      m(
        'tbody',
        rows.map((row) => {
          const rowInfo: HoverTableRow = Array.isArray(row)
            ? {cells: row}
            : row;
          return m(
            'tr',
            {
              onmouseover: rowInfo.sectionHeader
                ? undefined
                : (e: Event) => {
                    (e.currentTarget as HTMLElement).style.backgroundColor =
                      'rgba(0, 0, 0, 0.05)';
                  },
              onmouseout: rowInfo.sectionHeader
                ? undefined
                : (e: Event) => {
                    (e.currentTarget as HTMLElement).style.backgroundColor =
                      'transparent';
                  },
              style: {
                borderTop: rowInfo.sectionHeader
                  ? '1px solid rgba(0, 0, 0, 0.12)'
                  : undefined,
                backgroundColor: rowInfo.sectionHeader
                  ? 'rgba(0, 0, 0, 0.02)'
                  : undefined,
                opacity: rowInfo.dimmed ? '0.7' : undefined,
              },
            },
            rowInfo.cells.map((cell) =>
              m(
                'td',
                {
                  style: rowInfo.sectionHeader ? headerCellStyle : cellStyle,
                },
                cell,
              ),
            ),
          );
        }),
      ),
    ]);
  }

  private renderDestroyedBtsMemory(
    instance: DestroyedBtsVmPageMemorySummary,
    trace: Trace,
  ): m.Children {
    const memory =
      instance.btsMemoryBytes === undefined
        ? '-'
        : formatMemoryBytes(instance.btsMemoryBytes);
    return m(
      'span',
      {
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: '4px',
        },
      },
      [
        memory,
        instance.btsMemoryBytes !== undefined && !instance.isResidualAccurate
          ? renderResidualAccuracyHint()
          : null,
        instance.snapshotSliceId === undefined
          ? null
          : m(Button, {
              icon: 'photo_camera',
              compact: true,
              title: 'Open latest BTS snapshot before this time',
              onclick: (event: Event) => {
                event.stopPropagation();
                if (instance.snapshotSliceId !== undefined) {
                  selectMemorySnapshot(trace, {
                    sliceId: instance.snapshotSliceId,
                    instanceId: instance.instanceId,
                  });
                }
              },
            }),
      ],
    );
  }

  private buildBtsInstanceRows(
    engineInfo: AliveMemorySummary['backgroundThreadScriptingEngines'][string],
    trace: Trace,
  ): Array<m.Children[] | HoverTableRow> {
    const rows: Array<m.Children[] | HoverTableRow> = engineInfo.instances.map(
      (instance) => [
        instance.instanceId,
        instance.url,
        this.formatBtsInstanceMemory(
          instance.btsMemoryBytes,
          engineInfo.sizeBytes,
        ),
      ],
    );
    const destroyedInstances = engineInfo.destroyedInstances ?? [];
    if (!showDestroyedBtsPages || destroyedInstances.length === 0) {
      return rows;
    }
    rows.push({
      cells: ['Destroyed', '', 'Residual'],
      dimmed: true,
      sectionHeader: true,
    });
    rows.push(
      ...destroyedInstances.map((instance) => ({
        cells: [
          instance.instanceId,
          instance.url,
          this.renderDestroyedBtsMemory(instance, trace),
        ],
        dimmed: true,
      })),
    );
    return rows;
  }

  private renderBackgroundThreadScriptingEngines(
    btsEngines: Array<
      AliveMemorySummary['backgroundThreadScriptingEngines'][string]
    >,
    trace: Trace,
    deltas?: PssMemoryDeltas,
  ): m.Children {
    return btsEngines.map((engineInfo) => {
      const isExpanded = !this.collapsedBtsEngines.has(
        engineInfo.btsEngineName,
      );
      const btsEngineDelta =
        memoryPssTotalMode === 'rss'
          ? deltas?.btsEngineRssSizeBytes[engineInfo.btsEngineName] ?? 0
          : deltas?.btsEngineSizeBytes[engineInfo.btsEngineName] ?? 0;

      return m(
        '.bts-engine-section',
        {
          style: {
            marginBottom: '12px',
            border: '1px solid rgba(0, 0, 0, 0.08)',
            borderRadius: '4px',
            overflow: 'hidden',
          },
        },
        [
          m(
            '.bts-engine-header',
            {
              onclick: () => {
                if (isExpanded) {
                  this.collapsedBtsEngines.add(engineInfo.btsEngineName);
                } else {
                  this.collapsedBtsEngines.delete(engineInfo.btsEngineName);
                }
              },
              onmouseover: (e: Event) => {
                (e.currentTarget as HTMLElement).style.backgroundColor =
                  'rgba(0, 0, 0, 0.05)';
              },
              onmouseout: (e: Event) => {
                (e.currentTarget as HTMLElement).style.backgroundColor =
                  'rgba(0, 0, 0, 0.02)';
              },
              style: {
                display: 'grid',
                gridTemplateColumns: '22% 33% 25% 20%',
                gap: '8px',
                padding: '8px',
                fontSize: '13px',
                cursor: 'pointer',
                backgroundColor: 'rgba(0, 0, 0, 0.02)',
              },
            },
            [
              m('span', engineInfo.btsEngineName),
              m('span', engineInfo.desc),
              m(
                'span',
                formatMemoryBytes(
                  this.getModeSize(
                    engineInfo.sizeBytes,
                    engineInfo.rssSizeBytes,
                  ),
                ),
              ),
              m('span', [
                formatMemoryDeltaBytes(btsEngineDelta),
                this.renderSinceTraceStartHint(),
              ]),
            ],
          ),
          isExpanded
            ? this.renderHoverTable(
                [
                  {title: 'Instance ID', width: '15%'},
                  {title: 'URL', width: '65%'},
                  {title: 'Memory', width: '20%'},
                ],
                this.buildBtsInstanceRows(engineInfo, trace),
              )
            : null,
        ],
      );
    });
  }

  private renderMainThreadScriptingEngines(
    mtsEngines: AliveMemorySummary['mainThreadScriptingEngines'],
  ): m.Children {
    return mtsEngines.map((engineInfo) => {
      const isExpanded = !this.collapsedMtsEngines.has(engineInfo.instanceId);

      return m(
        '.mts-engine-section',
        {
          style: {
            marginBottom: '12px',
            border: '1px solid rgba(0, 0, 0, 0.08)',
            borderRadius: '4px',
            overflow: 'hidden',
          },
        },
        [
          m(
            '.mts-engine-header',
            {
              onclick: () => {
                if (isExpanded) {
                  this.collapsedMtsEngines.add(engineInfo.instanceId);
                } else {
                  this.collapsedMtsEngines.delete(engineInfo.instanceId);
                }
              },
              onmouseover: (e: Event) => {
                (e.currentTarget as HTMLElement).style.backgroundColor =
                  'rgba(0, 0, 0, 0.05)';
              },
              onmouseout: (e: Event) => {
                (e.currentTarget as HTMLElement).style.backgroundColor =
                  'rgba(0, 0, 0, 0.02)';
              },
              style: {
                display: 'grid',
                gridTemplateColumns: '22% 53% 25%',
                gap: '8px',
                padding: '8px',
                fontSize: '13px',
                cursor: 'pointer',
                backgroundColor: 'rgba(0, 0, 0, 0.02)',
              },
            },
            [
              m('span', `Instance ID: ${engineInfo.instanceId}`),
              m('span', engineInfo.desc),
              m(
                'span',
                formatMemoryBytes(
                  this.getModeSize(
                    engineInfo.sizeBytes,
                    engineInfo.rssSizeBytes,
                  ),
                ),
              ),
            ],
          ),
          isExpanded
            ? this.renderHoverTable(
                [{title: 'URL', width: '100%'}],
                [[engineInfo.url]],
              )
            : null,
        ],
      );
    });
  }

  private renderMtsVmPools(pools: MtsVmPoolMemoryDetails[]): m.Children {
    if (pools.length === 0) {
      return null;
    }
    return m(
      'div',
      {
        style: {
          marginTop: '12px',
        },
      },
      [
        m('h5', {style: {margin: '0 0 8px 0'}}, 'MTS Pools'),
        m(
          '.mts-pool-section',
          {
            style: {
              marginBottom: '12px',
              border: '1px solid rgba(0, 0, 0, 0.08)',
              borderRadius: '4px',
              overflow: 'hidden',
            },
          },
          [
            m(
              '.mts-pool-header',
              {
                onclick: () => {
                  this.mtsPoolsCollapsed = !this.mtsPoolsCollapsed;
                },
                onmouseover: (e: Event) => {
                  (e.currentTarget as HTMLElement).style.backgroundColor =
                    'rgba(0, 0, 0, 0.05)';
                },
                onmouseout: (e: Event) => {
                  (e.currentTarget as HTMLElement).style.backgroundColor =
                    'rgba(0, 0, 0, 0.02)';
                },
                style: {
                  display: 'grid',
                  gridTemplateColumns: '65fr 15fr 20fr',
                  padding: '8px',
                  backgroundColor: 'rgba(0, 0, 0, 0.02)',
                  cursor: 'pointer',
                  fontSize: '12px',
                  fontWeight: 'bold',
                },
              },
              [
                m('span', 'URL'),
                m('span', 'Engine Instances'),
                m('span', 'Memory'),
              ],
            ),
            this.mtsPoolsCollapsed
              ? null
              : this.renderHoverTable(
                  [
                    {title: 'URL', width: '65%'},
                    {title: 'Engine Instances', width: '15%'},
                    {title: 'Memory', width: '20%'},
                  ],
                  pools.map((pool) => [
                    m(
                      'span',
                      {style: {overflowWrap: 'anywhere'}},
                      pool.url || 'Unknown URL',
                    ),
                    pool.instanceCount,
                    formatMemoryBytes(
                      this.getModeSize(pool.sizeBytes, pool.rssSizeBytes),
                    ),
                  ]),
                  {
                    hideHeader: true,
                    marginBottom: '0',
                  },
                ),
          ],
        ),
      ],
    );
  }

  private renderMemoryDeltas(deltas?: PssMemoryDeltas): m.Children {
    if (deltas === undefined) {
      return m(
        'p',
        {
          style: {
            fontSize: '12px',
            opacity: '0.8',
          },
        },
        'No memory delta data.',
      );
    }

    return this.renderHoverTable(
      [
        {title: 'Metric', width: '45%'},
        {title: 'Delta', width: '55%'},
      ],
      [
        [
          'Physical Memory',
          formatMemoryDeltaBytes(deltas.physicalMemorySizeBytes),
        ],
        [
          'Total Engine Memory',
          formatMemoryDeltaBytes(
            this.getModeSize(
              deltas.totalEngineSizeBytes,
              deltas.totalEngineRssSizeBytes,
            ),
          ),
        ],
        [
          'Total BTS Memory',
          formatMemoryDeltaBytes(
            this.getModeSize(
              deltas.totalBtsEngineSizeBytes,
              deltas.totalBtsEngineRssSizeBytes,
            ),
          ),
        ],
        [
          'Total MTS Memory',
          formatMemoryDeltaBytes(
            this.getModeSize(
              deltas.totalMtsEngineSizeBytes,
              deltas.totalMtsEngineRssSizeBytes,
            ),
          ),
        ],
      ],
    );
  }

  private renderAliveInstanceCounts(summary: AliveMemorySummary): m.Children {
    const componentCategories = [
      'text',
      'image',
      'scroll-view',
      'x-input',
      'view',
    ];

    return this.renderHoverTable(
      [
        {title: 'Category', width: '35%'},
        {title: 'Count', width: '65%'},
      ],
      [
        ...componentCategories.map((category) => [
          category,
          summary.componentCounts[category] ?? 0,
        ]),
        ['lynxTasmElement', summary.elementCount],
      ],
    );
  }

  private renderAliveMemorySummary(
    summary: AliveMemorySummary | undefined,
    trace: Trace,
    deltas?: PssMemoryDeltas,
  ): m.Children {
    if (summary === undefined) {
      return null;
    }

    const btsEngines = Object.values(summary.backgroundThreadScriptingEngines);
    const btsTotalSizeBytes = btsEngines.reduce(
      (total, engineInfo) =>
        total + this.getModeSize(engineInfo.sizeBytes, engineInfo.rssSizeBytes),
      0,
    );
    const mtsTotalSizeBytes = summary.mainThreadScriptingEngines.reduce(
      (total, engineInfo) =>
        total + this.getModeSize(engineInfo.sizeBytes, engineInfo.rssSizeBytes),
      0,
    );
    const totalEngineSizeBytes = this.getModeSize(
      summary.totalEngineSizeBytes,
      summary.totalEngineRssSizeBytes,
    );
    const btsVmPoolSizeBytes = this.getModeSize(
      summary.btsVmPoolSizeBytes,
      summary.btsVmPoolRssSizeBytes,
    );
    const mtsVmPoolSizeBytes = this.getModeSize(
      summary.mtsVmPoolSizeBytes,
      summary.mtsVmPoolRssSizeBytes,
    );
    const totalVmPoolSizeBytes = this.getModeSize(
      summary.totalVmPoolSizeBytes,
      summary.totalVmPoolRssSizeBytes,
    );

    return m(
      '.alive-memory-summary',
      {
        style: {
          marginBottom: '16px',
        },
      },
      [
        m(
          'div',
          {
            style: {
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: '16px',
              marginBottom: '16px',
            },
          },
          [
            m('div', [
              m(
                'h4',
                {style: {margin: '0 0 8px 0'}},
                'Memory Change Since Trace Start',
              ),
              this.renderMemoryDeltas(deltas),
            ]),
            m('div', [
              m('h4', {style: {margin: '0 0 8px 0'}}, 'Alive Instance Counts'),
              this.renderAliveInstanceCounts(summary),
            ]),
          ],
        ),
        m('h4', {style: {margin: '0 0 8px 0'}}, 'Total Engine Memory'),
        m(
          'div',
          {
            style: {
              marginBottom: '16px',
              fontSize: '12px',
              opacity: '0.8',
            },
          },
          this.renderActiveAndPoolSize(
            totalEngineSizeBytes,
            totalVmPoolSizeBytes,
          ),
        ),
        m(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              marginBottom: '8px',
            },
          },
          [
            m(
              'h4',
              {style: {margin: '0'}},
              'Background Thread Scripting Engines',
            ),
            m(Checkbox, {
              label: 'Show Destroyed Pages',
              checked: showDestroyedBtsPages,
              onchange: (event: Event) => {
                showDestroyedBtsPages = (event.target as HTMLInputElement)
                  .checked;
              },
            }),
          ],
        ),
        m(
          'div',
          {
            style: {
              marginBottom: '8px',
              fontSize: '12px',
              opacity: '0.8',
            },
          },
          [
            'Total BTS size: ',
            this.renderActiveAndPoolSize(btsTotalSizeBytes, btsVmPoolSizeBytes),
          ],
        ),
        this.renderBackgroundThreadScriptingEngines(btsEngines, trace, deltas),
        m(
          'h4',
          {style: {margin: '0 0 8px 0'}},
          'Main Thread Scripting Engines',
        ),
        m(
          'div',
          {
            style: {
              marginBottom: '8px',
              fontSize: '12px',
              opacity: '0.8',
            },
          },
          [
            'Total MTS size: ',
            this.renderActiveAndPoolSize(mtsTotalSizeBytes, mtsVmPoolSizeBytes),
          ],
        ),
        this.renderMainThreadScriptingEngines(
          summary.mainThreadScriptingEngines,
        ),
        this.renderMtsVmPools(summary.mtsVmPools ?? []),
      ],
    );
  }

  view(vnode: m.Vnode<MemoryPssTotalPanelAttrs>): m.Children {
    const aliveMemorySummary = this.getAliveMemorySummary(vnode.attrs.data);
    const pssMemoryDeltas = this.getPssMemoryDeltas(vnode.attrs.data);

    if (aliveMemorySummary === undefined) {
      return m('p', 'No alive memory instances found.');
    }

    return this.renderAliveMemorySummary(
      aliveMemorySummary,
      vnode.attrs.trace,
      pssMemoryDeltas,
    );
  }
}

export {
  BtsVmMemoryPanel,
  BtsVmSlotAreaPanel,
  MemoryDashboard,
  MemoryPssFocusControls,
  MemoryPssTotalPanel,
  MemoryPssTotalModeSelector,
  SectionWithRightContent,
};
