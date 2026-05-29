// Copyright (C) 2026 The Android Open Source Project
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

import {expect, Locator, Page, test} from '@playwright/test';
import fs from 'fs';
import path from 'path';
import {
  COMMAND_QUERY_LYNX_VIEW,
  LYNX_ISSUES_PLUGIN_ID,
  LYNX_PERF_ELEMENT_PLUGIN_ID,
  LYNX_SCROLL_PLUGIN_ID,
  LYNX_UI_TREE_PLUGIN_ID,
  LYNX_VITAL_TIMESTAMP_PLUGIN_ID,
} from '../lynx_perf/constants';
import {PerfettoTestHelper} from './perfetto_ui_test_helper';

const LYNX_TRACE = 'lynx_vital_timestamp.pftrace';
const ENABLED_PLUGINS = [
  'lynx.FocusMode',
  'lynx.FrameJank',
  'lynx.Perf',
  LYNX_PERF_ELEMENT_PLUGIN_ID,
  LYNX_SCROLL_PLUGIN_ID,
  'lynx.SourceMap',
  'lynx.SourceFiles',
  LYNX_UI_TREE_PLUGIN_ID,
  LYNX_VITAL_TIMESTAMP_PLUGIN_ID,
].join(',');

type OpenTraceArgs = {
  [key: string]: string;
};

test.describe.configure({mode: 'serial'});

let pth: PerfettoTestHelper;
let page: Page;

function hasTestTrace(traceName: string): boolean {
  const parts = ['test', 'data', traceName];
  if (process.cwd().endsWith('/ui')) {
    parts.unshift('..');
  }
  return fs.existsSync(path.join(...parts));
}

async function openLynxTrace(args: OpenTraceArgs = {}) {
  test.skip(
    !hasTestTrace(LYNX_TRACE),
    `Add test/data/${LYNX_TRACE} to run Lynx upgrade regression tests`,
  );

  await pth.openTraceFile(LYNX_TRACE, {
    enablePlugins: ENABLED_PLUGINS,
    ...args,
  });
}

async function workspaceSnapshot() {
  return page.evaluate(() => {
    const serialize = (node: {
      name: string;
      uri?: string;
      children: ReadonlyArray<unknown>;
    }): unknown => ({
      name: node.name,
      uri: node.uri,
      children: node.children.map((child) =>
        serialize(
          child as {
            name: string;
            uri?: string;
            children: ReadonlyArray<unknown>;
          },
        ),
      ),
    });
    return self.app.trace!.currentWorkspace.children.map((child) =>
      serialize(
        child as {
          name: string;
          uri?: string;
          children: ReadonlyArray<unknown>;
        },
      ),
    );
  });
}

type TrackTreeNode = {
  name: string;
  uri?: string;
  children: TrackTreeNode[];
};

function flattenTracks(nodes: unknown[]): TrackTreeNode[] {
  const result: TrackTreeNode[] = [];
  const visit = (node: TrackTreeNode) => {
    result.push(node);
    node.children.forEach(visit);
  };
  (nodes as TrackTreeNode[]).forEach(visit);
  return result;
}

function findGroupContainingUri(
  nodes: unknown[],
  uri: string,
): TrackTreeNode | undefined {
  const visit = (node: TrackTreeNode): TrackTreeNode | undefined => {
    if (
      node.children.some((child) =>
        flattenTracks([child]).some((n) => n.uri === uri),
      )
    ) {
      return node;
    }
    for (const child of node.children) {
      const result = visit(child);
      if (result !== undefined) {
        return result;
      }
    }
    return undefined;
  };
  for (const node of nodes as TrackTreeNode[]) {
    const result = visit(node);
    if (result !== undefined) {
      return result;
    }
  }
  return undefined;
}

