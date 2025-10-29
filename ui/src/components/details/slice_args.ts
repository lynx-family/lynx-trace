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

import m from 'mithril';
import {Anchor} from '../../widgets/anchor';
import {MenuItem} from '../../widgets/menu';
import {ArgsDict, ArgValue} from '../sql_utils/args';
import {Trace} from '../../public/trace';
import {renderArguments} from './args';
import {extensions} from '../extensions';
import {sqliteString} from '../../base/string_utils';
import {SLICE_TABLE} from '../widgets/sql/table_definitions';
import {sourceMapState} from '../../source_map/source_map_state';
import {raf} from '../../core/raf_scheduler';
import {stringToJsonObject} from '../../lynx_perf/string_utils';
import {Icons} from '../../base/semantic_icons';
import {lynxPerfGlobals} from '../../lynx_perf/lynx_perf_globals';
import {RightSidebarTab} from '../../lynx_perf/types';

export function canFocusLynxViewArgument(key: string, value: ArgValue): boolean {
  return (
    lynxPerfGlobals.state.lynxviewInstances.length > 0 &&
    (key === 'debug.instance_id' || key === 'args.instance_id') &&
    value != null &&
    String(value).length > 0
  );
}

// Renders slice arguments (key/value pairs) as a subtree.
export function renderSliceArguments(trace: Trace, args: ArgsDict): m.Children {
  return renderArguments(
    trace,
    args,
    (key, value) => {
      const displayValue = value === null ? 'NULL' : String(value);
      const canFocusLynxView = canFocusLynxViewArgument(key, value);
      const menuItems: m.Children[] = [
        m(MenuItem, {
          label: 'Find slices with same arg value',
          icon: 'search',
          onclick: () => {
            extensions.addLegacySqlTableTab(trace, {
              table: SLICE_TABLE,
              filters: [
                {
                  op: (cols) => `${cols[0]} = ${sqliteString(displayValue)}`,
                  columns: [
                    {
                      column: 'display_value',
                      source: {
                        table: 'args',
                        joinOn: {
                          arg_set_id: 'arg_set_id',
                          key: sqliteString(key),
                        },
                      },
                    },
                  ],
                },
              ],
            });
          },
        }),
      ];
      if (!canFocusLynxView) {
        menuItems.push(
          m(MenuItem, {
            label: 'Visualize argument values',
            icon: 'query_stats',
            onclick: () => {
              extensions.addVisualizedArgTracks(trace, key);
            },
          }),
        );
      }
      if (canFocusLynxView) {
        menuItems.push(
          m(MenuItem, {
            label: 'Focus LynxView',
            icon: 'filter',
            onclick: () => {
              lynxPerfGlobals.changeRightSidebarTab(RightSidebarTab.LynxView);
            },
          }),
        );
      }
      if (key === 'args.originSource') {
        menuItems.push(
          m(MenuItem, {
            label: 'Open source file',
            icon: 'visibility',
            onclick: () => {
              openSourceFile(value);
            },
          }),
        );
      }
      return menuItems;
    },
    (key, value) => {
      if (key === 'args.originSource' && typeof value === 'string') {
        return renderSourceFile(value);
      }
      if (typeof value === 'string' && value !== '') {
        const parsedJson = stringToJsonObject(value);
        if (parsedJson !== undefined) {
          const formattedJson = JSON.stringify(parsedJson, null, 2);
          return m('div', [
            m('pre', {style: {backgroundColor: 'transparent'}}, formattedJson),
            m(MenuItem, {
              icon: Icons.Copy,
              label: '',
              onclick: () => {
                navigator.clipboard.writeText(formattedJson);
              },
            }),
          ]);
        }
      }
      return undefined;
    },
  );
}

function renderSourceFile(value: string): m.Children {
  if (
    sourceMapState.state.sourceFileDrawerVisible &&
    sourceMapState.state.currentSourceFile !== value
  ) {
    sourceMapState.edit((draft) => {
      draft.currentSourceFile = value;
    });
    raf.scheduleFullRedraw();
  }
  return m(
    Anchor,
    {
      icon: 'visibility',
      onclick: () => {
        openSourceFile(value);
      },
    },
    value,
  );
}

function openSourceFile(value: ArgValue) {
  if (typeof value !== 'string') {
    return;
  }
  sourceMapState.edit((draft) => {
    draft.currentSourceFile = value;
  });
  raf.scheduleFullRedraw();
}
