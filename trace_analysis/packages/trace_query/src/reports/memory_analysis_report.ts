// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import * as fs from 'fs';
import * as path from 'path';

import {
  MemoryAnalysisResult,
  MemoryChart,
  MemoryConfidence,
  MemoryIssue,
  MemoryPage,
  SharedBtsVmAnalysis,
} from '../types/memory_analysis';

interface LocalizedCopy {
  zh: string;
  en: string;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function localized(copy: LocalizedCopy): string {
  return `<span class="i18n" data-zh="${escapeHtml(copy.zh)}" data-en="${escapeHtml(copy.en)}">${escapeHtml(copy.zh)}</span>`;
}

function yesNo(value: boolean): string {
  return localized(value ? { zh: '是', en: 'Yes' } : { zh: '否', en: 'No' });
}

function formatBytes(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return '-';
  }
  const sign = value < 0 ? '-' : '';
  const absolute = Math.abs(value);
  if (absolute >= 1024 * 1024 * 1024) {
    return `${sign}${(absolute / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
  }
  if (absolute >= 1024 * 1024) {
    return `${sign}${(absolute / (1024 * 1024)).toFixed(2)} MiB`;
  }
  if (absolute >= 1024) {
    return `${sign}${(absolute / 1024).toFixed(2)} KiB`;
  }
  return `${value} B`;
}

function formatTimestamp(tsMs: number | undefined, traceStartMs: number): string {
  if (tsMs === undefined) {
    return '-';
  }
  return `${((tsMs - traceStartMs) / 1000).toFixed(3)}s`;
}

function pageAnchorId(instanceId: number): string {
  return `page-instance-${instanceId}`;
}

function renderPageInstanceLinks(instanceIds: number[]): string {
  if (instanceIds.length === 0) {
    return '-';
  }
  return instanceIds
    .map((instanceId) => {
      const escapedInstanceId = escapeHtml(instanceId);
      return `<a class="page-instance-link" href="#${pageAnchorId(
        instanceId,
      )}" data-page-instance-id="${escapedInstanceId}">${escapedInstanceId}</a>`;
    })
    .join(', ');
}

function confidenceCopy(confidence: MemoryConfidence): LocalizedCopy {
  if (confidence === 'high') {
    return { zh: '高置信度', en: 'High confidence' };
  }
  if (confidence === 'medium') {
    return { zh: '中等置信度', en: 'Medium confidence' };
  }
  return { zh: '低置信度', en: 'Low confidence' };
}

function confidenceBadge(confidence: MemoryConfidence): string {
  return `<span class="badge confidence ${confidence}">${localized(confidenceCopy(confidence))}</span>`;
}

function issueTitleCopy(issue: MemoryIssue): LocalizedCopy {
  const titles: Record<string, string> = {
    high_page_memory: 'High-memory page',
    mts_pool_growth: 'Excessive MTS VM pool growth',
    shared_bts_possible_leak: 'Possible shared BTS VM memory leak',
    shared_bts_first_load_leak: 'Shared BTS first-load leak',
    shared_bts_continuous_leak: 'Continuous shared BTS leak',
    shared_bts_vm_not_destroyed: 'BTS VM not destroyed',
    shared_bts_accumulate_rising: 'BTS VM Accumulate memory is rising',
  };
  return { zh: issue.title, en: titles[issue.code] ?? issue.title };
}

function formatByteCountsInMessage(message: string): string {
  const formattedLists = message.replace(
    /([：:]\s*)((?:-?\d+\s*,\s*)+-?\d+)\s+bytes/g,
    (_match, prefix: string, values: string) =>
      `${prefix}${values
        .split(',')
        .map((value) => formatBytes(Number(value.trim())))
        .join(', ')}`,
  );
  return formattedLists.replace(/(-?\d+)\s+bytes/g, (_match, value: string) => formatBytes(Number(value)));
}

function issueMessageCopy(issue: MemoryIssue): LocalizedCopy {
  const value = formatBytes(issue.valueBytes);
  let en: string;
  switch (issue.code) {
    case 'high_page_memory':
      en = `The page-loading PSS peak increased by ${value}, exceeding 150 MiB.`;
      break;
    case 'mts_pool_growth':
      en = `MTS VM Pool RSS increased by ${value} during the page lifetime, exceeding 3 MiB.`;
      break;
    case 'shared_bts_possible_leak':
      en = `Shared BTS Accumulate increased by ${value} after the page exited and GC completed.`;
      break;
    case 'shared_bts_first_load_leak':
      en = `The first load increased shared BTS Accumulate by ${value}, at least 10 times every later run.`;
      break;
    case 'shared_bts_continuous_leak':
      en = 'Every repeated page load increased shared BTS Accumulate beyond the leak threshold.';
      break;
    case 'shared_bts_vm_not_destroyed':
      en = `The BTS VM was created after trace start but was not destroyed before trace end. Its final RSS was ${value}.`;
      break;
    case 'shared_bts_accumulate_rising':
      en = `The BTS VM Accumulate values after GC show a rising trend, with the stable level increasing by ${value}.`;
      break;
    default:
      en = formatByteCountsInMessage(issue.message);
  }
  return { zh: formatByteCountsInMessage(issue.message), en };
}

function knownCopy(text: string): LocalizedCopy {
  const translations: Record<string, string> = {
    '当前 Trace 未开启 memory_trace_force_gc，页面退出后的回落分析仅为低置信度参考。':
      'memory_trace_force_gc is disabled. Post-exit memory rollback is low-confidence evidence only.',
    'Trace 中没有找到与用户指定 URL 或 instance_id 匹配的页面。': 'No page matches the requested URL or instance_id.',
    '目标页面与其它页面创建过程重叠，部分单页面结论置信度较低。':
      'The target page overlaps other page creation, reducing confidence in some page-level conclusions.',
    'Trace 中还加载了至少两个无关页面，建议减少无关 Lynx 页面或使用回放重新录制。':
      'At least two unrelated pages were loaded. Reduce unrelated Lynx pages or record the replay again.',
    '超过三分之一的页面创建后未退出，页面数量增加会自然推高进程物理内存。':
      'More than one third of created pages did not exit. A growing page count naturally raises process memory.',
    '所有 BTS 虚拟机均没有可用的 bts_vm_acc_* 内存轨道，或 VM 类型不支持内存上报。':
      'No BTS VM has a usable bts_vm_acc_* track, or the VM type does not support memory reporting.',
    '页面生命期高度重合，无法准确计算单一页面的峰值内存增量。':
      'Page lifetimes overlap heavily, so the peak increase of one page cannot be measured accurately.',
    '页面在 Trace 结束前未销毁，跳过退出后的内存回落分析。':
      'The page did not exit before the trace ended; post-exit rollback analysis was skipped.',
    '页面销毁后没有找到 RunGC，无法计算高置信度内存回落。':
      'No RunGC was found after page destruction, so high-confidence rollback cannot be calculated.',
    'GC 完成前有其它页面创建，放弃计算物理内存回落。':
      'Another page was created before GC completed; physical-memory rollback was not calculated.',
    '该页面没有 BTS Runtime，已省略 BTS 相关分析。':
      'This page has no BTS Runtime, so BTS-specific analysis was omitted.',
    '页面不是独立页面，未绘制高置信度内存增量图。':
      'The page is not isolated, so no high-confidence memory delta chart was drawn.',
    '页面不是独立页面或 BTS 不支持内存上报，未绘制高置信度内存增量图。':
      'The page is not isolated or its BTS does not report memory, so no high-confidence delta chart was drawn.',
    '该页面未使用共享 BTS 虚拟机。': 'This page does not use a shared BTS VM.',
    '指定的滚动时间范围与页面生命期没有交集。': 'The requested scrolling range does not overlap the page lifetime.',
    '指定时间范围内没有足够的 PSS 数据。': 'The requested range does not contain enough PSS data.',
    '页面退出后 PSS 低于页面创建前水位，存在其它内存下降因素。':
      'Post-exit PSS fell below the pre-load level, indicating other memory reductions.',
    '页面创建并销毁后 PSS 上涨不明显，内存泄漏概率较低。':
      'PSS did not rise significantly after the page loaded and exited; leak probability is low.',
    '页面退出并完成 GC 后 PSS 仍有明显上涨。':
      'PSS remains significantly above the pre-load level after page exit and GC.',
    '页面退出后 PSS 仍有上涨；未开启强制 GC，仅作为低置信度趋势参考。':
      'PSS remains elevated after page exit. Forced GC is disabled, so this is low-confidence trend evidence.',
    '样本少于 10 个，无法可靠判断趋势。': 'Fewer than 10 samples are available; the trend is inconclusive.',
    '样本少于 3 个，无法可靠判断趋势。': 'Fewer than 3 samples are available; the trend is inconclusive.',
    '平滑后的基线持续上移，稳健斜率为正，且首尾差异超过噪声阈值。':
      'The smoothed baseline rises persistently, the robust slope is positive, and the endpoint delta exceeds noise.',
    '未同时满足基线持续上移、正斜率和显著首尾差异。':
      'The series does not simultaneously show a rising baseline, positive slope, and significant endpoint delta.',
    'GC 后内存水位整体上移，稳健斜率为正，且首尾差异超过噪声阈值。':
      'Post-GC memory levels rise overall, the robust slope is positive, and the endpoint delta exceeds noise.',
    '未同时满足 GC 后内存水位整体上移、正斜率和显著首尾差异。':
      'The post-GC series does not simultaneously show an overall level rise, positive slope, and significant endpoint delta.',
  };
  return { zh: text, en: translations[text] ?? text };
}