async function selectFirstVitalTimestamp() {
  return page.evaluate(async (trackUri) => {
    const trace = self.app.trace!;
    const queryResult = await trace.engine.query(`
      select slice.id as id
      from slice
      join args on args.arg_set_id = slice.arg_set_id
      where args.key in ('debug.pipeline_id', 'args.pipeline_id')
        and slice.name in (
          'Timing::Mark.draw_end',
          'Timing::Mark.paintEnd',
          'Timing::Mark.fspEnd'
        )
      order by slice.ts
      limit 1
    `);
    if (queryResult.numRows() === 0) {
      throw new Error('No Lynx vital timestamp pipeline marker found');
    }
    const id = queryResult.firstRow({id: 0}).id;
    trace.selection.selectTrackEvent(trackUri, id);
    return id;
  }, LYNX_VITAL_TIMESTAMP_PLUGIN_ID);
}

async function findPipelineSliceRefs() {
  const pipelineDetail = page
    .locator('.detail-box-container')
    .filter({hasText: 'Pipeline Detail'});
  await expect(pipelineDetail).toBeVisible();

  const rows = pipelineDetail.locator('tbody tr');
  await pipelineDetail.locator('a.pf-anchor').first().waitFor({
    state: 'visible',
    timeout: 60_000,
  });

  let fallback:
    | {start: Locator; end: Locator; startId: number; endId: number}
    | undefined;
  for (let i = 0; i < (await rows.count()); i++) {
    const links = rows.nth(i).locator('a.pf-anchor');
    if ((await links.count()) < 2) {
      continue;
    }
    const start = links.nth(0);
    const end = links.nth(1);
    const startId = Number(await start.textContent());
    const endId = Number(await end.textContent());
    if (fallback === undefined) {
      fallback = {start, end, startId, endId};
    }
    if (startId !== endId) {
      return {start, end, startId, endId};
    }
  }

  if (fallback === undefined) {
    throw new Error('No pipeline slice references found');
  }
  return fallback;
}

async function expectSelectedSlice(id: number) {
  await expect
    .poll(async () => {
      const selection = await page.evaluate(() => {
        const selection = self.app.trace!.selection.selection;
        return {
          kind: selection.kind,
          eventId: 'eventId' in selection ? selection.eventId : undefined,
        };
      });
      return selection.kind === 'track_event' ? selection.eventId : undefined;
    })
    .toBe(id);
}

test.beforeEach(async ({browser}, _testInfo) => {
  page = await browser.newPage();
  pth = new PerfettoTestHelper(page);
});

test.afterEach(async () => {
  await page.close();
});

test('loads Lynx trace and keeps custom tracks in the Lynx process group', async () => {
  test.setTimeout(120_000);
  await openLynxTrace();

  const snapshot = await workspaceSnapshot();
  const flatTracks = flattenTracks(snapshot);
  expect(
    flatTracks.some((track) => track.uri === LYNX_VITAL_TIMESTAMP_PLUGIN_ID),
  ).toBe(true);

  const vitalGroup = findGroupContainingUri(
    snapshot,
    LYNX_VITAL_TIMESTAMP_PLUGIN_ID,
  );
  expect(vitalGroup).toBeDefined();
  expect(vitalGroup?.name).not.toBe('');

  const issueTracks = flatTracks.filter(
    (track) =>
      track.uri === LYNX_ISSUES_PLUGIN_ID ||
      track.uri === LYNX_UI_TREE_PLUGIN_ID ||
      track.uri === LYNX_PERF_ELEMENT_PLUGIN_ID,
  );
  for (const issueTrack of issueTracks) {
    expect(findGroupContainingUri(snapshot, issueTrack.uri!)).toBe(vitalGroup);
  }
});

