// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import {Engine} from '../../../trace_processor/engine';
import {
  LONG,
  NUM,
  NUM_NULL,
  STR,
  STR_NULL,
} from '../../../trace_processor/query_result';
import {BtsVmInstance, loadBtsVmInstances} from './bts_vm_generations';
import {loadBtsVmMemoryTrackAssignments} from './bts_vm_memory_tracks';
import {isBtsVmPageSlot} from './bts_vm_slot_memory';
import {
  MemorySnapshot,
  isVmMemorySnapshot,
  loadMemorySnapshots,
} from './memory_snapshots';

export interface MemoryPageInfo {
  instanceId: number;
  url?: string;
  createTs?: bigint;
  destroyTs?: bigint;
  mtsVmType?: string;
  btsVm?: BtsVmInstance;
}

export interface MemoryPageDetails {
  page: MemoryPageInfo;
  totalPeakBytes?: number;
  mtsPeakBytes?: number;
  btsPeakBytes?: number;
  btsPageSlotPeakBytes?: number;
  tasmElementPeakCount?: number;
  snapshots: ReadonlyArray<MemorySnapshot>;
}

const pagesByEngine = new WeakMap<
  Engine,
  Promise<ReadonlyMap<number, MemoryPageInfo>>
>();

export function loadMemoryPageInfos(
  engine: Engine,
): Promise<ReadonlyMap<number, MemoryPageInfo>> {
  let pages = pagesByEngine.get(engine);
  if (pages === undefined) {
    pages = queryMemoryPageInfos(engine);
    pagesByEngine.set(engine, pages);
  }
  return pages;
}

export async function loadMemoryPageUrl(
  engine: Engine,
  trackId: number,
  instanceId: number,
): Promise<string | undefined> {
  const page = (await loadMemoryPageInfos(engine)).get(instanceId);
  if (page?.url !== undefined) {
    return page.url;
  }
  const result = await engine.query(`
    SELECT a.display_value AS url
    FROM counter c
    JOIN args a ON a.arg_set_id = c.arg_set_id
      AND a.flat_key IN ('url', 'debug.url', 'args.url')
    WHERE c.track_id = ${trackId} AND a.display_value != ''
    ORDER BY c.ts, c.id LIMIT 1
  `);
  const row = result.iter({url: STR});
  return row.valid() ? row.url : undefined;
}