function classificationCopy(classification: MemoryPage['classification']): LocalizedCopy {
  const labels: Record<MemoryPage['classification'], LocalizedCopy> = {
    'pre-existing': { zh: 'Trace 前已存在', en: 'Pre-existing' },
    independent: { zh: '独立页面', en: 'Isolated page' },
    grouped: { zh: '同组页面', en: 'Grouped pages' },
    overlapping: { zh: '生命期重叠', en: 'Overlapping lifetime' },
  };
  return labels[classification];
}

function sharedBtsNamesForIssue(issue: MemoryIssue, result: MemoryAnalysisResult): string[] {
  const names = new Set<string>();
  if (issue.vmId) {
    const vmName = result.sharedBtsVmAnalyses.find((analysis) => analysis.vmId === issue.vmId)?.vmName;
    if (vmName) {
      names.add(vmName);
    }
  }
  for (const instanceId of issue.instanceIds) {
    const page = result.pages.find((item) => item.instanceId === instanceId);
    if (page?.sharedBts && page.btsVmName) {
      names.add(page.btsVmName);
    }
  }
  return [...names].sort();
}

function renderIssue(issue: MemoryIssue, result: MemoryAnalysisResult): string {
  const sharedBtsNames = sharedBtsNamesForIssue(issue, result);
  return `<article class="issue" data-bts-vm-names="${escapeHtml(JSON.stringify(sharedBtsNames))}">
    <div class="issue-title">${localized(issueTitleCopy(issue))} ${confidenceBadge(issue.confidence)}</div>
    <p>${localized(issueMessageCopy(issue))}</p>
    <div class="issue-meta">${localized({ zh: '页面', en: 'Pages' })}: ${escapeHtml(issue.instanceIds.join(', ') || '-')}
      ${issue.vmId ? ` · VM: ${escapeHtml(issue.vmId)}` : ''}
      ${issue.valueBytes !== undefined ? ` · ${localized({ zh: '数值', en: 'Value' })}: ${escapeHtml(`${issue.valueBytes} bytes`)}` : ''}
    </div>
  </article>`;
}

function renderKeyValueRows(rows: Array<{ label: LocalizedCopy; value: string }>): string {
  return rows.map((row) => `<tr><th>${localized(row.label)}</th><td>${row.value}</td></tr>`).join('');
}

function renderReportFilter(result: MemoryAnalysisResult): string {
  const vmNames = [
    ...new Set(
      result.vms
        .filter((vm) => vm.kind === 'bts' && vm.shared && vm.name)
        .map((vm) => vm.name)
        .sort((left, right) => left.localeCompare(right)),
    ),
  ];
  if (vmNames.length === 0) {
    return `<section class="report-filter">
      <h2>${localized({ zh: '过滤报告内容', en: 'Filter report content' })}</h2>
      <p class="empty">${localized({
        zh: 'Trace 中没有共享 Context 的 BTS 虚拟机。',
        en: 'No shared-context BTS VM is present in the trace.',
      })}</p>
    </section>`;
  }
  return `<section class="report-filter">
    <h2>${localized({ zh: '过滤报告内容', en: 'Filter report content' })}</h2>
    <p>${localized({
      zh: '按共享 Context 的 BTS 虚拟机名称过滤页面、进一步分析和结论。',
      en: 'Filter pages, further analysis, and conclusions by shared-context BTS VM name.',
    })}</p>
    <div class="report-filter-options">
      ${vmNames
        .map(
          (name) => `<label>
            <input class="bts-filter-checkbox" type="checkbox" value="${escapeHtml(name)}" checked>
            <span>${escapeHtml(name)}</span>
          </label>`,
        )
        .join('')}
    </div>
  </section>`;
}

function seriesNameCopy(name: string): LocalizedCopy {
  const translations: Record<string, string> = {
    'Process PSS Delta': '进程 PSS 增量',
    'BTS RSS Delta': 'BTS RSS 增量',
    'BTS Accumulate Delta': 'BTS Accumulate 增量',
    'MTS RSS': 'MTS RSS',
    'MTS Accumulate': 'MTS Accumulate',
    'Process PSS': '进程 PSS',
    'BTS RSS': 'BTS RSS',
    'BTS Accumulate': 'BTS Accumulate',
    'BTS Accumulate after GC': 'GC 后 BTS Accumulate',
  };
  return { zh: translations[name] ?? name, en: name };
}

function chartTitleCopy(chart: MemoryChart): LocalizedCopy {
  const deltaMatch = /^Page (\d+) Memory Delta$/.exec(chart.title);
  if (deltaMatch?.[1]) {
    return { zh: `页面 ${deltaMatch[1]} 内存增量`, en: chart.title };
  }
  const scrollMatch = /^Page (\d+) Scroll Memory Trend$/.exec(chart.title);
  if (scrollMatch?.[1]) {
    return { zh: `页面 ${scrollMatch[1]} 滚动内存趋势`, en: chart.title };
  }
  const uiMatch = /^Page (\d+) Lynx UI View Trend$/.exec(chart.title);
  if (uiMatch?.[1]) {
    return { zh: `页面 ${uiMatch[1]} Lynx UI View 趋势`, en: chart.title };
  }
  const componentMatch = /^Page (\d+) Component Counts$/.exec(chart.title);
  if (componentMatch?.[1]) {
    return { zh: `页面 ${componentMatch[1]} 组件数量`, en: chart.title };
  }
  const sharedBtsMatch = /^Shared BTS VM Heap Size: (.*) \(generation (\d+)\)$/.exec(chart.title);
  if (sharedBtsMatch?.[1] && sharedBtsMatch[2]) {
    return {
      zh: `共享的 BTS 虚拟机堆大小曲线：${sharedBtsMatch[1]}（generation ${sharedBtsMatch[2]}）`,
      en: chart.title,
    };
  }
  return { zh: chart.title, en: chart.title };
}

function renderChartBody(chart: MemoryChart): string {
  return `<div class="chart" data-chart-id="${escapeHtml(chart.id)}">
      <canvas></canvas>
      <div class="chart-tooltip"></div>
      <div class="chart-legend" role="group"></div>
    </div>`;
}

function renderChart(chart: MemoryChart): string {
  return `<section class="chart-card">
    <h4>${localized(chartTitleCopy(chart))}</h4>
    ${renderChartBody(chart)}
  </section>`;
}

