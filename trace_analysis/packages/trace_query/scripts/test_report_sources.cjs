// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0.
// Actual offline report interaction, including the source panel opened by a node link.
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const uiRequire = createRequire(path.resolve(__dirname, '../../../../ui/package.json'));
const { chromium } = uiRequire('playwright');
const { expect } = uiRequire('@playwright/test');

async function checkSourceConnector(panel, hasOriginal) {
  const connectors = panel.locator('.pf-snapshot-viewer__source-connector');
  await expect(connectors).toHaveCount(hasOriginal ? 3 : 0);
  if (!hasOriginal) return;
  const geometry = await panel.evaluate((element) => {
    const original = element.querySelector('.pf-snapshot-viewer__original-source-link').getBoundingClientRect();
    const generated = element.querySelector('.pf-snapshot-viewer__generated-location').getBoundingClientRect();
    const parts = Array.from(element.querySelectorAll('.pf-snapshot-viewer__source-connector'));
    const [top, middle, bottom] = parts.map((part) => part.getBoundingClientRect());
    return {
      topAligned: Math.abs(top.top + top.height / 2 - original.top - original.height / 2) < 1,
      bottomAligned: Math.abs(bottom.top + bottom.height / 2 - generated.top - generated.height / 2) < 1,
      continuous: Math.abs(top.bottom - middle.top) < 1 && Math.abs(middle.bottom - bottom.top) < 1,
      leftAligned: top.left === middle.left && middle.left === bottom.left,
      outsideText: top.right < original.left && bottom.right < generated.left,
      decorative: parts.every((part) => part.getAttribute('aria-hidden') === 'true'),
    };
  });
  assert.deepEqual(geometry, {
    topAligned: true,
    bottomAligned: true,
    continuous: true,
    leftAligned: true,
    outsideText: true,
    decorative: true,
  });
}

async function checkSourceLayerOrder(panel, hasOriginal) {
  await expect(panel).not.toContainText('Source ·');
  await checkSourceConnector(panel, hasOriginal);
  const blocks = await panel.evaluate((element) =>
    Array.from(element.children).flatMap((child) => {
      if (child.matches('.pf-snapshot-viewer__original-source-link')) return ['original-link'];
      if (child.matches('pre.pf-snapshot-viewer__generated-source')) return ['generated-code'];
      if (child.matches('pre')) return ['original-code'];
      if (child.matches('div') && child.querySelector('.pf-snapshot-viewer__generated-source-link'))
        return ['runtime-link'];
      if (child.matches('div') && child.textContent.startsWith('Generated JavaScript ·')) return ['coordinates'];
      if (child.matches('div')) return ['diagnostic'];
      return [];
    }),
  );
  assert.deepEqual(
    blocks,
    hasOriginal
      ? ['original-link', 'original-code', 'runtime-link', 'generated-code', 'coordinates']
      : ['runtime-link', 'generated-code', 'diagnostic', 'coordinates'],
  );
  const layout = await panel.evaluate((element) => {
    const body = element.closest('.pf-snapshot-viewer__retainer-body');
    const boxes = [element, ...element.querySelectorAll('pre')];
    return {
      scrollbar: getComputedStyle(body).scrollbarWidth,
      keyboardAccessible: body.tabIndex === 0,
      bodyFits: body.scrollWidth <= body.clientWidth + 1,
      sourceFits: boxes.every(
        (box) =>
          getComputedStyle(box).overflowY === 'visible' &&
          box.scrollWidth <= box.clientWidth + 1 &&
          box.scrollHeight <= box.clientHeight + 1,
      ),
      wraps: boxes.slice(1).every((box) => getComputedStyle(box).whiteSpace === 'pre-wrap'),
    };
  });
  assert.deepEqual(layout, {
    scrollbar: 'none',
    keyboardAccessible: true,
    bodyFits: true,
    sourceFits: true,
    wraps: true,
  });
}