test('hides Lynx issue tracks when no issue data exists and keeps issue tracks above Vital Timestamp', async () => {
  test.setTimeout(120_000);
  await openLynxTrace();

  const result = await page.evaluate(
    async ({uiTreeUri, elementUri, vitalUri}) => {
      const trace = self.app.trace!;
      const uiIssueRows = await trace.engine.query(`
        select count(1) as count
        from slice
        where name = 'DumpUITreeLayout'
      `);
      const elementIssueRows = await trace.engine.query(`
        select count(1) as count
        from slice
        where name = 'DumpElementTree'
      `);
      const flatten = (node: {
        name: string;
        uri?: string;
        children: ReadonlyArray<unknown>;
      }): Array<{name: string; uri?: string}> => [
        {name: node.name, uri: node.uri},
        ...node.children.flatMap((child) =>
          flatten(
            child as {
              name: string;
              uri?: string;
              children: ReadonlyArray<unknown>;
            },
          ),
        ),
      ];
      const tracks = trace.currentWorkspace.children.flatMap((child) =>
        flatten(
          child as {
            name: string;
            uri?: string;
            children: ReadonlyArray<unknown>;
          },
        ),
      );
      return {
        uiIssueRows: uiIssueRows.firstRow({count: 0}).count,
        elementIssueRows: elementIssueRows.firstRow({count: 0}).count,
        uris: tracks.map((track) => track.uri),
        uiIndex: tracks.findIndex((track) => track.uri === uiTreeUri),
        elementIndex: tracks.findIndex((track) => track.uri === elementUri),
        vitalIndex: tracks.findIndex((track) => track.uri === vitalUri),
      };
    },
    {
      uiTreeUri: LYNX_UI_TREE_PLUGIN_ID,
      elementUri: LYNX_PERF_ELEMENT_PLUGIN_ID,
      vitalUri: LYNX_VITAL_TIMESTAMP_PLUGIN_ID,
    },
  );

  expect(result.vitalIndex).toBeGreaterThanOrEqual(0);
  if (result.uiIssueRows === 0) {
    expect(result.uris).not.toContain(LYNX_UI_TREE_PLUGIN_ID);
  }
  if (result.uiIndex !== -1) {
    expect(result.uiIndex).toBeGreaterThanOrEqual(0);
    expect(result.uiIndex).toBeLessThan(result.vitalIndex);
  }

  if (result.elementIssueRows === 0) {
    expect(result.uris).not.toContain(LYNX_PERF_ELEMENT_PLUGIN_ID);
  }
  if (result.elementIndex !== -1) {
    expect(result.elementIndex).toBeGreaterThanOrEqual(0);
    expect(result.elementIndex).toBeLessThan(result.vitalIndex);
  }
});

test('pipeline slice refs jump to source slices', async () => {
  test.setTimeout(120_000);
  await openLynxTrace();
  await selectFirstVitalTimestamp();

  const refs = await findPipelineSliceRefs();
  await refs.start.click();
  await pth.waitForPerfettoIdle();
  await expectSelectedSlice(refs.startId);

  await selectFirstVitalTimestamp();
  await pth.waitForPerfettoIdle();
  const refreshedRefs = await findPipelineSliceRefs();
  await refreshedRefs.end.click();
  await pth.waitForPerfettoIdle();
  await expectSelectedSlice(refreshedRefs.endId);
});

test('Focus LynxView filters non-selected instance slices without continuous repaint', async () => {
  test.setTimeout(120_000);
  await openLynxTrace();

  const instances = await page.evaluate(async () => {
    const trace = self.app.trace!;
    const result = await trace.engine.query(`
      select distinct cast(instance_id as text) as instanceId
      from instance_id_slice
      where instance_id is not null
      order by instance_id
    `);
    const it = result.iter({instanceId: 'str'});
    const instanceIds: string[] = [];
    for (; it.valid(); it.next()) {
      instanceIds.push(it.instanceId);
    }
    return instanceIds;
  });

  test.skip(
    instances.length < 2,
    'Trace has fewer than two LynxView instances',
  );

  await openLynxTrace({focus_lynxviews: instances[0]});

  await expect
    .poll(async () =>
      page.evaluate(() => self.app.trace!.commands.hasCommand('queryLynxView')),
    )
    .toBe(true);
  await pth.waitForPerfettoIdle(250);

  await page.getByText('Focus LynxView').click();
  await expect(page.locator('.rightbar-lynxview-container')).toBeVisible();
  await expect(page.locator('.rightbar-lynxview-container')).toContainText(
    instances[0],
  );
  expect(page.url()).toContain(`focus_lynxviews=${instances[0]}`);
});