function renderSharedBtsVmAnalysis(analysis: SharedBtsVmAnalysis, chart: MemoryChart, traceStartTsMs: number): string {
  const lifecycleResult = analysis.createdAfterTraceStart
    ? analysis.notDestroyedIssue
      ? {
          className: 'analysis-issue',
          badge: confidenceBadge('high'),
          summary: localized({
            zh: `该 BTS 虚拟机直到 Trace 结束仍未销毁，结束时 RSS 为 ${formatBytes(analysis.endRssBytes)}。`,
            en: `The BTS VM was not destroyed before trace end. Its final RSS was ${formatBytes(analysis.endRssBytes)}.`,
          }),
        }
      : {
          className: '',
          badge: '',
          summary: localized({
            zh: '该 BTS 虚拟机在 Trace 结束前已销毁，未命中“虚拟机未销毁”规则。',
            en: 'The BTS VM was destroyed before trace end, so the not-destroyed rule was not triggered.',
          }),
        }
    : {
        className: '',
        badge: '',
        summary: localized({
          zh: '轨道首个数据点位于 Trace 启动后 100ms 内，不能判定该虚拟机是在 Trace 启动后创建的。',
          en: 'The first track sample is within 100 ms of trace start, so this rule cannot prove the VM was created after trace start.',
        }),
      };
  const trend = analysis.gcAccumulateTrend;
  const insufficientSamples = trend.reason.startsWith('样本少于 ');
  const trendResult = trend.rising
    ? {
        className: 'analysis-issue',
        badge: confidenceBadge('medium'),
        summary: localized({
          zh: '各次 GC 完成后的 Accumulate 内存呈现上涨趋势。',
          en: 'Accumulate memory after successive GC completions shows a rising trend.',
        }),
      }
    : {
        className: '',
        badge: '',
        summary: localized({
          zh: insufficientSamples
            ? '可用的 GC 后内存样本不足，无法可靠判断趋势。'
            : '各次 GC 完成后的 Accumulate 内存未呈现显著上涨趋势。',
          en: insufficientSamples
            ? 'There are too few post-GC memory samples for a reliable trend assessment.'
            : 'Accumulate memory after GC does not show a significant rising trend.',
        }),
      };
  return `<details class="shared-bts-card" data-bts-vm-name="${escapeHtml(analysis.vmName)}" open>
    <summary>${localized(chartTitleCopy(chart))}</summary>
    <div class="shared-bts-content">
      <h4>${localized({ zh: '分析结果', en: 'Analysis results' })}</h4>
      <div class="shared-bts-analysis-grid">
        <article class="analysis-item ${lifecycleResult.className}">
          <h4>${localized({ zh: '分析项一：虚拟机销毁状态', en: 'Analysis 1: VM destruction status' })} ${
            lifecycleResult.badge
          }</h4>
          <p>${lifecycleResult.summary}</p>
          <p>${localized({ zh: '轨道首个数据点', en: 'First track sample' })}: ${escapeHtml(
            formatTimestamp(analysis.firstSampleTsMs, traceStartTsMs),
          )}</p>
          <p>${localized({ zh: '关联页面', en: 'Associated pages' })}: ${escapeHtml(
            analysis.instanceIds.join(', ') || '-',
          )}</p>
        </article>
        <article class="analysis-item ${trendResult.className}">
          <h4>${localized({ zh: '分析项二：GC 后 Accumulate 趋势', en: 'Analysis 2: Post-GC Accumulate trend' })} ${
            trendResult.badge
          }</h4>
          <p>${trendResult.summary}</p>
          <p>${localized({ zh: '样本数', en: 'Samples' })}: ${trend.sampleCount} · ${localized({
            zh: '首尾稳定水位变化',
            en: 'Stable-level delta',
          })}: ${escapeHtml(formatBytes(trend.delta))}</p>
          <p>${localized({ zh: '稳健斜率', en: 'Robust slope' })}: ${escapeHtml(
            `${formatBytes(trend.slopePerSecond)}/s`,
          )}</p>
          <p>${localized(knownCopy(trend.reason))}</p>
        </article>
      </div>
      ${renderChartBody(chart)}
    </div>
  </details>`;
}

function renderPage(page: MemoryPage, result: MemoryAnalysisResult): string {
  const titleUrl = page.url ? escapeHtml(page.url) : localized({ zh: '（未知 URL）', en: '(unknown URL)' });
  const repeat =
    page.repeatedFocusIndex !== undefined
      ? ` · ${localized({
          zh: `第 ${page.repeatedFocusIndex}/${page.repeatedFocusTotal ?? '?'} 次加载`,
          en: `Load ${page.repeatedFocusIndex}/${page.repeatedFocusTotal ?? '?'}`,
        })}`
      : '';
  const selected = page.selected
    ? `<span class="badge selected">${localized({ zh: '分析目标', en: 'Analysis target' })}</span>`
    : '';
  const groupNotice =
    page.classification === 'grouped'
      ? `<div class="notice warning">${localized({
          zh: '该页面与其它页面生命期高度重叠，以下相关数据为同组页面整体内存数据。',
          en: 'This page heavily overlaps other page lifetimes. The following values represent the whole page group.',
        })}</div>`
      : '';
  const lifetime =
    page.createTsMs !== undefined && page.destroyTsMs !== undefined
      ? `${((page.destroyTsMs - page.createTsMs) / 1000).toFixed(3)}s`
      : '-';
  const analysisRows: string[] = [];
  if (page.analysis.peakMemory) {
    analysisRows.push(`<article class="analysis-item">
      <h4>${localized({ zh: '页面峰值内存增量', en: 'Page peak memory increase' })} ${confidenceBadge(
        page.analysis.peakMemory.confidence,
      )}</h4>
      <strong>${escapeHtml(formatBytes(page.analysis.peakMemory.deltaBytes))}</strong>
      <p>${localized({ zh: '区间', en: 'Range' })}: ${escapeHtml(
        formatTimestamp(page.analysis.peakMemory.startTsMs, result.trace.startTsMs),
      )} – ${escapeHtml(formatTimestamp(page.analysis.peakMemory.endTsMs, result.trace.startTsMs))}</p>
    </article>`);
  }
  if (page.analysis.mtsPool) {
    analysisRows.push(`<article class="analysis-item">
      <h4>${localized({ zh: 'MTS VM Pool RSS 增量', en: 'MTS VM Pool RSS increase' })} ${confidenceBadge(
        page.analysis.mtsPool.confidence,
      )}</h4>
      <strong>${escapeHtml(formatBytes(page.analysis.mtsPool.mtsPoolDeltaBytes))}</strong>
    </article>`);
  }
  if (page.analysis.rollback) {
    analysisRows.push(`<article class="analysis-item">
      <h4>${localized({
        zh: '页面退出物理内存相比页面加载前',
        en: 'Physical memory after page exit vs. before page load',
      })} ${confidenceBadge(page.analysis.rollback.confidence)}</h4>
      <strong>${escapeHtml(formatBytes(page.analysis.rollback.deltaBytes))}</strong>
      <p>${localized(knownCopy(page.analysis.rollback.message))}</p>
      <p><code>t_start</code> ${localized({ zh: 'PSS 采样点', en: 'PSS sample' })}: ${escapeHtml(
        formatTimestamp(page.analysis.rollback.baselineTsMs, result.trace.startTsMs),
      )} · PSS: ${escapeHtml(formatBytes(page.analysis.rollback.baselineBytes))}</p>
      <p><code>m_low</code> ${localized({ zh: 'PSS 采样点', en: 'PSS sample' })}: ${escapeHtml(
        formatTimestamp(page.analysis.rollback.lowestTsMs, result.trace.startTsMs),
      )} · PSS: ${escapeHtml(formatBytes(page.analysis.rollback.lowestBytes))}</p>
      <p>${localized({ zh: '观察区间', en: 'Observation range' })}: ${escapeHtml(
        formatTimestamp(page.analysis.rollback.observationStartTsMs, result.trace.startTsMs),
      )} – ${escapeHtml(formatTimestamp(page.analysis.rollback.observationEndTsMs, result.trace.startTsMs))}</p>
    </article>`);
  }
  if (page.analysis.sharedBtsLeaks.length > 0) {
    analysisRows.push(`<article class="analysis-item">
      <h4>${localized({ zh: '共享 BTS 内存回落', en: 'Shared BTS memory rollback' })}</h4>
      <table>
        <thead><tr>
          <th>${localized({ zh: 'GC 完成时间', en: 'GC completion' })}</th>
          <th>${localized({ zh: 'Accumulate 增量', en: 'Accumulate delta' })}</th>
          <th>${localized({ zh: 'RSS 增量', en: 'RSS delta' })}</th>
          <th>${localized({ zh: '判定', en: 'Assessment' })}</th>
        </tr></thead>
        <tbody>${page.analysis.sharedBtsLeaks
          .map(
            (event) => `<tr class="${event.issue ? 'issue-row' : ''}">
              <td>${escapeHtml(formatTimestamp(event.gcEndTsMs, result.trace.startTsMs))}</td>
              <td>${escapeHtml(formatBytes(event.accumulateDeltaBytes))}</td>
              <td>${escapeHtml(formatBytes(event.rssDeltaBytes))}</td>
              <td>${localized(
                event.issue ? { zh: '可能泄漏', en: 'Possible leak' } : { zh: '未超过阈值', en: 'Below threshold' },
              )} · ${localized(confidenceCopy(event.confidence))}</td>
            </tr>`,
          )
          .join('')}</tbody>
      </table>
    </article>`);
  }
  if (page.analysis.trends.length > 0) {
    analysisRows.push(`<article class="analysis-item">
      <h4>${localized({ zh: '滚动/滑动趋势判定', en: 'Scrolling/sliding trend assessment' })}</h4>
      <table>
        <thead><tr>
          <th>${localized({ zh: '数据', en: 'Series' })}</th>
          <th>${localized({ zh: '趋势', en: 'Trend' })}</th>
          <th>${localized({ zh: '首尾差异', en: 'Endpoint delta' })}</th>
          <th>${localized({ zh: '稳健斜率/秒', en: 'Robust slope/sec' })}</th>
          <th>${localized({ zh: '说明', en: 'Notes' })}</th>
        </tr></thead>
        <tbody>${page.analysis.trends
          .map(
            (trend) => `<tr class="${trend.rising ? 'issue-row' : ''}">
              <td>${localized(seriesNameCopy(trend.seriesName))}</td>
              <td>${localized(
                trend.rising ? { zh: '上涨', en: 'Rising' } : { zh: '无显著上涨', en: 'No significant rise' },
              )}</td>
              <td>${escapeHtml(trend.unit === 'count' ? trend.delta.toFixed(1) : formatBytes(trend.delta))}</td>
              <td>${escapeHtml(
                trend.unit === 'count' ? trend.slopePerSecond.toFixed(2) : formatBytes(trend.slopePerSecond),
              )}</td>
              <td>${localized(knownCopy(trend.reason))}</td>
            </tr>`,
          )
          .join('')}</tbody>
      </table>
    </article>`);
  }

  const charts = [page.analysis.memoryChart, page.analysis.componentChart, ...page.analysis.trendCharts]
    .filter((chart): chart is MemoryChart => chart !== undefined)
    .map(renderChart)
    .join('');
  const notes =
    page.analysis.notes.length > 0
      ? `<ul class="notes">${page.analysis.notes.map((note) => `<li>${localized(knownCopy(note))}</li>`).join('')}</ul>`
      : '';
  const sharedBtsName = page.sharedBts ? page.btsVmName : '';
  return `<details id="${pageAnchorId(page.instanceId)}" class="page-card" data-page-instance-id="${escapeHtml(
    page.instanceId,
  )}" data-bts-vm-name="${escapeHtml(sharedBtsName)}" ${page.selected ? 'open' : ''}>
    <summary>
      <span class="page-title">${titleUrl}${repeat}</span>
      <span class="page-summary">instance ${page.instanceId} ${selected}</span>
    </summary>
    <div class="page-content">
      ${groupNotice}
      <table class="basic-info"><tbody>${renderKeyValueRows([
        { label: { zh: 'instance_id', en: 'instance_id' }, value: escapeHtml(page.instanceId) },
        { label: { zh: 'URL', en: 'URL' }, value: escapeHtml(page.url || '-') },
        {
          label: { zh: '创建时间', en: 'Creation time' },
          value: escapeHtml(formatTimestamp(page.createTsMs, result.trace.startTsMs)),
        },
        {
          label: { zh: '销毁事件时间', en: 'Destruction event time' },
          value: escapeHtml(formatTimestamp(page.shellDestroyTsMs, result.trace.startTsMs)),
        },
        { label: { zh: '存活时长', en: 'Lifetime' }, value: escapeHtml(lifetime) },
        { label: { zh: 'Trace 前已存活', en: 'Alive before trace' }, value: yesNo(page.preExisting) },
        { label: { zh: '已销毁', en: 'Destroyed' }, value: yesNo(page.destroyed) },
        {
          label: { zh: '页面分类', en: 'Page classification' },
          value: localized(classificationCopy(page.classification)),
        },
        { label: { zh: 'MTS VM', en: 'MTS VM' }, value: escapeHtml(page.mtsVmType || '-') },
        { label: { zh: 'BTS VM', en: 'BTS VM' }, value: escapeHtml(page.btsVmType || '-') },
        { label: { zh: 'BTS 名称', en: 'BTS name' }, value: escapeHtml(page.btsVmName || '-') },
        { label: { zh: '共享 Context', en: 'Shared context' }, value: yesNo(page.sharedBts) },
        { label: { zh: 'BTS Generation', en: 'BTS generation' }, value: escapeHtml(page.btsVmGeneration) },
      ])}</tbody></table>
      ${analysisRows.join('')}
      ${notes}
      ${charts}
    </div>
  </details>`;
}

