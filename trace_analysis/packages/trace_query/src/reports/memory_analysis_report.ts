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
  BtsResidualAnalysis,
  MemorySnapshot,
  MemoryReportSnapshotData,
  ResidualFinding,
} from '../types/memory_analysis';

interface LocalizedCopy {
  zh: string;
  en: string;
}

const MTS_POOL_GROWTH_BYTES = 3 * 1024 * 1024;

const REPORT_SECTIONS = {
  'analysis-notes': { zh: '前置说明', en: 'Notes before analysis' },
  'page-analysis': { zh: '页面实例分析', en: 'Page instance analysis' },
  'mts-pool': { zh: '异常 MTS 虚拟机缓存池归属', en: 'Abnormal MTS VM pool attribution' },
  'shared-bts': { zh: '共享的 BTS 虚拟机 Slot 内存', en: 'Shared BTS VM slot memory' },
  'bts-residual': { zh: 'BTS 页面退出残留分析', en: 'BTS post-exit residual analysis' },
  krypton: { zh: 'Graphic内存分析', en: 'Graphic Memory Analysis' },
  snapshots: { zh: 'JS 引擎堆快照', en: 'JS heap snapshots' },
  conclusion: { zh: '结论', en: 'Conclusion' },
};

const SNAPSHOT_SUBSECTIONS = {
  'source-origins': { zh: 'JS 源码来源与绑定状态', en: 'JS source origins and binding status' },
  'snapshot-inventory': { zh: '快照清单', en: 'Snapshot inventory' },
};

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

function residualStatus(analysis: BtsResidualAnalysis): string {
  const labels: Record<BtsResidualAnalysis['status'], LocalizedCopy> = {
    pending: { zh: '待分析', en: 'Pending analysis' },
    failed: { zh: '分析失败', en: 'Analysis failed' },
    insufficient: { zh: '证据不足', en: 'Insufficient evidence' },
    retained: { zh: '存在保活，待核实', en: 'Retained; needs verification' },
    suspected: { zh: '疑似泄漏', en: 'Suspected leak' },
    cleared: { zh: '已观察到清零', en: 'Observed cleared' },
    confirmed: { zh: '泄漏', en: 'Leak' },
    excluded: { zh: '已排除', en: 'Excluded' },
    'known-non-leak': { zh: '已知非泄漏', en: 'Known non-leak' },
  };
  const label = localized(labels[analysis.status]);
  return analysis.status === 'confirmed' ? `<span class="confirmed-status">${label}</span>` : label;
}

function residualText(value: string, analysis: BtsResidualAnalysis): string {
  return localized(analysis.translations?.[value] ?? knownCopy(value));
}

function findingTitle(finding: ResidualFinding, analysis: BtsResidualAnalysis, sourceLeak: boolean): string {
  const copy = analysis.translations?.[finding.title] ?? knownCopy(finding.title);
  const suffix =
    sourceLeak || finding.disposition === 'confirmed'
      ? /\s*[，,：:·—–-]\s*(?:泄漏|leak)\s*$/i
      : finding.disposition === 'known-non-leak'
        ? /\s*[，,：:·—–-]\s*(?:已知非泄漏|非泄漏|known non-leak|non-leak)\s*$/i
        : undefined;
  // Remove only a terminal status repeated by the adjacent badge; preserve evidence and translation keys.
  const title = (text: string) => (suffix ? text.replace(suffix, '').trim() || text : text);
  return localized({ zh: title(copy.zh), en: title(copy.en) });
}

function findingDisposition(disposition: ResidualFinding['disposition'], sourceLeak = false): string {
  const labels: Record<ResidualFinding['disposition'], LocalizedCopy> = {
    confirmed: { zh: '泄漏', en: 'Leak' },
    suspected: { zh: '疑似泄漏', en: 'Suspected leak' },
    retained: { zh: '存在保活', en: 'Retention observed' },
    excluded: { zh: '已排除', en: 'Excluded' },
    information: { zh: '观察信息', en: 'Observation' },
    'known-non-leak': { zh: '非泄漏', en: 'Non-leak' },
  };
  // Source badges are a display policy, not evidence of a confirmed lifecycle violation.
  const label = localized(sourceLeak && disposition !== 'confirmed' ? { zh: '泄漏', en: 'Leak' } : labels[disposition]);
  const badgeClasses: Partial<Record<ResidualFinding['disposition'], string>> = {
    confirmed: 'leak',
    information: 'observation',
    'known-non-leak': 'non-leak',
  };
  const badgeClass = sourceLeak ? 'leak' : badgeClasses[disposition];
  return badgeClass ? `<span class="badge ${badgeClass}">${label}</span>` : label;
}

function snapshotIntegrity(snapshot: MemorySnapshot): string {
  const labels: Record<MemorySnapshot['integrity'], LocalizedCopy> = {
    pending: { zh: '未提取', en: 'Not extracted' },
    complete: { zh: '完整', en: 'Complete' },
    incomplete: { zh: '不完整', en: 'Incomplete' },
    'metadata-only': { zh: '仅清零元数据', en: 'Clearing metadata only' },
  };
  return localized(labels[snapshot.integrity]);
}

function captureReason(reason?: string): string {
  const labels: Record<string, LocalizedCopy> = {
    first_post_exit_full_gc: { zh: '退出后首次完整 GC', en: 'First full GC after exit' },
    post_exit_page_count_within_two: { zh: '退出后前两次页面加载', en: 'First two page loads after exit' },
    residual_cleared: { zh: '残留清零', en: 'Residual cleared' },
    residual_reappeared: { zh: '残留重新出现', en: 'Residual reappeared' },
    residual_change_exceeds_20_percent: { zh: '残留变化超过 20%', en: 'Residual changed by more than 20%' },
  };
  return labels[reason ?? ''] ? localized(labels[reason ?? '']!) : escapeHtml(reason ?? '-');
}

function snapshotLink(
  snapshot: MemorySnapshot,
  result: MemoryAnalysisResult,
  label?: string,
  node?: { nodeIndex: number; nodeId: number },
): string {
  const text = label ?? escapeHtml(snapshot.snapshotId);
  if (
    !result.artifacts ||
    snapshot.integrity === 'metadata-only' ||
    snapshot.identityError ||
    snapshot.chunkCount === 0
  )
    return text;
  const target = node
    ? ` data-node-index="${escapeHtml(node.nodeIndex)}" data-node-id="${escapeHtml(node.nodeId)}"`
    : '';
  return `<a href="#snapshot-${encodeURIComponent(snapshot.snapshotId)}" data-snapshot-viewer data-snapshot-vm="${escapeHtml(snapshot.vmId)}" data-snapshot-id="${escapeHtml(snapshot.snapshotId)}"${target}>${text}</a>`;
}

function findingConclusion(
  finding: ResidualFinding,
  analysis: BtsResidualAnalysis,
  result: MemoryAnalysisResult,
): string {
  const anchors = finding.representativeObjects ?? [];
  if (!anchors.length) return residualText(finding.conclusion, analysis);
  const copy = analysis.translations?.[finding.conclusion] ?? knownCopy(finding.conclusion);
  return (['zh', 'en'] as const)
    .map((language) => {
      const remaining = new Set(anchors);
      const link = (anchor: (typeof anchors)[number]) => {
        const snapshot = result.snapshots.find((item) => item.snapshotId === anchor.snapshotId);
        return snapshot ? snapshotLink(snapshot, result, escapeHtml(anchor.label), anchor) : escapeHtml(anchor.label);
      };
      let value = copy[language];
      let html = '';
      // Insert each explicit label once, escaping the untouched prose separately.
      while (value) {
        const next = [...remaining]
          .map((anchor) => ({ anchor, index: value.indexOf(anchor.label) }))
          .filter(({ index }) => index >= 0)
          .sort((a, b) => a.index - b.index || b.anchor.label.length - a.anchor.label.length)[0];
        if (!next) break;
        html += escapeHtml(value.slice(0, next.index)) + link(next.anchor);
        value = value.slice(next.index + next.anchor.label.length);
        remaining.delete(next.anchor);
      }
      html += escapeHtml(value);
      if (remaining.size) {
        html += `<br>${language === 'zh' ? '代表性对象' : 'Representative objects'}: ${[...remaining].map(link).join(' · ')}`;
      }
      return `<span class="finding-copy" lang="${language}">${html}</span>`;
    })
    .join('');
}

function snapshotLinks(ids: string[] | undefined, result: MemoryAnalysisResult): string {
  if (!result.artifacts || !ids?.length) return '';
  const snapshots = ids.flatMap((id) => result.snapshots.filter((snapshot) => snapshot.snapshotId === id));
  return snapshots
    .map((snapshot, index) =>
      snapshotLink(
        snapshot,
        result,
        localized({
          zh: snapshots.length === 1 ? '查看证据快照' : `证据快照 ${index + 1}`,
          en: snapshots.length === 1 ? 'View evidence snapshot' : `Evidence snapshot ${index + 1}`,
        }),
      ),
    )
    .join(' · ');
}

// User-specified source badges; these do not limit generic holder attribution.
const NON_LEAK_SOURCES = new Set(['moduleCacheMonitor', '_$factoryCache', '_$loadScriptCache', '__Engine']);

function sourceStatus(owners: { label: string; labels?: string[] }[]): 'unresolved' | 'non-leak' | 'leak' {
  const labels = owners.flatMap((owner) => owner.labels ?? [owner.label]);
  return !labels.length ? 'unresolved' : labels.every((label) => NON_LEAK_SOURCES.has(label)) ? 'non-leak' : 'leak';
}

function sourceBadge(owners: { label: string; labels?: string[] }[]): string {
  const status = sourceStatus(owners);
  if (status === 'unresolved') {
    return `<span class="badge confidence low" data-source-status="unresolved">${localized({ zh: '待核实', en: 'Needs verification' })}</span>`;
  }
  const nonLeak = status === 'non-leak';
  return `<span class="badge ${nonLeak ? 'non-leak' : 'leak'}" data-source-status="${nonLeak ? 'non-leak' : 'leak'}">${localized(nonLeak ? { zh: '非泄漏', en: 'Non-leak' } : { zh: '泄漏', en: 'Leak' })}</span>`;
}

