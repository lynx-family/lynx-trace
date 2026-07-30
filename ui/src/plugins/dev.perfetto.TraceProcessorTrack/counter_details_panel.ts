// Copyright (C) 2024 The Android Open Source Project
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

import {Time, duration, time} from '../../base/time';
import {Engine} from '../../trace_processor/engine';
import {Trace} from '../../public/trace';
import {
  LONG,
  LONG_NULL,
  NUM,
  NUM_NULL,
  STR,
} from '../../trace_processor/query_result';
import {TrackEventDetailsPanel} from '../../public/details_panel';
import m from 'mithril';
import {DetailsShell} from '../../widgets/details_shell';
import {GridLayout} from '../../widgets/grid_layout';
import {Section} from '../../widgets/section';
import {Tree, TreeNode} from '../../widgets/tree';
import {Timestamp} from '../../components/widgets/timestamp';
import {DurationWidget} from '../../components/widgets/duration';
import {TrackEventSelection} from '../../public/selection';
import {hasArgs, renderArguments} from '../../components/details/args';
import {asArgSetId} from '../../components/sql_utils/core_types';
import {Args, ArgsDict, getArgs} from '../../components/sql_utils/args';
import {
  YMode,
  counterDisplayUnit,
  counterValueExpression,
} from '../../components/tracks/counter_track';
import {assertUnreachable} from '../../base/assert';
import {
  BtsVmMemoryPanel,
  MemoryDashboard,
  MemoryPssFocusControls,
  MemoryPssTotalPanel,
  MemoryPssTotalModeSelector,
  SectionWithRightContent,
} from '../../lynx_perf/common_components/memory/memory_details_section';
import {
  formatBtsVmInstanceName,
  loadBtsVmInstances,
} from '../../lynx_perf/common_components/memory/bts_vm_generations';
import {
  assignBtsVmMemoryTracks,
  loadBtsVmMemoryTracks,
  loadBtsVmMemoryTrackAssignments,
} from '../../lynx_perf/common_components/memory/bts_vm_memory_tracks';
import {
  BtsVmMemorySample,
  buildBtsVmMemorySample,
} from '../../lynx_perf/common_components/memory/bts_vm_memory_details';
import {lynxPerfGlobals} from '../../lynx_perf/lynx_perf_globals';

interface CounterDetails {
  // The "left" timestamp of the counter sample T(N)
  ts: time;

  // The delta between this sample and the next one's timestamps T(N+1) - T(N)
  duration: duration;

  // The raw value F(N)
  value: number;

  // The delta: F(N+1) - F(N)
  delta: number;

  // The rate: (F(N+1) - F(N)) / dt
  rate: number;

  args?: ArgsDict;
}

interface BtsVmMemoryDetails extends BtsVmMemorySample {
  vmName: string;
  vmType: string;
}

interface AliveMemoryCounterTrack {
  id: number;
  name: string;
  instanceId: number;
}

interface MemoryFocusTarget {
  instanceId: number;
  btsEngineName: string;
  url: string;
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

interface VmEngineDescriptions {
  mainThreadScriptingEngines: Record<number, string>;
  backgroundThreadScriptingEngines: Record<string, string>;
  backgroundThreadScriptingEngineNames: Record<number, string>;
  backgroundThreadScriptingEngineMemoryTrackIds: Record<string, number>;
  instanceUrls: Record<number, string>;
}

interface VmMemoryValue {
  sizeBytes: number;
  rssSizeBytes: number;
}

interface VmPoolMemorySummary {
  btsSizeBytes: number;
  btsRssSizeBytes: number;
  mtsSizeBytes: number;
  mtsRssSizeBytes: number;
}

const MEMORY_COUNTER_ALIGNMENT_TOLERANCE: duration = 10_000_000n;

export class CounterDetailsPanel implements TrackEventDetailsPanel {
  private readonly trace: Trace;
  private readonly engine: Engine;
  private readonly trackId: number;
  private readonly sqlSource: string;
  private readonly trackName: string;
  private readonly getMode: () => YMode;
  private readonly unit: string;
  private readonly rateUnit: string;
  private counterDetails?: CounterDetails;
  private btsVmMemoryDetails?: BtsVmMemoryDetails;

  constructor(
    trace: Trace,
    trackId: number,
    trackName: string,
    getMode: () => YMode,
    unit: string,
    rateUnit: string,
    sqlSource: string,
  ) {
    this.trace = trace;
    this.engine = trace.engine;
    this.trackId = trackId;
    this.trackName = trackName;
    this.getMode = getMode;
    this.unit = unit;
    this.rateUnit = rateUnit;
    this.sqlSource = sqlSource;
  }

  async load(selection: TrackEventSelection) {
    const {eventId} = selection;
    if (this.isBtsVmMemoryTrack()) {
      const counterDetails = await loadCounterDetails(
        this.engine,
        eventId,
        this.sqlSource,
      );
      this.btsVmMemoryDetails = await loadBtsVmMemoryDetails(
        this.engine,
        this.trackId,
        eventId,
        this.sqlSource,
        counterDetails,
      );
      this.counterDetails = counterDetails;
      return;
    }

    if (this.isPssTotalTrack()) {
      const counterDetails = await loadPssTotalCounterDetails(
        this.engine,
        eventId,
        this.sqlSource,
      );
      this.updateCounterTrackBackgroundHighlight(
        selection,
        getAliveMemoryCounterTrackIds(counterDetails),
      );
      const firstEventId = await loadFirstCounterEventId(
        this.engine,
        this.sqlSource,
      );
      if (firstEventId === undefined) {
        this.counterDetails = counterDetails;
        return;
      }

      const firstCounterDetails = await loadPssTotalCounterDetails(
        this.engine,
        firstEventId,
        this.sqlSource,
      );
      this.counterDetails = addPssMemoryDeltas(
        counterDetails,
        firstCounterDetails,
      );
      return;
    }

    const counterDetails = await loadCounterDetails(
      this.engine,
      eventId,
      this.sqlSource,
    );
    if (this.isMemoryTrack()) {
      await addMemoryTrackUrl(this.engine, counterDetails, this.trackName);
    }
    this.counterDetails = counterDetails;
  }