function renderFurtherAnalysis(result: MemoryAnalysisResult): string {
  const chartsById = new Map(result.sharedBtsHeapCharts.map((chart) => [chart.id, chart]));
  const vmNamesById = new Map(result.vms.map((vm) => [vm.id, vm.name]));
  const sharedBtsVmAnalyses =
    result.sharedBtsVmAnalyses.length === 0
      ? `<p class="empty">${localized({
          zh: '没有找到支持内存上报的共享 BTS 虚拟机。',
          en: 'No memory-reporting shared BTS VM was found.',
        })}</p>`
      : `<div class="shared-bts-filter-list">
          ${result.sharedBtsVmAnalyses
            .map((analysis) => {
              const chart = chartsById.get(analysis.chartId);
              return chart === undefined ? '' : renderSharedBtsVmAnalysis(analysis, chart, result.trace.startTsMs);
            })
            .join('')}
          <p class="empty filter-empty" data-filter-empty="shared-bts">${localized({
            zh: '当前过滤条件下没有共享 BTS 虚拟机分析结果。',
            en: 'No shared BTS VM analysis matches the current filter.',
          })}</p>
        </div>`;
  const leakRows =
    result.sharedBtsLeakEvents.length === 0
      ? `<p class="empty">${localized({
          zh: '没有可展示的共享 BTS 泄漏周期。',
          en: 'No shared BTS leak cycles are available.',
        })}</p>`
      : `<table class="shared-bts-leak-table">
        <thead><tr>
          <th>VM</th>
          <th>${localized({ zh: '页面', en: 'Pages' })}</th>
          <th>Accumulate</th>
          <th>RSS</th>
          <th>${localized({ zh: '快照对', en: 'Snapshot pair' })}</th>
          <th>${localized({ zh: '判定', en: 'Assessment' })}</th>
        </tr></thead>
        <tbody>${result.sharedBtsLeakEvents
          .map(
            (event) => `<tr class="${event.issue ? 'issue-row' : ''}" data-bts-vm-name="${escapeHtml(
              vmNamesById.get(event.vmId) ?? '',
            )}">
              <td>${escapeHtml(event.vmId)}</td>
              <td>${renderPageInstanceLinks(event.instanceIds)}</td>
              <td>${escapeHtml(formatBytes(event.accumulateDeltaBytes))}</td>
              <td>${escapeHtml(formatBytes(event.rssDeltaBytes))}</td>
              <td>${escapeHtml(event.preSnapshotId ?? '-')} → ${escapeHtml(event.postSnapshotId ?? '-')}</td>
              <td>${localized(
                event.issue ? { zh: '可能泄漏', en: 'Possible leak' } : { zh: '未超过阈值', en: 'Below threshold' },
              )}${
                event.analysable
                  ? ` · ${localized({ zh: '可进行 Snapshot 分析', en: 'Snapshot analysis available' })}`
                  : ''
              }</td>
            </tr>`,
          )
          .join('')}</tbody>
      </table>
      <p class="empty filter-empty" data-filter-empty="shared-bts-leaks">${localized({
        zh: '当前过滤条件下没有共享 BTS 泄漏周期。',
        en: 'No shared BTS leak cycle matches the current filter.',
      })}</p>`;
  const snapshotRows =
    result.snapshots.length === 0
      ? `<p class="empty">${localized({ zh: 'Trace 中没有 JS 堆快照。', en: 'No JS heap snapshot is present.' })}</p>`
      : `<table>
        <thead><tr>
          <th>VM</th>
          <th>${localized({ zh: '序号', en: 'Index' })}</th>
          <th>Snapshot ID</th>
          <th>${localized({ zh: '时间', en: 'Time' })}</th>
          <th>${localized({ zh: 'Dump 耗时', en: 'Dump duration' })}</th>
          <th>Accumulate</th>
          <th>RSS</th>
        </tr></thead>
        <tbody>${result.snapshots
          .map(
            (snapshot) => `<tr>
              <td>${escapeHtml(snapshot.vmId)}</td>
              <td>${snapshot.index}</td>
              <td class="mono">${escapeHtml(snapshot.snapshotId)}</td>
              <td>${escapeHtml(formatTimestamp(snapshot.willTsMs, result.trace.startTsMs))}</td>
              <td>${snapshot.dumpDurationMs.toFixed(1)}ms</td>
              <td>${escapeHtml(formatBytes(snapshot.memory.accumulateBytes))}</td>
              <td>${escapeHtml(formatBytes(snapshot.memory.rssBytes))}</td>
            </tr>`,
          )
          .join('')}</tbody>
      </table>`;
  return `<section>
    <h2>${localized({ zh: '进一步分析', en: 'Further analysis' })}</h2>
    <h3>${localized({ zh: '共享的 BTS 虚拟机堆大小曲线', en: 'Shared BTS VM heap size curves' })}</h3>
    ${sharedBtsVmAnalyses}
    <h3>${localized({ zh: '共享 BTS 泄漏周期', en: 'Shared BTS leak cycles' })}</h3>
    ${leakRows}
    <h3>${localized({ zh: 'JS 引擎堆快照', en: 'JS heap snapshots' })}</h3>
    ${snapshotRows}
  </section>`;
}