async function checkGcFunctionNames(page, frame) {
  await frame.getByPlaceholder('Filter by class').fill('system / var_ref [slot=4]');
  const group = frame.getByTitle('system / var_ref [slot=4] (native)', { exact: true });
  if ((await group.getAttribute('aria-expanded')) !== 'true') await group.click();
  await frame.locator('[data-object-root="true"]').first().waitFor();
  if (!(await frame.locator('[data-object-root="true"][data-object-id="14391"]').count())) {
    await frame.getByRole('button', { name: /^Show all [\d,]+$/ }).click();
  }
  // Holder nodes have zero size and are reached through outgoing references.
  for (const id of [14391, 14393, 16645, 24439, 24441]) {
    await frame.locator(`[data-object-id="${id}"]`).first().locator('.pf-snapshot-viewer__object-toggle').click();
    if (id === 16645) await frame.getByRole('button', { name: 'Show all 122', exact: true }).click();
  }
  const object = frame.locator('[data-object-id="24503"]');
  const name = object.locator('.pf-snapshot-viewer__source-function');
  const link = object.locator('.pf-snapshot-viewer__source-link');
  await expect(link).toHaveText('base.ts:73:18');
  await expect(name).toHaveText('mergePendingUpdate');
  await expect(name).toHaveAttribute('title', 'mergePendingUpdate');
  assert.equal(await link.evaluate((el) => el.nextElementSibling?.textContent), 'mergePendingUpdate');
  const toggle = object.locator('.pf-snapshot-viewer__object-toggle');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await link.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await frame.locator('[data-object-id="24487"]').first().locator('.pf-snapshot-viewer__object-label').click();
  const row = frame.locator('.pf-snapshot-viewer__retainer-row').filter({
    has: frame.locator('.pf-snapshot-viewer__source-function', { hasText: /^mergePendingUpdate$/ }),
  });
  await expect(row).toHaveCount(1);
  await expect(row.locator('.pf-snapshot-viewer__object-id')).toHaveText(' @24503');
  const sourceToggle = row.locator('.pf-snapshot-viewer__source-link');
  const treeToggle = row.locator(':scope > button');
  const expanded = await treeToggle.getAttribute('aria-expanded');
  await expect(sourceToggle).toHaveAttribute('aria-expanded', 'false');
  await sourceToggle.click();
  assert.equal(await treeToggle.getAttribute('aria-expanded'), expanded);
  const panel = row.locator('.pf-snapshot-viewer__retainer-source > .pf-snapshot-viewer__source-details');
  await expect(panel.locator('.pf-snapshot-viewer__source-line')).toContainText('private static mergePendingUpdate(');
  await checkSourceLayerOrder(panel, true);
  for (const width of [1600, 1100, 900]) {
    await page.setViewportSize({ width, height: 1100 });
    await checkSourceConnector(panel, true);
    const geometry = await row.evaluate((el) => {
      const source = el.querySelector('.pf-snapshot-viewer__source-details').getBoundingClientRect();
      const metrics = el.querySelector('.pf-snapshot-viewer__retainer-metrics').getBoundingClientRect();
      const labelElement = el.querySelector('.pf-snapshot-viewer__source-function');
      const label = labelElement.getBoundingClientRect();
      const link = el.querySelector('.pf-snapshot-viewer__source-link').getBoundingClientRect();
      const tree = el.closest('.pf-snapshot-viewer__retainer-tree');
      return {
        sourceRight: source.right,
        metricsRight: metrics.right,
        sourceTop: source.top,
        metricsBottom: metrics.bottom,
        nameLeft: label.left,
        nameRight: label.right,
        nameOverflows: labelElement.scrollWidth > labelElement.clientWidth + 1,
        linkRight: link.right,
        treeWidth: tree.clientWidth,
        scrollWidth: tree.scrollWidth,
      };
    });
    assert(Math.abs(geometry.sourceRight - geometry.metricsRight) <= 1, JSON.stringify(geometry));
    assert(geometry.sourceTop >= geometry.metricsBottom, JSON.stringify(geometry));
    assert(geometry.nameLeft >= geometry.linkRight, JSON.stringify(geometry));
    assert(geometry.nameRight <= geometry.metricsRight, JSON.stringify(geometry));
    assert(geometry.scrollWidth <= geometry.treeWidth + 1, JSON.stringify(geometry));
    if (width === 1600) assert(!geometry.nameOverflows, JSON.stringify(geometry));
  }
  await page.setViewportSize({ width: 1600, height: 1100 });
  await row.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(os.tmpdir(), 'memory-report-source-function-names.png'),
    animations: 'disabled',
  });
  await sourceToggle.click();
  await expect(panel).toHaveCount(0);
  await sourceToggle.focus();
  await page.keyboard.press('Enter');
  await expect(panel).toBeVisible();
  console.log(
    'Both trees show mergePendingUpdate beside base.ts:73:18 before expansion; source width and keyboard toggle: passed.',
  );
}