function allocationBreakdown(finding: ResidualFinding, result: MemoryAnalysisResult): string {
  const data = finding.allocationBreakdown;
  if (!data) return '';
  const snapshot = result.snapshots.find((s) => s.snapshotId === data.snapshotId);
  const link = (label: string, node: { nodeIndex: number; nodeId: number }) =>
    snapshot ? snapshotLink(snapshot, result, escapeHtml(label), node) : escapeHtml(label);
  const allocationPreview = (sample: (typeof data.rows)[number]['samples'][number]) => {
    if (!sample.stringPreview) return '';
    const preview = sample.stringPreview;
    const value = `"${preview.text}${preview.truncated ? '...' : ''}"`;
    return `<div class="allocation-string">${escapeHtml(value)}</div>`;
  };
  return `<div class="cache-breakdown"><strong>${localized({ zh: '残留来源分解', en: 'Residual retention breakdown' })}</strong>
    <div class="residual-table-wrap"><table><thead><tr>${[
      { zh: '来源（共同持有已去重）', en: 'Owners (shared allocations counted once)' },
      { zh: '浅层大小 / 对象数', en: 'Shallow size / count' },
      { zh: '分配与持有路径', en: 'Allocations and retention paths' },
      { zh: '其它持有证据', en: 'Additional retention evidence' },
    ]
      .map((copy) => `<th>${localized(copy)}</th>`)
      .join('')}</tr></thead><tbody>${[...data.rows]
      .sort((a, b) => b.bytes - a.bytes)
      .map(
        (row) => `<tr data-allocation-bytes="${row.bytes}">
      <td>${row.owners.map((owner) => link(owner.label, owner)).join(' + ') || localized({ zh: '未归属到所选持有者', en: 'Not attributed to selected holders' })} ${sourceBadge(row.owners)}</td>
      <td>${row.bytes} B / ${row.count}</td>
      <td>${row.samples
        .map(
          (
            sample,
          ) => `<div class="allocation-item"><div class="allocation-summary">${link(`${sample.type} @${sample.nodeId}`, sample)} · ${sample.bytes} B</div>
        ${allocationPreview(sample)}
        ${sample.paths.map((route) => `<div class="cache-path">${escapeHtml(route)}</div>`).join('')}</div>`,
        )
        .join('')}
        ${row.count > row.samples.length ? localized({ zh: `展示 ${row.samples.length} 个代表对象，统计包含全部 ${row.count} 个`, en: `${row.samples.length} examples shown; all ${row.count} allocations counted` }) : ''}</td>
      <td>${
        [
          ...(row.owners.length > 1
            ? [{ zh: '多个持有者共同持有，已去重', en: 'Shared by multiple holders; counted once' }]
            : []),
          ...(row.gcAtom ? [{ zh: 'GC atom_array 共同持有', en: 'Also held by GC atom_array' }] : []),
          ...(row.otherRoot ? [{ zh: '另有其它强根路径', en: 'Additional strong root path' }] : []),
          ...(!row.owners.length && !row.otherRoot && !row.gcAtom
            ? [{ zh: '未发现已知强根，native 保活待核实', en: 'No known strong root; native retention unresolved' }]
            : []),
        ]
          .map(localized)
          .join('<br>') || '—'
      }</td></tr>`,
      )
      .join('')}</tbody>
      <tfoot><tr><th>${localized({ zh: '合计', en: 'Total' })}</th><th>${data.bytes} B / ${data.nodeIds.length}</th><td colspan="2"></td></tr></tfoot></table></div>
    <p class="hint">${localized({ zh: '每个分配的 self_size 只计一次。标签按来源名称规则判定，多个持有者需全部命中非泄漏名单才标为非泄漏。归属大小不等于断开引用后的可回收量。', en: 'Count each allocation self_size once. Source-name rules determine badges; all holders must be on the non-leak list for a Non-leak badge. Attributed bytes are not the amount reclaimable after removing references.' })}</p></div>`;
}

function renderResidualAnalysis(analysis: BtsResidualAnalysis, result: MemoryAnalysisResult, vmName: string): string {
  const snapshots = analysis.snapshotIds.map((id) => result.snapshots.find((item) => item.snapshotId === id)!);
  return `<details open class="residual-card" id="${analysis.reportAnchor}" data-bts-vm-name="${escapeHtml(vmName)}" data-status="${analysis.status}">
    <summary>instance ${analysis.instanceId} · slot_${analysis.slotId}${analysis.status === 'known-non-leak' ? '' : ` · ${residualStatus(analysis)}`}</summary>
    <div class="residual-body">
    <p>${escapeHtml(analysis.vmId)} · ${localized({ zh: '末次有效残留', en: 'Latest valid residual' })}: <strong>${escapeHtml(formatBytes(analysis.residualBytes))}</strong>
    · ${localized({ zh: '末端完整覆盖', en: 'Complete sequence tail' })}: ${yesNo(analysis.tailComplete)}</p>
    <p>${localized({ zh: '引擎模式', en: 'Engine mode' })}: ${escapeHtml(analysis.analyzerContext?.engineMode.toUpperCase() ?? '-')}
      · ${localized({ zh: '同一已销毁页面的连续观察', en: 'Consecutive observations of one destroyed page' })}
      · ${localized({ zh: '已知非泄漏残留', en: 'Known non-leak residual' })}: <strong>${escapeHtml(formatBytes(analysis.knownNonLeakBytes))}</strong></p>
    <p>${localized({ zh: '可量化泄漏量', en: 'Quantified leak size' })}: ${escapeHtml(formatBytes(analysis.leakBytes))}
      ${analysis.leakSizeBasis ? residualText(analysis.leakSizeBasis, analysis) : ''}</p>
    <div class="residual-table-wrap"><table><thead><tr>
      <th>#</th><th>Snapshot ID</th><th>${localized({ zh: '时间 / 退出后 / 距 Trace 末尾', en: 'Time / since exit / until trace end' })}</th>
      <th>${localized({ zh: '后续加载数 / 原因', en: 'Later page loads / reason' })}</th>
      <th>${localized({ zh: '触发时 / 采集后残留', en: 'Trigger / captured residual' })}</th><th>${localized({ zh: '完整性', en: 'Integrity' })}</th>
    </tr></thead><tbody>${snapshots
      .map(
        (snapshot, index) => `<tr>
      <td>${index + 1}</td><td class="mono">${snapshotLink(snapshot, result)}${snapshot.sha256 ? `<details><summary>SHA-256</summary>${escapeHtml(snapshot.sha256)}</details>` : ''}</td>
      <td>${formatTimestamp(snapshot.captureTsMs, result.trace.startTsMs)} /
        ${analysis.destroyTsMs === undefined ? '-' : `${((snapshot.captureTsMs - analysis.destroyTsMs) / 1000).toFixed(3)}s`} /
        ${((result.trace.endTsMs - snapshot.captureTsMs) / 1000).toFixed(3)}s</td>
      <td>${snapshot.postExitPageCount ?? '-'} / ${captureReason(snapshot.captureReason)}</td>
      <td>${formatBytes(snapshot.triggerRetainedBytes)} / ${formatBytes(snapshot.retainedBytes)}</td>
      <td>${snapshotIntegrity(snapshot)} ${localized(knownCopy(snapshot.identityError ?? snapshot.extractionError ?? ''))}</td>
    </tr>`,
      )
      .join('')}</tbody></table></div>
    ${analysis.findings
      .map((finding) => {
        const sourceLeak =
          finding.allocationBreakdown?.rows.some((row) => sourceStatus(row.owners) === 'leak') ?? false;
        return `<article class="analysis-item ${finding.disposition === 'confirmed' ? 'issue-row' : ''}">
      <h4>${findingTitle(finding, analysis, sourceLeak)} · ${findingDisposition(
        finding.disposition,
        sourceLeak,
      )} ${confidenceBadge(finding.confidence)}</h4>
      <p>${findingConclusion(finding, analysis, result)}</p>
      ${allocationBreakdown(finding, result)}
      <p>${snapshotLinks(finding.snapshotIds, result)}</p>
      ${finding.disposition === 'known-non-leak' ? `<p>${localized({ zh: '可忽略残留', en: 'Ignorable residual' })}: ${escapeHtml(formatBytes(finding.exclusion?.bytes))}</p>` : ''}
      ${finding.limitations.map((item) => `<p>${residualText(item, analysis)}</p>`).join('')}
      ${finding.exclusion ? `<p>${escapeHtml(`${finding.exclusion.ruleId}@${finding.exclusion.version}`)}${finding.exclusion.reason !== finding.conclusion ? `: ${residualText(finding.exclusion.reason, analysis)}` : ''}</p>` : ''}
      <p class="mono">${escapeHtml(finding.evidence_refs.join(', '))}</p>
    </article>`;
      })
      .join('')}
    ${analysis.gaps.map((gap) => `<p class="notice warning">${residualText(gap, analysis)}</p>`).join('')}
    ${
      analysis.reportPath || analysis.reportHtml
        ? `<details class="residual-child"><summary>${localized({ zh: '打开页面独立分析报告', en: 'Open page analysis report' })}</summary>
      ${
        analysis.reportPath
          ? `<a href="${escapeHtml(analysis.reportPath)}" download="instance-${analysis.instanceId}-residual.html">${localized({ zh: '保存独立 HTML', en: 'Save standalone HTML' })}</a>`
          : `<button type="button" class="download-residual" data-instance="${analysis.instanceId}">${localized({ zh: '保存独立 HTML', en: 'Save standalone HTML' })}</button>`
      }
      <iframe title="instance ${analysis.instanceId} residual analysis" loading="lazy" sandbox="allow-scripts" ${analysis.reportPath ? `src="${escapeHtml(analysis.reportPath)}"` : `srcdoc="${escapeHtml(analysis.reportHtml)}"`}></iframe>
    </details>`
        : `<p>${localized({ zh: '对象分析尚未完成，当前状态不能解释为无泄漏。', en: 'Object analysis is incomplete; this does not establish absence of leaks.' })}</p>`
    }
    </div></details>`;
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
  if (issue.titleText) return issue.titleText;
  const titles: Record<string, string> = {
    high_page_memory: 'High-memory page',
    mts_pool_growth: 'Excessive MTS VM pool growth',
    bts_residual_confirmed: 'BTS page leak',
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
  if (issue.messageText) return issue.messageText;
  const value = formatBytes(issue.valueBytes);
  let en: string;
  switch (issue.code) {
    case 'high_page_memory':
      en = `The page-loading PSS peak increased by ${value}, exceeding 150 MiB.`;
      break;
    case 'mts_pool_growth':
      en = `MTS VM Pool RSS increased by ${value} during the page lifetime, exceeding 3 MiB. Attribution: ${
        issue.poolUrls?.join(', ') || 'Unknown URL'
      }.`;
      break;
    case 'bts_residual_confirmed':
      en = issue.message;
      break;
    case 'shared_bts_vm_not_destroyed':
      en = `The BTS VM was created after trace start but was not destroyed before trace end. Its final RSS was ${value}.`;
      break;
    case 'shared_bts_accumulate_rising':
      en = `The BTS VM Accumulate values after VM_GC show a rising trend, with the stable level increasing by ${value}.`;
      break;
    default:
      en = formatByteCountsInMessage(issue.message);
  }
  return { zh: formatByteCountsInMessage(issue.message), en };
}

function knownCopy(text: string): LocalizedCopy {
  const translations: Record<string, string> = {
    '快照不能唯一绑定 VM generation。': 'The snapshot cannot be uniquely assigned to a VM generation.',
    'instance_id 与范围 ID 冲突。': 'The instance_id conflicts with the snapshot scope ID.',
    'slot 与范围 ID 冲突。': 'The slot conflicts with the snapshot scope ID.',
    '页面专用 slot 归属不明确。': 'The dedicated page slot cannot be uniquely attributed.',
    'residual 采集早于 BTS 页面销毁。': 'The residual was captured before BTS page destruction.',
    'residual 缺少有效的 retained_bytes。': 'The residual record has no valid retained_bytes value.',
    '没有该销毁页面的 residual 快照，无法分析对象残留。':
      'No residual snapshot is available for this destroyed page; object retention cannot be analyzed.',
    '非页面专用 slot，无法归因到单页。': 'This slot is not page-exclusive and cannot be attributed to one page.',
    '序列末端未完整覆盖，展示的是末次有效观察。':
      'The sequence tail is incomplete; the latest valid observation is shown.',
    '快照 include_internal_allocations 不一致，统计不可直接比较。':
      'Snapshot include_internal_allocations settings differ; statistics are not directly comparable.',
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
    '页面在 BTS 线程销毁后，该虚拟机未发生 VM_GC，无法确认 slot 残留。':
      'The BTS VM did not run VM_GC after the page was destroyed on the BTS thread, so slot residual memory cannot be confirmed.',
    'VM_GC 后没有包含页面 slot 的 BTS 内存样本，无法计算残留量。':
      'No BTS memory sample containing the page slot was recorded after VM_GC, so residual memory cannot be calculated.',
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
    'VM_GC 后内存水位整体上移，稳健斜率为正，且首尾差异超过噪声阈值。':
      'Post-VM_GC memory levels rise overall, the robust slope is positive, and the endpoint delta exceeds noise.',
    '未同时满足 VM_GC 后内存水位整体上移、正斜率和显著首尾差异。':
      'The post-VM_GC series does not simultaneously show an overall level rise, positive slope, and significant endpoint delta.',
  };
  let en = translations[text] ?? text;
  // Identity errors may combine multiple independently diagnosed conflicts.
  if (en === text) {
    for (const [source, translation] of Object.entries(translations)) en = en.replaceAll(source, translation);
  }
  return { zh: text, en };
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
    <div class="issue-meta">${localized({ zh: '页面', en: 'Pages' })}: ${renderPageInstanceLinks(issue.instanceIds)}
      ${issue.vmId ? ` · VM: ${escapeHtml(issue.vmId)}` : ''}
      ${issue.slotId !== undefined ? ` · slot_${escapeHtml(issue.slotId)}` : ''}
      ${
        issue.poolUrls?.length
          ? ` · ${localized({ zh: 'Pool 归属', en: 'Pool attribution' })}: ${escapeHtml(issue.poolUrls.join(', '))}`
          : ''
      }
      ${issue.valueBytes !== undefined ? ` · ${localized({ zh: '数值', en: 'Value' })}: ${escapeHtml(`${issue.valueBytes} bytes`)}` : ''}
      ${issue.code === 'bts_residual_confirmed' ? `<a class="residual-link" href="#residual-instance-${issue.instanceIds[0]}">${localized({ zh: '查看泄漏分析报告', en: 'View leak analysis report' })}</a>` : ''}
      ${snapshotLinks(issue.snapshotIds, result)}
      ${result.artifacts && !issue.snapshotIds?.length ? localized({ zh: '此 issue 未记录可定位的对象证据快照。', en: 'No locatable object evidence snapshot was recorded for this issue.' }) : ''}
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
      zh: '按共享 Context 的 BTS 虚拟机名称过滤页面、VM 分析、退出残留和结论。',
      en: 'Filter pages, VM analyses, post-exit residuals, and conclusions by shared-context BTS VM name.',
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
    'BTS Accumulate after VM_GC': 'VM_GC 后 BTS Accumulate',
  };
  return { zh: translations[name] ?? name, en: name };
}