  private formatWithUnit(value: number, mode: YMode): string {
    const unitLabel = counterDisplayUnit(mode, this.unit, this.rateUnit);
    return unitLabel
      ? `${value.toLocaleString()} ${unitLabel}`
      : value.toLocaleString();
  }

  private renderValueNodes(info: CounterDetails): m.Children {
    const mode = this.getMode();
    switch (mode) {
      case 'value':
        return [
          m(TreeNode, {
            left: 'Value',
            right: this.formatWithUnit(info.value, 'value'),
          }),
          m(TreeNode, {
            left: 'Delta',
            right: this.formatWithUnit(info.delta, 'delta'),
          }),
          m(TreeNode, {
            left: 'Rate',
            right: this.formatWithUnit(info.rate, 'rate'),
          }),
        ];
      case 'delta':
        return [
          m(TreeNode, {
            left: 'Value',
            right: this.formatWithUnit(info.value, 'value'),
          }),
          m(TreeNode, {
            left: 'Delta',
            right: this.formatWithUnit(info.delta, 'delta'),
          }),
        ];
      case 'rate':
        return m(TreeNode, {
          left: 'Rate',
          right: this.formatWithUnit(info.rate, 'rate'),
        });
      default:
        assertUnreachable(mode);
    }
  }

  private isMemoryTrack(): boolean {
    return this.trackName.startsWith('memory_');
  }

  private isPssTotalTrack(): boolean {
    return this.trackName === 'summary.total-pss';
  }

  private isBtsVmMemoryTrack(): boolean {
    return this.trackName.startsWith('bts_vm_acc_');
  }

  private updateCounterTrackBackgroundHighlight(
    selection: TrackEventSelection,
    trackIds: Iterable<number>,
  ) {
    lynxPerfGlobals.updateCounterTrackBackgroundHighlight(selection, trackIds);
    this.trace.raf.scheduleFullRedraw();
  }

  private renderMemoryDashboard(counterInfo: CounterDetails) {
    if (this.isBtsVmMemoryTrack() && this.btsVmMemoryDetails !== undefined) {
      return m(
        Section,
        {title: 'BTS VM Memory'},
        m(BtsVmMemoryPanel, this.btsVmMemoryDetails),
      );
    }

    if (!counterInfo.args) {
      return null;
    }

    if (this.isMemoryTrack()) {
      return m(
        Section,
        {title: 'Memory Dashboard'},
        m(MemoryDashboard, {data: counterInfo.args}),
      );
    } else if (this.isPssTotalTrack()) {
      return m(
        SectionWithRightContent,
        {
          title: 'Memory PSS Panel',
          rightContent: m(MemoryPssTotalModeSelector),
          extraContent: m(MemoryPssFocusControls, {
            data: counterInfo.args,
            trace: this.trace,
          }),
        },
        m(MemoryPssTotalPanel, {data: counterInfo.args}),
      );
    }
    return null;
  }

  render() {
    const counterInfo = this.counterDetails;
    if (counterInfo) {
      const args =
        hasArgs(counterInfo.args) &&
        m(
          Section,
          {title: 'Arguments'},
          m(Tree, renderArguments(this.trace, counterInfo.args)),
        );

      const memoryDashboard = this.renderMemoryDashboard(counterInfo);

      return m(
        DetailsShell,
        {title: 'Counter', description: `${this.trackName}`},
        m(
          GridLayout,
          m(
            Section,
            {title: 'Properties'},
            m(
              Tree,
              m(TreeNode, {left: 'Name', right: `${this.trackName}`}),
              m(TreeNode, {
                left: 'Start time',
                right: m(Timestamp, {trace: this.trace, ts: counterInfo.ts}),
              }),
              this.renderValueNodes(counterInfo),
              m(TreeNode, {
                left: 'Duration',
                right: m(DurationWidget, {
                  trace: this.trace,
                  dur: counterInfo.duration,
                }),
              }),
            ),
          ),
          memoryDashboard ?? args,
        ),
      );
    } else {
      return m(DetailsShell, {title: 'Counter', description: 'Loading...'});
    }
  }

