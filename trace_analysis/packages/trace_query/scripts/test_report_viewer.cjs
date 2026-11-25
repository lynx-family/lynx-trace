// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0.
// End-to-end check against a generated report with at least two evidence links.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');
const uiRequire = createRequire(path.resolve(__dirname, '../../../../ui/package.json'));
const { chromium } = uiRequire('playwright');
const { expect } = uiRequire('@playwright/test');

async function checkRevealedObject(frame, id) {
  const selected = frame.locator(
    `.pf-snapshot-viewer__object--selected[data-object-root=true][data-object-id="${id}"]`,
  );
  await selected.waitFor();
  assert.equal(await selected.count(), 1, 'The object has one selected root row');
  assert.equal(await frame.getByText('Located object', { exact: true }).count(), 0);
  const position = await selected.evaluate((row) => {
    const bounds = row.getBoundingClientRect();
    const table = row.closest('.pf-snapshot-viewer__summary-table');
    const viewport = table.getBoundingClientRect();
    const header = table.querySelector('thead').getBoundingClientRect();
    let group = row.previousElementSibling;
    while (group && !group.classList.contains('pf-snapshot-viewer__class')) group = group.previousElementSibling;
    return {
      visible: bounds.top >= Math.max(viewport.top, header.bottom) && bounds.bottom <= viewport.bottom,
      group: group?.dataset.classKey,
      expanded: group?.querySelector('button').getAttribute('aria-expanded'),
    };
  });
  assert.ok(position.visible, `Linked object @${id} is scrolled into view`);
  const toggle = selected.locator('button.pf-snapshot-viewer__object-toggle');
  if (await toggle.isEnabled()) {
    await expect(toggle, 'Outgoing references expand automatically').toHaveAttribute('aria-expanded', 'true');
    await frame.locator('[data-reference-name]').first().waitFor();
  }
  return { selected, position, toggle };
}

async function checkPanelResizing(browser, url) {
  const page = await browser.newPage({ viewport: { width: 1800, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  try {
    if (url.startsWith('file:')) await page.context().setOffline(true);
    await page.goto(url);
    const link = page.locator('.analysis-item [data-node-index]').first();
    await link.evaluate((element) => {
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (parent.tagName === 'DETAILS') parent.open = true;
      }
    });
    const id = await link.getAttribute('data-node-id');
    await link.click();
    const frame = page.frameLocator('iframe[title="快照详情 / Snapshot details"]');
    const { selected } = await checkRevealedObject(frame, id);
    const panel = frame.locator('.pf-snapshot-viewer');
    await panel.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
    const table = frame.locator('.pf-snapshot-viewer__summary-table table');
    const dimensions = () =>
      table.evaluate((element) => ({
        width: element.getBoundingClientRect().width,
        viewport: element.parentElement.clientWidth,
        scrollWidth: element.parentElement.scrollWidth,
        minimum: parseFloat(element.style.minWidth),
      }));
    const drag = async (handle, delta) => {
      const bounds = await handle.boundingBox();
      const x = bounds.x + bounds.width / 2;
      const y = bounds.y + Math.min(20, bounds.height / 2);
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + delta, y, { steps: 20 });
      await page.mouse.up();
    };
    const resize = async (width) => {
      const bounds = await panel.boundingBox();
      await drag(frame.locator('.pf-snapshot-viewer__resizer'), bounds.width - width);
      await expect.poll(async () => Math.abs((await panel.boundingBox()).width - width)).toBeLessThan(2);
    };
    const fillsViewport = async () => {
      await expect
        .poll(
          async () => {
            const size = await dimensions();
            return Math.abs(size.width - size.viewport);
          },
          { message: 'The detail table fills the enlarged panel without a blank right side' },
        )
        .toBeLessThan(2);
    };
    await resize(1600);
    await fillsViewport();
    for (const mode of ['summary', 'comparison']) {
      await frame.getByRole('combobox', { name: 'Snapshot mode', exact: true }).selectOption(mode);
      await frame.locator('.pf-snapshot-viewer__class').first().waitFor();
      await resize(1100);
      const original = await dimensions();
      await drag(frame.locator('[data-column-key="name"]'), 40);
      await expect.poll(async () => (await dimensions()).minimum).toBeGreaterThan(original.width + 20);
      const customized = await dimensions();
      await resize(1600);
      await fillsViewport();
      assert.equal((await dimensions()).minimum, customized.minimum, 'Enlarging preserves custom column sizes');
      if (mode === 'summary') {
        await selected.waitFor();
        await frame.locator('.pf-snapshot-viewer__retainer-row').first().waitFor();
        await page.screenshot({
          path: path.join(os.tmpdir(), 'memory-report-resize-after.png'),
          animations: 'disabled',
        });
      }
      await resize(700);
      const small = await dimensions();
      assert.ok(small.scrollWidth > small.viewport + 100, 'Shrinking preserves horizontal scrolling');
      assert.ok(Math.abs(small.width - customized.minimum) < 2, 'Shrinking retains the custom minimum width');
      await resize(1600);
      await fillsViewport();
    }
    await page.setViewportSize({ width: 1200, height: 1000 });
    await expect.poll(async () => (await panel.boundingBox()).width).toBeLessThanOrEqual(1200);
    await page.setViewportSize({ width: 1800, height: 1000 });
    await fillsViewport();
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        panelResize: 'passed in summary and comparison',
        customColumns: 'preserved',
        windowResize: 'passed',
      }),
    );
  } finally {
    await page.close();
  }
}