function chartTitleCopy(chart: MemoryChart): LocalizedCopy {
  const graphics: Record<string, string> = {
    'Graphic Component Memory Usage': 'Graphic组件内存占用',
    'Canvas Graphics Resource Counts': 'Canvas组件图形资源计数',
    'Krypton Resource Memory': 'Krypton资源内存',
    'Graphic Resource Memory': 'Graphic资源内存',
    'Krypton Graphics Resource Counts': 'Krypton图形资源计数',
  };
  if (graphics[chart.title]) return { zh: graphics[chart.title]!, en: chart.title };
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
  const sharedBtsMatch = /^Shared BTS VM Slot Memory: (.*) \(generation (\d+)\)$/.exec(chart.title);
  if (sharedBtsMatch?.[1] && sharedBtsMatch[2]) {
    return {
      zh: `共享的 BTS 虚拟机 Slot 内存：${sharedBtsMatch[1]}（generation ${sharedBtsMatch[2]}）`,
      en: chart.title,
    };
  }
  return { zh: chart.title, en: chart.title };
}

function renderChartBody(chart: MemoryChart): string {
  const notes = (chart.graphics?.notes ?? []).map((note) => `<p class="chart-note">${localized(note)}</p>`).join('');
  if (!chart.series.length)
    return `${notes}<p class="empty">${localized({
      zh: '未采集到此类资源的有效明细/轨道，无法绘图。',
      en: 'No detail/tracks for this resource type were captured; a chart is unavailable.',
    })}</p>`;
  return `${notes}<div class="chart" data-chart-id="${escapeHtml(chart.id)}">
      <canvas role="img" aria-label="${escapeHtml(chartTitleCopy(chart).zh)} / ${escapeHtml(chartTitleCopy(chart).en)}"></canvas>
      <div class="chart-tooltip"></div>
      <div class="chart-legend" role="group"></div>
    </div>`;
}

function renderChart(chart: MemoryChart): string {
  if (chart.graphics)
    return `<details class="chart-card" open>
    <summary>${localized(chartTitleCopy(chart))}</summary>${renderChartBody(chart)}</details>`;
  return `<section class="chart-card">
    <h4>${localized(chartTitleCopy(chart))}</h4>
    ${renderChartBody(chart)}
  </section>`;
}

function globalGraphicGroups(result: MemoryAnalysisResult) {
  return (result.kryptonAnalyses ?? []).filter((group) =>
    [...group.memoryChart.series, ...group.countChart.series, ...(group.memoryChart.graphics?.comparisons ?? [])].some(
      (series) => series.name.startsWith('Krypton') && series.trackId !== undefined,
    ),
  );
}

function renderGraphicAnalysis(result: MemoryAnalysisResult): string {
  const groups = globalGraphicGroups(result);
  if (!groups.length) return '';
  return `<section id="krypton"><h2>${localized(REPORT_SECTIONS.krypton)}</h2>
    ${groups.map((group) => `${renderChart(group.memoryChart)}${renderChart(group.countChart)}`).join('')}
  </section>`;
}