async function checkRcSourceLabels(browser, directory) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  try {
    await page.context().setOffline(true);
    await page.goto(pathToFileURL(path.join(directory, 'report.html')).href);
    const link = page.locator('.analysis-item [data-node-id="15397"]').first();
    const ancestors = link.locator('xpath=ancestor::details');
    for (let index = 0; index < (await ancestors.count()); index++) {
      const details = ancestors.nth(index);
      if (!(await details.evaluate((element) => element.open))) {
        await details.locator(':scope > summary').click();
      }
    }
    await link.click();
    const frame = page.frameLocator('iframe[title="快照详情 / Snapshot details"]');
    const profile = frame.locator('[data-snapshot-slice-id="6435"]');
    await profile.click();
    await expect(profile).toHaveAttribute('aria-current', 'true');
    const group = frame.locator('button[title="Function (closure)"]');
    await expect(group).toBeVisible();
    if ((await group.getAttribute('aria-expanded')) !== 'true') await group.click();
    const mapped = frame.locator('[data-object-root="true"][data-object-id="15397"] .pf-snapshot-viewer__source-link');
    const script = frame.locator('[data-object-root="true"][data-object-id="27923"] .pf-snapshot-viewer__source-link');
    await expect(mapped).toHaveText('App.tsx:20:59');
    await expect(script).toHaveText('canvas.ts:38:39');
    await expect(mapped.locator('..').locator('.pf-snapshot-viewer__source-function')).toHaveCount(0);
    await expect(script.locator('..').locator('.pf-snapshot-viewer__source-function')).toHaveText('createCanvas');
    await script.click();
    const source = frame.locator('.pf-snapshot-viewer__retainer-body > .pf-snapshot-viewer__source-details');
    await expect(source).toContainText('file:///krypton.js');
    await expect(source).toContainText('byte offset 25172');
    await expect(source.locator('.pf-snapshot-viewer__original-source-link')).toHaveAttribute(
      'href',
      'https://code.byted.org/lynx/template-assembler/blob/710b41823ed73572117b7b6852ed5df6995d4646/krypton/js/krypton-deprecated/src/canvas.ts#L38',
    );
    await expect(source.locator('.pf-snapshot-viewer__source-line')).toContainText('canvasImpl.prototype.createCanvas');
    await page.screenshot({
      path: path.join(os.tmpdir(), 'memory-report-rc-source-filenames.png'),
      animations: 'disabled',
    });
    await frame
      .locator('[data-object-root="true"][data-object-id="27927"] .pf-snapshot-viewer__source-link')
      .click();
    await expect(source.locator('.pf-snapshot-viewer__original-source-link')).toHaveText(
      'krypton/js/krypton-deprecated/src/canvas.ts:88:46',
    );
    await expect(source.locator('.pf-snapshot-viewer__generated-location')).toHaveText(
      'file:///krypton.js · byte offset 26042',
    );
    await checkSourceLayerOrder(source, true);
    await page.screenshot({
      path: path.join(os.tmpdir(), 'memory-report-krypton-source-arrow.png'),
      animations: 'disabled',
    });
    await frame.getByTitle('Close snapshot viewer').first().click();
    const coreLink = page.locator('.analysis-item [data-node-id="33811"]').first();
    const coreAncestors = coreLink.locator('xpath=ancestor::details');
    for (let index = 0; index < (await coreAncestors.count()); index++) {
      const details = coreAncestors.nth(index);
      if (!(await details.evaluate((element) => element.open))) {
        await details.locator(':scope > summary').click();
      }
    }
    await coreLink.click();
    await expect(source.locator('.pf-snapshot-viewer__original-source-link')).toHaveAttribute(
      'href',
      'https://code.byted.org/lynx/template-assembler/blob/710b41823ed73572117b7b6852ed5df6995d4646/lynx/js_libraries/lynx-core/src/lynx/lynx.ts#L318',
    );
    await expect(source.locator('.pf-snapshot-viewer__source-line')).toContainText('setSharedData');
    await expect(source.locator('.pf-snapshot-viewer__generated-source-link')).toHaveAttribute(
      'href',
      /\/lynx_core_dev\.js#L\d+:\d+$/,
    );
    assert.deepEqual(errors, []);
    console.log('RC first snapshot -> @15397 App.tsx:20:59; @27923 verified Krypton canvas.ts:38:39: passed.');
    console.log('Core runtime URL lynx_core.js -> verified dev build -> tracked lynx.ts:318:19: passed.');
  } finally {
    await page.close();
  }
}