async function checkPagedObjectLinks(browser, standalone) {
  // Exercise a class beyond the initial 200 groups and a node beyond its first page.
  const metadata = JSON.parse(
    /<script type="application\/json" id="memory-report-snapshots">([\s\S]*?)<\/script>/.exec(
      fs.readFileSync(path.join(standalone, 'report.html'), 'utf8'),
    )[1],
  ).snapshots[0];
  const strings = ['root', 'value', 'PagedObject', 'shared value'];
  const nodes = [];
  const edges = [];
  const classCount = 215;
  const objectCount = 650;
  const firstObject = classCount + 1;
  const stringIndex = firstObject + objectCount;
  nodes.push(0, 0, 1, 0, stringIndex);
  for (let index = 1; index <= stringIndex; index++) edges.push(0, 0, index * 5);
  for (let index = 0; index < classCount; index++) {
    strings.push(`LargeClass${index}`);
    nodes.push(1, strings.length - 1, index + 2, 1000000, 0);
  }
  for (let index = 0; index < objectCount; index++) {
    nodes.push(1, 2, 10000 + index, 16, 1);
    edges.push(0, 1, stringIndex * 5);
  }
  nodes.push(2, 3, 999999, 16, 0);
  const content = JSON.stringify({
    snapshot: {
      meta: {
        node_fields: ['type', 'name', 'id', 'self_size', 'edge_count'],
        node_types: [['synthetic', 'object', 'string'], 'string', 'number', 'number', 'number'],
        edge_fields: ['type', 'name_or_index', 'to_node'],
        edge_types: [['property'], 'string_or_number', 'node'],
      },
      node_count: nodes.length / 5,
      edge_count: edges.length / 3,
    },
    nodes,
    edges,
    strings,
  });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  try {
    await page.addInitScript(() => {
      window.objectPageRequests = [];
      const original = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (message, ...args) {
        if (message.action === 'objects') window.objectPageRequests.push(message);
        return original.call(this, message, ...args);
      };
    });
    await page.context().setOffline(true);
    await page.goto(pathToFileURL(path.join(standalone, 'assets/snapshot-viewer.html')).href);
    const selection = (position) => ({
      id: metadata.vmId,
      snapshotId: metadata.snapshotId,
      node: { index: firstObject + position, id: 10000 + position },
    });
    const open = async (positions, data) =>
      page.evaluate(
        ({ selections, data }) => {
          for (const selection of selections) {
            window.postMessage({ type: 'memory-snapshot-open', request: { language: 'en', selection, data } }, '*');
          }
        },
        { selections: positions.map(selection), data },
      );
    await open([450], { snapshots: [{ ...metadata, content }], vms: [] });
    const { selected, position, toggle } = await checkRevealedObject(page, 10450);
    assert.equal(position.group, JSON.stringify(['object', 'PagedObject']));
    assert.equal(position.expanded, 'true');
    assert.ok((await page.locator('.pf-snapshot-viewer__class').count()) > 200);
    assert.equal(await page.locator('[data-object-root=true]').count(), 100);
    const requests = await page.evaluate(() => window.objectPageRequests);
    assert.deepEqual(
      requests.map(({ offset, limit }) => ({ offset, limit })),
      [{ offset: 400, limit: 100 }],
      'Direct reveal loads one page rather than the entire prefix',
    );
    await page.getByText('Objects 401–500 of 650', { exact: true }).waitFor();
    await page.locator('.pf-snapshot-viewer__retainer-row').first().waitFor();
    await page.screenshot({ path: path.join(os.tmpdir(), 'memory-report-paged-object-check.png') });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await selected.evaluate((row) => (row.dataset.pagingIdentity = 'retained'));
    await page.getByRole('button', { name: 'Show previous', exact: true }).click();
    await page.getByText('Objects 301–500 of 650', { exact: true }).waitFor();
    assert.equal(await selected.getAttribute('data-paging-identity'), 'retained', 'Prepending keeps existing rows');
    await expect(toggle, 'Paging preserves manual collapse').toHaveAttribute('aria-expanded', 'false');
    await page.getByRole('button', { name: 'Show more', exact: true }).click();
    await page.getByText('Objects 301–600 of 650', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Show more', exact: true }).click();
    await page.getByText('Objects 301–650 of 650', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Show more', exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Show all 650', exact: true }).click();
    await page.getByText('Objects 301–650 of 650', { exact: true }).waitFor({ state: 'hidden' });
    const ids = await page
      .locator('[data-object-root=true]')
      .evaluateAll((rows) => rows.map((row) => row.dataset.objectId));
    assert.equal(ids.length, 650);
    assert.equal(new Set(ids).size, 650);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await open([1, 649]);
    await checkRevealedObject(page, 10649);
    assert.equal(await page.locator('[data-object-root=true]').count(), 50);
    await page.getByText('Objects 601–650 of 650', { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ pagedObjectReveal: 'passed', stableRows: 'passed', rapidSelection: 'passed' }));
  } finally {
    await page.close();
  }
}