function renderSharedBtsVmAnalysis(analysis: SharedBtsVmAnalysis, chart: MemoryChart, traceStartTsMs: number): string {
  const lifecycleResult = analysis.createdAfterTraceStart
    ? analysis.notDestroyedIssue
      ? {
          className: 'analysis-issue',
          badge: confidenceBadge('high'),
          summary: localized({
            zh: `该 BTS 虚拟机直到 Trace 结束仍未销毁，结束时 RSS 为 ${formatBytes(analysis.endRssBytes)}（源样本 ${formatTimestamp(analysis.endRssSampleTsMs, traceStartTsMs)}）。`,
            en: `The BTS VM was not destroyed before trace end. Its final RSS was ${formatBytes(analysis.endRssBytes)} (sample ${formatTimestamp(analysis.endRssSampleTsMs, traceStartTsMs)}).`,
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
          zh: '各次 VM_GC 完成后的 Accumulate 内存呈现上涨趋势。',
          en: 'Accumulate memory after successive VM_GC events shows a rising trend.',
        }),
      }
    : {
        className: '',
        badge: '',
        summary: localized({
          zh: insufficientSamples
            ? '可用的 VM_GC 后内存样本不足，无法可靠判断趋势。'
            : '各次 VM_GC 完成后的 Accumulate 内存未呈现显著上涨趋势。',
          en: insufficientSamples
            ? 'There are too few post-VM_GC memory samples for a reliable trend assessment.'
            : 'Accumulate memory after VM_GC does not show a significant rising trend.',
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
          <h4>${localized({
            zh: '分析项二：VM_GC 后 Accumulate 趋势',
            en: 'Analysis 2: Post-VM_GC Accumulate trend',
          })} ${trendResult.badge}</h4>
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
      <p>${localized({ zh: '区间', en: 'Range' })}: ${escapeHtml(
        formatTimestamp(page.analysis.mtsPool.startTsMs, result.trace.startTsMs),
      )} – ${escapeHtml(formatTimestamp(page.analysis.mtsPool.endTsMs, result.trace.startTsMs))}</p>
      <table>
        <thead><tr>
          <th>URL</th>
          <th>${localized({ zh: '引擎实例', en: 'Engine instances' })}</th>
          <th>Accumulate</th>
          <th>RSS</th>
        </tr></thead>
        <tbody>${page.analysis.mtsPool.pools
          .map(
            (pool) => `<tr class="${pool.rssDeltaBytes > MTS_POOL_GROWTH_BYTES ? 'issue-row' : ''}">
              <td class="url-cell">${escapeHtml(pool.url)}</td>
              <td>${pool.startInstanceCount} → ${pool.endInstanceCount} (${pool.instanceCountDelta >= 0 ? '+' : ''}${
                pool.instanceCountDelta
              })</td>
              <td>${escapeHtml(formatBytes(pool.accumulateDeltaBytes))}</td>
              <td>${escapeHtml(formatBytes(pool.rssDeltaBytes))}</td>
            </tr>`,
          )
          .join('')}</tbody>
      </table>
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
  const residual = result.residualAnalyses.find((item) => item.id === page.analysis.residualAnalysisId);
  if (residual) {
    analysisRows.push(`<article class="analysis-item">
      <h4>${localized({ zh: 'BTS 页面退出残留', en: 'BTS post-exit residual' })}</h4>
      <p>slot_${residual.slotId} · ${escapeHtml(formatBytes(residual.residualBytes))} · ${residualStatus(residual)}</p>
      <a class="residual-link" href="#${residual.reportAnchor}">${localized({ zh: '查看快照序列与分析报告', en: 'View snapshot sequence and analysis' })}</a>
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

  const charts = [
    page.analysis.memoryChart,
    page.analysis.componentChart,
    page.analysis.graphicMemoryChart,
    page.analysis.canvasResourceChart,
    ...page.analysis.trendCharts,
  ]
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
        {
          label: { zh: 'BTS Slot', en: 'BTS slot' },
          value: page.btsSlot === undefined ? '-' : `slot_${escapeHtml(page.btsSlot)}`,
        },
      ])}</tbody></table>
      ${analysisRows.join('')}
      ${notes}
      ${charts}
    </div>
  </details>`;
}

function renderVmAndSnapshotSections(result: MemoryAnalysisResult): string {
  const chartsById = new Map(result.sharedBtsSlotCharts.map((chart) => [chart.id, chart]));
  const vmNamesById = new Map(result.vms.map((vm) => [vm.id, vm.name]));
  const mtsPoolRows =
    result.mtsPoolGrowthEvents.length === 0
      ? `<p class="empty">${localized({
          zh: '没有发现超过阈值的 MTS 虚拟机缓存池增长。',
          en: 'No MTS VM pool growth exceeded the threshold.',
        })}</p>`
      : `<table>
        <thead><tr>
          <th>${localized({ zh: '页面', en: 'Page' })}</th>
          <th>URL</th>
          <th>${localized({ zh: '引擎实例', en: 'Engine instances' })}</th>
          <th>Accumulate</th>
          <th>RSS</th>
          <th>${localized({ zh: '区间', en: 'Range' })}</th>
        </tr></thead>
        <tbody>${result.mtsPoolGrowthEvents
          .flatMap((event) => {
            const attributedPools = event.pools.filter((pool) => pool.rssDeltaBytes > 0);
            return (attributedPools.length > 0 ? attributedPools : event.pools).map(
              (pool) => `<tr class="issue-row">
                <td>${renderPageInstanceLinks([event.instanceId])}</td>
                <td class="url-cell">${escapeHtml(pool.url)}</td>
                <td>${pool.startInstanceCount} → ${pool.endInstanceCount} (${
                  pool.instanceCountDelta >= 0 ? '+' : ''
                }${pool.instanceCountDelta})</td>
                <td>${escapeHtml(formatBytes(pool.accumulateDeltaBytes))}</td>
                <td>${escapeHtml(formatBytes(pool.rssDeltaBytes))}</td>
                <td>${escapeHtml(formatTimestamp(event.startTsMs, result.trace.startTsMs))} – ${escapeHtml(
                  formatTimestamp(event.endTsMs, result.trace.startTsMs),
                )}</td>
              </tr>`,
            );
          })
          .join('')}</tbody>
      </table>`;
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
    result.residualAnalyses
      .map((analysis) => renderResidualAnalysis(analysis, result, vmNamesById.get(analysis.vmId) ?? ''))
      .join('') ||
    `<p class="empty">${localized({ zh: '没有可分析的页面 residual 序列。', en: 'No page residual sequences available.' })}</p>`;
  const snapshotRows =
    result.snapshots.length === 0
      ? `<p class="empty">${localized({ zh: 'Trace 中没有 JS 堆快照。', en: 'No JS heap snapshot is present.' })}</p>`
      : `<table>
        <thead><tr>
          <th>VM</th>
          <th>${localized({ zh: '序号', en: 'Index' })}</th>
          <th>Snapshot ID</th>
          <th>${localized({ zh: '范围 / 页面 / Slot', en: 'Scope / page / slot' })}</th>
          <th>${localized({ zh: '时间', en: 'Time' })}</th>
          <th>${localized({ zh: 'Dump 耗时', en: 'Dump duration' })}</th>
          <th>Accumulate</th>
          <th>RSS</th>
          <th>${localized({ zh: '完整性 / 归属', en: 'Integrity / identity' })}</th>
        </tr></thead>
        <tbody>${result.snapshots
          .map(
            (snapshot) => `<tr>
              <td>${escapeHtml(snapshot.assignedVmId ?? snapshot.vmId)}</td>
              <td>${snapshot.index}</td>
              <td class="mono">${snapshotLink(snapshot, result)}</td>
              <td>${escapeHtml(snapshot.kind)} / ${snapshot.instanceId ?? '-'} / ${snapshot.slotId ?? '-'}</td>
              <td>${escapeHtml(formatTimestamp(snapshot.captureTsMs, result.trace.startTsMs))}</td>
              <td>${snapshot.dumpDurationMs === undefined ? '-' : `${snapshot.dumpDurationMs.toFixed(1)}ms`}</td>
              <td>${escapeHtml(formatBytes(snapshot.memory.accumulateBytes))}</td>
              <td>${escapeHtml(formatBytes(snapshot.memory.rssBytes))}</td>
              <td>${snapshotIntegrity(snapshot)} ${localized(knownCopy(snapshot.identityError ?? ''))}</td>
            </tr>`,
          )
          .join('')}</tbody>
      </table>`;
  return `<section id="mts-pool">
    <h2>${localized(REPORT_SECTIONS['mts-pool'])}</h2>
    <div class="report-table-wrap">${mtsPoolRows}</div>
  </section>
  <section id="shared-bts">
    <h2>${localized(REPORT_SECTIONS['shared-bts'])}</h2>
    ${sharedBtsVmAnalyses}
  </section>
  <section id="bts-residual">
    <h2>${localized(REPORT_SECTIONS['bts-residual'])}</h2>
    ${leakRows}
    <p class="empty filter-empty" data-filter-empty="bts-slot-leaks">${localized({
      zh: '当前过滤条件下没有页面 residual 分析。',
      en: 'No page residual analyses match the current filter.',
    })}</p>
  </section>
  ${renderGraphicAnalysis(result)}
  <section id="snapshots">
    <h2>${localized(REPORT_SECTIONS.snapshots)}</h2>
    ${renderSourceBindings(result)}
    <h3 id="snapshot-inventory">${localized(SNAPSHOT_SUBSECTIONS['snapshot-inventory'])}</h3>
    <div class="report-table-wrap">${snapshotRows}</div>
  </section>`;
}

function renderReportNavigation(pages: MemoryPage[], residuals: BtsResidualAnalysis[], showGraphic: boolean): string {
  const link = (id: string, label: string) =>
    `<a href="#${escapeHtml(encodeURIComponent(id))}" data-report-target="${escapeHtml(id)}">${label}</a>`;
  return `<aside class="report-sidebar">
    <details class="report-toc" open>
      <summary>${localized({ zh: '目录', en: 'Contents' })}</summary>
      <nav aria-label="报告目录 / Report contents"><ul>${Object.entries(REPORT_SECTIONS)
        .filter(([id]) => id !== 'krypton' || showGraphic)
        .map(([id, title]) => {
          const children =
            id === 'page-analysis'
              ? pages.map((page, index) =>
                  link(pageAnchorId(page.instanceId), localized({ zh: `页面 ${index + 1}`, en: `Page ${index + 1}` })),
                )
              : id === 'bts-residual'
                ? residuals.map((analysis) =>
                    link(analysis.reportAnchor, `instance ${escapeHtml(analysis.instanceId)}`),
                  )
                : id === 'snapshots'
                  ? Object.entries(SNAPSHOT_SUBSECTIONS).map(([childId, title]) => link(childId, localized(title)))
                  : [];
          return `<li>${link(id, localized(title))}${children.length ? `<ul>${children.map((child) => `<li>${child}</li>`).join('')}</ul>` : ''}</li>`;
        })
        .join('')}</ul></nav>
    </details>
  </aside>`;
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
      'VM_GC': '#dc2626',
      'destroy_vm_instance': '#dc2626',
      'page_uses_bts_vm': '#2563eb',
      'BTSRuntime::Destroy': '#7c3aed',
      'capture_snapshot': '#059669',
      'bts_residual_confirmed': '#e11d48',
      'LynxShell::Create': '#2563eb',
      'LynxShell::~LynxShell': '#7c3aed',
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
      'BTS Accumulate after VM_GC': { zh: 'VM_GC 后 BTS Accumulate', en: 'BTS Accumulate after VM_GC' },
    };
    const eventLabels = {
      'RunGC': { zh: 'RunGC', en: 'RunGC' },
      'VM_GC': { zh: 'VM_GC', en: 'VM_GC' },
      'destroy_vm_instance': { zh: 'VM 销毁', en: 'VM destroyed' },
      'page_uses_bts_vm': { zh: '页面进入 BTS', en: 'Page entered BTS' },
      'BTSRuntime::Destroy': { zh: '页面退出 BTS', en: 'Page left BTS' },
      'capture_snapshot': { zh: '堆快照', en: 'Heap snapshot' },
      'bts_residual_confirmed': { zh: 'BTS 页面泄漏（点击查看）', en: 'BTS page leak (click to view)' },
      'LynxShell::Create': { zh: '页面创建 · LynxShell::Create', en: 'Page created · LynxShell::Create' },
      'LynxShell::~LynxShell': { zh: '页面销毁结束 · LynxShell::~LynxShell', en: 'Page destruction completed · LynxShell::~LynxShell' },
    };
    const confidenceLabels = {
      high: { zh: '高置信度', en: 'High confidence' },
      medium: { zh: '中等置信度', en: 'Medium confidence' },
      low: { zh: '低置信度', en: 'Low confidence' },
    };
    const graphicsLabels = Object.fromEntries(Object.values(charts).flatMap((chart) => [...chart.series, ...(chart.graphics?.comparisons || [])])
      .filter((series) => series.label).map((series) => [series.name, series.label]));
    const seriesLabel = (name) => (graphicsLabels[name] || seriesLabels[name])?.[currentLanguage] || name;
    const eventLabel = (name) => eventLabels[name]?.[currentLanguage] || name;
    const eventColor = (name) => eventColors[name] || '#475569';
    const seriesColor = (series, index) => {
      if (series.color) return series.color;
      if (series.colorKey) {
        let hash = 0;
        for (const c of series.colorKey) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
        return 'hsl(' + (hash % 360) + ' 62% 47%)';
      }
      if (series.slotId === 0) return '#64748b';
      if (series.slotId === 1) return '#2563eb';
      if (series.slotId === 2) return '#ea580c';
      return series.slotId === undefined ? colors[index % colors.length] : 'hsl(' + ((series.slotId * 47) % 360) + ' 62% 47%)';
    };
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
    const positionTooltip = (element, canvasWidth, canvasHeight, mouseX, mouseY, fixedTop) => {
      const tooltipWidth = element.offsetWidth;
      const tooltipHeight = element.offsetHeight;
      let left = mouseX + 14;
      if (left + tooltipWidth > canvasWidth - 8) left = mouseX - tooltipWidth - 14;
      const maxLeft = Math.max(8, canvasWidth - tooltipWidth - 8);
      element.style.left = Math.max(8, Math.min(maxLeft, left)) + 'px';
      const top = fixedTop ?? mouseY - 70;
      const maxTop = Math.max(8, canvasHeight - tooltipHeight - 8);
      element.style.top = Math.max(8, Math.min(maxTop, top)) + 'px';
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
        marker.style.background = seriesColor(series, index);
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
      let hoverOverlay = root.querySelector('.chart-hover-overlay');
      if (!hoverOverlay) {
        hoverOverlay = document.createElement('canvas');
        hoverOverlay.className = 'chart-hover-overlay';
        canvas.after(hoverOverlay);
      }
      const tooltip = root.querySelector('.chart-tooltip');
      const stackedArea =
        chart.renderMode === 'stacked-area' || chart.series.some((series) => series.renderMode === 'stacked-area');
      const isStackedSeries = (series) => (series.renderMode || chart.renderMode || 'line') === 'stacked-area';
      const areaSeries = chart.series.filter(isStackedSeries);
      const intervalBars =
        chart.renderMode === 'interval-bars' || chart.series.some((series) => series.renderMode === 'interval-bars');
      const detailedChart = intervalBars || stackedArea || !!chart.graphics;
      const hiddenSeries = hiddenSeriesByChart.get(chart.id) || new Set();
      hiddenSeriesByChart.set(chart.id, hiddenSeries);
      renderLegend(root, chart, hiddenSeries);
      const visibleSeries = chart.series
        .map((series, index) => ({ series, index }))
        .filter((item) => !hiddenSeries.has(item.series.name));
      const rect = root.getBoundingClientRect();
      const width = Math.max(640, rect.width);
      const height = detailedChart ? 390 : 320;
      const ratio = window.devicePixelRatio || 1;
      canvas.width = width * ratio;
      canvas.height = height * ratio;
      canvas.style.width = width + 'px';
      canvas.style.height = height + 'px';
      hoverOverlay.width = width * ratio;
      hoverOverlay.height = height * ratio;
      hoverOverlay.style.width = width + 'px';
      hoverOverlay.style.height = height + 'px';
      const ctx = canvas.getContext('2d');
      const hoverCtx = hoverOverlay.getContext('2d');
      ctx.scale(ratio, ratio);
      hoverCtx.scale(ratio, ratio);
      const clearHoverPoints = () => hoverCtx.clearRect(0, 0, width, height);
      const pad = { left: 72, right: 20, top: 22, bottom: detailedChart ? 120 : 46 };
      const all = visibleSeries.flatMap((item) => item.series.points).filter((point) => !point.unavailable);
      if (all.length === 0 && !chart.graphics) {
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
      const pointAtOrBefore = (series, ts) =>
        [...series.points].reverse().find((point) => point.tsMs <= ts);
      const knownValue = (point) => point && !point.unavailable ? point.value : 0;
      let minY = all.length ? Math.min(...all.map((point) => point.value)) : 0;
      let maxY = all.length ? Math.max(...all.map((point) => point.value)) : 1;
      if (stackedArea) {
        const timestamps = [...new Set(all.map((point) => point.tsMs))];
        minY = Math.min(0, minY);
        maxY = Math.max(
          maxY,
          ...timestamps.map((ts) =>
            visibleSeries.filter((item) => isStackedSeries(item.series))
              .reduce((total, item) => total + knownValue(pointAtOrBefore(item.series, ts)), 0),
          ),
        );
      }
      if (chart.zeroBaseline) {
        minY = Math.min(0, minY);
        maxY = Math.max(0, maxY);
      }
      if (minY === maxY) { if (!chart.zeroBaseline) minY -= 1; maxY += 1; }
      const yMargin = (maxY - minY) * 0.08;
      if (!detailedChart || minY < 0) minY -= yMargin;
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
        ctx.fillText(format(value, chart.series[0].unit), 4, py + 4);
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
          detailedChart ? height - 10 : plotBottom + 18,
        );
      }
      ctx.textAlign = 'left';
      visibleSeries.forEach(({ series, index }, visibleIndex) => {
        const color = seriesColor(series, index);
        const seriesRenderMode = series.renderMode || chart.renderMode || 'line';
        if (seriesRenderMode === 'stacked-area') {
          ctx.save();
          ctx.fillStyle = color;
          ctx.globalAlpha = 0.72;
          series.points.forEach((point, pointIndex) => {
            if (point.unavailable || point.value === 0) return;
            const nextPoint = series.points[pointIndex + 1];
            const startTsMs = Math.max(minX, point.tsMs);
            const endTsMs = Math.min(maxX, nextPoint?.tsMs ?? maxX);
            if (endTsMs <= startTsMs) return;
            const bottomValue = visibleSeries
              .slice(0, visibleIndex)
              .filter((item) => isStackedSeries(item.series))
              .reduce(
                (total, item) => total + knownValue(pointAtOrBefore(item.series, point.tsMs)),
                0,
              );
            const topValue = bottomValue + point.value;
            ctx.fillRect(
              x(startTsMs),
              y(topValue),
              Math.max(1, x(endTsMs) - x(startTsMs)),
              y(bottomValue) - y(topValue),
            );
          });
          ctx.restore();
          return;
        }
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
        ctx.lineWidth = detailedChart ? 1.25 : 2;
        ctx.beginPath();
        let previous;
        series.points.forEach((point, pointIndex) => {
          if (point.unavailable) {
            if (chart.graphics && previous) ctx.lineTo(x(point.tsMs), y(previous.value));
            previous = undefined;
            return;
          }
          const px = x(point.tsMs); const py = y(point.value);
          if (!previous) ctx.moveTo(px, py);
          else {
            if (chart.graphics && series.interpolation !== 'linear') ctx.lineTo(px, y(previous.value));
            ctx.lineTo(px, py);
          }
          previous = point;
        });
        ctx.stroke();
        if (chart.graphics) {
          const first = series.points.find((point) => !point.unavailable);
          if (first) { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x(first.tsMs), y(first.value), 2.5, 0, Math.PI * 2); ctx.fill(); }
        }
      });
      const chartEvents = [...(chart.events || [])]
        .filter((item) => item.tsMs >= minX && item.tsMs <= maxX)
        .filter((item) => !chart.graphics?.filterPageEvents ||
          !document.querySelector('.bts-filter-checkbox[value="' + CSS.escape(item.btsVmName || '') + '"]') ||
          document.querySelector('.bts-filter-checkbox[value="' + CSS.escape(item.btsVmName || '') + '"]').checked)
        .sort((left, right) => left.tsMs - right.tsMs || left.name.localeCompare(right.name));
      const verticalEventMarkers = chartEvents
        .filter((item) => item.renderMode === 'vertical-line')
        .map((item) => ({ item, px: x(item.tsMs) }));
      verticalEventMarkers.forEach((marker, index) => {
        ctx.save();
        ctx.strokeStyle = eventColor(marker.item.name);
        ctx.fillStyle = eventColor(marker.item.name);
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(marker.px, pad.top);
        ctx.lineTo(marker.px, plotBottom);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = '600 10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        ctx.textAlign = marker.px > width - pad.right - 40 ? 'right' : 'left';
        ctx.fillText('GC', marker.px + (ctx.textAlign === 'right' ? -3 : 3), pad.top + 11 + (index % 2) * 12);
        ctx.restore();
      });
      const markerLanes = [-Infinity, -Infinity, -Infinity, -Infinity];
      const eventMarkers = chartEvents
        .filter((item) => item.renderMode !== 'vertical-line')
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
        if (marker.item.name === 'bts_residual_confirmed') {
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
        if (item.slotId !== undefined) rows.push('<div>slot_' + escapeMarkup(item.slotId) + '</div>');
        if (item.residualBytes !== undefined) {
          rows.push('<div>' + (currentLanguage === 'zh' ? '残留量' : 'Residual') + ': ' +
            escapeMarkup(format(item.residualBytes, 'bytes')) + '</div>');
        }
        if (item.leakBytes !== undefined) {
          rows.push('<div>' + (currentLanguage === 'zh' ? '可量化泄漏量' : 'Quantified leak size') + ': ' +
            escapeMarkup(format(item.leakBytes, 'bytes')) + '</div>');
          rows.push('<div>' + escapeMarkup(item.leakSizeBasisText?.[currentLanguage] || item.leakSizeBasis || '') + '</div>');
        }
        if (item.url) rows.push('<div class="tooltip-url">URL: ' + escapeMarkup(item.url) + '</div>');
        if (item.snapshotId) rows.push('<div>' + snapshotLabel + ': ' + escapeMarkup(item.snapshotId) + '</div>');
        tooltip.innerHTML = rows.join('');
        tooltip.style.display = 'block';
        positionTooltip(tooltip, width, height, mouseX, mouseY);
      };
      canvas.onclick = (event) => {
        const bounds = canvas.getBoundingClientRect();
        const marker = eventMarkers.find((m) => m.item.reportAnchor &&
          event.clientX - bounds.left >= m.left - 3 && event.clientX - bounds.left <= m.right + 3 &&
          event.clientY - bounds.top >= m.top - 5 && event.clientY - bounds.top <= m.bottom + 5);
        if (marker) document.querySelector('a.residual-link[href="#' + marker.item.reportAnchor + '"]')?.click();
      };
      canvas.onmousemove = (event) => {
        const bounds = canvas.getBoundingClientRect();
        const mouseX = event.clientX - bounds.left;
        const mouseY = event.clientY - bounds.top;
        clearHoverPoints();
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
        const verticalEventMarker = verticalEventMarkers
          .filter((marker) => Math.abs(marker.px - mouseX) <= 4 && mouseY >= pad.top && mouseY <= plotBottom)
          .sort((left, right) => Math.abs(left.px - mouseX) - Math.abs(right.px - mouseX))[0];
        if (verticalEventMarker) {
          showEventTooltip(verticalEventMarker, mouseX, mouseY);
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
            const nearest = (chart.graphics && series.interpolation !== 'linear') || seriesRenderMode === 'interval-bars' || seriesRenderMode === 'stacked-area'
              ? pointAtOrBefore(series, ts)
              : (chart.graphics && ts < (series.points[0]?.tsMs ?? Infinity)) ? undefined : series.points.reduce(
                  (best, point) => (Math.abs(point.tsMs - ts) < Math.abs(best.tsMs - ts) ? point : best),
                  series.points[0],
                );
            return { series, nearest: nearest || (chart.graphics ? { tsMs: ts, value: 0, unavailable: 'not yet reported' } : undefined), color: seriesColor(series, index) };
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
        const total = areaSeries.reduce((sum, series) => sum + knownValue(pointAtOrBefore(series, ts)), 0);
        const knownAreaCount = areaSeries.filter((series) => {
          const point = pointAtOrBefore(series, ts);
          return point && !point.unavailable;
        }).length;
        const partial = areaSeries.length === 0 || areaSeries.some((series) => {
          const point = pointAtOrBefore(series, ts);
          return !point || point.unavailable || point.partial;
        });
        const rowLabel = (row) => {
          if (row.series.slotId === undefined || row.series.slotId < 3) return seriesLabel(row.series.name);
          const instanceIds = row.nearest.instanceIds || [];
          const destroyedInstanceIds = row.nearest.destroyedInstanceIds || [];
          if (instanceIds.length === 1) {
            return 'slot_' + row.series.slotId + ' (instance_id=' + instanceIds[0] +
              (destroyedInstanceIds.includes(instanceIds[0]) ? ', destroyed' : '') + ')';
          }
          if (instanceIds.length > 1) {
            return 'slot_' + row.series.slotId + ' (instance_ids=' + instanceIds.join(', ') + ')';
          }
          return 'slot_' + row.series.slotId;
        };
        let stackedValue = 0;
        rows.forEach((row) => {
          if (row.nearest.unavailable) return;
          if (isStackedSeries(row.series)) stackedValue += row.nearest.value;
          const pointValue = isStackedSeries(row.series) ? stackedValue : row.nearest.value;
          hoverCtx.save();
          hoverCtx.fillStyle = row.color;
          hoverCtx.strokeStyle = '#fff';
          hoverCtx.lineWidth = 1.5;
          hoverCtx.beginPath();
          hoverCtx.arc(x(chart.graphics && row.series.interpolation !== 'linear' ? ts : row.nearest.tsMs), y(pointValue), 4, 0, Math.PI * 2);
          hoverCtx.fill();
          hoverCtx.stroke();
          hoverCtx.restore();
        });
        const graphicSummary = chart.graphics ? (
          (stackedArea ? '<div>' + (currentLanguage === 'zh' ? (partial ? '已知分量合计 / 占比' : '全部分量合计 / 占比') :
            (partial ? 'Known-part sum / shares' : 'All-part sum / shares')) + ': ' + (knownAreaCount ? format(total, 'bytes') : '—') + '</div>' : '') +
          (chart.graphics.comparisons || []).map((series) => {
            const point = pointAtOrBefore(series, ts);
            return '<div>' + escapeMarkup(seriesLabel(series.name)) + ' (' + (currentLanguage === 'zh' ? (point?.partial ? '已知部分对照' : '总量对照') : (point?.partial ? 'known-part comparison' : 'comparison')) + '): ' +
              (point && !point.unavailable ? format(point.value, 'bytes') : '—') + '</div>';
          }).join('') + '<div>' + (currentLanguage === 'zh' ? '上报值可能来自缓存；非 PSS / VM 内存。' : 'Reports may be cached; not PSS / VM memory.') + '</div>'
        ) : '';
        tooltip.innerHTML = '<strong>t=' + (((chart.graphics ? ts : rows[0].nearest.tsMs) - traceStartMs) / 1000).toFixed(3) + 's</strong>' +
          rows.map((row) => '<div><i style="background:' + row.color + '"></i>' +
            escapeMarkup(rowLabel(row)) + ': ' +
            (row.nearest.unavailable ? (currentLanguage === 'zh' ? '未知 / 缺失 / 冲突' : 'Unknown / missing / conflicting') :
              format(row.nearest.value, row.series.unit) +
              (row.nearest.partial ? (currentLanguage === 'zh' ? '（已知部分）' : ' (known part)') : '') +
              (isStackedSeries(row.series) ? ' (' + (total > 0 ? (row.nearest.value / total) * 100 : 0).toFixed(2) + '%)' : '')) +
            '</div>').join('') +
          graphicSummary + alivePages;
        tooltip.style.display = 'block';
        positionTooltip(tooltip, width, height, mouseX, mouseY, 14);
      };
      canvas.onmouseleave = () => {
        clearHoverPoints();
        tooltip.style.display = 'none';
      };
    };
    const renderAll = () => document.querySelectorAll('.chart').forEach(render);
    document.addEventListener('report-filter-change', renderAll);
    document.querySelectorAll('details.chart-card').forEach((card) => card.addEventListener('toggle', renderAll));
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
    const leakRows = [...document.querySelectorAll('.residual-card[data-bts-vm-name]')];
    const issueCards = [...document.querySelectorAll('.issue[data-bts-vm-names]')];
    const pageCount = document.querySelector('[data-filter-page-count]');
    const issueCount = document.querySelector('[data-filter-issue-count]');
    const conclusion = document.querySelector('[data-filter-conclusion]');
    const emptyPages = document.querySelector('[data-filter-empty="pages"]');
    const emptySharedBts = document.querySelector('[data-filter-empty="shared-bts"]');
    const emptyLeakRows = document.querySelector('[data-filter-empty="bts-slot-leaks"]');
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
      const visibleResiduals = leakRows.filter((row) => !row.classList.contains('filtered-out'));
      for (const [name, statuses] of [['confirmed', ['confirmed']], ['suspected', ['suspected', 'retained']], ['incomplete', ['pending', 'failed', 'insufficient']]]) {
        const count = visibleResiduals.filter((row) => statuses.includes(row.dataset.status)).length;
        document.querySelector('[data-residual-count="' + name + '"]').textContent = String(count);
      }
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
        const unresolved = visibleResiduals.filter((row) => ['pending', 'failed', 'insufficient', 'retained', 'suspected'].includes(row.dataset.status)).length;
        if (unresolved) conclusion.textContent += english ? ' ' + unresolved + ' page(s) still require verification.' : ' 另有 ' + unresolved + ' 页待分析或核实，不能据此排除泄漏。';
      }
      document.dispatchEvent(new Event('report-filter-change'));
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
      const download = target.closest('.download-residual');
      if (download) {
        const frame = download.closest('.residual-child').querySelector('iframe');
        const url = URL.createObjectURL(new Blob([frame.srcdoc], { type: 'text/html' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = 'instance-' + download.dataset.instance + '-residual.html';
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        return;
      }
      const residualLink = target.closest('.residual-link');
      if (residualLink) {
        const card = document.getElementById(residualLink.getAttribute('href').slice(1));
        if (!card) return;
        event.preventDefault();
        card.open = true;
        const child = card.querySelector('.residual-child');
        if (child) child.open = true;
        history.pushState(null, '', '#' + card.id);
        card.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
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

function reportNavigationScript(): string {
  return `<script>
  (() => {
    const toc = document.querySelector('.report-toc');
    const nav = toc.querySelector('nav');
    const entries = [...nav.querySelectorAll('[data-report-target]')].map((link) => ({
      link,
      item: link.closest('li'),
      target: document.getElementById(link.dataset.reportTarget),
    })).filter((entry) => entry.target);
    const narrow = window.matchMedia('(max-width: 1000px)');
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let visibleEntries = entries;
    let activeEntry;
    let navigationEntry;
    let navigationPosition;
    let scheduled = false;
    const updateActive = () => {
      scheduled = false;
      if (navigationPosition !== undefined && navigationPosition !== window.scrollY) {
        navigationEntry = undefined;
        navigationPosition = undefined;
      }
      const offset = narrow.matches ? 88 : 40;
      let current = visibleEntries[0];
      for (const entry of visibleEntries) {
        if (entry.target.getBoundingClientRect().top <= offset) current = entry;
      }
      if (window.scrollY > 0 && window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2) {
        // Near the footer, multiple anchors can share the same maximum scroll position.
        const top = navigationEntry?.target.getBoundingClientRect().top;
        if (top !== undefined && top >= 0 && top < window.innerHeight) {
          current = navigationEntry;
          navigationPosition = window.scrollY;
        } else {
          current = visibleEntries[visibleEntries.length - 1];
        }
      } else if (navigationEntry && Math.abs(navigationEntry.target.getBoundingClientRect().top -
        parseFloat(getComputedStyle(navigationEntry.target).scrollMarginTop)) < 1) {
        navigationEntry = undefined;
      }
      if (!current || current === activeEntry) return;
      if (activeEntry) activeEntry.link.removeAttribute('aria-current');
      activeEntry = current;
      current.link.setAttribute('aria-current', 'location');
      if (toc.open) {
        const bounds = nav.getBoundingClientRect();
        const item = current.link.getBoundingClientRect();
        if (item.top < bounds.top) nav.scrollTop += item.top - bounds.top;
        else if (item.bottom > bounds.bottom) nav.scrollTop += item.bottom - bounds.bottom;
      }
    };
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(updateActive);
    };
    const sync = () => {
      navigationEntry = undefined;
      navigationPosition = undefined;
      visibleEntries = entries.filter((entry) => {
        const visible = !entry.target.classList.contains('filtered-out');
        entry.item.hidden = !visible;
        return visible;
      });
      schedule();
    };
    const navigate = (entry, behavior) => {
      if (!entry || entry.item.hidden) return;
      navigationEntry = entry;
      navigationPosition = undefined;
      for (let target = entry.target; target; target = target.parentElement) {
        if (target instanceof HTMLDetailsElement) target.open = true;
      }
      if (narrow.matches) toc.open = false;
      entry.target.tabIndex = -1;
      entry.target.focus({ preventScroll: true });
      requestAnimationFrame(() => {
        entry.target.scrollIntoView({ behavior, block: 'start' });
        schedule();
      });
    };
    nav.addEventListener('click', (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element && event.target.closest('[data-report-target]');
      if (!link) return;
      event.preventDefault();
      const entry = entries.find((item) => item.link === link);
      if (!entry || entry.item.hidden) return;
      if (location.hash !== link.hash) history.pushState(null, '', link.hash);
      navigate(entry, reducedMotion.matches ? 'instant' : 'smooth');
    });
    const navigateHash = () => {
      let id;
      try { id = decodeURIComponent(location.hash.slice(1)); } catch { return; }
      navigate(visibleEntries.find((entry) => entry.target.id === id), 'instant');
    };
    const resize = () => {
      toc.open = !narrow.matches;
      schedule();
    };
    narrow.addEventListener('change', resize);
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    window.addEventListener('hashchange', navigateHash);
    document.addEventListener('toggle', schedule, true);
    document.addEventListener('report-filter-change', sync);
    new ResizeObserver(schedule).observe(document.querySelector('main'));
    resize();
    sync();
    navigateHash();
  })();
  </script>`;
}

function summaryConclusionCopy(result: MemoryAnalysisResult): LocalizedCopy {
  return {
    zh: result.summary.conclusion,
    en: `${result.summary.issueCount} memory issue(s); ${result.summary.confirmedLeakPageCount} page(s) with leaks, ${result.summary.suspectedPageCount} requiring verification, and ${result.summary.incompletePageCount} with incomplete analysis or insufficient evidence.`,
  };
}

function renderSourceBindings(result: MemoryAnalysisResult): string {
  const title = `<h3 id="source-origins">${localized(SNAPSHOT_SUBSECTIONS['source-origins'])}</h3>`;
  const sources = result.frontendSources;
  if (!sources)
    return `${title}<p class="empty">${localized({
      zh: '未提供源码绑定资料；仍可浏览堆快照。',
      en: 'No source binding data was supplied; heap snapshots remain available.',
    })}</p>`;
  const artifacts = sources.artifacts ?? [];
  const projects = sources.projects ?? [];
  const code = (text: string | undefined) => `<code>${escapeHtml(text || '-')}</code>`;
  const key = (candidate: { projectId: string; script: string }) =>
    JSON.stringify([candidate.projectId, candidate.script]);
  const selectedUses = new Map<string, number>();
  const candidateUses = new Set<string>();
  for (const snapshot of result.snapshots) {
    const locations = sources.snapshots[snapshot.snapshotId]?.locations;
    for (const binding of Object.values(locations?.bindings ?? {})) {
      for (const candidate of binding.candidates) candidateUses.add(key(candidate));
      if (binding.selected) {
        const selected = key(binding.selected);
        selectedUses.set(selected, (selectedUses.get(selected) ?? 0) + 1);
      }
    }
  }
  const origin = (project: (typeof projects)[number] | undefined) =>
    project
      ? `${code(project.id)} · ${localized(project.lynx ? { zh: 'Lynx 公共脚本', en: 'Lynx runtime' } : { zh: '业务工程', en: 'Application project' })}
      <br>${localized(project.origin?.kind === 'git' ? { zh: 'Git 仓库', en: 'Git repository' } : { zh: '本地工程', en: 'Local project' })}
      ${project.origin?.url ? `<br>${code(project.origin.url)}` : ''}
      ${project.root ? `<br>${code(project.root)}` : ''}
      ${project.origin?.ref ? `<br>ref: ${code(project.origin.ref)}` : ''}
      ${project.commit ? `<br>commit: ${code(project.commit)}` : ''}
      ${
        project.artifactOrigin
          ? `<br>${localized({ zh: '独立产物来源', en: 'Separate artifact origin' })}: ${code(project.artifactOrigin.kind)} ${code(project.artifactOrigin.locator)}
      ${project.artifactOrigin.ref ? `<br>artifact ref: ${code(project.artifactOrigin.ref)}` : ''}
      ${project.artifactOrigin.commit ? `<br>artifact commit: ${code(project.artifactOrigin.commit)}` : ''}`
          : ''
      }
      ${project.lynx ? `<br>${escapeHtml(project.lynx.platform)} · ${escapeHtml(project.lynx.selection.kind)} ${code(project.lynx.selection.requested)}` : ''}`
      : '-';
  const inventoryRows = artifacts.map((artifact) => {
    const uses = selectedUses.get(key(artifact)) ?? 0;
    const status: LocalizedCopy = uses
      ? { zh: `已绑定 ${uses} 个快照脚本`, en: `Bound to ${uses} snapshot scripts` }
      : candidateUses.has(key(artifact))
        ? { zh: '候选，未绑定', en: 'Candidate, not bound' }
        : { zh: '已提供，未引用', en: 'Supplied, not referenced' };
    return `<tr data-source-artifact class="${uses ? 'source-bound' : 'source-unbound'}">
      <td>${origin(projects.find((project) => project.id === artifact.projectId))}</td>
      <td>JS: ${code(artifact.script)}<br>${artifact.inlineMap ? localized({ zh: '内联 sourcemap', en: 'Inline sourcemap' }) : 'Map'}: ${code(artifact.map)}</td>
      <td>${localized(
        artifact.map
          ? { zh: 'JS / map 已准备', en: 'JS / map prepared' }
          : { zh: '仅生成 JS；未提供 sourcemap', en: 'Generated JS only; no sourcemap supplied' },
      )}<br>${localized({
        zh: `${artifact.sourceFileCount} 个已校验原始文件`,
        en: `${artifact.sourceFileCount} validated original files`,
      })}<br><span class="source-binding-status">${localized(status)}</span></td>
      <td><details><summary>SHA-256</summary>JS: ${code(artifact.scriptSha256)}<br>Map: ${code(artifact.mapSha256)}</details></td></tr>`;
  });
  for (const project of projects.filter(
    (project) => !artifacts.some((artifact) => artifact.projectId === project.id),
  )) {
    inventoryRows.push(
      `<tr data-source-project class="source-unbound"><td>${origin(project)}</td><td>-</td><td>${localized(
        project.abandoned
          ? { zh: '已跳过（用户同意）', en: 'Skipped with user agreement' }
          : { zh: '产物清单未保存', en: 'Artifact inventory not saved' },
      )}</td><td>${escapeHtml(project.abandoned?.reason ?? '-')}</td></tr>`,
    );
  }
  const table = (
    id: string,
    headers: LocalizedCopy[],
    rows: string[],
  ) => `<div class="report-table-wrap"><table class="source-table" id="${id}">
    <thead><tr>${headers.map((header) => `<th>${localized(header)}</th>`).join('')}</tr></thead>
    <tbody>${rows.join('')}</tbody></table></div>`;
  return `${title}
    <p class="muted">${localized({
      zh: '下表列出已提供的源码产物及绑定状态。准备记录不代表当前文件仍在本机；函数偏移匹配不等于捕获脚本的完整哈希校验，也不改变泄漏结论。',
      en: 'Supplied source artifacts and binding status are listed below. Preparation records do not imply files still exist locally; function offset alignment is not a full captured-script hash check and does not change leak conclusions.',
    })}</p>
    ${!sources.artifacts ? `<p class="notice">${localized({ zh: '旧分析数据未保存完整产物清单，以下仅展示已保存的来源。', en: 'Legacy analysis data has no complete artifact inventory; only saved provenance is shown.' })}</p>` : ''}
    ${
      inventoryRows.length
        ? table(
            'source-inventory',
            [
              { zh: '工程 / 来源 / 版本', en: 'Project / origin / revision' },
              { zh: '生成 JS / sourcemap', en: 'Generated JS / sourcemap' },
              { zh: '准备与使用状态', en: 'Preparation and use' },
              { zh: '哈希 / 原因', en: 'Hashes / reason' },
            ],
            inventoryRows,
          )
        : `<p class="empty">${localized({ zh: '没有已准备的源码产物。', en: 'No prepared source artifacts.' })}</p>`
    }
    ${sources.warnings.length ? `<ul class="notice warning">${sources.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('')}</ul>` : ''}`;
}

export function generateMemoryAnalysisReport(
  result: MemoryAnalysisResult,
  outputPath: string,
  snapshots?: MemoryReportSnapshotData,
): string {
  const charts = [
    ...result.pages.flatMap((page) =>
      [
        page.analysis.memoryChart,
        page.analysis.componentChart,
        page.analysis.graphicMemoryChart,
        page.analysis.canvasResourceChart,
        ...page.analysis.trendCharts,
      ].filter((chart): chart is MemoryChart => chart !== undefined),
    ),
    ...result.sharedBtsSlotCharts,
    ...globalGraphicGroups(result).flatMap((group) => [group.memoryChart, group.countChart]),
  ];
  const warningHtml =
    result.warnings.length === 0
      ? `<div class="notice success">${localized({
          zh: '未发现基础指标分析的前置限制；对象证据覆盖见各页面 residual 分析。',
          en: 'No prerequisite limitation for base metrics was detected; see each residual analysis for object coverage.',
        })}</div>`
      : result.warnings.map((warning) => `<div class="notice warning">${localized(knownCopy(warning))}</div>`).join('');
  const issuesHtml =
    result.issues.length === 0
      ? `<div class="notice success">${localized({
          zh: '未发现规则命中的高或中置信度 issue。',
          en: 'No rule-defined high- or medium-confidence issue was found.',
        })}</div>`
      : result.issues.map((issue) => renderIssue(issue, result)).join('');
  const sortedPages = [...result.pages].sort((a, b) => a.realCreateTsMs - b.realCreateTsMs);
  const pagesHtml = sortedPages.map((page) => renderPage(page, result)).join('');
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Lynx 内存分析报告</title>
  <style>
    :root { scrollbar-gutter:stable; color-scheme: light; --ink:#162033; --muted:#64748b; --line:#dbe3ee; --panel:#fff; --bg:#f4f7fb; --accent:#2457d6; --danger:#b42318; }
    html:not([lang="en"]) .finding-copy[lang="en"], html[lang="en"] .finding-copy[lang="zh"] { display:none; }
    * { box-sizing: border-box; }
    body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    .report-layout { display:grid; grid-template-columns:240px minmax(0,1fr); gap:32px; max-width:1520px; margin:0 auto; padding:40px 24px 80px; }
    main { min-width:0; }
    main > section[id], #snapshots > h3[id], .page-card, .residual-card { scroll-margin-top:24px; }
    .report-sidebar { position:sticky; top:24px; align-self:start; min-width:0; }
    .report-toc { border:1px solid var(--line); border-radius:12px; background:var(--panel); overflow:hidden; }
    .report-toc > summary { padding:12px 16px; font-weight:700; cursor:pointer; }
    .report-toc nav { max-height:calc(100vh - 112px); overflow-y:auto; overscroll-behavior:contain; padding:0 8px 12px; }
    .report-toc ul { list-style:none; margin:0; padding:0; }
    .report-toc ul ul { margin:2px 0 6px 14px; padding-left:8px; border-left:1px solid var(--line); }
    .report-toc a { display:block; padding:8px 10px; border-radius:7px; color:var(--muted); text-decoration:none; font-size:13px; line-height:1.5; overflow-wrap:anywhere; }
    .report-toc a:hover { background:#f1f5f9; color:var(--ink); }
    .report-toc a[aria-current="location"] { color:var(--accent); background:#eaf0ff; font-weight:650; }
    .report-toc a:focus-visible { outline:2px solid var(--accent); outline-offset:-2px; }
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
    .confirmed-status { color:var(--danger); }
    .badge.leak { background:#fee2e2; color:var(--danger); }
    .badge.observation { background:#dcfce7; color:#166534; }
    .badge.non-leak { background:#fef3c7; color:#92400e; }
    .confidence.high { background:#dbeafe; color:#1d4ed8; }
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
    .url-cell { max-width:420px; overflow-wrap:anywhere; word-break:break-word; }
    .analysis-item { margin:16px 0; border:1px solid var(--line); border-radius:9px; padding:14px; }
    .analysis-item strong { font-size:20px; }
    .analysis-item p { margin:4px 0; color:var(--muted); }
    .analysis-item.analysis-issue { border-color:#f2a69e; border-left:5px solid var(--danger); background:#fff8f6; }
    .issue-row td { background:#fff7ed; }
    .notes { color:var(--muted); }
    .chart-card { margin:18px 0; border:1px solid var(--line); border-radius:10px; padding:14px; overflow:hidden; }
    .chart-card summary { font-weight:650; cursor:pointer; }
    .chart-note { color:var(--muted); font-size:12px; line-height:1.6; }
    .shared-bts-card { margin:18px 0; border:1px solid var(--line); border-radius:10px; background:var(--panel); overflow:hidden; }
    .shared-bts-card > summary { padding:14px 16px; cursor:pointer; font-weight:700; }
    .shared-bts-card[open] > summary { border-bottom:1px solid var(--line); }
    .shared-bts-content { padding:16px; }
    .shared-bts-analysis-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
    .shared-bts-analysis-grid .analysis-item { margin:0; }
    .chart { position:relative; width:100%; min-height:320px; overflow-x:auto; }
    .chart canvas { display:block; }
    .chart-hover-overlay { position:absolute; z-index:1; left:0; top:0; pointer-events:none; }
    .chart-legend { display:flex; flex-wrap:wrap; gap:7px; padding:8px 4px 2px 72px; }
    .chart-legend-item { display:inline-flex; align-items:center; gap:7px; border:1px solid var(--line); border-radius:999px; padding:4px 9px; color:#334155; background:#fff; cursor:pointer; font-size:12px; }
    .chart-legend-item:hover { border-color:#94a3b8; background:#f8fafc; }
    .chart-legend-item i { width:10px; height:3px; border-radius:2px; }
    .chart-legend-item.hidden { opacity:.45; }
    .chart-legend-item.hidden span { text-decoration:line-through; }
    .chart-event-legend-item { display:inline-flex; align-items:center; gap:7px; padding:4px 3px; color:#475569; font-size:12px; }
    .chart-event-legend-item i { width:10px; height:10px; border-radius:4px; }
    .chart-tooltip { display:none; position:absolute; z-index:2; width:max-content; max-width:none; padding:6px; background:rgba(0,0,0,.8); color:#fff; border-radius:6px; pointer-events:none; font-size:12px; line-height:1.3; white-space:nowrap; }
    .chart-tooltip.event-tooltip { width:auto; min-width:440px; max-width:600px; padding:10px 12px; background:rgba(15,23,42,.94); white-space:normal; }
    .chart-tooltip div { margin-top:3px; }
    .chart-tooltip i { display:inline-block; width:9px; height:9px; margin-right:7px; border-radius:50%; }
    .chart-tooltip .tooltip-url { overflow-wrap:anywhere; word-break:break-word; }
    .mono { font:12px ui-monospace,SFMono-Regular,Menlo,monospace; word-break:break-all; }
    footer { margin-top:40px; color:var(--muted); text-align:center; }
    .residual-card { margin:16px 0; border:1px solid #cbd5e1; border-radius:12px; overflow:hidden; }
    .pf-memory-report-frame { position:fixed; inset:0; width:100%; height:100%; border:0; z-index:10000; background:transparent; }
    .residual-card > summary { padding:18px; background:#f1f5f9; cursor:pointer; font-weight:650; }
    .residual-body { padding:18px; }
    .residual-table-wrap, .report-table-wrap { overflow-x:auto; }
    .source-table { table-layout:fixed; min-width:760px; }
    .source-table th, .source-table td { overflow-wrap:anywhere; vertical-align:top; }
    .source-table code { white-space:normal; font-size:12px; }
    .source-table .source-bound .source-binding-status { color:#15803d; font-weight:600; }
    .source-table .source-unbound { color:var(--muted); }
    .source-table .source-unbound * { color:inherit; }
    #source-inventory th:nth-child(1) { width:30%; }
    #source-inventory th:nth-child(2) { width:35%; }
    #source-inventory th:nth-child(4) { width:13%; }
    .cache-breakdown { margin:12px 0; }
    .cache-breakdown table { width:100%; table-layout:fixed; }
    .cache-breakdown th:nth-child(1) { width:23%; }
    .cache-breakdown th:nth-child(2) { width:14%; }
    .cache-breakdown th:nth-child(4) { width:20%; }
    .cache-breakdown td { overflow-wrap:anywhere; vertical-align:top; }
    .cache-breakdown td:first-child .badge { margin-left:4px; white-space:nowrap; }
    /* Same string color as snapshot_viewer.scss in the report's light theme. */
    .allocation-string { color:var(--pf-color-success, rgb(0, 128, 0)); white-space:pre-wrap; }
    .allocation-string, .cache-path { font-size:12px; }
    .cache-path { color:var(--text-secondary); margin:4px 0 8px; }
    .residual-card td { overflow-wrap:anywhere; }
    .residual-child > summary { cursor:pointer; padding:16px 0; font-weight:650; }
    .residual-child iframe { width:100%; height:850px; border:1px solid #e2e8f0; margin-top:12px; }
    @media (max-width:1000px) {
      .report-layout { grid-template-columns:minmax(0,1fr); gap:20px; padding:16px 16px 50px; }
      .report-sidebar { top:12px; z-index:10; }
      .report-toc { box-shadow:0 4px 16px rgba(33,54,91,.08); }
      .report-toc nav { max-height:50vh; }
      main > section[id], #snapshots > h3[id], .page-card, .residual-card { scroll-margin-top:76px; }
    }
    @media (max-width:800px) { .summary-grid,.shared-bts-analysis-grid { grid-template-columns:repeat(1,minmax(0,1fr)); } .header-top { align-items:flex-start; } }
  </style>
</head>
<body><div class="report-layout">
${renderReportNavigation(sortedPages, result.residualAnalyses, globalGraphicGroups(result).length > 0)}
<main>
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
      )}</div>
    ${result.artifacts ? `<p><a href="#snapshots" data-snapshot-viewer>${localized({ zh: '浏览 Trace 快照', en: 'Browse trace snapshots' })}</a> · <a href="${escapeHtml(result.artifacts.trace.file)}" download>${localized({ zh: '下载原始 Trace', en: 'Download source trace' })}</a></p>` : ''}
  </header>
  <div class="summary-grid">
    <div class="metric"><strong>${result.summary.pageCount}</strong>${localized({ zh: '页面实例', en: 'Page instances' })}</div>
    <div class="metric"><strong data-filter-page-count>${result.summary.analyzedPageCount}</strong>${localized({ zh: '分析目标', en: 'Analysis targets' })}</div>
    <div class="metric"><strong>${result.summary.vmCount}</strong>${localized({ zh: '虚拟机', en: 'Virtual machines' })}</div>
    <div class="metric"><strong>${result.summary.snapshotCount}</strong>${localized({ zh: '堆快照', en: 'Heap snapshots' })}</div>
    <div class="metric"><strong data-filter-issue-count>${result.summary.issueCount}</strong><span>Issue</span></div>
    <div class="metric"><strong data-residual-count="confirmed">${result.summary.confirmedLeakPageCount}</strong>${localized({ zh: '泄漏页面', en: 'Leak pages' })}</div>
    <div class="metric"><strong data-residual-count="suspected">${result.summary.suspectedPageCount}</strong>${localized({ zh: '待核实页面', en: 'Pages to verify' })}</div>
    <div class="metric"><strong data-residual-count="incomplete">${result.summary.incompletePageCount}</strong>${localized({ zh: '未完成 / 证据不足', en: 'Incomplete / insufficient evidence' })}</div>
  </div>
  <section id="analysis-notes"><h2>${localized(REPORT_SECTIONS['analysis-notes'])}</h2>${warningHtml}</section>
  ${renderReportFilter(result)}
  <section id="page-analysis" class="page-analysis-section"><h2>${localized(REPORT_SECTIONS['page-analysis'])}</h2>${
    pagesHtml ||
    `<p class="empty">${localized({ zh: '没有找到 Lynx 页面实例。', en: 'No Lynx page instance was found.' })}</p>`
  }<p class="empty filter-empty" data-filter-empty="pages">${localized({
    zh: '当前过滤条件下没有页面实例分析结果。',
    en: 'No page instance analysis matches the current filter.',
  })}</p></section>
  ${renderVmAndSnapshotSections(result)}
  <section id="conclusion" class="conclusion-section"><h2>${localized(REPORT_SECTIONS.conclusion)}</h2>
  ${(result.analystNotes ?? []).map((note) => `<p class="analyst-note">${localized(note)}</p>`).join('')}
  <div data-filter-conclusion class="notice ${
    result.issues.length ? 'warning' : 'success'
  }">${localized(summaryConclusionCopy(result))}</div>${issuesHtml}</section>
  <footer>${localized({
    zh: '由 @lynx-js/trace-query 内存分析生成',
    en: 'Generated by @lynx-js/trace-query memory analysis',
  })}</footer>
</main></div>
${chartScript(charts, result.trace.startTsMs)}
${reportFilterScript()}
${pageNavigationScript()}
${reportNavigationScript()}
${snapshots ? `<script type="application/json" id="memory-report-snapshots">${JSON.stringify(snapshots).replace(/</g, '\\u003c')}</script><script src="assets/bridge.js"></script>` : ''}
</body></html>`;

  const resolvedPath = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  fs.writeFileSync(resolvedPath, html, 'utf8');
  return resolvedPath;
}