function chartScript(charts: MemoryChart[], traceStartMs: number): string {
  const chartJson = JSON.stringify(Object.fromEntries(charts.map((chart) => [chart.id, chart]))).replace(
    /</g,
    '\\u003c',
  );
  return `<script>
  (() => {
    const charts = ${chartJson};
    const traceStartMs = ${traceStartMs};
    const colors = ['#2563eb', '#dc2626', '#059669', '#7c3aed', '#ea580c', '#0891b2', '#be123c', '#4f46e5'];
    const eventColors = {
      'RunGC': '#d97706',
      'destroy_vm_instance': '#dc2626',
      'page_uses_bts_vm': '#2563eb',
      'BTSRuntime::Destroy': '#7c3aed',
      'will_capture_snapshot': '#059669',
      'shared_bts_possible_leak': '#e11d48',
    };
    let currentLanguage = 'zh';
    const seriesLabels = {
      'Process PSS Delta': { zh: '进程 PSS 增量', en: 'Process PSS Delta' },
      'BTS RSS Delta': { zh: 'BTS RSS 增量', en: 'BTS RSS Delta' },
      'BTS Accumulate Delta': { zh: 'BTS Accumulate 增量', en: 'BTS Accumulate Delta' },
      'Process PSS': { zh: '进程 PSS', en: 'Process PSS' },
      'BTS RSS': { zh: 'BTS RSS', en: 'BTS RSS' },
      'BTS Accumulate': { zh: 'BTS Accumulate', en: 'BTS Accumulate' },
      'MTS RSS': { zh: 'MTS RSS', en: 'MTS RSS' },
      'MTS Accumulate': { zh: 'MTS Accumulate', en: 'MTS Accumulate' },
    };
    const eventLabels = {
      'RunGC': { zh: 'RunGC', en: 'RunGC' },
      'destroy_vm_instance': { zh: 'VM 销毁', en: 'VM destroyed' },
      'page_uses_bts_vm': { zh: '页面进入 BTS', en: 'Page entered BTS' },
      'BTSRuntime::Destroy': { zh: '页面退出 BTS', en: 'Page left BTS' },
      'will_capture_snapshot': { zh: '堆快照', en: 'Heap snapshot' },
      'shared_bts_possible_leak': { zh: '共享 BTS 可能泄漏', en: 'Possible shared BTS leak' },
    };
    const confidenceLabels = {
      high: { zh: '高置信度', en: 'High confidence' },
      medium: { zh: '中等置信度', en: 'Medium confidence' },
      low: { zh: '低置信度', en: 'Low confidence' },
    };
    const seriesLabel = (name) => seriesLabels[name]?.[currentLanguage] || name;
    const eventLabel = (name) => eventLabels[name]?.[currentLanguage] || name;
    const eventColor = (name) => eventColors[name] || '#475569';
    const escapeMarkup = (value) => String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
    const format = (value, unit) => {
      if (unit === 'count') return Math.round(value).toLocaleString();
      const abs = Math.abs(value);
      const sign = value < 0 ? '-' : '';
      if (abs >= 1073741824) return sign + (abs / 1073741824).toFixed(2) + ' GiB';
      if (abs >= 1048576) return sign + (abs / 1048576).toFixed(2) + ' MiB';
      if (abs >= 1024) return sign + (abs / 1024).toFixed(2) + ' KiB';
      return Math.round(value) + ' B';
    };
    const hiddenSeriesByChart = new Map();
    const renderLegend = (root, chart, hiddenSeries) => {
      const legend = root.querySelector('.chart-legend');
      legend.replaceChildren();
      chart.series.forEach((series, index) => {
        const hidden = hiddenSeries.has(series.name);
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'chart-legend-item' + (hidden ? ' hidden' : '');
        button.setAttribute('aria-pressed', String(!hidden));
        button.title = currentLanguage === 'zh' ? '点击显示或隐藏该数据' : 'Click to show or hide this series';
        const marker = document.createElement('i');
        marker.style.background = colors[index % colors.length];
        const label = document.createElement('span');
        label.textContent = seriesLabel(series.name);
        button.append(marker, label);
        button.addEventListener('click', () => {
          if (hiddenSeries.has(series.name)) hiddenSeries.delete(series.name);
          else hiddenSeries.add(series.name);
          render(root);
        });
        legend.append(button);
      });
      [...new Set((chart.events || []).map((event) => event.name))].forEach((name) => {
        const item = document.createElement('span');
        item.className = 'chart-event-legend-item';
        const marker = document.createElement('i');
        marker.style.background = eventColor(name);
        const label = document.createElement('span');
        label.textContent = eventLabel(name);
        item.append(marker, label);
        legend.append(item);
      });
    };
    const render = (root) => {
      const chart = charts[root.dataset.chartId];
      if (!chart || chart.series.length === 0) return;
      const canvas = root.querySelector('canvas');
      const tooltip = root.querySelector('.chart-tooltip');
      const intervalBars =
        chart.renderMode === 'interval-bars' || chart.series.some((series) => series.renderMode === 'interval-bars');
      const hiddenSeries = hiddenSeriesByChart.get(chart.id) || new Set();
      hiddenSeriesByChart.set(chart.id, hiddenSeries);
      renderLegend(root, chart, hiddenSeries);
      const visibleSeries = chart.series
        .map((series, index) => ({ series, index }))
        .filter((item) => !hiddenSeries.has(item.series.name));
      const rect = root.getBoundingClientRect();
      const width = Math.max(640, rect.width);
      const height = intervalBars ? 390 : 320;
      const ratio = window.devicePixelRatio || 1;
      canvas.width = width * ratio;
      canvas.height = height * ratio;
      canvas.style.width = width + 'px';
      canvas.style.height = height + 'px';
      const ctx = canvas.getContext('2d');
      ctx.scale(ratio, ratio);
      const pad = { left: 72, right: 20, top: 22, bottom: intervalBars ? 120 : 46 };
      const all = visibleSeries.flatMap((item) => item.series.points);
      if (all.length === 0) {
        tooltip.style.display = 'none';
        ctx.fillStyle = '#64748b';
        ctx.font = '13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        ctx.fillText(
          currentLanguage === 'zh' ? '所有数据均已隐藏，点击下方标签恢复显示。' : 'All series are hidden. Click a label below to restore it.',
          pad.left,
          height / 2,
        );
        return;
      }
      const minX = chart.xStartTsMs ?? Math.min(...all.map((point) => point.tsMs));
      const maxX = chart.xEndTsMs ?? Math.max(...all.map((point) => point.tsMs));
      let minY = Math.min(...all.map((point) => point.value));
      let maxY = Math.max(...all.map((point) => point.value));
      if (chart.zeroBaseline) {
        minY = Math.min(0, minY);
        maxY = Math.max(0, maxY);
      }
      if (minY === maxY) { minY -= 1; maxY += 1; }
      const yMargin = (maxY - minY) * 0.08;
      if (!intervalBars || minY < 0) minY -= yMargin;
      maxY += yMargin;
      const x = (value) => pad.left + ((value - minX) / Math.max(1, maxX - minX)) * (width - pad.left - pad.right);
      const y = (value) => pad.top + (1 - (value - minY) / (maxY - minY)) * (height - pad.top - pad.bottom);
      const plotBottom = height - pad.bottom;
      ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.strokeStyle = '#dbe3ee';
      ctx.fillStyle = '#64748b';
      ctx.lineWidth = 1;
      for (let i = 0; i <= 4; i += 1) {
        const value = minY + ((maxY - minY) * i) / 4;
        const py = y(value);
        ctx.beginPath(); ctx.moveTo(pad.left, py); ctx.lineTo(width - pad.right, py); ctx.stroke();
        ctx.fillText(format(value, visibleSeries[0].series.unit), 4, py + 4);
      }
      if (chart.zeroBaseline) {
        const zeroY = y(0);
        ctx.save();
        ctx.strokeStyle = '#334155';
        ctx.fillStyle = '#334155';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(pad.left, zeroY);
        ctx.lineTo(width - pad.right + 14, zeroY);
        ctx.stroke();
        ctx.textAlign = 'right';
        ctx.fillText('0', pad.left - 7, zeroY + 4);
        ctx.restore();
      }
      for (let i = 0; i <= 4; i += 1) {
        const value = minX + ((maxX - minX) * i) / 4;
        const px = x(value);
        ctx.textAlign = i === 0 ? 'left' : i === 4 ? 'right' : 'center';
        ctx.fillText(
          ((value - traceStartMs) / 1000).toFixed(1) + 's',
          px,
          intervalBars ? height - 10 : plotBottom + 18,
        );
      }
      ctx.textAlign = 'left';
      visibleSeries.forEach(({ series, index }) => {
        const color = colors[index % colors.length];
        const seriesRenderMode = series.renderMode || chart.renderMode || 'line';
        if (seriesRenderMode === 'interval-bars') {
          const zeroY = y(0);
          ctx.save();
          ctx.fillStyle = color;
          ctx.globalAlpha = 0.68;
          ctx.beginPath();
          series.points.forEach((point, pointIndex) => {
            const nextPoint = series.points[pointIndex + 1];
            const startTsMs = Math.max(minX, point.tsMs);
            const endTsMs = Math.min(maxX, nextPoint?.tsMs ?? maxX);
            if (endTsMs <= startTsMs) return;
            const left = x(startTsMs);
            const right = x(endTsMs);
            const valueY = y(point.value);
            const top = Math.min(valueY, zeroY);
            const barHeight = Math.max(1, Math.abs(zeroY - valueY));
            ctx.rect(left, top, Math.max(1, right - left), barHeight);
          });
          ctx.fill();
          ctx.restore();
          return;
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = intervalBars ? 1.25 : 2;
        ctx.beginPath();
        series.points.forEach((point, pointIndex) => {
          const px = x(point.tsMs); const py = y(point.value);
          if (pointIndex === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        });
        ctx.stroke();
      });
      const markerLanes = [-Infinity, -Infinity, -Infinity, -Infinity];
      const eventMarkers = [...(chart.events || [])]
        .filter((item) => item.tsMs >= minX && item.tsMs <= maxX)
        .sort((left, right) => left.tsMs - right.tsMs || left.name.localeCompare(right.name))
        .map((item) => {
          const px = x(item.tsMs);
          let lane = markerLanes.findIndex((lastX) => px - lastX >= 18);
          if (lane < 0) {
            lane = markerLanes.indexOf(Math.min(...markerLanes));
          }
          markerLanes[lane] = px;
          const top = plotBottom + 12 + lane * 20;
          return { item, px, top, left: px - 7, right: px + 7, bottom: top + 14 };
        });
      eventMarkers.forEach((marker) => {
        const color = eventColor(marker.item.name);
        ctx.save();
        ctx.fillStyle = color;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        if (marker.item.name === 'shared_bts_possible_leak') {
          ctx.beginPath();
          ctx.moveTo(marker.px, plotBottom + 2);
          ctx.lineTo(marker.px - 5, marker.top);
          ctx.lineTo(marker.px + 5, marker.top);
          ctx.closePath();
          ctx.fill();
          ctx.beginPath();
          ctx.moveTo(marker.px, marker.top - 4);
          ctx.lineTo(marker.px + 9, marker.top + 7);
          ctx.lineTo(marker.px, marker.top + 18);
          ctx.lineTo(marker.px - 9, marker.top + 7);
          ctx.closePath();
          ctx.fill();
          ctx.fillStyle = '#fff';
          ctx.font = 'bold 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('!', marker.px, marker.top + 7);
          ctx.restore();
          return;
        }
        ctx.beginPath();
        ctx.moveTo(marker.px, plotBottom + 2);
        ctx.lineTo(marker.px - 4, marker.top);
        ctx.lineTo(marker.px + 4, marker.top);
        ctx.closePath();
        ctx.fill();
        ctx.beginPath();
        ctx.roundRect(marker.left, marker.top, 14, 14, 4);
        ctx.fill();
        ctx.restore();
      });
      const showEventTooltip = (marker, mouseX, mouseY) => {
        const item = marker.item;
        const timeLabel = currentLanguage === 'zh' ? '时间' : 'Time';
        const sliceLabel = currentLanguage === 'zh' ? 'Slice ID' : 'Slice ID';
        const snapshotLabel = currentLanguage === 'zh' ? 'Snapshot ID' : 'Snapshot ID';
        const pagesLabel = currentLanguage === 'zh' ? '页面' : 'Pages';
        const confidenceLabel = currentLanguage === 'zh' ? '置信度' : 'Confidence';
        tooltip.classList.add('event-tooltip');
        const rows = [
          '<strong><i style="background:' + eventColor(item.name) + '"></i>' + escapeMarkup(eventLabel(item.name)) + '</strong>',
          '<div>' + timeLabel + ': ' + ((item.tsMs - traceStartMs) / 1000).toFixed(3) + 's</div>',
        ];
        if (item.sliceId !== undefined) rows.push('<div>' + sliceLabel + ': ' + escapeMarkup(item.sliceId) + '</div>');
        if (item.instanceId !== undefined) rows.push('<div>instance_id: ' + escapeMarkup(item.instanceId) + '</div>');
        if (item.instanceIds) rows.push('<div>' + pagesLabel + ': ' + escapeMarkup(item.instanceIds.join(', ')) + '</div>');
        if (item.confidence) {
          rows.push('<div>' + confidenceLabel + ': ' + escapeMarkup(confidenceLabels[item.confidence]?.[currentLanguage] || item.confidence) + '</div>');
        }
        if (item.accumulateDeltaBytes !== undefined) {
          rows.push('<div>Accumulate: +' + escapeMarkup(format(item.accumulateDeltaBytes, 'bytes')) + '</div>');
        }
        if (item.rssDeltaBytes !== undefined) {
          rows.push('<div>RSS: ' + escapeMarkup(format(item.rssDeltaBytes, 'bytes')) + '</div>');
        }
        if (item.url) rows.push('<div class="tooltip-url">URL: ' + escapeMarkup(item.url) + '</div>');
        if (item.snapshotId) rows.push('<div>' + snapshotLabel + ': ' + escapeMarkup(item.snapshotId) + '</div>');
        tooltip.innerHTML = rows.join('');
        tooltip.style.display = 'block';
        tooltip.style.left = Math.max(8, Math.min(width - 610, mouseX + 14)) + 'px';
        tooltip.style.top = Math.min(height - 120, Math.max(8, mouseY - 70)) + 'px';
      };
      canvas.onmousemove = (event) => {
        const bounds = canvas.getBoundingClientRect();
        const mouseX = event.clientX - bounds.left;
        const mouseY = event.clientY - bounds.top;
        const eventMarker = eventMarkers
          .filter(
            (marker) =>
              mouseX >= marker.left - 3 &&
              mouseX <= marker.right + 3 &&
              mouseY >= marker.top - 3 &&
              mouseY <= marker.bottom + 3,
          )
          .sort((left, right) => Math.abs(left.px - mouseX) - Math.abs(right.px - mouseX))[0];
        if (eventMarker) {
          showEventTooltip(eventMarker, mouseX, mouseY);
          return;
        }
        if (mouseX < pad.left || mouseX > width - pad.right || mouseY > plotBottom) {
          tooltip.style.display = 'none';
          return;
        }
        const ts = minX + ((mouseX - pad.left) / Math.max(1, width - pad.left - pad.right)) * (maxX - minX);
        const rows = visibleSeries
          .map(({ series, index }) => {
            const seriesRenderMode = series.renderMode || chart.renderMode || 'line';
            const nearest = seriesRenderMode === 'interval-bars'
              ? [...series.points].reverse().find((point) => point.tsMs <= ts) || series.points[0]
              : series.points.reduce(
                  (best, point) => (Math.abs(point.tsMs - ts) < Math.abs(best.tsMs - ts) ? point : best),
                  series.points[0],
                );
            return { series, nearest, color: colors[index % colors.length] };
          })
          .filter((row) => row.nearest);
        if (rows.length === 0) return;
        tooltip.classList.remove('event-tooltip');
        const loadedInstanceIds = rows.find((row) => row.nearest.loadedInstanceIds !== undefined)?.nearest.loadedInstanceIds;
        const alivePages =
          loadedInstanceIds === undefined
            ? ''
            : '<div>' +
              (currentLanguage === 'zh' ? '当前使用 VM 的页面 instance_id' : 'Current VM page instance_ids') +
              ': ' +
              escapeMarkup([...loadedInstanceIds].sort((left, right) => left - right).join(', ') || '-') +
              '</div>';
        tooltip.innerHTML = '<strong>t=' + ((rows[0].nearest.tsMs - traceStartMs) / 1000).toFixed(3) + 's</strong>' +
          rows.map((row) => '<div><i style="background:' + row.color + '"></i>' +
            seriesLabel(row.series.name) + ': ' + format(row.nearest.value, row.series.unit) + '</div>').join('') +
          alivePages;
        tooltip.style.display = 'block';
        tooltip.style.left = Math.min(width - 250, Math.max(8, mouseX + 14)) + 'px';
        tooltip.style.top = '14px';
      };
      canvas.onmouseleave = () => { tooltip.style.display = 'none'; };
    };
    const renderAll = () => document.querySelectorAll('.chart').forEach(render);
    const setLanguage = (language) => {
      currentLanguage = language === 'en' ? 'en' : 'zh';
      document.documentElement.lang = currentLanguage === 'zh' ? 'zh-CN' : 'en';
      document.title = currentLanguage === 'zh' ? 'Lynx 内存分析报告' : 'Lynx Memory Analysis Report';
      document.querySelectorAll('.i18n').forEach((element) => {
        element.textContent = element.dataset[currentLanguage] || element.textContent;
      });
      document.querySelectorAll('[data-language]').forEach((button) => {
        button.classList.toggle('active', button.dataset.language === currentLanguage);
      });
      renderAll();
    };
    document.querySelectorAll('[data-language]').forEach((button) => {
      button.addEventListener('click', () => setLanguage(button.dataset.language));
    });
    setLanguage('zh');
    let timer;
    window.addEventListener('resize', () => { clearTimeout(timer); timer = setTimeout(renderAll, 120); });
  })();
  </script>`;
}