async function checkFilePickers(browser, url, directory, data) {
  const page = await browser.newPage();
  try {
    // Keep the same-origin restriction while replacing the OS dialogs and disk.
    // The old file:// iframe fails this check even though blob downloads work.
    await page.addInitScript(() => {
      const state = (window.reportPickerTest = { files: [], calls: [], cancel: false });
      const stored = new Map();
      const choose = (kind) => {
        void window.top.document;
        state.calls.push(kind);
        if (state.cancel) throw new DOMException('Cancelled', 'AbortError');
      };
      const file = (name) => ({
        createWritable: async () => {
          let content;
          return {
            write: async (value) => {
              content = value;
            },
            close: async () => {
              stored.set(name, content);
              state.files.push({ name, content });
            },
            abort: async () => {},
          };
        },
      });
      const directory = (prefix) => ({
        getDirectoryHandle: async (name) => directory(`${prefix}${name}/`),
        getFileHandle: async (name, options) => {
          const key = `${prefix}${name}`;
          if (!options?.create && !stored.has(key)) throw new DOMException('Missing', 'NotFoundError');
          return file(key);
        },
      });
      window.showSaveFilePicker = async ({ suggestedName }) => {
        choose('save');
        return file(suggestedName);
      };
      window.showDirectoryPicker = async () => {
        choose('directory');
        return directory('');
      };
    });
    if (url.startsWith('file:')) await page.context().setOffline(true);
    await page.goto(url);
    const link = page.locator('.issue [data-snapshot-id]').first();
    const id = await link.getAttribute('data-snapshot-id');
    const snapshot = data.snapshots.find((item) => item.snapshotId === id);
    await link.click();
    const frame = page.frameLocator('iframe[title="快照详情 / Snapshot details"]');
    await frame.locator('.pf-snapshot-viewer__class').first().waitFor();
    assert.ok(await frame.locator('body').evaluate(() => window.parent.document === window.frameElement.ownerDocument));
    await frame.locator('[aria-current=true]').click({ button: 'right' });
    await frame.getByText('Download snapshot', { exact: true }).click();
    await frame.getByText('Downloaded 1/1 snapshots.', { exact: true }).waitFor();
    const saved = await frame.locator('body').evaluate(() => window.reportPickerTest.files);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].content, fs.readFileSync(path.join(directory, snapshot.outputPath), 'utf8'));
    assert.ok(saved[0].name.endsWith('.heapsnapshot'));

    const group = frame.locator(`[data-snapshot-tree-key="instance:${snapshot.instanceId}:${snapshot.kind}"]`);
    await group.click({ button: 'right' });
    await frame.getByText('Download snapshots to directory', { exact: true }).click();
    const expected = data.snapshots.filter(
      (item) => item.instanceId === snapshot.instanceId && item.kind === snapshot.kind,
    );
    await frame.getByText(`Downloaded ${expected.length}/${expected.length} snapshots.`, { exact: true }).waitFor();
    const files = await frame.locator('body').evaluate(() => window.reportPickerTest.files.slice(1));
    assert.equal(files.length, expected.length);
    assert.ok(files.every((item) => item.name.includes('/')));
    assert.deepEqual(
      files.map((item) => item.content).sort(),
      expected.map((item) => fs.readFileSync(path.join(directory, item.outputPath), 'utf8')).sort(),
    );
    // Cancelling a picker must not silently download through another mechanism.
    await frame.locator('body').evaluate(() => {
      window.reportPickerTest.cancel = true;
    });
    let fallbackDownloads = 0;
    page.on('download', () => fallbackDownloads++);
    await frame.locator('[aria-current=true]').click({ button: 'right' });
    await frame.getByText('Download snapshot', { exact: true }).click();
    await frame.locator('.pf-snapshot-viewer__download-status').waitFor({ state: 'hidden' });
    assert.equal(fallbackDownloads, 0);
    const result = await frame.locator('body').evaluate(() => window.reportPickerTest);
    assert.deepEqual(result.calls, ['save', 'directory', 'save']);
    assert.equal(result.files.length, 1 + expected.length);
    console.log(
      JSON.stringify({ url, sameOrigin: 'passed', savePicker: 'passed', directoryPicker: 'passed', cancel: 'passed' }),
    );
  } finally {
    await page.close();
  }
}