function parseRecord(
  value: string | null,
): Record<string, unknown> | undefined {
  if (value === null) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function vmType(desc: string | null): string | undefined {
  if (desc === null || desc.trim() === '') {
    return undefined;
  }
  const record = parseRecord(desc);
  return record === undefined
    ? desc
    : typeof record.vm_type === 'string'
      ? record.vm_type
      : undefined;
}

export function memoryPageBtsVmType(page: MemoryPageInfo): string | undefined {
  return page.btsVm === undefined ? undefined : vmType(page.btsVm.desc);
}

async function queryMemoryPageInfos(
  engine: Engine,
): Promise<ReadonlyMap<number, MemoryPageInfo>> {
  const [result, vms] = await Promise.all([
    engine.query(`
      SELECT
        s.name,
        s.ts,
        s.dur,
        CAST((
          SELECT display_value FROM args
          WHERE arg_set_id = s.arg_set_id
            AND flat_key IN ('instance_id', 'debug.instance_id', 'args.instance_id')
          LIMIT 1
        ) AS INT) AS instanceId,
        (
          SELECT display_value FROM args
          WHERE arg_set_id = s.arg_set_id
            AND flat_key IN ('url', 'debug.url', 'args.url')
          LIMIT 1
        ) AS url,
        (
          SELECT display_value FROM args
          WHERE arg_set_id = s.arg_set_id
            AND flat_key IN ('desc', 'debug.desc', 'args.desc')
          LIMIT 1
        ) AS desc
      FROM slice s
      WHERE s.name IN (
        'LynxShell::Create', 'LynxShell::~LynxShell',
        'page_uses_mts_vm', 'page_uses_bts_vm',
        'LynxView::loadTemplateBundle', 'LynxTemplateRender::loadTemplateBundle',
        'LynxDevtool::onLoadFromBundle', 'LynxEngine::LoadTemplateBundle',
        'LynxEngine::LoadTemplate', 'LynxLoadTemplate',
        'TemplateAssembler::OnJSPrepared', 'NativeFacadeDarwin::OnTemplateLoaded',
        'LynxViewLifecycle::didLoadFinishedWithUrl'
      )
      ORDER BY s.ts, s.id
    `),
    loadBtsVmInstances(engine),
  ]);
  const pages = new Map<number, MemoryPageInfo>();
  const templateUrls = new Map<number, string>();
  for (
    const row = result.iter({
      name: STR,
      ts: LONG,
      dur: LONG,
      instanceId: NUM_NULL,
      url: STR_NULL,
      desc: STR_NULL,
    });
    row.valid();
    row.next()
  ) {
    if (row.instanceId === null || !Number.isSafeInteger(row.instanceId)) {
      continue;
    }
    let page = pages.get(row.instanceId);
    if (page === undefined) {
      page = {instanceId: row.instanceId};
      pages.set(row.instanceId, page);
    }
    if (row.name === 'LynxShell::Create') {
      page.createTs ??= row.ts;
    } else if (row.name === 'LynxShell::~LynxShell' && row.dur >= 0n) {
      page.destroyTs ??= row.ts + row.dur;
    } else if (row.name === 'page_uses_mts_vm') {
      page.mtsVmType ??= vmType(row.desc);
    }
    const url = row.url?.trim();
    if (url) {
      page.url ??= url;
      if (row.name !== 'page_uses_mts_vm' && row.name !== 'page_uses_bts_vm') {
        if (!templateUrls.has(row.instanceId)) {
          templateUrls.set(row.instanceId, url);
        }
      }
    }
  }
  for (const vm of vms) {
    for (const use of vm.uses) {
      let page = pages.get(use.instanceId);
      if (page === undefined) {
        page = {instanceId: use.instanceId, url: use.url};
        pages.set(use.instanceId, page);
      }
      page.btsVm ??= vm;
    }
  }
  for (const [instanceId, url] of templateUrls) {
    pages.get(instanceId)!.url = url;
  }
  return pages;
}

function numberValue(value: unknown): number | undefined {
  if (
    typeof value !== 'number' &&
    (typeof value !== 'string' || value.trim() === '')
  ) {
    return undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function maxValue(
  previous: number | undefined,
  value: number | undefined,
): number | undefined {
  return value === undefined
    ? previous
    : previous === undefined
      ? value
      : Math.max(previous, value);
}

export async function loadMemoryPageDetails(
  engine: Engine,
  trackId: number,
  instanceId: number,
  traceStart: bigint,
  traceEnd: bigint,
): Promise<MemoryPageDetails> {
  const [pages, snapshots, result] = await Promise.all([
    loadMemoryPageInfos(engine),
    loadMemorySnapshots(engine),
    engine.query(`
      SELECT
        c.id,
        c.value,
        MAX(CASE WHEN a.flat_key IN (
          'mainThreadScriptingEngine', 'debug.mainThreadScriptingEngine',
          'args.mainThreadScriptingEngine'
        ) THEN a.display_value END) AS mts,
        MAX(CASE WHEN a.flat_key IN (
          'backgroundThreadScriptingEngine', 'debug.backgroundThreadScriptingEngine',
          'args.backgroundThreadScriptingEngine'
        ) THEN a.display_value END) AS bts,
        MAX(CASE WHEN a.flat_key IN (
          'lynxTasmElement', 'debug.lynxTasmElement', 'args.lynxTasmElement'
        ) THEN a.display_value END) AS elements,
        MAX(CASE WHEN a.flat_key IN ('url', 'debug.url', 'args.url')
          THEN a.display_value END) AS url
      FROM counter c
      LEFT JOIN args a ON a.arg_set_id = c.arg_set_id
      WHERE c.track_id = ${trackId}
      GROUP BY c.id
      ORDER BY c.ts, c.id
    `),
  ]);
  // Keep counter-only fallback information local to this panel.
  const page: MemoryPageInfo = {...(pages.get(instanceId) ?? {instanceId})};
  const details: MemoryPageDetails = {
    page,
    snapshots: snapshots.filter(
      (snapshot) =>
        !isVmMemorySnapshot(snapshot) && snapshot.instanceId === instanceId,
    ),
  };
  for (
    const row = result.iter({
      id: NUM,
      value: NUM,
      mts: STR_NULL,
      bts: STR_NULL,
      elements: STR_NULL,
      url: STR_NULL,
    });
    row.valid();
    row.next()
  ) {
    details.totalPeakBytes = maxValue(
      details.totalPeakBytes,
      numberValue(row.value),
    );
    const mts = parseRecord(row.mts);
    details.mtsPeakBytes = maxValue(
      details.mtsPeakBytes,
      numberValue(mts?.sizeBytes),
    );
    const bts = parseRecord(row.bts);
    details.btsPeakBytes = maxValue(
      details.btsPeakBytes,
      numberValue(bts?.sizeBytes),
    );
    details.tasmElementPeakCount = maxValue(
      details.tasmElementPeakCount,
      numberValue(parseRecord(row.elements)?.instanceCount),
    );
    if (row.url?.trim()) {
      page.url ??= row.url;
    }
  }
  if (page.btsVm !== undefined) {
    const assignments = await loadBtsVmMemoryTrackAssignments(engine);
    const assignment = assignments.find(
      ({vm}) =>
        vm.name === page.btsVm?.name &&
        vm.generation === page.btsVm?.generation,
    );
    if (assignment !== undefined) {
      const start = page.createTs ?? traceStart;
      const end = page.destroyTs ?? traceEnd;
      const use = assignment.vm.uses.find(
        (item) => item.instanceId === instanceId,
      );
      const slotKey = isBtsVmPageSlot(use?.slot)
        ? `slot_${use.slot}`
        : undefined;
      const peaks = await engine.query(`
        WITH samples AS (
          SELECT id, ts, value, arg_set_id FROM counter
          WHERE track_id = ${assignment.track.id}
            AND ts >= ${start} AND ts <= ${end}
          UNION ALL
          SELECT id, ts, value, arg_set_id FROM counter
          WHERE id = (
            SELECT id FROM counter
            WHERE track_id = ${assignment.track.id} AND ts < ${start}
              AND ts >= ${assignment.vm.createTs}
            ORDER BY ts DESC, id DESC LIMIT 1
          )
        )
        SELECT
          MAX(value) AS vmPeak,
          ${
            slotKey === undefined
              ? 'NULL'
              : `MAX((
                  SELECT CAST(display_value AS REAL) FROM args
                  WHERE arg_set_id = samples.arg_set_id
                    AND flat_key IN ('${slotKey}', 'debug.${slotKey}', 'args.${slotKey}')
                  LIMIT 1
                ))`
          } AS slotPeak
        FROM samples
      `);
      const peak = peaks.firstRow({vmPeak: NUM_NULL, slotPeak: NUM_NULL});
      details.btsPeakBytes = peak.vmPeak ?? undefined;
      details.btsPageSlotPeakBytes = peak.slotPeak ?? undefined;
    } else if (page.btsVm.shared) {
      // A page-level statistic is not a substitute for a shared VM heap.
      details.btsPeakBytes = undefined;
    }
  }
  return details;
}
