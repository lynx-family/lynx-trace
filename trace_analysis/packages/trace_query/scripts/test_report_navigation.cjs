// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0.
// End-to-end navigation checks against a generated report with pages and residuals.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');
const uiRequire = createRequire(path.resolve(__dirname, '../../../../ui/package.json'));
const { chromium } = uiRequire('playwright');

async function main() {
  const directory = path.resolve(process.argv[2]);
  const data = JSON.parse(fs.readFileSync(path.join(directory, 'analysis.json'), 'utf8'));
  const pages = [...data.pages].sort((a, b) => a.realCreateTsMs - b.realCreateTsMs);
  const pageIds = pages.map((item) => `page-instance-${item.instanceId}`);
  const residualIds = data.residualAnalyses.map((item) => item.reportAnchor);
  const snapshotSubsections = ['source-origins', 'snapshot-inventory'];
  const sectionIds = [
    'analysis-notes',
    'page-analysis',
    'mts-pool',
    'shared-bts',
    'bts-residual',
    'snapshots',
    'conclusion',
  ];
  assert.ok(pageIds.length && residualIds.length, 'Use a report containing pages and residual analyses');
  const url = pathToFileURL(path.join(directory, 'report.html')).href;
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.context().setOffline(true);
    await page.goto(url);
    const toc = page.locator('.report-toc');
    const nav = toc.locator('nav');
    const link = (id) => nav.locator(`[data-report-target="${id}"]`);
    const arrived = async (id) => {
      await page
        .waitForFunction((targetId) => {
          const target = document.getElementById(targetId);
          const active = document.querySelector('.report-toc [aria-current="location"]');
          const atBottom = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
          const aligned =
            Math.abs(target.getBoundingClientRect().top - parseFloat(getComputedStyle(target).scrollMarginTop)) < 3;
          return active?.dataset.reportTarget === targetId && (aligned || atBottom);
        }, id)
        .catch(async (error) => {
          console.error(
            await page.evaluate(
              (targetId) => ({
                target: targetId,
                top: document.getElementById(targetId).getBoundingClientRect().top,
                active: document.querySelector('.report-toc [aria-current="location"]')?.dataset.reportTarget,
                scrollY: window.scrollY,
                height: window.innerHeight,
                scrollHeight: document.documentElement.scrollHeight,
                hash: location.hash,
              }),
              id,
            ),
          );
          throw error;
        });
    };
    const jump = async (id) => {
      await link(id).click();
      await arrived(id);
    };
    const topIds = () =>
      nav.locator(':scope > ul > li > a').evaluateAll((links) => links.map((item) => item.dataset.reportTarget));
    assert.deepEqual(await topIds(), sectionIds);
    assert.deepEqual(
      await nav.locator('ul ul a').evaluateAll((links) => links.map((item) => item.dataset.reportTarget)),
      [...pageIds, ...residualIds, ...snapshotSubsections],
    );
    assert.deepEqual(
      await nav.locator('ul ul a[data-report-target^="page-instance-"]').allTextContents(),
      pages.map((_, index) => `页面 ${index + 1}`),
    );
    for (const id of sectionIds) assert.equal(await page.locator(`#${id} > h2`).count(), 1);
    for (const id of snapshotSubsections) assert.equal(await page.locator(`#snapshots > h3#${id}`).count(), 1);
    assert.deepEqual(
      await link('snapshots')
        .locator('..')
        .locator('ul a')
        .evaluateAll((links) => links.map((item) => item.dataset.reportTarget)),
      snapshotSubsections,
    );
    assert.equal(await page.getByRole('heading', { name: '进一步分析', exact: true }).count(), 0);
    const geometry = await page.evaluate(() => ({
      sidebar: document.querySelector('.report-sidebar').getBoundingClientRect().toJSON(),
      main: document.querySelector('main').getBoundingClientRect().toJSON(),
    }));
    assert.ok(geometry.sidebar.right < geometry.main.left, 'Desktop contents stay left of the report');

    // Exercise actual smooth scrolling and expansion of a collapsed page.
    const first = page.locator(`#${pageIds[0]}`);
    if (await first.evaluate((element) => element.open)) await first.locator(':scope > summary').click();
    await jump(pageIds[0]);
    assert.ok(await first.evaluate((element) => element.open));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const residual = page.locator(`#${residualIds[0]}`);
    if (await residual.evaluate((element) => element.open)) await residual.locator(':scope > summary').click();
    await jump(residualIds[0]);
    assert.ok(await residual.evaluate((element) => element.open));
    assert.ok(
      !(await residual.locator('.residual-child').evaluate((element) => element.open)),
      'Navigation does not open the embedded child report',
    );
    await page.screenshot({ path: path.join(os.tmpdir(), 'memory-report-navigation-desktop.png') });
    await page.goBack();
    await arrived(pageIds[0]);
    await page.goForward();
    await arrived(residualIds[0]);

    // The snapshot section entry must not trigger the snapshot viewer.
    await jump('snapshots');
    for (const id of snapshotSubsections) await jump(id);
    assert.equal(await page.locator('.pf-memory-report-frame').count(), 0);
    await jump('conclusion');
    await jump('analysis-notes');
    // Ordinary scrolling also updates the current location.
    await page.locator(`#${pageIds.at(-1)} > summary`).scrollIntoViewIfNeeded();
    await page.mouse.move(geometry.main.left + 80, 500);
    await page.mouse.wheel(0, 550);
    await page.waitForFunction(
      (id) => document.querySelector('.report-toc [aria-current="location"]')?.dataset.reportTarget === id,
      pageIds.at(-1),
    );

    await page.locator('[data-language="en"]').click();
    assert.equal(await link('page-analysis').textContent(), 'Page instance analysis');
    assert.equal(await link('source-origins').textContent(), 'JS source origins and binding status');
    assert.equal(await link('snapshot-inventory').textContent(), 'Snapshot inventory');
    assert.equal(await link(pageIds[0]).textContent(), 'Page 1');
    assert.equal(await link(residualIds[0]).textContent(), `instance ${data.residualAnalyses[0].instanceId}`);
    assert.equal(await page.getByRole('heading', { name: 'Further analysis', exact: true }).count(), 0);
    const filters = page.locator('.bts-filter-checkbox');
    if (await filters.count()) {
      for (const filter of await filters.all()) await filter.uncheck();
      await page.waitForFunction(
        (ids) =>
          ids.every((id) => document.querySelector(`.report-toc [data-report-target="${id}"]`).closest('li').hidden),
        [...pageIds, ...residualIds],
      );
      assert.deepEqual(await topIds(), sectionIds);
      await page.locator('[data-language="zh"]').click();
      assert.deepEqual(
        await nav.locator('ul ul a:visible').evaluateAll((links) => links.map((item) => item.dataset.reportTarget)),
        snapshotSubsections,
        'Snapshot subsections stay visible when page filters are empty',
      );
      await jump('page-analysis');
      assert.ok(await page.locator('[data-filter-empty="pages"]').isVisible());
      for (const filter of await filters.all()) await filter.check();
      await page.waitForFunction(() =>
        [...document.querySelectorAll('.report-toc ul ul li')].every((item) => !item.hidden),
      );
      assert.equal(await link(pageIds[0]).textContent(), '页面 1');
    }

    // A short viewport needs its own contents scrollbar, without moving the report.
    await page.setViewportSize({ width: 1500, height: 420 });
    await jump('analysis-notes');
    const scrollBefore = await page.evaluate(() => window.scrollY);
    await nav.hover();
    await page.mouse.wheel(0, 300);
    await page.waitForFunction(() => document.querySelector('.report-toc nav').scrollTop > 0);
    assert.equal(await page.evaluate(() => window.scrollY), scrollBefore);
    await jump('conclusion');

    await page.setViewportSize({ width: 720, height: 960 });
    await page.waitForFunction(() => !document.querySelector('.report-toc').open);
    await toc.locator(':scope > summary').click();
    await jump(residualIds[0]);
    assert.ok(!(await toc.evaluate((element) => element.open)));
    const mobile = await page.evaluate(
      (id) => ({
        menuBottom: document.querySelector('.report-sidebar').getBoundingClientRect().bottom,
        targetTop: document.getElementById(id).getBoundingClientRect().top,
        width: document.documentElement.clientWidth,
        contentWidth: document.documentElement.scrollWidth,
      }),
      residualIds[0],
    );
    assert.ok(mobile.targetTop >= mobile.menuBottom, 'The collapsed menu does not cover the destination');
    assert.ok(mobile.contentWidth <= mobile.width, 'Navigation layout does not overflow the viewport');
    for (const id of snapshotSubsections) {
      await toc.locator(':scope > summary').click();
      await jump(id);
      assert.ok(!(await toc.evaluate((element) => element.open)));
      const geometry = await page.evaluate(
        (target) => ({
          menuBottom: document.querySelector('.report-sidebar').getBoundingClientRect().bottom,
          targetTop: document.getElementById(target).getBoundingClientRect().top,
        }),
        id,
      );
      assert.ok(geometry.targetTop >= geometry.menuBottom, 'Snapshot subheading is not covered by the menu');
    }
    await page.screenshot({ path: path.join(os.tmpdir(), 'memory-report-navigation-mobile.png') });
    await page.setViewportSize({ width: 1500, height: 1000 });
    await page.waitForFunction(() => document.querySelector('.report-toc').open);
    await page.goto(`${url}#${pageIds[0]}`);
    await arrived(pageIds[0]);
    assert.ok(await page.locator(`#${pageIds[0]}`).evaluate((element) => element.open));
    assert.deepEqual(errors, []);
    console.log(
      `Report navigation passed: ${sectionIds.length} sections, ${pageIds.length} pages, ${residualIds.length} residual entries.`,
    );
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