async function main() {
  const directory = path.resolve(process.argv[2]);
  const httpUrl = process.argv[3];
  const data = JSON.parse(fs.readFileSync(path.join(directory, 'analysis.json'), 'utf8'));
  // Prove inspection works with neither the source Trace nor extracted files.
  const standalone = fs.mkdtempSync(path.join(os.tmpdir(), 'embedded-snapshot-viewer-'));
  fs.copyFileSync(path.join(directory, 'report.html'), path.join(standalone, 'report.html'));
  fs.cpSync(path.join(directory, 'assets'), path.join(standalone, 'assets'), { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const url of [httpUrl, pathToFileURL(path.join(standalone, 'report.html')).href].filter(Boolean)) {
      const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
      const errors = [];
      const requests = [];
      let fileChoosers = 0;
      page.on('pageerror', (error) => errors.push(String(error)));
      page.on('request', (request) => requests.push(request.url()));
      page.on('filechooser', () => fileChoosers++);
      await page.addInitScript(() => {
        window.showSaveFilePicker = undefined;
        window.embeddedTransfers = 0;
        window.addEventListener('message', ({ data }) => {
          if (data?.type === 'memory-snapshot-open' && data.request?.data) window.embeddedTransfers++;
        });
      });
      if (url.startsWith('file:')) await page.context().setOffline(true);
      await page.goto(url);
      const reportGeometry = () =>
        page.locator('main').evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return { left: rect.left, width: rect.width };
        });
      const initialGeometry = await reportGeometry();
      const links = page.locator('.issue [data-snapshot-id]');
      assert.ok((await links.count()) >= 2);
      const selectedId = await links.first().getAttribute('data-snapshot-id');
      await links.first().evaluate((element) => {
        element.click();
        element.click();
      });
      const frame = page.frameLocator('iframe[title="快照详情 / Snapshot details"]');
      await frame.locator('.pf-snapshot-viewer__class').first().waitFor({ timeout: 60000 });
      assert.deepEqual(await reportGeometry(), initialGeometry, 'Opening preserves report geometry');
      assert.ok((await frame.locator('[aria-current=true]').getAttribute('title')).includes(selectedId));
      const appearance = await frame.locator('.pf-snapshot-viewer').evaluate((element) => ({
        background: getComputedStyle(element).backgroundColor,
        left: element.getBoundingClientRect().left,
      }));
      assert.equal(appearance.background, 'rgb(255, 255, 255)');
      assert.ok(appearance.left > 0);
      await frame.locator('[aria-current=true]').click({ button: 'right' });
      const downloadEvent = page.waitForEvent('download');
      await frame.getByText('Download snapshot', { exact: true }).click();
      const download = await downloadEvent;
      const snapshot = data.snapshots.find((item) => item.snapshotId === selectedId);
      assert.equal(
        fs.readFileSync(await download.path(), 'utf8'),
        fs.readFileSync(path.join(directory, snapshot.outputPath), 'utf8'),
      );
      await frame.getByRole('searchbox', { name: 'Filter by class' }).fill('Function [slot=');
      await frame.locator('.pf-snapshot-viewer__class button').first().click();
      const object = frame.locator('.pf-snapshot-viewer__object').first();
      await object.waitFor();
      await object.click();
      await frame.locator('.pf-snapshot-viewer__retainer-row').first().waitFor();
      await frame.locator('[data-reference-name]').first().waitFor();
      await frame.getByRole('searchbox', { name: 'Filter by class' }).fill('');
      await frame.getByRole('combobox', { name: 'Snapshot mode', exact: true }).selectOption('comparison');
      await frame.getByRole('combobox', { name: 'Comparison baseline', exact: true }).waitFor();
      await frame.getByRole('button', { name: 'Allocate Size', exact: false }).waitFor();
      const baseline = frame.getByRole('combobox', { name: 'Comparison baseline', exact: true });
      const alternatives = await baseline
        .locator('option')
        .evaluateAll((options) => options.map((option) => option.value));
      await baseline.selectOption(alternatives.at(-1));
      await frame.locator('.pf-snapshot-viewer__class').first().waitFor();
      await frame.locator('.pf-memory-report-backdrop').click({ position: { x: 10, y: 100 } });
      await page.locator('iframe[title="快照详情 / Snapshot details"]').waitFor({ state: 'hidden' });
      assert.ok(await page.locator('iframe[title="快照详情 / Snapshot details"]').isHidden());
      assert.deepEqual(await reportGeometry(), initialGeometry, 'Closing preserves report geometry');
      assert.equal(await page.locator('body').evaluate((element) => element.style.overflow), '');
      assert.equal(fileChoosers, 0, 'No file chooser is needed');
      assert.ok(!requests.some((url) => /\.(pftrace|wasm|heapsnapshot)(?:$|\?)/.test(url)));
      const nextId = await links.nth(1).getAttribute('data-snapshot-id');
      await links.nth(1).click();
      await frame.locator(`[aria-current=true][title*="${nextId}"]`).waitFor();
      await frame.getByRole('combobox', { name: 'Snapshot mode', exact: true }).selectOption('summary');
      await frame.locator('.pf-snapshot-viewer__class').first().waitFor();
      await page.screenshot({
        path: path.join(require('node:os').tmpdir(), 'memory-report-viewer-check.png'),
        animations: 'disabled',
      });
      await frame.locator('input[type=file]').setInputFiles(path.join(directory, snapshot.outputPath));
      await frame.locator('[aria-current=true][data-snapshot-slice-id="-1"]').waitFor();
      await frame.locator('.pf-snapshot-viewer__class').first().waitFor();
      await frame.getByRole('searchbox', { name: 'Filter by class' }).press('Escape');
      await page.locator('iframe[title="快照详情 / Snapshot details"]').waitFor({ state: 'hidden' });
      assert.ok(await page.locator('iframe[title="快照详情 / Snapshot details"]').isHidden());
      const firstBreakdown = data.residualAnalyses
        .find((a) => a.instanceId === 1)
        ?.findings.find((f) => f.id === 'unclassified')?.allocationBreakdown;
      if (firstBreakdown) {
        const table = page.locator('.cache-breakdown').first();
        await table.evaluate((element) => {
          for (let parent = element.parentElement; parent; parent = parent.parentElement) {
            if (parent.tagName === 'DETAILS') parent.open = true;
          }
        });
        assert.equal(await table.locator('tbody tr').count(), firstBreakdown.rows.length);
        const bytes = await table
          .locator('[data-allocation-bytes]')
          .evaluateAll((rows) => rows.reduce((sum, row) => sum + Number(row.dataset.allocationBytes), 0));
        assert.equal(bytes, firstBreakdown.bytes);
        await table.scrollIntoViewIfNeeded();
        await page.screenshot({
          path: path.join(os.tmpdir(), 'memory-cache-breakdown-check.png'),
          animations: 'disabled',
        });
        for (const sample of firstBreakdown.rows.flatMap((row) => row.samples)) {
          const link = table.locator(`[data-node-id="${sample.nodeId}"]`);
          await link.click();
          const selected = frame.locator(`.pf-snapshot-viewer__object--selected[data-object-id="${sample.nodeId}"]`);
          await selected.waitFor();
          if (sample.stringPreview) {
            const item = table.locator(`.allocation-item:has([data-node-id="${sample.nodeId}"])`);
            const string = item.locator('.allocation-string');
            const fontSize = await string.evaluate((element) => getComputedStyle(element).fontSize);
            assert.equal(fontSize, '12px');
            assert.equal(
              fontSize,
              await item
                .locator('.cache-path')
                .first()
                .evaluate((element) => getComputedStyle(element).fontSize),
              'String preview and retention paths share the same font size',
            );
            assert.equal(
              await item.locator('.allocation-summary').textContent(),
              `${sample.type} @${sample.nodeId} · ${sample.bytes} B`,
            );
            assert.ok(
              await item.evaluate(
                (element) =>
                  element.querySelector('.allocation-string').getBoundingClientRect().top >=
                  element.querySelector('.allocation-summary').getBoundingClientRect().bottom,
              ),
              'String content starts below the type, ID and size line',
            );
            const actual = selected.locator('.pf-snapshot-viewer__string').first();
            assert.equal(
              await string.evaluate((element) => getComputedStyle(element).color),
              await actual.evaluate((element) => getComputedStyle(element).color),
              'String colors match snapshot details',
            );
            const value = await actual.evaluate((element) =>
              [...element.childNodes]
                .filter((node) => node.nodeType === Node.TEXT_NODE)
                .map((node) => node.textContent)
                .join(''),
            );
            const prefix = Array.from(value.slice(0, 256)).slice(0, 128).join('');
            assert.equal(await string.textContent(), `"${prefix}${prefix.length < value.length ? '...' : ''}"`);
          }
          await frame.locator('.pf-snapshot-viewer__retainer-row').first().waitFor();
          await frame.getByRole('searchbox', { name: 'Filter by class' }).press('Escape');
          await page.locator('iframe[title="快照详情 / Snapshot details"]').waitFor({ state: 'hidden' });
        }
      }
      const objectLinks = page.locator('.analysis-item [data-node-index]:visible');
      assert.ok(await objectLinks.count(), 'Report includes representative node links');
      const functionLink = objectLinks.filter({ hasText: 'Function @16581' }).first();
      if (await functionLink.count()) {
        await functionLink.click();
        const { selected, position } = await checkRevealedObject(frame, 16581);
        assert.equal(position.group, JSON.stringify(['closure', 'Function']));
        assert.equal(position.expanded, 'true');
        assert.equal(await frame.locator('[data-object-root=true][data-object-id="16581"]').count(), 1);
        assert.ok(
          await selected.evaluate((row) => row.previousElementSibling.textContent.includes('×1')),
          'Function @16581 is directly below its original Function ×1 group',
        );
        await page.screenshot({
          path: path.join(os.tmpdir(), 'memory-report-function-reveal-check.png'),
          animations: 'disabled',
        });
        await frame.getByRole('searchbox', { name: 'Filter by class' }).press('Escape');
        await page.locator('iframe[title="快照详情 / Snapshot details"]').waitFor({ state: 'hidden' });
      }
      for (const language of ['en', 'zh-CN']) {
        await page.locator(`[data-language="${language === 'en' ? 'en' : 'zh'}"]`).click();
        const nonLeakSources = new Set(['moduleCacheMonitor', '_$factoryCache', '_$loadScriptCache', '__Engine']);
        const breakdowns = data.residualAnalyses.flatMap((analysis) =>
          analysis.findings.flatMap((finding) => (finding.allocationBreakdown ? [finding.allocationBreakdown] : [])),
        );
        for (const [index, breakdown] of breakdowns.entries()) {
          const rows = [...breakdown.rows].sort((a, b) => b.bytes - a.bytes);
          const table = page.locator('.cache-breakdown').nth(index);
          const displayed = await table.locator('tbody tr').evaluateAll((elements) =>
            elements.map((element) => {
              const badge = element.querySelector('[data-source-status]');
              return {
                bytes: Number(element.dataset.allocationBytes),
                status: badge?.dataset.sourceStatus,
                text: badge?.textContent,
                rounded: badge ? getComputedStyle(badge).borderRadius : '',
              };
            }),
          );
          assert.deepEqual(
            displayed.map((row) => row.bytes),
            rows.map((row) => row.bytes),
            'Rows sort largest first',
          );
          const titleLeak = await table.evaluate(
            (element) => element.closest('article').querySelector('h4 .badge.leak')?.textContent ?? null,
          );
          assert.equal(
            titleLeak,
            displayed.some((row) => row.status === 'leak') ? (language === 'en' ? 'Leak' : '泄漏') : null,
            'Finding title reflects a leak in its source table',
          );
          for (const [i, row] of rows.entries()) {
            for (const sample of row.samples.filter((sample) => sample.stringPreview)) {
              const preview = sample.stringPreview;
              const value = `"${preview.text}${preview.truncated ? '...' : ''}"`;
              assert.equal(
                await table
                  .locator(`.allocation-item:has([data-node-id="${sample.nodeId}"]) .allocation-string`)
                  .textContent(),
                value,
              );
              assert.ok(
                [...value].length <= 133,
                'String previews stop at 128 characters plus ... and surrounding quotes',
              );
            }
            const labels = row.owners.flatMap((owner) => owner.labels ?? [owner.label]);
            const status = !labels.length
              ? 'unresolved'
              : labels.every((label) => nonLeakSources.has(label))
                ? 'non-leak'
                : 'leak';
            assert.equal(displayed[i].status, status);
            assert.equal(
              displayed[i].text,
              (language === 'en'
                ? { 'non-leak': 'Non-leak', leak: 'Leak', unresolved: 'Needs verification' }
                : { 'non-leak': '非泄漏', leak: '泄漏', unresolved: '待核实' })[status],
            );
            assert.equal(displayed[i].rounded, '999px');
          }
        }
        const columnRatio = await page
          .locator('.cache-breakdown table')
          .first()
          .evaluate(
            (table) => table.querySelector('th').getBoundingClientRect().width / table.getBoundingClientRect().width,
          );
        assert.ok(columnRatio <= 0.24, 'Source column retains its 23% width');
        // Test the reported zero-size holders as well as the leaked function.
        for (const label of ['moduleCacheMonitor', 'sharedData', '__Engine', 'Function @']) {
          const candidates = objectLinks.filter({ hasText: label });
          const count = await candidates.count();
          assert.ok(count > 0, `Missing ${label} link in ${language}`);
          for (const index of [...new Set([0, count - 1])]) {
            const link = candidates.nth(index);
            await link.evaluate((element) => {
              for (let parent = element.parentElement; parent; parent = parent.parentElement) {
                if (parent.tagName === 'DETAILS') parent.open = true;
              }
            });
            const id = await link.getAttribute('data-node-id');
            const snapshotId = await link.getAttribute('data-snapshot-id');
            await link.click();
            const { selected, position, toggle } = await checkRevealedObject(frame, id);
            await frame.locator(`[aria-current=true][title*="${snapshotId}"]`).waitFor();
            await frame.locator('.pf-snapshot-viewer__retainer-row').first().waitFor();
            assert.equal(await frame.getByRole('searchbox', { name: 'Filter by class' }).inputValue(), '');
            assert.equal(
              await frame.getByRole('combobox', { name: 'Snapshot mode', exact: true }).inputValue(),
              'summary',
            );
            assert.deepEqual(await reportGeometry(), initialGeometry);
            if (label !== 'Function @') {
              assert.equal(await selected.locator('td').nth(2).getAttribute('title'), '0 bytes');
            } else {
              assert.ok(position.group, 'Regular objects remain in their original class');
              assert.equal(position.expanded, 'true');
            }
            await toggle.click();
            await expect(toggle).toHaveAttribute('aria-expanded', 'false');
            await toggle.click();
            await expect(toggle).toHaveAttribute('aria-expanded', 'true');
            await frame.locator('[data-reference-name]').first().waitFor();
            await frame.getByRole('searchbox', { name: 'Filter by class' }).fill('nonexistent-filter');
            await frame.getByRole('searchbox', { name: 'Filter by class' }).press('Escape');
            await page.locator('iframe[title="快照详情 / Snapshot details"]').waitFor({ state: 'hidden' });
          }
        }
      }
      const secondAnalysis = data.residualAnalyses.find((a) => a.instanceId === 2);
      const secondBreakdown = secondAnalysis?.findings.find((f) => f.id === 'unclassified')?.allocationBreakdown;
      if (secondBreakdown) {
        const engine = secondBreakdown.rows.find((row) => row.owners.some((owner) => owner.label === '__Engine'));
        assert.ok(engine, '__Engine is measured as a holder without a name allowlist');
        if (secondBreakdown.bytes === 137440) {
          assert.equal(engine.bytes, 1032);
          assert.equal(engine.count, 11);
          assert.ok(secondBreakdown.rows.every((row) => row.owners.length > 0));
        }
        const table = page.locator(`#${secondAnalysis.reportAnchor} .cache-breakdown`);
        await table.evaluate((element) => {
          for (let parent = element.parentElement; parent; parent = parent.parentElement) {
            if (parent.tagName === 'DETAILS') parent.open = true;
          }
        });
        const row = table.locator('tbody tr').filter({ has: page.locator('td:first-child', { hasText: '__Engine' }) });
        assert.equal(await row.locator('td').nth(1).innerText(), `${engine.bytes} B / ${engine.count}`);
        const sample = engine.samples[0];
        await row.locator(`[data-node-id="${sample.nodeId}"]`).click();
        await frame.locator(`.pf-snapshot-viewer__object--selected[data-object-id="${sample.nodeId}"]`).waitFor();
        await frame.getByRole('searchbox', { name: 'Filter by class' }).press('Escape');
        await page.locator('iframe[title="快照详情 / Snapshot details"]').waitFor({ state: 'hidden' });
        await row.scrollIntoViewIfNeeded();
        await page.screenshot({
          path: path.join(os.tmpdir(), 'memory-generic-holder-check.png'),
          animations: 'disabled',
        });
      }
      const badLink = objectLinks.filter({ hasText: 'moduleCacheMonitor' }).first();
      const correctId = await badLink.getAttribute('data-node-id');
      await badLink.evaluate((element) => {
        element.dataset.nodeId = '-1';
      });
      await badLink.click();
      await frame.getByText('The linked object does not match this snapshot.', { exact: true }).waitFor();
      assert.equal(await frame.locator('.pf-snapshot-viewer__object--selected').count(), 0);
      await frame.locator('.pf-memory-report-backdrop').click({ position: { x: 10, y: 100 } });
      await page.locator('iframe[title="快照详情 / Snapshot details"]').waitFor({ state: 'hidden' });
      await badLink.evaluate((element, id) => {
        element.dataset.nodeId = id;
      }, correctId);
      await badLink.click();
      await frame.locator(`.pf-snapshot-viewer__object--selected[data-object-id="${correctId}"]`).waitFor();
      await page.screenshot({
        path: path.join(os.tmpdir(), 'memory-report-node-links-check.png'),
        animations: 'disabled',
      });
      assert.equal(await frame.locator('body').evaluate(() => window.embeddedTransfers), 1);
      assert.deepEqual(errors, []);
      console.log(
        JSON.stringify({
          url,
          selectedId,
          nextId,
          references: 'passed',
          comparison: 'passed',
          offlineWithoutTrace: 'passed',
          download: 'passed',
          externalSnapshot: 'passed',
          close: 'passed',
          representativeNodes: 'passed in both languages',
          nodeIdentityMismatch: 'rejected',
          reportGeometry: 'unchanged',
          errors,
        }),
      );
      await page.close();
      await checkFilePickers(browser, url, directory, data);
      await checkPanelResizing(browser, url);
    }
    await checkPagedObjectLinks(browser, standalone);
  } finally {
    await browser.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