async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
    const errors = [];
    page.on('pageerror', (error) => {
      errors.push(String(error));
      console.error('Browser error:', String(error));
    });
    page.setDefaultTimeout(10000);
    await page.context().setOffline(true);
    await page.goto(pathToFileURL(path.join(path.resolve(process.argv[2]), 'report.html')).href);
    const link = page.locator('.analysis-item [data-node-id="16581"]').first();
    const ancestors = link.locator('xpath=ancestor::details');
    for (let index = 0; index < (await ancestors.count()); index++) {
      const details = ancestors.nth(index);
      if (!(await details.evaluate((element) => element.open))) {
        await details.locator(':scope > summary').click();
      }
    }
    await link.click();
    const frame = page.frameLocator('iframe[title="快照详情 / Snapshot details"]');
    const selected = frame.locator(
      '.pf-snapshot-viewer__object--selected[data-object-id="16581"][data-object-root="true"]',
    );
    await expect(selected)
      .toBeVisible()
      .catch(async (error) => {
        console.error('Viewer messages:', await frame.locator('.pf-snapshot-viewer__message').allTextContents());
        console.error('Loader:', await frame.locator('.pf-memory-report-loader').allTextContents());
        throw error;
      });
    const source = frame.locator('.pf-snapshot-viewer__retainer-body > .pf-snapshot-viewer__source-details');
    await expect(source).toBeVisible();
    const original = source.locator('.pf-snapshot-viewer__original-source-link');
    await expect(original).toHaveAttribute('href', /file:\/\/\/.*\/src\/App\.tsx#L20:59$/);
    await expect(source.locator('.pf-snapshot-viewer__source-line')).toContainText('lynx.setSharedData');
    await expect(source).toContainText('byte offset 39549');
    await checkSourceLayerOrder(source, true);
    await page.setViewportSize({ width: 900, height: 1100 });
    await checkSourceLayerOrder(source, true);
    await page.setViewportSize({ width: 1600, height: 1100 });
    await expect(source.locator('.pf-snapshot-viewer__generated-source mark')).toHaveAttribute(
      'title',
      'Byte offset 39549',
    );
    const scriptLinks = source.locator('.pf-snapshot-viewer__generated-source-link');
    await expect(scriptLinks).toHaveAttribute('href', /file:\/\/\/.*\/background\.a3deaafc\.js#L1:39550$/);
    const blue = selected.locator('.pf-snapshot-viewer__source-link');
    await expect(blue).toHaveText('App.tsx:20:59');
    await expect(selected.locator('.pf-snapshot-viewer__source-function')).toHaveCount(0);
    assert.equal(await blue.evaluate((element) => getComputedStyle(element).color), 'rgb(40, 120, 212)');
    const before = await selected.locator('.pf-snapshot-viewer__object-toggle').getAttribute('aria-expanded');
    await blue.click();
    await expect(selected.locator('.pf-snapshot-viewer__object-toggle')).toHaveAttribute('aria-expanded', before);
    await expect(source).toBeVisible();
    await page.screenshot({
      path: path.join(os.tmpdir(), 'memory-report-function-source.png'),
      animations: 'disabled',
    });
    const bytecodeNode = frame.locator('[data-object-id="14365"]');
    const bytecodeLink = bytecodeNode.locator('.pf-snapshot-viewer__source-link');
    await expect(bytecodeLink).toHaveText('App.tsx:20:59');
    await bytecodeLink.click();
    await expect(bytecodeNode).toHaveClass(/pf-snapshot-viewer__object--selected/);
    await expect(original).toHaveAttribute('href', /file:\/\/\/.*\/src\/App\.tsx#L20:59$/);
    await expect(source.locator('.pf-snapshot-viewer__source-line')).toContainText('lynx.setSharedData');
    await expect(source).not.toContainText('No frontend source mapping');
    await page.screenshot({
      path: path.join(os.tmpdir(), 'memory-report-bytecode-source.png'),
      animations: 'disabled',
    });
    await frame.locator('[data-snapshot-slice-id="7188"]').click();
    await frame.locator('button[title="Function (closure)"]').click();
    await frame.locator('[data-object-root="true"]').first().waitFor();
    const fallbackNode = frame.locator('[data-object-root="true"][data-object-id="12931"]');
    if (!(await fallbackNode.count())) {
      await frame.getByRole('button', { name: /^Show all [\d,]+$/ }).click();
    }
    await expect(fallbackNode.locator('.pf-snapshot-viewer__source-link')).toHaveText('background.a3deaafc.js');
    await expect(fallbackNode.locator('.pf-snapshot-viewer__source-function')).toHaveText('t');
    await fallbackNode.locator('.pf-snapshot-viewer__source-link').click();
    await expect(source).toContainText('No source mapping for this position.');
    await expect(source).toContainText('Generated JavaScript · 1:59');
    await checkSourceLayerOrder(source, false);
    await expect(scriptLinks).toHaveCount(1);
    for (const anchor of await scriptLinks.all()) {
      await expect(anchor).toHaveAttribute('href', /file:\/\/\/.*\/background\.a3deaafc\.js#L1:59$/);
      await expect(anchor).toHaveText('file://view3/.rspeedy/main/background.a3deaafc.js');
    }
    const generated = source.locator('.pf-snapshot-viewer__generated-source');
    const highlight = generated.locator('mark');
    await expect(highlight).toHaveAttribute('title', 'Byte offset 58');
    await expect(highlight).toHaveText(/^function t\(t\)\{/);
    assert.equal(
      await generated.evaluate((element) => {
        const range = document.createRange();
        range.setStart(element, 0);
        range.setEndBefore(element.querySelector('mark'));
        return range.toString();
      }),
      '(function(){"use strict";var e=Function("return this;")();',
    );
    await expect(source.locator('pre:not(.pf-snapshot-viewer__generated-source)')).toHaveCount(0);
    assert.equal(await highlight.evaluate((element) => getComputedStyle(element).fontWeight), '700');
    await page.screenshot({
      path: path.join(os.tmpdir(), 'memory-report-generated-source.png'),
      animations: 'disabled',
    });
    const generatedHref = await scriptLinks.first().getAttribute('href');
    const opened = page.waitForEvent('popup');
    await scriptLinks.first().click();
    const generatedPage = await opened;
    await generatedPage.waitForURL(generatedHref, { waitUntil: 'domcontentloaded', timeout: 5000 });
    assert.equal(generatedPage.url(), generatedHref, 'The generated script link opens the actual local JS file');
    await generatedPage.close();
    await checkGcFunctionNames(page, frame);
    assert.deepEqual(errors, []);
    console.log('Offline report -> exact snapshot/node -> blue source link -> App.tsx:20:59 and excerpt: passed.');
    console.log('Second snapshot -> bytecode @14365 -> App.tsx:20:59 and original source: passed.');
    console.log('First instance 1 snapshot -> @12931 -> generated context highlighted from byte 58: passed.');
    console.log('Generated script URL -> local file and generated line/column link: passed.');
    if (process.argv[3]) await checkRcSourceLabels(browser, path.resolve(process.argv[3]));
  } finally {
    await browser.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