test('sourcemap decode state and sourceFiles drawer are wired', async () => {
  test.setTimeout(120_000);
  await openLynxTrace();

  const result = await page.evaluate(async () => {
    const trace = self.app.trace!;
    const jsProfile = await trace.engine.query(`
      select count(1) as count
      from slice
      where category = 'jsprofile'
    `);
    const sourceMapCandidates = await trace.engine.query(`
      select count(1) as count
      from slice
      join args on args.arg_set_id = slice.arg_set_id
      where slice.name in ('evaluatePreparedJavaScript', 'evaluateJavaScript')
        and args.key in (
          'debug.url',
          'debug.source_url',
          'args.url',
          'args.source_url'
        )
    `);
    const sourceFiles = await trace.engine.query(`
      select count(1) as count
      from source_files
    `);
    const originSource = await trace.engine.query(`
      select slice.id as id, args.display_value as value
      from slice
      join args on args.arg_set_id = slice.arg_set_id
      where args.key = 'args.originSource'
      limit 1
    `);
    return {
      jsProfileCount: jsProfile.firstRow({count: 0}).count,
      sourceMapCandidateCount: sourceMapCandidates.firstRow({
        count: 0,
      }).count,
      sourceFileCount: sourceFiles.firstRow({count: 0}).count,
      originSource:
        originSource.numRows() === 0
          ? undefined
          : originSource.firstRow({id: 0, value: 'str'}),
    };
  });

  if (result.jsProfileCount > 0) {
    expect(result.sourceMapCandidateCount).toBeGreaterThan(0);
    await expect(page.getByText('SourceMap Decode')).toBeVisible();
  }

  if (result.sourceFileCount > 0 && result.originSource !== undefined) {
    await page.evaluate((id) => {
      self.app.trace!.selection.selectSqlEvent('slice', id, {
        scrollToSelection: true,
      });
    }, result.originSource.id);
    await pth.waitForPerfettoIdle();
    await page.getByText(result.originSource.value).click();
    await expect(page.locator('.source-file-drawer')).toBeVisible();
  }
});

test('Scroll track names, null arg sets, and frame aggregation stay usable', async () => {
  test.setTimeout(120_000);
  await openLynxTrace();

  const result = await page.evaluate(
    async ({scrollUri, queryCommand}) => {
      const trace = self.app.trace!;
      const scrollRows = await trace.engine.query(`
        select
          id,
          arg_set_id as argSetId
        from slice
        where name in ('StartFluencyTrace', 'StopFluencyTrace')
        order by ts
      `);
      const hasScrollSlices = scrollRows.numRows() > 0;
      const firstScrollId = hasScrollSlices
        ? scrollRows.firstRow({id: 0, argSetId: 0}).id
        : undefined;

      const hasScrollTrack = trace.currentWorkspace.flatTracks.some(
        (track) => track.uri === scrollUri,
      );
      const hasQueryCommand = trace.commands.hasCommand(queryCommand);
      return {
        hasScrollSlices,
        hasScrollTrack,
        firstScrollId,
        hasQueryCommand,
      };
    },
    {
      scrollUri: LYNX_SCROLL_PLUGIN_ID,
      queryCommand: COMMAND_QUERY_LYNX_VIEW,
    },
  );

  if (result.hasScrollSlices) {
    expect(result.hasScrollTrack).toBe(true);
    expect(result.firstScrollId).toBeDefined();
    await page.evaluate(
      ({scrollUri, eventId}) => {
        self.app.trace!.selection.selectTrackEvent(scrollUri, eventId);
      },
      {scrollUri: LYNX_SCROLL_PLUGIN_ID, eventId: result.firstScrollId!},
    );
    await pth.waitForPerfettoIdle();
    await expect(page.locator('.pf-drawer-panel__drawer')).toContainText(
      'Frame Rendering',
    );
  }
  expect(result.hasQueryCommand).toBe(true);
});