function reportFilterScript(): string {
  return `<script>
  (() => {
    const checkboxes = [...document.querySelectorAll('.bts-filter-checkbox')];
    if (checkboxes.length === 0) return;
    const pageCards = [...document.querySelectorAll('.page-card[data-bts-vm-name]')];
    const sharedBtsCards = [...document.querySelectorAll('.shared-bts-card[data-bts-vm-name]')];
    const leakTable = document.querySelector('.shared-bts-leak-table');
    const leakRows = [...document.querySelectorAll('.shared-bts-leak-table tbody tr[data-bts-vm-name]')];
    const issueCards = [...document.querySelectorAll('.issue[data-bts-vm-names]')];
    const pageCount = document.querySelector('[data-filter-page-count]');
    const issueCount = document.querySelector('[data-filter-issue-count]');
    const conclusion = document.querySelector('[data-filter-conclusion]');
    const emptyPages = document.querySelector('[data-filter-empty="pages"]');
    const emptySharedBts = document.querySelector('[data-filter-empty="shared-bts"]');
    const emptyLeakRows = document.querySelector('[data-filter-empty="shared-bts-leaks"]');
    const selectedVmNames = () => new Set(checkboxes.filter((input) => input.checked).map((input) => input.value));
    const setVisible = (element, visible) => element.classList.toggle('filtered-out', !visible);
    const update = () => {
      const selected = selectedVmNames();
      let visiblePages = 0;
      pageCards.forEach((card) => {
        const visible = selected.has(card.dataset.btsVmName || '');
        setVisible(card, visible);
        if (visible) visiblePages += 1;
      });
      let visibleSharedBts = 0;
      sharedBtsCards.forEach((card) => {
        const visible = selected.has(card.dataset.btsVmName || '');
        setVisible(card, visible);
        if (visible) visibleSharedBts += 1;
      });
      let visibleLeakRows = 0;
      leakRows.forEach((row) => {
        const visible = selected.has(row.dataset.btsVmName || '');
        setVisible(row, visible);
        if (visible) visibleLeakRows += 1;
      });
      if (leakTable) setVisible(leakTable, visibleLeakRows > 0);
      let visibleIssues = 0;
      issueCards.forEach((card) => {
        let vmNames = [];
        try {
          vmNames = JSON.parse(card.dataset.btsVmNames || '[]');
        } catch {
          vmNames = [];
        }
        const visible = vmNames.some((name) => selected.has(name));
        setVisible(card, visible);
        if (visible) visibleIssues += 1;
      });
      if (emptyPages) emptyPages.classList.toggle('visible', visiblePages === 0);
      if (emptySharedBts) emptySharedBts.classList.toggle('visible', visibleSharedBts === 0);
      if (emptyLeakRows) emptyLeakRows.classList.toggle('visible', leakRows.length > 0 && visibleLeakRows === 0);
      if (pageCount) pageCount.textContent = String(visiblePages);
      if (issueCount) issueCount.textContent = String(visibleIssues);
      if (conclusion) {
        const english = document.documentElement.lang.startsWith('en');
        conclusion.classList.toggle('warning', visibleIssues > 0);
        conclusion.classList.toggle('success', visibleIssues === 0);
        conclusion.textContent = visibleIssues > 0
          ? english
            ? visibleIssues + ' memory issue(s) match the current BTS VM filter.'
            : '当前 BTS 虚拟机过滤条件下发现 ' + visibleIssues + ' 个内存 issue。'
          : english
            ? 'No high- or medium-confidence memory issue matches the current BTS VM filter.'
            : '当前 BTS 虚拟机过滤条件下未发现规则命中的高或中置信度内存问题。';
      }
    };
    checkboxes.forEach((checkbox) => checkbox.addEventListener('change', update));
    document.querySelectorAll('[data-language]').forEach((button) => {
      button.addEventListener('click', () => queueMicrotask(update));
    });
    update();
  })();
  </script>`;
}

