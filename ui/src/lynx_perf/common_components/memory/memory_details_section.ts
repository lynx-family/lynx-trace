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
import Chart, {ActiveElement, ChartEvent, TooltipItem} from 'chart.js/auto';
import {Args, ArgsDict} from '../../../components/sql_utils/args';
import {Button} from '../../../widgets/button';
import {Checkbox} from '../../../widgets/checkbox';
import {Icons} from '../../../base/semantic_icons';
import {HTMLAttrs} from '../../../widgets/common';
import {TextInput} from '../../../widgets/text_input';
import {Trace} from '../../../public/trace';
import {lynxPerfGlobals} from '../../lynx_perf_globals';
import {MemoryTrackFocusFilter} from '../../types';
import {formatMemoryBytes, formatMemoryDeltaBytes} from './memory_format';

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
}

interface BtsVmMemoryPanelAttrs {
  vmName: string;
  vmType: string;
  accumulateBytes: number;
  rssBytes: number;
  annotations?: Args;
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
      instances: Array<{
        instanceId: number;
        url: string;
      }>;
    }
  >;
  totalEngineSizeBytes: number;
  totalEngineRssSizeBytes: number;
  btsVmPoolSizeBytes: number;
  btsVmPoolRssSizeBytes: number;
  mtsVmPoolSizeBytes: number;
  mtsVmPoolRssSizeBytes: number;
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
            width: '300px',
            height: '300px',
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
        width: '300px',
        height: '300px',
        maxWidth: '300px',
        maxHeight: '300px',
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
                m('td', component.name),
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
                  '.chart-container',
                  {
                    style: {
                      position: 'relative',
                      width: '100%',
                      maxWidth: '300px',
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

  view({attrs}: m.Vnode<BtsVmMemoryPanelAttrs>): m.Children {
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
              'debug.annotations',
            ),
            attrs.annotations === undefined
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
                      maxHeight: '240px',
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
                  this.formatAnnotations(attrs.annotations),
                ),
          ],
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
    rows: m.Children[][],
  ): m.Children {
    const tableStyle = {
      width: '100%',
      tableLayout: 'fixed',
      borderCollapse: 'collapse',
      marginBottom: '16px',
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
      m('thead', [
        m(
          'tr',
          columns.map((column) =>
            m(
              'th',
              {
                style: {
                  ...headerCellStyle,
                  width: column.width,
                },
              },
              column.title,
            ),
          ),
        ),
      ]),
      m(
        'tbody',
        rows.map((row) =>
          m(
            'tr',
            {
              onmouseover: (e: Event) => {
                (e.currentTarget as HTMLElement).style.backgroundColor =
                  'rgba(0, 0, 0, 0.05)';
              },
              onmouseout: (e: Event) => {
                (e.currentTarget as HTMLElement).style.backgroundColor =
                  'transparent';
              },
            },
            row.map((cell) => m('td', {style: cellStyle}, cell)),
          ),
        ),
      ),
    ]);
  }

  private renderBackgroundThreadScriptingEngines(
    btsEngines: Array<
      AliveMemorySummary['backgroundThreadScriptingEngines'][string]
    >,
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
                  {title: 'URL', width: '85%'},
                ],
                engineInfo.instances.map((instance) => [
                  instance.instanceId,
                  instance.url,
                ]),
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
    summary?: AliveMemorySummary,
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
          'h4',
          {style: {margin: '0 0 8px 0'}},
          'Background Thread Scripting Engines',
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
        this.renderBackgroundThreadScriptingEngines(btsEngines, deltas),
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
      ],
    );
  }

  view(vnode: m.Vnode<MemoryPssTotalPanelAttrs>): m.Children {
    const aliveMemorySummary = this.getAliveMemorySummary(vnode.attrs.data);
    const pssMemoryDeltas = this.getPssMemoryDeltas(vnode.attrs.data);

    if (aliveMemorySummary === undefined) {
      return m('p', 'No alive memory instances found.');
    }

    return this.renderAliveMemorySummary(aliveMemorySummary, pssMemoryDeltas);
  }
}

export {
  BtsVmMemoryPanel,
  MemoryDashboard,
  MemoryPssFocusControls,
  MemoryPssTotalPanel,
  MemoryPssTotalModeSelector,
  SectionWithRightContent,
};