  isLoading(): boolean {
    return this.counterDetails === undefined;
  }
}

function getAliveMemoryCounterTrackIds(
  counterDetails: CounterDetails,
): number[] {
  const value = getArgDisplayValue(
    counterDetails.args ?? {},
    'debug.alive_memory_counter_tracks',
  );
  if (value === undefined) {
    return [];
  }

  try {
    const tracks = JSON.parse(value) as unknown;
    if (!Array.isArray(tracks)) {
      return [];
    }
    return tracks.flatMap((track) => {
      if (typeof track !== 'object' || track === null) {
        return [];
      }
      const id = Number((track as Record<string, unknown>).id);
      return Number.isFinite(id) ? [id] : [];
    });
  } catch {
    return [];
  }
}

async function loadBtsVmMemoryDetails(
  engine: Engine,
  trackId: number,
  eventId: number,
  sqlSource: string,
  counterDetails: CounterDetails,
): Promise<BtsVmMemoryDetails> {
  const [assignments, rssValues, annotations] = await Promise.all([
    loadBtsVmMemoryTrackAssignments(engine, true),
    loadBtsVmRssValues(engine, eventId, sqlSource),
    loadBtsVmAnnotations(engine, eventId, sqlSource),
  ]);
  const assignment = assignments.find(({track}) => track.id === trackId);
  const vmName =
    assignment === undefined
      ? 'Unknown BTS VM'
      : formatBtsVmInstanceName(assignment.vm.name, assignment.vm.generation);
  const vmType =
    assignment === undefined ? '' : normalizeVmEngineDesc(assignment.vm.desc);

  return {
    vmName,
    vmType,
    ...buildBtsVmMemorySample(
      counterDetails.value,
      rssValues.baseUsageBytes,
      rssValues.pageRssUsageBytes,
      counterDetails.args,
      annotations,
    ),
  };
}

async function loadBtsVmAnnotations(
  engine: Engine,
  eventId: number,
  sqlSource: string,
): Promise<Args | undefined> {
  const result = await engine.query(`
    WITH current_sample AS (
      SELECT arg_set_id
      FROM (${sqlSource})
      WHERE id = ${eventId}
    )
    SELECT
      annotation.flat_key AS flatKey,
      annotation.display_value AS displayValue
    FROM args annotation
    WHERE annotation.arg_set_id = (
      SELECT arg_set_id FROM current_sample
    )
    ORDER BY annotation.flat_key
  `);
  const annotations: ArgsDict = {};
  for (
    const it = result.iter({
      flatKey: STR,
      displayValue: STR,
    });
    it.valid();
    it.next()
  ) {
    const current = annotations[it.flatKey];
    if (current === undefined) {
      annotations[it.flatKey] = it.displayValue;
    } else if (Array.isArray(current)) {
      current.push(it.displayValue);
    } else {
      annotations[it.flatKey] = [current, it.displayValue];
    }
  }
  return Object.keys(annotations).length === 0 ? undefined : annotations;
}

async function loadBtsVmRssValues(
  engine: Engine,
  eventId: number,
  sqlSource: string,
): Promise<{baseUsageBytes: number; pageRssUsageBytes: number}> {
  const result = await engine.query(`
    WITH current_sample AS (
      SELECT arg_set_id
      FROM (${sqlSource})
      WHERE id = ${eventId}
    )
    SELECT
      CAST(COALESCE((
        SELECT base_arg.display_value
        FROM args base_arg
        WHERE base_arg.arg_set_id = (
          SELECT arg_set_id FROM current_sample
        )
          AND base_arg.flat_key IN ('base_usage', 'debug.base_usage')
        LIMIT 1
      ), '0') AS REAL) AS baseUsageBytes,
      CAST(COALESCE((
        SELECT rss_arg.display_value
        FROM args rss_arg
        WHERE rss_arg.arg_set_id = (
          SELECT arg_set_id FROM current_sample
        )
          AND rss_arg.flat_key IN (
            'page_rss_usage',
            'debug.page_rss_usage'
          )
        LIMIT 1
      ), '0') AS REAL) AS pageRssUsageBytes
  `);
  const row = result.iter({
    baseUsageBytes: NUM,
    pageRssUsageBytes: NUM,
  });
  return {
    baseUsageBytes: row.baseUsageBytes,
    pageRssUsageBytes: row.pageRssUsageBytes,
  };
}

async function loadCounterDetails(
  engine: Engine,
  id: number,
  sqlSource: string,
): Promise<CounterDetails> {
  const deltaExpr = counterValueExpression('delta');
  const rateExpr = counterValueExpression('rate');
  const query = `
    WITH src AS (
      SELECT
        id,
        ts,
        value,
        ${deltaExpr} as delta,
        ${rateExpr} as rate,
        arg_set_id
      FROM (${sqlSource})
    ),
    CURRENT AS (
      SELECT * FROM src WHERE id = ${id}
    ),
    NEXT as (
      SELECT
        ts
      FROM (${sqlSource})
      WHERE ts > (select ts from CURRENT)
      ORDER BY ts ASC
      LIMIT 1
    )
    SELECT
      ts as leftTs,
      value,
      delta,
      rate,
      arg_set_id as argSetId,
      (SELECT ts FROM NEXT) as rightTs
    FROM CURRENT
  `;

  const counter = await engine.query(query);
  const row = counter.iter({
    value: NUM,
    delta: NUM,
    rate: NUM,
    leftTs: LONG,
    rightTs: LONG_NULL,
    argSetId: NUM_NULL,
  });
  const leftTs = Time.fromRaw(row.leftTs);
  const rightTs = row.rightTs !== null ? Time.fromRaw(row.rightTs) : leftTs;
  const duration = rightTs - leftTs;
  const argSetId = row.argSetId;
  const args =
    argSetId == null ? undefined : await getArgs(engine, asArgSetId(argSetId));
  return {
    ts: leftTs,
    value: row.value,
    delta: row.delta,
    rate: row.rate,
    duration,
    args,
  };
}

async function loadVmEngineDescriptions(
  engine: Engine,
): Promise<VmEngineDescriptions> {
  const vmEngineDescriptions: VmEngineDescriptions = {
    mainThreadScriptingEngines: {},
    backgroundThreadScriptingEngines: {},
    backgroundThreadScriptingEngineNames: {},
    backgroundThreadScriptingEngineMemoryTrackIds: {},
    instanceUrls: {},
  };
  const vmEvents = await engine.query(`
    SELECT
      arg_set_id as argSetId
    FROM slice
    WHERE name = 'page_uses_mts_vm'
      AND arg_set_id IS NOT NULL
  `);

  for (const it = vmEvents.iter({argSetId: NUM}); it.valid(); it.next()) {
    const args = await getArgs(engine, asArgSetId(it.argSetId));
    const instanceId = getArgDisplayValue(args, 'debug.instance_id');
    const desc = normalizeVmEngineDesc(
      getArgDisplayValue(args, 'debug.desc') ?? '',
    );
    if (instanceId === undefined) {
      continue;
    }

    const instanceIdNumber = Number(instanceId);
    const url = getArgDisplayValue(args, 'debug.url');
    if (url !== undefined) {
      vmEngineDescriptions.instanceUrls[instanceIdNumber] = url;
    }

    vmEngineDescriptions.mainThreadScriptingEngines[instanceIdNumber] = desc;
  }

  const [btsVmInstances, btsVmMemoryTracks] = await Promise.all([
    loadBtsVmInstances(engine),
    loadBtsVmMemoryTracks(engine),
  ]);
  const memoryTrackByVm = new Map(
    assignBtsVmMemoryTracks(btsVmInstances, btsVmMemoryTracks).map(
      ({vm, track}) => [vm, track],
    ),
  );
  for (const btsVmInstance of btsVmInstances) {
    const btsEngineName = formatBtsVmInstanceName(
      btsVmInstance.name,
      btsVmInstance.generation,
    );
    vmEngineDescriptions.backgroundThreadScriptingEngines[btsEngineName] =
      normalizeVmEngineDesc(btsVmInstance.desc);
    const memoryTrack = memoryTrackByVm.get(btsVmInstance);
    if (memoryTrack !== undefined) {
      vmEngineDescriptions.backgroundThreadScriptingEngineMemoryTrackIds[
        btsEngineName
      ] = memoryTrack.id;
    }
    for (const use of btsVmInstance.uses) {
      vmEngineDescriptions.backgroundThreadScriptingEngineNames[
        use.instanceId
      ] = btsEngineName;
      if (use.url !== undefined) {
        vmEngineDescriptions.instanceUrls[use.instanceId] = use.url;
      }
    }
  }

  await loadInstanceUrlsFromTemplateEvents(
    engine,
    vmEngineDescriptions.instanceUrls,
  );
  return vmEngineDescriptions;
}

async function loadBtsVmMemoryAt(
  engine: Engine,
  trackId: number,
  ts: time,
): Promise<VmMemoryValue> {
  const result = await engine.query(`
    SELECT
      c.value,
      CAST(COALESCE((
        SELECT base_arg.display_value
        FROM args base_arg
        WHERE base_arg.arg_set_id = c.arg_set_id
          AND base_arg.flat_key IN ('base_usage', 'debug.base_usage')
        LIMIT 1
      ), '0') AS REAL) AS baseUsage,
      CAST(COALESCE((
        SELECT rss_arg.display_value
        FROM args rss_arg
        WHERE rss_arg.arg_set_id = c.arg_set_id
          AND rss_arg.flat_key IN ('page_rss_usage', 'debug.page_rss_usage')
        LIMIT 1
      ), '0') AS REAL) AS pageRssUsage
    FROM counter c
    WHERE c.track_id = ${trackId}
      AND c.ts <= ${ts}
    ORDER BY c.ts DESC, c.id DESC
    LIMIT 1
  `);
  const row = result.iter({
    value: NUM,
    baseUsage: NUM,
    pageRssUsage: NUM,
  });
  if (!row.valid()) {
    return {sizeBytes: 0, rssSizeBytes: 0};
  }
  return {
    sizeBytes: row.value,
    rssSizeBytes: row.baseUsage + row.pageRssUsage,
  };
}

function getArgDisplayValue(args: ArgsDict, key: string): string | undefined {
  const value = getArgValue(args, key);
  if (value === undefined) {
    return undefined;
  }
  return argToDisplayValue(value);
}

function getArgValue(args: ArgsDict, path: string): Args | undefined {
  let value: Args | undefined = args;
  for (const key of path.split('.')) {
    if (value === null || typeof value !== 'object' || value instanceof Array) {
      return undefined;
    }
    value = value[key];
  }
  return value;
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

function flattenArgs(
  args: ArgsDict,
  prefix: string = '',
): Array<{flatKey: string; key: string; value: Args; displayValue: string}> {
  const flattened: Array<{
    flatKey: string;
    key: string;
    value: Args;
    displayValue: string;
  }> = [];
  for (const [key, value] of Object.entries(args)) {
    const flatKey = prefix === '' ? key : `${prefix}.${key}`;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      flattened.push(...flattenArgs(value, flatKey));
      continue;
    }

    flattened.push({
      flatKey,
      key: flatKey,
      value,
      displayValue: argToDisplayValue(value),
    });
  }
  return flattened;
}

async function loadInstanceUrlsFromTemplateEvents(
  engine: Engine,
  instanceUrls: Record<number, string>,
  targetInstanceId?: number,
): Promise<void> {
  const instanceIdFilter =
    targetInstanceId === undefined
      ? ''
      : `AND CAST(instance_arg.display_value AS INT) = ${targetInstanceId}`;
  const urlEvents = await engine.query(`
    SELECT
      s.name as eventName,
      s.ts,
      s.arg_set_id as argSetId,
      instance_arg.display_value as instanceId,
      url_arg.display_value as url
    FROM slice s
    JOIN args url_arg ON url_arg.arg_set_id = s.arg_set_id
      AND url_arg.flat_key IN ('debug.url', 'args.url')
    JOIN args instance_arg ON instance_arg.arg_set_id = s.arg_set_id
      AND instance_arg.flat_key IN ('debug.instance_id', 'args.instance_id')
    WHERE s.name IN (
      'LynxView::loadTemplateBundle',
      'LynxTemplateRender::loadTemplateBundle',
      'LynxDevtool::onLoadFromBundle',
      'LynxEngine::LoadTemplateBundle',
      'LynxLoadTemplate',
      'TemplateAssembler::OnJSPrepared',
      'NativeFacadeDarwin::OnTemplateLoaded',
      'LynxViewLifecycle::didLoadFinishedWithUrl'
    )
    ${instanceIdFilter}
    ORDER BY s.ts ASC
  `);

  for (
    const it = urlEvents.iter({
      eventName: STR,
      ts: NUM,
      argSetId: NUM,
      instanceId: STR,
      url: STR,
    });
    it.valid();
    it.next()
  ) {
    const instanceId = Number(it.instanceId);
    if (!Number.isFinite(instanceId)) {
      continue;
    }

    if (instanceUrls[instanceId] === undefined) {
      instanceUrls[instanceId] = it.url;
    }
  }
}

async function addMemoryTrackUrl(
  engine: Engine,
  counterDetails: CounterDetails,
  trackName: string,
): Promise<void> {
  const currentUrl =
    getArgDisplayValue(counterDetails.args ?? {}, 'debug.url') ??
    getArgDisplayValue(counterDetails.args ?? {}, 'args.url');
  if (currentUrl?.trim()) {
    counterDetails.args = withDebugArg(counterDetails.args, 'url', currentUrl);
    return;
  }
  const instanceIdText = /^memory_(\d+)$/.exec(trackName)?.[1];
  if (instanceIdText === undefined) {
    return;
  }
  const instanceId = Number(instanceIdText);
  const instanceUrls: Record<number, string> = {};
  await loadInstanceUrlsFromTemplateEvents(engine, instanceUrls, instanceId);
  const url = instanceUrls[instanceId];
  if (url !== undefined) {
    counterDetails.args = withDebugArg(counterDetails.args, 'url', url);
  }
}

function withDebugArg(
  args: ArgsDict | undefined,
  key: string,
  value: Args,
): ArgsDict {
  const result: ArgsDict = {...(args ?? {})};
  const existingDebug = result.debug;
  const debugArgs: ArgsDict =
    existingDebug !== null &&
    typeof existingDebug === 'object' &&
    !Array.isArray(existingDebug)
      ? {...existingDebug}
      : {};
  debugArgs[key] = value;
  result.debug = debugArgs;
  return result;
}

function normalizeVmEngineDesc(desc: string): string {
  if (!desc.trimStart().startsWith('{')) {
    return desc;
  }

  try {
    const descRecord = JSON.parse(desc) as Record<string, unknown>;
    const vmType = descRecord.vm_type;
    return typeof vmType === 'string' ? vmType : desc;
  } catch {
    return desc;
  }
}

async function loadFirstCounterEventId(
  engine: Engine,
  sqlSource: string,
): Promise<number | undefined> {
  const query = await engine.query(`
    SELECT
      id
    FROM (${sqlSource})
    ORDER BY ts ASC
    LIMIT 1
  `);
  const row = query.iter({id: NUM});
  return row.valid() ? row.id : undefined;
}

function addPssMemoryDeltas(
  counterDetails: CounterDetails,
  firstCounterDetails: CounterDetails,
): CounterDetails {
  const currentSummary = getAliveMemorySummary(counterDetails);
  const firstSummary = getAliveMemorySummary(firstCounterDetails);
  if (currentSummary === undefined || firstSummary === undefined) {
    return counterDetails;
  }

  const deltas = calculatePssMemoryDeltas(
    counterDetails,
    currentSummary,
    firstCounterDetails,
    firstSummary,
  );
  const deltasDisplayValue = JSON.stringify(deltas);
  counterDetails.args = withDebugArg(
    counterDetails.args,
    'pss_memory_deltas',
    deltasDisplayValue,
  );
  return counterDetails;
}

function calculatePssMemoryDeltas(
  counterDetails: CounterDetails,
  currentSummary: AliveMemorySummary,
  firstCounterDetails: CounterDetails,
  firstSummary: AliveMemorySummary,
): PssMemoryDeltas {
  const currentBtsEngines = currentSummary.backgroundThreadScriptingEngines;
  const firstBtsEngines = firstSummary.backgroundThreadScriptingEngines;
  const btsEngineNames = new Set([
    ...Object.keys(currentBtsEngines),
    ...Object.keys(firstBtsEngines),
  ]);
  const btsEngineSizeBytes: Record<string, number> = {};
  const btsEngineRssSizeBytes: Record<string, number> = {};
  for (const btsEngineName of btsEngineNames) {
    btsEngineSizeBytes[btsEngineName] =
      (currentBtsEngines[btsEngineName]?.sizeBytes ?? 0) -
      (firstBtsEngines[btsEngineName]?.sizeBytes ?? 0);
    btsEngineRssSizeBytes[btsEngineName] =
      (currentBtsEngines[btsEngineName]?.rssSizeBytes ?? 0) -
      (firstBtsEngines[btsEngineName]?.rssSizeBytes ?? 0);
  }

  const currentActiveBtsSizeBytes = Object.values(currentBtsEngines).reduce(
    (total, engineInfo) => total + engineInfo.sizeBytes,
    0,
  );
  const firstActiveBtsSizeBytes = Object.values(firstBtsEngines).reduce(
    (total, engineInfo) => total + engineInfo.sizeBytes,
    0,
  );
  const currentActiveBtsRssSizeBytes = Object.values(currentBtsEngines).reduce(
    (total, engineInfo) => total + engineInfo.rssSizeBytes,
    0,
  );
  const firstActiveBtsRssSizeBytes = Object.values(firstBtsEngines).reduce(
    (total, engineInfo) => total + engineInfo.rssSizeBytes,
    0,
  );
  const currentTotalBtsSizeBytes =
    currentActiveBtsSizeBytes + currentSummary.btsVmPoolSizeBytes;
  const firstTotalBtsSizeBytes =
    firstActiveBtsSizeBytes + firstSummary.btsVmPoolSizeBytes;
  const currentTotalBtsRssSizeBytes =
    currentActiveBtsRssSizeBytes + currentSummary.btsVmPoolRssSizeBytes;
  const firstTotalBtsRssSizeBytes =
    firstActiveBtsRssSizeBytes + firstSummary.btsVmPoolRssSizeBytes;
  const currentActiveMtsSizeBytes =
    currentSummary.mainThreadScriptingEngines.reduce(
      (total, engineInfo) => total + engineInfo.sizeBytes,
      0,
    );
  const firstActiveMtsSizeBytes =
    firstSummary.mainThreadScriptingEngines.reduce(
      (total, engineInfo) => total + engineInfo.sizeBytes,
      0,
    );
  const currentActiveMtsRssSizeBytes =
    currentSummary.mainThreadScriptingEngines.reduce(
      (total, engineInfo) => total + engineInfo.rssSizeBytes,
      0,
    );
  const firstActiveMtsRssSizeBytes =
    firstSummary.mainThreadScriptingEngines.reduce(
      (total, engineInfo) => total + engineInfo.rssSizeBytes,
      0,
    );
  const currentTotalMtsSizeBytes =
    currentActiveMtsSizeBytes + currentSummary.mtsVmPoolSizeBytes;
  const firstTotalMtsSizeBytes =
    firstActiveMtsSizeBytes + firstSummary.mtsVmPoolSizeBytes;
  const currentTotalMtsRssSizeBytes =
    currentActiveMtsRssSizeBytes + currentSummary.mtsVmPoolRssSizeBytes;
  const firstTotalMtsRssSizeBytes =
    firstActiveMtsRssSizeBytes + firstSummary.mtsVmPoolRssSizeBytes;
  const currentTotalEngineSizeBytes =
    currentSummary.totalEngineSizeBytes + currentSummary.totalVmPoolSizeBytes;
  const firstTotalEngineSizeBytes =
    firstSummary.totalEngineSizeBytes + firstSummary.totalVmPoolSizeBytes;
  const currentTotalEngineRssSizeBytes =
    currentSummary.totalEngineRssSizeBytes +
    currentSummary.totalVmPoolRssSizeBytes;
  const firstTotalEngineRssSizeBytes =
    firstSummary.totalEngineRssSizeBytes + firstSummary.totalVmPoolRssSizeBytes;

  return {
    physicalMemorySizeBytes: counterDetails.value - firstCounterDetails.value,
    totalEngineSizeBytes:
      currentTotalEngineSizeBytes - firstTotalEngineSizeBytes,
    totalEngineRssSizeBytes:
      currentTotalEngineRssSizeBytes - firstTotalEngineRssSizeBytes,
    totalBtsEngineSizeBytes: currentTotalBtsSizeBytes - firstTotalBtsSizeBytes,
    totalBtsEngineRssSizeBytes:
      currentTotalBtsRssSizeBytes - firstTotalBtsRssSizeBytes,
    totalMtsEngineSizeBytes: currentTotalMtsSizeBytes - firstTotalMtsSizeBytes,
    totalMtsEngineRssSizeBytes:
      currentTotalMtsRssSizeBytes - firstTotalMtsRssSizeBytes,
    btsEngineSizeBytes,
    btsEngineRssSizeBytes,
  };
}

function getAliveMemorySummary(
  counterDetails: CounterDetails,
): AliveMemorySummary | undefined {
  if (counterDetails.args === undefined) {
    return undefined;
  }

  const summaryValue = getArgDisplayValue(
    counterDetails.args,
    'debug.alive_memory_summary',
  );
  if (summaryValue === undefined) {
    return undefined;
  }

  try {
    return JSON.parse(summaryValue) as AliveMemorySummary;
  } catch {
    return undefined;
  }
}

function getEngineRssSizeBytes(detail: Record<string, unknown>): number {
  return (
    (Number(detail.page_rss_usage) || 0) + (Number(detail.base_usage) || 0)
  );
}

async function loadVmPoolMemorySummary(
  engine: Engine,
  ts: time,
): Promise<VmPoolMemorySummary> {
  const summary: VmPoolMemorySummary = {
    btsSizeBytes: 0,
    btsRssSizeBytes: 0,
    mtsSizeBytes: 0,
    mtsRssSizeBytes: 0,
  };
  const btsPoolStates = await engine.query(`
    SELECT
      arg_set_id as argSetId
    FROM slice
    WHERE name = 'bts_vm_pool_state'
      AND ts <= ${ts}
      AND arg_set_id IS NOT NULL
    ORDER BY ts DESC
    LIMIT 1
  `);
  const btsPoolState = btsPoolStates.iter({argSetId: NUM});
  if (btsPoolState.valid()) {
    const poolMemory = calculateVmPoolMemoryFromArgs(
      await getArgs(engine, asArgSetId(btsPoolState.argSetId)),
    );
    summary.btsSizeBytes += poolMemory.sizeBytes;
    summary.btsRssSizeBytes += poolMemory.rssSizeBytes;
  }

  const mtsPoolStates = await engine.query(`
    SELECT
      arg_set_id as argSetId
    FROM slice
    WHERE name = 'mts_vm_pool_state'
      AND ts <= ${ts}
      AND arg_set_id IS NOT NULL
    ORDER BY ts DESC
  `);
  const loadedMtsPoolIds = new Set<string>();
  for (const it = mtsPoolStates.iter({argSetId: NUM}); it.valid(); it.next()) {
    const args = await getArgs(engine, asArgSetId(it.argSetId));
    const poolInstanceId = getArgDisplayValue(args, 'debug.pool_instance_id');
    if (poolInstanceId === undefined || loadedMtsPoolIds.has(poolInstanceId)) {
      continue;
    }

    loadedMtsPoolIds.add(poolInstanceId);
    if (getArgDisplayValue(args, 'debug.destroyed') === '1') {
      continue;
    }

    const poolMemory = calculateVmPoolMemoryFromArgs(args);
    summary.mtsSizeBytes += poolMemory.sizeBytes;
    summary.mtsRssSizeBytes += poolMemory.rssSizeBytes;
  }

  return summary;
}

function calculateVmPoolMemoryFromArgs(args: ArgsDict): {
  sizeBytes: number;
  rssSizeBytes: number;
} {
  let sizeBytes = 0;
  let rssSizeBytes = 0;
  for (const arg of flattenArgs(args)) {
    if (
      !arg.flatKey.startsWith('debug.id_') &&
      !arg.key.startsWith('debug.id_')
    ) {
      continue;
    }

    const argValue =
      typeof arg.value === 'string' ? arg.value : arg.displayValue;
    if (!argValue.trimStart().startsWith('{')) {
      continue;
    }

    let json: unknown;
    try {
      json = JSON.parse(argValue);
    } catch {
      continue;
    }
    if (typeof json !== 'object' || json === null) {
      continue;
    }

    const jsonRecord = json as Record<string, unknown>;
    sizeBytes += Number(jsonRecord.acc_usage) || 0;
    rssSizeBytes +=
      (Number(jsonRecord.base_usage) || 0) +
      (Number(jsonRecord.page_rss_usage) || 0);
  }

  return {sizeBytes, rssSizeBytes};
}

async function loadPssTotalCounterDetails(
  engine: Engine,
  id: number,
  sqlSource: string,
): Promise<CounterDetails> {
  const vmEngineDescriptions = await loadVmEngineDescriptions(engine);
  const counterDetails = await loadCounterDetails(engine, id, sqlSource);
  const vmPoolMemorySummary = await loadVmPoolMemorySummary(
    engine,
    counterDetails.ts,
  );
  const memoryCounterTracks: AliveMemoryCounterTrack[] = [];
  const memoryTracks = await engine.query(`
    SELECT
      id,
      name
    FROM counter_track
    WHERE name LIKE 'memory_%'
    ORDER BY id
  `);

  for (
    const it = memoryTracks.iter({id: NUM, name: STR});
    it.valid();
    it.next()
  ) {
    const match = /^memory_(\d+)$/.exec(it.name);
    if (match === null) {
      continue;
    }

    memoryCounterTracks.push({
      id: it.id,
      name: it.name,
      instanceId: Number(match[1]),
    });
  }

  if (memoryCounterTracks.length === 0) {
    return counterDetails;
  }

  const aliveMemoryCounterTracks = [];
  const aliveMemoryCounterTrackDetails: Array<{
    id: number;
    name: string;
    instanceId: number;
    counterId: number;
    value: number;
    args: Array<{
      flatKey: string;
      key: string;
      displayValue: string;
    }>;
  }> = [];
  const componentCategories = new Set([
    'text',
    'image',
    'scroll-view',
    'x-input',
    'view',
  ]);
  const aliveMemorySummary: AliveMemorySummary = {
    componentCounts: {
      'text': 0,
      'image': 0,
      'scroll-view': 0,
      'x-input': 0,
      'view': 0,
    },
    elementCount: 0,
    mainThreadScriptingEngines: [],
    backgroundThreadScriptingEngines: {},
    totalEngineSizeBytes: 0,
    totalEngineRssSizeBytes: 0,
    btsVmPoolSizeBytes: 0,
    btsVmPoolRssSizeBytes: 0,
    mtsVmPoolSizeBytes: 0,
    mtsVmPoolRssSizeBytes: 0,
    totalVmPoolSizeBytes: 0,
    totalVmPoolRssSizeBytes: 0,
  };
  aliveMemorySummary.btsVmPoolSizeBytes = vmPoolMemorySummary.btsSizeBytes;
  aliveMemorySummary.btsVmPoolRssSizeBytes =
    vmPoolMemorySummary.btsRssSizeBytes;
  aliveMemorySummary.mtsVmPoolSizeBytes = vmPoolMemorySummary.mtsSizeBytes;
  aliveMemorySummary.mtsVmPoolRssSizeBytes =
    vmPoolMemorySummary.mtsRssSizeBytes;
  aliveMemorySummary.totalVmPoolSizeBytes =
    vmPoolMemorySummary.btsSizeBytes + vmPoolMemorySummary.mtsSizeBytes;
  aliveMemorySummary.totalVmPoolRssSizeBytes =
    vmPoolMemorySummary.btsRssSizeBytes + vmPoolMemorySummary.mtsRssSizeBytes;
  const memoryCounterAlignmentEndTs = Time.add(
    counterDetails.ts,
    MEMORY_COUNTER_ALIGNMENT_TOLERANCE,
  );
  for (const memoryCounterTrack of memoryCounterTracks) {
    const memoryCounter = await engine.query(`
      WITH previous_counter AS (
        SELECT
          id,
          value
        FROM counter
        WHERE track_id = ${memoryCounterTrack.id}
          AND ts <= ${counterDetails.ts}
        ORDER BY ts DESC
        LIMIT 1
      ),
      next_aligned_counter AS (
        SELECT
          id,
          value
        FROM counter
        WHERE track_id = ${memoryCounterTrack.id}
          AND ts > ${counterDetails.ts}
          AND ts <= ${memoryCounterAlignmentEndTs}
        ORDER BY ts ASC
        LIMIT 1
      )
      SELECT
        id,
        value
      FROM previous_counter
      UNION ALL
      SELECT
        id,
        value
      FROM next_aligned_counter
      WHERE NOT EXISTS (SELECT 1 FROM previous_counter)
      LIMIT 1
    `);
    const memoryCounterRow = memoryCounter.iter({id: NUM, value: NUM});
    // Not found any counter aligned with the PSS sample. This track is not
    // alive because it has not been sampled or loaded yet.
    if (!memoryCounterRow.valid()) {
      continue;
    }

    const memoryCounterDetails = await loadCounterDetails(
      engine,
      memoryCounterRow.id,
      `
      SELECT id, ts, value, arg_set_id
      FROM counter
      WHERE track_id = ${memoryCounterTrack.id}
      `,
    );
    const memoryCounterUrl = getArgDisplayValue(
      memoryCounterDetails.args ?? {},
      'debug.url',
    );
    if (memoryCounterUrl !== undefined) {
      vmEngineDescriptions.instanceUrls[memoryCounterTrack.instanceId] =
        memoryCounterUrl;
    }

    // The counter node's value is zero, which means it is not alive
    // because the page had already been destroyed.
    if (memoryCounterRow.value === 0) {
      continue;
    }

    aliveMemoryCounterTracks.push(memoryCounterTrack);
    for (const arg of flattenArgs(memoryCounterDetails.args ?? {})) {
      const argValue =
        typeof arg.value === 'string' ? arg.value : arg.displayValue;
      let json: unknown;
      try {
        json = JSON.parse(argValue);
      } catch {
        continue;
      }
      if (typeof json !== 'object' || json === null) {
        continue;
      }

      const jsonRecord = json as Record<string, unknown>;
      const category = jsonRecord.category;
      if (typeof category !== 'string') {
        continue;
      }

      if (componentCategories.has(category)) {
        const instanceCount = Number(jsonRecord.instanceCount) || 0;
        aliveMemorySummary.componentCounts[category] += instanceCount;
      } else if (category === 'lynxTasmElement') {
        const detail = jsonRecord.detail;
        if (typeof detail === 'object' && detail !== null) {
          aliveMemorySummary.elementCount +=
            Number((detail as Record<string, unknown>).elementCount) || 0;
        }
      } else if (category === 'mainThreadScriptingEngine') {
        const sizeBytes = Number(jsonRecord.sizeBytes) || 0;
        const detail = jsonRecord.detail;
        const detailRecord =
          typeof detail === 'object' && detail !== null
            ? (detail as Record<string, unknown>)
            : {};
        const desc =
          vmEngineDescriptions.mainThreadScriptingEngines[
            memoryCounterTrack.instanceId
          ] ?? '';
        const url =
          vmEngineDescriptions.instanceUrls[memoryCounterTrack.instanceId] ??
          '';
        const rssSizeBytes = getEngineRssSizeBytes(detailRecord);
        const current = aliveMemorySummary.mainThreadScriptingEngines.find(
          (engineInfo) =>
            engineInfo.instanceId === memoryCounterTrack.instanceId,
        );
        if (current === undefined) {
          aliveMemorySummary.mainThreadScriptingEngines.push({
            instanceId: memoryCounterTrack.instanceId,
            desc,
            sizeBytes,
            rssSizeBytes,
            url,
          });
        } else {
          current.desc = current.desc || desc;
          current.url = current.url || url;
          current.sizeBytes = Math.max(current.sizeBytes, sizeBytes);
          current.rssSizeBytes = Math.max(current.rssSizeBytes, rssSizeBytes);
        }
      }
    }
    aliveMemoryCounterTrackDetails.push({
      ...memoryCounterTrack,
      counterId: memoryCounterRow.id,
      value: memoryCounterRow.value,
      args: flattenArgs(memoryCounterDetails.args ?? {}).map((arg) => ({
        flatKey: arg.flatKey,
        key: arg.key,
        displayValue: arg.displayValue,
      })),
    });
  }

  // No alive page is a valid zero-memory baseline for later PSS deltas.
  // Add missing main thread scripting engines. Some mts engines are of
  // lepus type and do not have 'mainThreadScriptingEngine' information
  // in memory counter tracks.
  for (const memoryCounterTrack of aliveMemoryCounterTracks) {
    const current = aliveMemorySummary.mainThreadScriptingEngines.find(
      (engineInfo) => engineInfo.instanceId === memoryCounterTrack.instanceId,
    );
    if (current !== undefined) {
      continue;
    }

    const desc =
      vmEngineDescriptions.mainThreadScriptingEngines[
        memoryCounterTrack.instanceId
      ];
    if (desc === undefined) {
      continue;
    }

    aliveMemorySummary.mainThreadScriptingEngines.push({
      instanceId: memoryCounterTrack.instanceId,
      desc,
      sizeBytes: 0,
      rssSizeBytes: 0,
      url:
        vmEngineDescriptions.instanceUrls[memoryCounterTrack.instanceId] ?? '',
    });
  }

  // Build the alive-page associations first; BTS memory is loaded once per VM
  // from its dedicated bts_vm_acc_* track below.
  for (const memoryCounterTrack of aliveMemoryCounterTracks) {
    const btsEngineName =
      vmEngineDescriptions.backgroundThreadScriptingEngineNames[
        memoryCounterTrack.instanceId
      ];
    if (btsEngineName === undefined) {
      continue;
    }

    const desc =
      vmEngineDescriptions.backgroundThreadScriptingEngines[btsEngineName] ??
      '';
    const instanceUrl =
      vmEngineDescriptions.instanceUrls[memoryCounterTrack.instanceId] ?? '';
    const current = aliveMemorySummary.backgroundThreadScriptingEngines[
      btsEngineName
    ] ?? {
      btsEngineName,
      desc,
      sizeBytes: 0,
      rssSizeBytes: 0,
      instanceIds: [],
      instances: [],
    };
    current.desc = current.desc || desc;
    if (!current.instanceIds.includes(memoryCounterTrack.instanceId)) {
      current.instanceIds.push(memoryCounterTrack.instanceId);
    }
    const currentInstance = current.instances.find(
      (instance) => instance.instanceId === memoryCounterTrack.instanceId,
    );
    if (currentInstance === undefined) {
      current.instances.push({
        instanceId: memoryCounterTrack.instanceId,
        url: instanceUrl,
      });
    } else if (instanceUrl !== '') {
      currentInstance.url = instanceUrl;
    }
    aliveMemorySummary.backgroundThreadScriptingEngines[btsEngineName] =
      current;
  }

  for (const [btsEngineName, engineInfo] of Object.entries(
    aliveMemorySummary.backgroundThreadScriptingEngines,
  )) {
    const memoryTrackId =
      vmEngineDescriptions.backgroundThreadScriptingEngineMemoryTrackIds[
        btsEngineName
      ];
    if (memoryTrackId === undefined) {
      continue;
    }
    const memory = await loadBtsVmMemoryAt(
      engine,
      memoryTrackId,
      counterDetails.ts,
    );
    engineInfo.sizeBytes = memory.sizeBytes;
    engineInfo.rssSizeBytes = memory.rssSizeBytes;
  }

  const aliveMemoryCounterTracksDisplayValue = JSON.stringify(
    aliveMemoryCounterTracks,
  );
  const aliveMemoryCounterTrackDetailsDisplayValue = JSON.stringify(
    aliveMemoryCounterTrackDetails,
  );
  aliveMemorySummary.totalEngineSizeBytes =
    aliveMemorySummary.mainThreadScriptingEngines.reduce(
      (total, engineInfo) => total + engineInfo.sizeBytes,
      0,
    ) +
    Object.values(aliveMemorySummary.backgroundThreadScriptingEngines).reduce(
      (total, engineInfo) => total + engineInfo.sizeBytes,
      0,
    );
  aliveMemorySummary.totalEngineRssSizeBytes =
    aliveMemorySummary.mainThreadScriptingEngines.reduce(
      (total, engineInfo) => total + engineInfo.rssSizeBytes,
      0,
    ) +
    Object.values(aliveMemorySummary.backgroundThreadScriptingEngines).reduce(
      (total, engineInfo) => total + engineInfo.rssSizeBytes,
      0,
    );
  const aliveMemorySummaryDisplayValue = JSON.stringify(aliveMemorySummary);
  const allMemoryFocusTargetsDisplayValue = JSON.stringify(
    buildAllMemoryFocusTargets(memoryCounterTracks, vmEngineDescriptions),
  );
  let debugArgs = withDebugArg(
    counterDetails.args,
    'alive_memory_counter_tracks',
    aliveMemoryCounterTracksDisplayValue,
  );
  debugArgs = withDebugArg(
    debugArgs,
    'alive_memory_counter_track_details',
    aliveMemoryCounterTrackDetailsDisplayValue,
  );
  debugArgs = withDebugArg(
    debugArgs,
    'alive_memory_summary',
    aliveMemorySummaryDisplayValue,
  );
  counterDetails.args = withDebugArg(
    debugArgs,
    'all_memory_focus_targets',
    allMemoryFocusTargetsDisplayValue,
  );

  // TODO: Implement PSS total specific counter loading with aliveMemoryCounterTracks.
  return counterDetails;
}

function buildAllMemoryFocusTargets(
  memoryCounterTracks: AliveMemoryCounterTrack[],
  vmEngineDescriptions: VmEngineDescriptions,
): MemoryFocusTarget[] {
  return memoryCounterTracks.map((track) => ({
    instanceId: track.instanceId,
    btsEngineName:
      vmEngineDescriptions.backgroundThreadScriptingEngineNames[
        track.instanceId
      ] ?? '',
    url: vmEngineDescriptions.instanceUrls[track.instanceId] ?? '',
  }));
}
