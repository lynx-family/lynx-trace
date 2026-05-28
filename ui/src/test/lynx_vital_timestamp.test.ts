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

import {test, Page, expect, Locator} from '@playwright/test';
import fs from 'fs';
import path from 'path';
import {LYNX_VITAL_TIMESTAMP_PLUGIN_ID} from '../lynx_perf/constants';
import {PerfettoTestHelper} from './perfetto_ui_test_helper';

const LYNX_VITAL_TIMESTAMP_TRACE = 'lynx_vital_timestamp.pftrace';

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

async function selectFirstVitalTimestamp() {
  const selectedId = await page.evaluate(async (trackUri) => {
    const trace = self.app.trace!;
    const queryResult = await trace.engine.query(`
      select slice.id as id
      from slice
      join args on args.arg_set_id = slice.arg_set_id
      where args.key = 'debug.pipeline_id'
        and slice.name in ('Timing::Mark.draw_end', 'Timing::Mark.paintEnd')
      order by slice.ts
      limit 1
    `);
    if (queryResult.numRows() === 0) {
      throw new Error('No Lynx vital timestamp pipeline marker found');
    }
    const id = queryResult.firstRow({id: Number()}).id;
    trace.selection.selectTrackEvent(trackUri, id);
    return id;
  }, LYNX_VITAL_TIMESTAMP_PLUGIN_ID);

  return selectedId;
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
  if (page !== undefined) {
    await page.close();
  }
});

test('vital timestamp pipeline slice refs jump to source slices', async () => {
  test.setTimeout(120_000);
  test.skip(
    !hasTestTrace(LYNX_VITAL_TIMESTAMP_TRACE),
    `Add test/data/${LYNX_VITAL_TIMESTAMP_TRACE} to run this test`,
  );

  await pth.openTraceFile(LYNX_VITAL_TIMESTAMP_TRACE, {
    enablePlugins: LYNX_VITAL_TIMESTAMP_PLUGIN_ID,
  });
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