function pageNavigationScript(): string {
  return `<script>
  (() => {
    document.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const link = target.closest('.page-instance-link');
      if (!link) return;
      const instanceId = link.dataset.pageInstanceId;
      if (!instanceId) return;
      const card = document.getElementById('page-instance-' + instanceId);
      if (!card) return;
      event.preventDefault();
      card.open = true;
      history.pushState(null, '', '#' + card.id);
      card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      card.classList.add('page-card-target');
      window.setTimeout(() => card.classList.remove('page-card-target'), 1600);
    });
  })();
  </script>`;
}

function summaryConclusionCopy(result: MemoryAnalysisResult): LocalizedCopy {
  if (result.issues.length > 0) {
    return {
      zh: result.summary.conclusion,
      en: 'Rule-defined memory issues were detected. Review the highlighted findings and page-level evidence below.',
    };
  }
  return {
    zh: result.summary.conclusion,
    en: 'No high- or medium-confidence memory issue was detected by the current rules.',
  };
}

export function generateMemoryAnalysisReport(result: MemoryAnalysisResult, outputPath: string): string {
  const charts = [
    ...result.pages.flatMap((page) =>
      [page.analysis.memoryChart, page.analysis.componentChart, ...page.analysis.trendCharts].filter(
        (chart): chart is MemoryChart => chart !== undefined,
      ),
    ),
    ...result.sharedBtsHeapCharts,
  ];
  const warningHtml =
    result.warnings.length === 0
      ? `<div class="notice success">${localized({
          zh: 'Trace 数据完整，未发现前置分析限制。',
          en: 'Trace data is complete; no pre-analysis limitation was found.',
        })}</div>`
      : result.warnings.map((warning) => `<div class="notice warning">${localized(knownCopy(warning))}</div>`).join('');
  const issuesHtml =
    result.issues.length === 0
      ? `<div class="notice success">${localized({
          zh: '未发现规则命中的高或中置信度 issue。',
          en: 'No rule-defined high- or medium-confidence issue was found.',
        })}</div>`
      : result.issues.map((issue) => renderIssue(issue, result)).join('');
  const pagesHtml = [...result.pages]
    .sort((a, b) => a.realCreateTsMs - b.realCreateTsMs)
    .map((page) => renderPage(page, result))
    .join('');
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Lynx 内存分析报告</title>
  <style>
    :root { color-scheme: light; --ink:#162033; --muted:#64748b; --line:#dbe3ee; --panel:#fff; --bg:#f4f7fb; --accent:#2457d6; --danger:#b42318; }
    * { box-sizing: border-box; }
    body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    main { max-width:1240px; margin:0 auto; padding:40px 24px 80px; }
    h1 { margin:0 0 6px; font-size:30px; letter-spacing:-.02em; }
    h2 { margin:36px 0 16px; font-size:22px; }
    h3 { margin:24px 0 10px; font-size:17px; }
    h4 { margin:0 0 8px; font-size:14px; }
    .header-top { display:flex; align-items:center; justify-content:space-between; gap:20px; }
    .language-switch { display:flex; padding:3px; border:1px solid var(--line); border-radius:9px; background:#fff; }
    .language-switch button { border:0; border-radius:6px; padding:5px 10px; color:var(--muted); background:transparent; cursor:pointer; }
    .language-switch button.active { color:#fff; background:var(--accent); }
    .subtitle,.issue-meta,.empty { color:var(--muted); }
    .summary-grid { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:12px; margin:24px 0; }
    .metric { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:16px; box-shadow:0 6px 18px rgba(33,54,91,.04); }
    .metric strong { display:block; font-size:24px; }
    .metric span { color:var(--muted); }
    .report-filter { margin:24px 0; padding:16px 18px; border:1px solid var(--line); border-radius:12px; background:var(--panel); }
    .report-filter h2 { margin:0 0 6px; }
    .report-filter p { margin:0 0 10px; color:var(--muted); }
    .report-filter-options { display:flex; flex-wrap:wrap; gap:8px; }
    .report-filter-options label { display:inline-flex; align-items:center; gap:7px; padding:5px 9px; border:1px solid var(--line); border-radius:8px; background:#f8fafc; cursor:pointer; }
    .report-filter-options input { margin:0; }
    .filtered-out { display:none !important; }
    .filter-empty { display:none; }
    .filter-empty.visible { display:block; }
    .notice { padding:12px 14px; margin:8px 0; border-radius:8px; border:1px solid; }
    .notice.warning { background:#fffbeb; border-color:#f7d070; color:#7a4b00; }
    .notice.success { background:#ecfdf3; border-color:#9bd7ae; color:#166534; }
    .issue { background:#fff4f2; border:1px solid #f2a69e; border-left:5px solid var(--danger); border-radius:10px; padding:14px 16px; margin:10px 0; }
    .issue-title { color:var(--danger); font-weight:700; font-size:15px; }
    .issue p { margin:5px 0; }
    .badge { display:inline-block; border-radius:999px; padding:2px 8px; font-size:11px; font-weight:700; vertical-align:middle; }
    .confidence.high { background:#fee2e2; color:#991b1b; }
    .confidence.medium { background:#fef3c7; color:#92400e; }
    .confidence.low { background:#e2e8f0; color:#475569; }
    .selected { background:#dbeafe; color:#1d4ed8; margin-left:7px; }
    .page-card { background:var(--panel); border:1px solid var(--line); border-radius:12px; margin:12px 0; overflow:hidden; }
    .page-card > summary { display:flex; align-items:flex-start; justify-content:space-between; gap:20px; padding:16px 18px; cursor:pointer; font-weight:700; }
    .page-card[open] > summary { border-bottom:1px solid var(--line); }
    .page-card-target { box-shadow:0 0 0 3px rgba(59,130,246,0.28); }
    .page-title { flex:1; min-width:0; white-space:normal; overflow-wrap:anywhere; word-break:break-word; line-height:1.45; }
    .page-summary { flex:none; color:var(--muted); font-weight:500; }
    .page-instance-link { color:var(--accent); font-weight:700; text-decoration:none; }
    .page-instance-link:hover { text-decoration:underline; }
    .page-content { padding:18px; }
    table { width:100%; border-collapse:collapse; background:#fff; }
    th,td { border-bottom:1px solid var(--line); padding:9px 10px; text-align:left; vertical-align:top; }
    th { color:#475569; font-weight:600; background:#f8fafc; }
    .basic-info th { width:190px; }
    .analysis-item { margin:16px 0; border:1px solid var(--line); border-radius:9px; padding:14px; }
    .analysis-item strong { font-size:20px; }
    .analysis-item p { margin:4px 0; color:var(--muted); }
    .analysis-item.analysis-issue { border-color:#f2a69e; border-left:5px solid var(--danger); background:#fff8f6; }
    .issue-row td { background:#fff7ed; }
    .notes { color:var(--muted); }
    .chart-card { margin:18px 0; border:1px solid var(--line); border-radius:10px; padding:14px; overflow:hidden; }
    .shared-bts-card { margin:18px 0; border:1px solid var(--line); border-radius:10px; background:var(--panel); overflow:hidden; }
    .shared-bts-card > summary { padding:14px 16px; cursor:pointer; font-weight:700; }
    .shared-bts-card[open] > summary { border-bottom:1px solid var(--line); }
    .shared-bts-content { padding:16px; }
    .shared-bts-analysis-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
    .shared-bts-analysis-grid .analysis-item { margin:0; }
    .chart { position:relative; width:100%; min-height:320px; overflow-x:auto; }
    .chart canvas { display:block; }
    .chart-legend { display:flex; flex-wrap:wrap; gap:7px; padding:8px 4px 2px 72px; }
    .chart-legend-item { display:inline-flex; align-items:center; gap:7px; border:1px solid var(--line); border-radius:999px; padding:4px 9px; color:#334155; background:#fff; cursor:pointer; font-size:12px; }
    .chart-legend-item:hover { border-color:#94a3b8; background:#f8fafc; }
    .chart-legend-item i { width:10px; height:3px; border-radius:2px; }
    .chart-legend-item.hidden { opacity:.45; }
    .chart-legend-item.hidden span { text-decoration:line-through; }
    .chart-event-legend-item { display:inline-flex; align-items:center; gap:7px; padding:4px 3px; color:#475569; font-size:12px; }
    .chart-event-legend-item i { width:10px; height:10px; border-radius:4px; }
    .chart-tooltip { display:none; position:absolute; z-index:2; min-width:220px; max-width:300px; padding:10px 12px; background:rgba(15,23,42,.94); color:#fff; border-radius:7px; pointer-events:none; font-size:12px; }
    .chart-tooltip.event-tooltip { min-width:440px; max-width:600px; }
    .chart-tooltip div { margin-top:3px; }
    .chart-tooltip i { display:inline-block; width:9px; height:9px; margin-right:7px; border-radius:50%; }
    .chart-tooltip .tooltip-url { overflow-wrap:anywhere; word-break:break-word; }
    .mono { font:12px ui-monospace,SFMono-Regular,Menlo,monospace; word-break:break-all; }
    footer { margin-top:40px; color:var(--muted); text-align:center; }
    @media (max-width:800px) { .summary-grid,.shared-bts-analysis-grid { grid-template-columns:repeat(1,minmax(0,1fr)); } .header-top { align-items:flex-start; } main { padding:24px 12px 50px; } }
  </style>
</head>
<body><main>
  <header>
    <div class="header-top">
      <h1>${localized({ zh: 'Lynx 内存分析', en: 'Lynx Memory Analysis' })}</h1>
      <div class="language-switch" aria-label="Language">
        <button type="button" data-language="zh" class="active">中文</button>
        <button type="button" data-language="en">English</button>
      </div>
    </div>
    <div class="subtitle">Trace ${escapeHtml(formatTimestamp(result.trace.startTsMs, result.trace.startTsMs))} –
      ${escapeHtml(formatTimestamp(result.trace.endTsMs, result.trace.startTsMs))} ·
      ${localized({ zh: '内存采集', en: 'Memory trace' })} ${localized(
        result.trace.memoryTraceEnabled ? { zh: '已开启', en: 'Enabled' } : { zh: '未开启', en: 'Disabled' },
      )} ·
      ${localized({ zh: '强制 GC', en: 'Force GC' })} ${localized(
        result.trace.forceGc ? { zh: '已开启', en: 'Enabled' } : { zh: '未开启', en: 'Disabled' },
      )}</div>
  </header>
  <div class="summary-grid">
    <div class="metric"><strong>${result.summary.pageCount}</strong>${localized({ zh: '页面实例', en: 'Page instances' })}</div>
    <div class="metric"><strong data-filter-page-count>${result.summary.analyzedPageCount}</strong>${localized({ zh: '分析目标', en: 'Analysis targets' })}</div>
    <div class="metric"><strong>${result.summary.vmCount}</strong>${localized({ zh: '虚拟机', en: 'Virtual machines' })}</div>
    <div class="metric"><strong>${result.summary.snapshotCount}</strong>${localized({ zh: '堆快照', en: 'Heap snapshots' })}</div>
    <div class="metric"><strong data-filter-issue-count>${result.summary.issueCount}</strong><span>Issue</span></div>
  </div>
  <section><h2>${localized({ zh: '前置说明', en: 'Notes before analysis' })}</h2>${warningHtml}</section>
  ${renderReportFilter(result)}
  <section class="page-analysis-section"><h2>${localized({ zh: '页面实例分析', en: 'Page instance analysis' })}</h2>${
    pagesHtml ||
    `<p class="empty">${localized({ zh: '没有找到 Lynx 页面实例。', en: 'No Lynx page instance was found.' })}</p>`
  }<p class="empty filter-empty" data-filter-empty="pages">${localized({
    zh: '当前过滤条件下没有页面实例分析结果。',
    en: 'No page instance analysis matches the current filter.',
  })}</p></section>
  ${renderFurtherAnalysis(result)}
  <section class="conclusion-section"><h2>${localized({ zh: '结论', en: 'Conclusion' })}</h2><div data-filter-conclusion class="notice ${
    result.issues.length ? 'warning' : 'success'
  }">${localized(summaryConclusionCopy(result))}</div>${issuesHtml}</section>
  <footer>${localized({
    zh: '由 @lynx-js/trace-query 内存分析生成',
    en: 'Generated by @lynx-js/trace-query memory analysis',
  })}</footer>
</main>
${chartScript(charts, result.trace.startTsMs)}
${reportFilterScript()}
${pageNavigationScript()}
</body></html>`;

  const resolvedPath = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  fs.writeFileSync(resolvedPath, html, 'utf8');
  return resolvedPath;
}
