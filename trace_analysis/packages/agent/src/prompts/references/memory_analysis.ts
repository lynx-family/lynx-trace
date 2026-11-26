// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { Prompt } from '../../types/prompt';

export const prompt: Prompt = {
  name: 'memory-analysis',
  description:
    'Analyzes Lynx Perfetto memory, Graphic components, Krypton resources and residual snapshots. Use for page memory, resource growth, VM pools or leak analysis with js-memory-analyzer.',
  prompt: `# Lynx Memory Analysis

Use the Query API for deterministic calculations and \`js-memory-analyzer\` for object evidence. Deliver a
portable directory with \`report.html\` as its entry point, finalized per-page reports, JSON evidence,
the original Trace and the shared snapshot viewer runtime.
Package finalized child reports as sibling HTML files and load them lazily by relative URL. Do not
duplicate large exhaustive allocation reports in the main HTML or \`analysis.json\`; preserve the
child files, download links and portability when rerendering into another directory.
Every report delivery or regeneration must include a file-size summary in the final response:
list the main report, each child HTML, evidence JSON and analysis data; group small assets or
snapshot files by directory/category and give the recursive directory total. Measure actual
file bytes, display clearly labeled MiB (1,048,576 bytes), and distinguish individual files
from combined sizes. Do not substitute allocated disk blocks for file lengths.

## JS source inventory

Inside the top-level **JS 引擎堆快照 / JS heap snapshots** section, show **JS 源码来源与绑定状态 /
JS source origins and binding status** and **快照清单 / Snapshot inventory** as second-level headings,
in that order. Add both as nested entries in the left navigation, with stable anchors and active-item
highlighting. Keep only the source inventory table; omit the per-snapshot binding/availability heading
and detail table. Include every supplied application and Lynx source, unselected build candidate,
unreferenced artifact and explicitly skipped project; do not limit this to successful runtime matches
or a header summary.

- The source inventory lists project ID/type, local root or Git URL, requested ref and actual commit,
  Lynx platform/revision, full generated JS and map paths (including inline maps), validated original
  file count, preparation/use status, JS/map SHA-256 and skip reasons.
  Independently supplied artifacts retain their own locator/ref/commit. JS-only inputs explicitly
  show “generated JS only; no sourcemap supplied” instead of claiming JS/map preparation.
- Show each bound artifact's snapshot-script count with green status text. Render the entire row of
  unbound artifacts and projects without artifacts in gray, including paths, revisions, hashes and
  reasons. Retain text distinguishing candidates not bound, supplied but unreferenced, skipped projects
  and missing inventories; do not rely on color alone or equate unbound with globally unusable.
- Compute counts from saved per-snapshot selections, keeping script IDs snapshot-scoped. Detailed
  candidates, locations and diagnostics remain in analysis data and the snapshot viewer.
- Preparation records do not guarantee source files still exist locally. Function-offset alignment
  does not prove captured-script byte identity or change leak conclusions.
- Preserve lightweight inventory, candidates and selected bindings in \`analysis.json\`, with locations
  bound to snapshot SHA-256, so offline rerenders need no source checkout. Do not embed full maps.
  Legacy data must explicitly say its inventory is incomplete; never infer missing provenance.
- Translate headings/statuses, escape all paths and diagnostics, wrap long values and allow horizontal
  table scrolling on narrow screens. Snapshot IDs retain viewer links. Missing sources, scripts or
  location records have explicit empty states and must not disable snapshot inspection.

## Required workflow

The [source-preparation](./source-preparation.md) contract is mandatory at analysis entry and
final delivery, including delegated \`js-memory-analyzer\` work. Pass \`--source-preparation\`
with both source decisions. Missing Lynx preparation is pending, never an implicit opt-out.

Apply [source-inputs](./source-inputs.md) to business and Lynx sources. Resolve an unspecified Lynx
repository automatically from remote probes: accessible internal selects internal; only an
inaccessible internal remote proceeds to OSS, without a user question or an intermediate pause.
Fresh Lynx initialization/dependency/build failures first receive environment diagnosis and one
automatic retry. If it still fails, ask whether to skip Lynx source assistance or terminate analysis.
Successful public-script builds continue despite incidental tracked changes. Initial clone/fetch/
checkout failures use acquisition recovery for missing/corrected revision or access information;
do not re-ask the Lynx repository family or switch accessible internal to OSS because a ref is absent.
Business build failures and later Lynx source mismatches use the explicit skip-source/abort decision.
Frontend artifact mismatches require config diagnosis and the abort/continue-without-artifacts/
provide-artifact-locator loop in [frontend-sources](./frontend-sources.md). Record opt-outs, skipped
sources and attribution limits; never infer a skip decision or impose a retry limit on replacement inputs.

Internal and OSS Lynx share the same Trace events and analysis capabilities. OSS root corresponds to
internal's \`lynx/\`; apply these analysis rules to both, using only evidence actually present in the Trace.

0. **Prepare Lynx public scripts** using [lynx-sources](./lynx-sources.md). Explicit runtime inputs or
   a prior opt-out take priority. Otherwise read \`LynxEngineVersion.version\` and require \`>= 4.5.0\`.
   Earlier versions are invalid even if their tags exist, because the relevant memory-analysis
   support was added in Lynx 4.5; use missing-tag recovery and ask for usable source/revision.
   For an eligible version, form and query the tag,
   then acquire/build automatically when it resolves. Ask for source location/revision only when
   the tag is absent or cannot be uniquely resolved. This preflight is allowed before frontend
   preparation. Local analysis tools and frontend projects are not runtime source selections.
1. When frontend projects were supplied, complete [frontend-sources](./frontend-sources.md):
   prepare all active projects and continue without requesting artifact confirmation. If source
   and prebuilt artifacts were supplied independently, acquire the artifacts without building the
   frontend; bind Trace locations to their JS first and map into the specified source project.
   JS-only inputs retain generated positions. When a business position used in the analysis cannot
   be mapped to the supplied project, apply the [binding question](./frontend-sources.md#generated-only-frontend-locations).
   Pass \`--frontend-manifest\` to analysis and source-enabled report generation.
2. **Check source preparation before analysis:** applicable Lynx public scripts and all supplied
   active frontend projects have prepared manifests, or explicit source opt-outs are recorded.
   Run \`memory-analysis\` with the user's trace and any page/scenario selectors. Pass \`--lynx-manifest\`
   when runtime artifacts are available, alongside frontend maps. Pass the source decision ledger;
   the command rejects pending decisions before Trace initialization. No \`frontend-confirm\` is required.
3. Read the full JSON and every selected page's \`residualAnalyses\` sequence. The command automatically
   extracts **all** its residual snapshots; source prerequisites now satisfied, no extra permission
   is needed to analyze them.
   Inspect saved source bindings and JS/map/source-content evidence; verify core prod/dev against
   actual snapshot function offsets before using source locations. On a real frontend mismatch,
   inspect project config variables/branches and explain likely causes with file/line evidence,
   then offer abort, continue without the affected artifacts, or supply an explicit artifact locator.
   Recheck replacements and repeat the decision until matched or explicitly aborted/opted out.
   A Lynx mismatch uses the affected-source opt-out/abort decision.
   Do not ask the user to judge map correctness. Unused variants
   and insufficient metadata are evidence gaps, not proven mismatches.
   Inspect Graphic page classification, deduplicated resource series, global Krypton tracks and their
   source identities as part of the base measurements. Missing PSS/BTS/residual data must not suppress
   independently available graphics charts.
4. Load the available \`js-memory-analyzer\` skill and follow its finalization contract. Hand off the
   caller policy and source ledger. Inspect every returned preflight, not only its aggregate status:
   mismatch/invalid required input returns to the failure interaction; standalone optional-source
   fallback does not apply. Analyze each
   complete, identity-valid sequence, including pages with one snapshot or zero subsequent page loads.
5. Produce one finalized analyzer JSON and HTML per page. Keep all findings and their limitations.
6. Complete each prepared group's binding review in the source ledger, including current snapshot
   hashes and evidence limitations. Write the residual import manifest, run \`memory-report\` with
   the updated \`--source-preparation\`, and deliver the final directory with a link to \`report.html\`.
   Do not stop after the preliminary report while analyzable residuals remain.

If an analyzer is unavailable, record that fact, continue the other pages/base metrics and explicitly
report incomplete analysis. Never interpret pending, failed or insufficient evidence as absence of leaks.
Keep heap snapshot content out of chat and HTML; pass local file paths to the analyzer.
The final viewer embeds the original snapshot strings for offline inspection. Source locations and
snippets are added by the report packager; node links still open/select the original snapshot first.

## Query commands

\`\`\`bash
node <skill-dir>/scripts/trace_query.bundle.cjs --source-preparation "<work-dir>/source-preparation.json" memory-analysis \\
  --path "<trace_path_or_url>" \\
  --output "<delivery-dir>"
\`\`\`

Selectors: \`--url "<substring>"\`, \`--instance-id <id>\`, or
\`--scenario scroll --start <absolute_ms> --end <absolute_ms>\` with a page selector.
Without selectors, analyze all pages created during the trace. For page/scenario selection, ask only
if the requested page or scrolling interval cannot be resolved. A broad request needs no page-selection
clarification; the Lynx decision and frontend prerequisites above still apply.

The command returns \`directory\`, \`reportPath\`, \`dataPath\`, summary, issues, snapshots and residual sequence metadata.
The full JSON uses \`schemaVersion: 4\`. Defaults are \`<output>/report.html\`, \`<output>/analysis.json\`,
and \`<output>/snapshots/\`. The Trace is copied into the directory, including URL inputs. \`artifacts.trace\`
records its relative filename, size and SHA-256. Explicit \`.html\` output paths remain supported and create
the sibling assets/data/Trace files. \`--output-data\` writes an additional JSON copy; preserve the primary
\`analysis.json\` beside its relative resources for rerendering.

If \`valid=false\`, explain the missing \`enable_memory_trace\` capture and stop memory analysis.
Memory tracing includes the post-exit collection workflow; no separate capture switch is required.

## Trace interpretation

- \`LynxShell::Create\` start and \`LynxShell::~LynxShell\` end define the page/PSS lifecycle.
- \`page_uses_bts_vm\` and complete \`BTSRuntime::Destroy\` end define its BTS lifecycle. Bind page,
  VM generation and dedicated slot together. Slots 0/1/2 mean unknown/common/overflow;
  3–255 support individual-page attribution.
- \`memory_<instance>\` provides MTS memory, UI component counts, Canvas App detail and AnimaX estimates;
  \`summary.total-pss\` is process PSS. Apply the Graphic rules below instead of summing arbitrary UI \`sizeBytes\`.
- Process-scoped \`Krypton*Mem\` tracks provide resource bytes and \`Krypton*Cnt\` tracks provide counts.
  \`KryptonTotalMemEst\` is a separate comparison total, never another stacked component or a page attribution source.
- \`bts_vm_acc_*\` is the BTS source. Bind by pointer and intersection of track sample interval and VM
  generation lifetime, requiring exactly one candidate. Missing/ambiguous counters disable only the
  affected counter analysis, not independently valid snapshot analysis.
- QuickJS(gc/rc) counters provide Accumulate and RSS (\`base_usage + page_rss_usage\`).
  RSS measures resident engine pages, not slot ownership or proof of leakage.
- \`RunGC\` is the global collection interval for PSS analysis; use completion plus 10 ms for settled data.
- \`VM_GC\` belongs to its pointer's active VM generation. It supports the VM Accumulate trend.
- \`capture_snapshot\` and \`snapshot_chunk\` provide snapshot metadata and content.

Capture scopes are \`mts_instance/<instance>\`, \`bts_vm/<id>\`,
\`bts_instance/<instance>/slot_<slot>\`, and \`bts_residual/<instance>/slot_<slot>\`.
VM scopes (including \`bts_unknown\`, \`bts_common\`, \`bts_overflow\`) bind through \`bts_vm_acc_<id>\` and
its unique generation association. Do not treat the VM identifier as a native pointer. Unresolvable snapshots remain in the
inventory with an identity explanation. Manual snapshots are supplemental, never invented exit baselines.

## Base measurements

Use the query's lifecycle classification and attribution windows. Do not recalculate these from raw SQL
unless diagnosing a failing command.

- Loading PSS peak increase >150 MiB: high-memory issue. Grouped pages share a group result; overlapping
  creations reduce individual attribution confidence.
- MTS pool RSS growth >3 MiB: pool issue. At each endpoint choose the latest state per \`pool_instance_id\`
  by timestamp/slice ID, exclude destroyed pools, group by URL (\`global_pool\` for global pools), retain
  negative deltas, and list positive contributors in Abnormal MTS VM pool attribution.
- Post-exit PSS >=2 MiB above baseline is a rollback observation. The final PSS delta point must use the
  exact minimum sample selected for rollback; show both endpoint timestamps and values.
- Component counts cover the page lifecycle. Counts and PSS changes alone do not confirm JS leaks.
- Add Graphic memory and Canvas resource count charts for eligible pages, and process Krypton charts
  over the full Trace. Keep resource estimates separate from PSS and VM memory.
- Scroll trends use aligned samples, moving median, Theil-Sen slope and a noise threshold; require at
  least 10 samples, positive slope, significant endpoint delta and predominantly nondecreasing buckets.
  Show MTS/BTS RSS and Accumulate with PSS, plus component counts.

### Shared BTS VM chart and analyses

Render slot values as stepped stacked areas in ascending slot order over the VM generation lifetime.
Label dedicated slots by page instance, and mark destroyed pages in the tooltip. The tooltip shows bytes
and fraction of all slots. **This chart has no RSS series.**

Show VM/page lifecycle bubbles, assigned captures at capture time, and VM_GC red dashed lines.
Only finalized findings explicitly classified as confirmed leaks add prominent leak markers. Clicking
one opens that page's embedded analyzer report. The marker uses the latest valid observation time.

Keep both VM analyses:

1. VM not destroyed: its track starts >100 ms after trace start and no destroy event occurs before trace
   end. Emit a high-confidence VM state issue and show end RSS. This does not confirm a page leak.
2. Post-VM_GC Accumulate trend: choose the first counter at/after each GC completion, deduplicate reused
   samples, exclude samples after VM destruction. Minimum 3 samples; 3–9 use unsmoothed values. Use
   robust slope, stable-level delta and noise threshold. A rising trend is a medium-confidence VM issue.

## Graphic component memory and resource counts

Use the Query API's structured series and provenance. If the installed query/report version does not
provide these capabilities, explicitly report the missing capability; do not claim a chart was generated
from instructions alone, fabricate data, or silently replace it with page totals.

### Identify and normalize page data

- Classify a component as Graphic when its JSON \`category\` contains \`canvas\` or \`animax\`, case
  insensitively. Only if \`category\` is absent, use the category argument key after stripping known prefixes.
  Preserve the original component name. A page is eligible if any sample in its observable lifetime
  contains a matching category, including zero-valued samples. Track Canvas eligibility separately.
- Read Canvas resources from \`detail.krypton.*\`. Accept finite nonnegative integer JSON numbers or
  decimal numeric strings. Preserve missing, invalid, negative and conflicting values with reasons;
  never coerce them to measured zero.
- Bytes are fields beginning with \`krypton.\` and ending with \`.bytes\`. Counts end with \`.count\`,
  plus the explicit \`krypton.total.object_count\` key. Include new resource keys dynamically, including
  audio buffer/sampler bytes, rather than limiting parsing to today's resources.
- Deduplicate Canvas detail within its process/page/CanvasApp identity. Standard pages share one
  CanvasApp across their Canvas UIs. Use explicit App identity when present; otherwise use that verified
  page association. Multiple categories reporting the same App contribute each resource key once.
  Merge identical duplicate fields; mark unresolved conflicting fields unavailable instead of summing,
  taking the maximum, or selecting an arbitrary category. If multiple independent Apps are verified,
  deduplicate each App before summing resource keys; otherwise expose the attribution ambiguity.
  Never deduplicate different pages merely because their numeric values match.
- Do not use Canvas category \`sizeBytes\`, multiply detail by \`instanceCount\`, or divide \`sizeBytes\`
  by the count. Each Canvas UI reports the same App total, with additional UI allocation bytes on iOS;
  category aggregation repeats that total. Detail dictionaries overwrite keys rather than sum values.
- Keep \`krypton.total.estimated_bytes\` as an independent App comparison total. Do not stack it,
  invent a remainder resource, or rescale resource bytes to force agreement. Preserve coverage and
  separately sampled-total differences.
- Use each AnimaX category's \`sizeBytes\` once. It already sums its Players' estimates; do not multiply
  or divide by \`instanceCount\`. Keep the exact component name as its series label, e.g. \`animax-view\`.
  Without reported detail, keep one area per AnimaX category and do not reverse-engineer subcomponents.
- Explain that AnimaX estimates resource sizes and fixed overhead, caches the result in its Player,
  and in the verified implementation recalculates only when rendering scale changes. Initial zero can
  mean not yet estimated. Page counters may repeat cached UI fields when other categories change;
  counter timestamp/sample count is not a fresh graphics measurement timestamp/count.

### Page charts

Inside each eligible page's analysis card, after its memory-delta and UI component-count charts, render:

1. **Graphic组件内存占用 / Graphic Component Memory Usage** — stepped stacked areas of deduplicated
   Canvas resource bytes together with one area per AnimaX category. The y-axis is bytes displayed as
   KiB/MiB, not a normalized 100% area. Use stable resource/component keys, stacking order and colors.
2. **Canvas组件图形资源计数 / Canvas Graphics Resource Counts** — only for Canvas pages, one stepped
   line per deduplicated resource count field, including \`krypton.total.object_count\`. Do not substitute
   UI \`instanceCount\`. Total/WebGL generic/subtype counts can overlap; never stack or sum them.

Use the page's observable Shell window: \`t_real_create\` (Shell create minus 200 ms, clipped to Trace
start), or Trace start for pre-existing pages, through Shell destroy end or Trace end. Do not extend
these charts into the PSS rollback window. Draw independently of PSS/BTS availability and overlapping
pages. AnimaX-only pages receive the area chart without the Canvas count chart.

Show the hover time once in the tooltip header, resource identities, values and estimate/cache notes.
For all new Graphic, Canvas and global Krypton charts, omit per-row source-time (\`@time\`), \`counter=\`
and \`track=\` suffixes, including comparison-total rows. Keep provenance in structured data only. For the area chart,
show bytes and each visible series' fraction of all valid parts, plus their sum. Hiding a legend item must
not change the percentage denominator; a zero sum yields zero percentages. With missing parts, label
the sum and percentages as known-part values. Show an available App comparison total separately.

Before first reporting and at explicit missing/invalid samples, keep unknown intervals. Hold valid values
between samples and to the observation end without linear interpolation or invented measurements.
Retain a visible point and held interval for a single valid sample, with a sparse-data note; do not infer
its trend. An exit \`memory_N=0\` without component detail is reporter clearing, not a resource-release
measurement or an area drop. If only some resources are available, render those with coverage notes.
If an eligible chart has no valid series, show the reason. Pages without the relevant category omit it.
Missing Canvas bytes must not fall back to aggregated Canvas \`sizeBytes\` or global Krypton data.

These charts describe resource statistics/estimates, are not additive to PSS/VM memory, and do not
independently confirm leaks. Preserve title folding, legends and language/filter state.

## Global Graphic analysis

Add the peer section **Graphic内存分析 / Graphic Memory Analysis** immediately after BTS post-exit
residual analysis and before JS heap snapshots, including navigation and a stable anchor. The section
does not require BTS or residuals, but requires global Krypton tracks. Without global Krypton tracks,
omit both the section and its navigation entry, even when AnimaX or summary.graphics is available.
Page-level Graphic/Canvas charts remain independent. Omit the "Process upid=..." heading; retain process identity in structured data.

Keep process/track identities. Render separate process groups when needed; ambiguous same-name tracks
within one process make that resource unavailable rather than being silently added. Do not mix processes.

- **Graphic资源内存 / Graphic Resource Memory**: stepped stacked areas for names starting with
  \`Krypton\` and ending with \`Mem\`. Exclude \`KryptonTotalMemEst\` from the stack; retain it only as a
  separate Krypton comparison total when available. Add same-process AnimaX category estimates,
  preserving component names. Include AnimaX in the sum, percentages, peak and tail summaries.
  Also provide a Graphic total estimate comparison: KryptonTotalMemEst plus AnimaX. Never stack either
  comparison total or append page Canvas detail.
- **Krypton图形资源计数 / Krypton Graphics Resource Counts**: separate stepped lines for names
  starting with \`Krypton\` and ending with \`Cnt\`, including total objects, WebGL objects and surfaces.
  Counts have overlapping scopes and must not be summed. Unknown suffixes do not imply a unit.

When a unique same-process \`summary.graphics\` track exists alongside Krypton tracks, overlay it as an
independent thin red line (#dc2626, 1.25 CSS px) on **Graphic资源内存 / Graphic Resource Memory**, retaining its raw name. Use track
presence, not an OS-name assumption; Android may provide it and other platforms can omit it.
It is system-reported process graphics memory, with different accounting from resource estimates.
Share the time and bytes axes; scale the y-axis to cover both the area stack and the line. Never include
this line in stack heights, resource sums, percentage denominators, resource peaks or Graphic total estimates.
Its tooltip shows an absolute value without a percentage, and its legend toggles independently.
Connect its own observed samples, keep unknown leading/missing intervals and real zeros, and hold the
last valid value to Trace end. Do not guess cross-process matches or merge ambiguous same-name tracks.

Both x-axes span the entire Trace. Align independent tracks at the union of sample timestamps using each
track's own last sample at or before the query time. No fixed sampling interval, future-value backfill,
or zero for a track merely because another track updated. Preserve real zero, unknown leading intervals
and single samples; extend the last observed Krypton value to Trace end. For AnimaX, sum each category
across active pages and count each page's sizeBytes once. Use actual Shell lifetimes, unknown values
before reporting/at missing samples, and known-part sums when only some active pages have data.
End a page's contribution at its observed Shell destruction; this ends the estimate scope, not a measured
release. Hold values for pages without an observed exit to Trace end. Include lifecycle boundaries in
timestamp alignment. Page/VM filters must not remove AnimaX values from global sums. Use stable colors/order and the same
known-part bytes, percentage, comparison-total and legend rules as the page area chart. Explain missing
bytes/count tracks independently.

Below **both** x-axes, reuse the shared BTS slot chart's lifecycle-bubble appearance and overlap handling,
but restrict the event set:

- Include only pages that contain Graphic components at some point in their observable lifetime and
  belong to the current Krypton process. Include AnimaX-only pages even when Krypton has no updates
  during them. These bubbles provide context, not per-page attribution of global resource memory.
- Use only actual \`LynxShell::Create\` start and \`LynxShell::~LynxShell\` end. Never move a create bubble
  by the 200 ms page-observation offset. Do not synthesize missing creation/destruction endpoints.
- Exclude BTS page events, VM lifecycle events, GC and snapshots. Unknown destruction duration is
  not an observed end. Unknown process association must not produce a guessed cross-process bubble.
- Deduplicate each Shell slice ID once per chart regardless of component count; preserve distinct
  simultaneous events. Both charts use identical event sets. Tooltips include event type/name,
  slice ID, actual instance ID, full URL and event time.
- Page selectors and shared-VM filters affect page cards and these bubbles, not process curves,
  totals or the full Trace time range. Preserve filter/legend/folding state across language changes.

Global tracing is enabled separately from App bookkeeping. Global counters need not equal summed page
details; GL surface counts can be global-only. Never infer a page leak from global residuals or adjacent
page bubbles. Translate titles, resource labels, estimate/cache/coverage notes and Shell event labels;
retain component names, raw keys, track names and evidence IDs.

## Residual sequence analysis

\`residualAnalyses\` groups \`(VM generation, instance, slot)\`. Each \`snapshotIds\` list preserves capture
order (timestamp then slice ID), including incomplete/ambiguous observations. The snapshot inventory
provides \`captureReason\`, \`postExitPageCount\`, \`retainedBytes\`, \`triggerRetainedBytes\`,
\`previousRetainedBytes\`, \`changePercent\`, \`includeInternalAllocations\`, integrity, output path and SHA-256.

Extraction validates a unique capture ID, declared chunk count, contiguous indices and byte offsets,
UTF-8 byte length and heap JSON structure. Per-snapshot failure does not abort later captures/pages.
Use the latest complete identity-valid capture's \`retainedBytes\`, not its trigger value, as the observed
residual. \`tailComplete=false\` means later observations are missing or invalid. Zero metadata can establish
clearing; later nonzero records must still be analyzed. No fixed byte threshold implies leakage.

Pass the analyzer the complete ordered sequence, page URL/instance, VM/generation/slot, exit timestamp
or protocol-only exit fact, collection metadata, gaps and any user-defined exclusion rules.
The API writes \`analyzerContext\` and \`contextPath\` for each page. Pass
\`--residual-context "<contextPath>"\` to analyzer \`summary\` (one snapshot) or \`trend\` (multiple).
It declares \`kind=bts_residual\`, \`sequence=same-page-post-exit\`, \`engineMode=gc|rc|unknown\`,
VM/instance/slot identity and ordered snapshot hashes/timestamps. Mode comes from VM metadata,
never filenames. Preserve \`residual_context\` in final evidence; imports require an exact match.

Explicitly state that these are **repeated post-exit observations of one destroyed page**:

- Use \`summary\` for every snapshot and \`retainers\` for stable/decreasing as well as growing families.
  \`trend\` can compare ordered observations, but growth-only candidate filtering is not residual coverage.
- Do not call \`page-exit\` without actual before/after inputs. Do not invent a baseline.
- Slot snapshots may contain context nodes from other slots; whole graph node counts are not this
  page's object count. Check slot ownership and source/holder boundaries.
- Different coverage settings limit comparability. Repeated hashes are repeated content, and equal
  cross-snapshot IDs do not prove object identity without verified runtime/ID semantics.
- Inspect dominators, independent direct holders, root paths and search coverage. GC, retention,
  lifecycle completion and a release defect are separate facts.
- Confirmed leaks require the analyzer's evidence standard (comparable lifecycle observations and
  verified retention/release gap). A single retained object or constant slot bytes is insufficient.
- Use \`confirmed\` and **泄漏 / Leak** once lifecycle completion, strong retention and a
  release gap are established. Source \`alignment\` / \`provenance: unverified\` limits exact-version/line
  attribution, not an independently established leak. Preserve that source limitation without
  downgrading the finding. One post-exit capture can be combined with independent lifecycle/release
  evidence; never promote retention alone or a release gap inferred only from unverified source.
- Without source verification, preserve the actual evidence strength and avoid claiming a source line
  or assigning responsibility to a specific layer.
- Do not filter leak candidates by key format, numeric length or presumed timestamp meaning, or
  require a particular cache API or Function value. Keys label observed retention edges; snapshots
  alone do not prove how they were generated. User examples supply scenario context, not generic
  matching templates. Confirm leaks from retention paths, expected lifetimes and verified release gaps.

The analyzer's finalized \`analysis.findings\` is the sole source of finding text. Preserve every finding,
evidence pointer, limitation and gap. \`retained\`/\`suspected\` findings stay separate from confirmed issues.

When a finding mentions concrete objects or references measured node evidence, require nonempty
\`representative_objects: [{label, evidence_ref}]\`, at most ten per finding. This limits displayed links,
not the number of analyzed objects. Each pointer must resolve
directly to a measured node under that finding's referenced \`queries\` or \`snapshots\` evidence.
Use a short label from the prose; a property name can label the node it actually references.
The importer derives the snapshot SHA-256 and node ord/id from evidence and requires a unique capture.
\`ord\` is the zero-based node ordinal, not an offset in the flattened snapshot array. Never infer it
from names or reuse ordinals across snapshots. Missing or ambiguous evidence must not produce a link.
Instead record the actual reason in \`object_anchor_gap\` (nonempty, at most 2000 characters).
It is displayed by the analyzer and imported as a translated limitation. Pure statistical findings
need no invented object. Finalization and Trace import reject measured node evidence with neither
anchors nor an explicit gap; draft findings may be incomplete. Do not bypass import by editing
the generated HTML or \`analysis.json\`. Missing JS/maps do not prevent snapshot-node navigation.
Before delivery, check every concrete label in Chinese and English: it must link to the intended
snapshot ord/id or show a concrete gap. A successful render alone does not verify this.
Object links expand the original Summary class and the target object's outgoing references, select
the node, scroll it into view and show Retainers. Load the target's page directly when needed, with
previous/next/all controls; do not duplicate it in a "Located object" section. Zero-size holders and
synthetic nodes outside the class statistics remain accessible as expandable rows without changing
those statistics. Validate ord/id and discard stale results when switching links.
Total slot residual and quantified leak bytes are different measurements. Do not add overlapping
retained sizes; omit \`leakBytes\` when a defensible non-overlapping estimate is unavailable.

### Known non-leak rules

Shared BTS VMs support both one shared context and a persistent common context plus separate
page contexts. The common context loads lynx_core.js; sharedData remains on its global object until
the VM is destroyed. group_id alone does not identify the context mode. VM-wide cache lifetime does
not exempt page allocations held by its entries. Check write/remove/limit contracts separately.

For remaining residual bytes, require the analyzer's exhaustive \`residual.cache_retention\`
measurement and \`allocation_breakdown: {evidence_ref, node_ids, holders: [{label, evidence_ref}]}\`.
The pointer is \`/snapshots/N/residual/cache_retention\`; select exactly the allocations discussed,
excluding nodes already counted in another finding or quantified leak lower bound.
Supply all holders already identified by the analyzer, using node references within that finding's
query/snapshot evidence. Any holder name/type is allowed, including __Engine closures; there is no
cache allowlist or automatic VM-lifetime claim. Holders have no ten-item display limit. Resolve the
same snapshot hash and node ord/id; never select by prose, label or a circular cache_retention reference.
Run \`render-report.js --analysis ... --attribute-residual --finalize --format json ...\` before rendering.
This emits \`holder-retention-2\` measurements from verified raw heaps; old v1 evidence stays readable.
Group by the complete nearest selected holder set and root flags; sum each self_size once.
Show other strong roots, GC atom_array co-retention, and unresolved native retention separately.
Keep all allocations in accounting; at most ten examples per row are displayed with snapshot links.
Attributed bytes are not reclaimable bytes and do not change leak/non-leak dispositions.
Sort source rows by attributed bytes descending (stable ties). Append rounded badges after the
source names without increasing the first-column width; badges may wrap. The user-specified
\`residual-source-labels-1\` rule marks moduleCacheMonitor, _$factoryCache, _$loadScriptCache and
__Engine as Non-leak. Match raw labels exactly; every holder/alias must match, otherwise show Leak.
Rows with no attributed holder show Needs verification. Keep Chinese/English labels in sync.
This presentation list does not restrict holder attribution or rewrite finalized finding totals.
If any source row is Leak, also show a red Leak badge on its finding title (including remaining
residual), replacing the existing displayed status. Otherwise preserve the title status. Apply
the same rule in main and child reports, with Chinese/English labels.
In the allocations/paths column, show string node contents using the snapshot viewer's string
color (light theme rgb(0, 128, 0)). Keep node links and IDs. Use the measured \`string_preview\`
text: the first 128 Unicode code points without the slot metadata suffix, appending ASCII \`...\`
only when truncated. Escape HTML; preserve surrogate pairs. Missing previews fall back to type/ID.
Keep type, linked node ID and size on the first line (e.g. \`string @11951 · 80 B\`).
Place the green string preview on a separate next line, followed by retention paths.
Wrap the preview in double quotes without JS/JSON string escaping; preserve its characters.
Surrounding quotes do not count toward the 128-character content limit.
Use the same 12px font size for string previews and retention paths.

Use analyzer \`bts-residual-2\` rule evidence; show finding badges as **非泄漏 / Non-leak**
in a light-yellow rounded pill matching the confidence badge style. Omit the known-non-leak
status from collapsible instance headings, and bold the full value and unit for known non-leak residual bytes.
Confirmed instance headings display **泄漏 / Leak** in red. Finding dispositions use
rounded pills: **泄漏 / Leak** in red on light red for \`confirmed\`, **非泄漏 / Non-leak** on light
yellow, and **观察信息 / Observation** in green on light green for \`information\`. Display labels
do not change the underlying dispositions or confirmed-leak counts.
Use **泄漏 / Leak** consistently in titles, labels, summaries and markers for \`confirmed\`.
When a finding heading has a matching status pill, remove the repeated terminal status and its
separator from the displayed title: \`sharedData 保活页面回调，泄漏\` becomes \`sharedData 保活页面回调\`,
and \`GC Atom 字符串：已知非泄漏\` becomes \`GC Atom 字符串\`. Apply the same rule to English and
child headings that have a status badge. Keep the badge and confidence; preserve original finding
titles, translation keys, conclusions and meaningful status words within the title body.
Source-table **泄漏 / Leak** badges do not promote a finding's actual disposition to \`confirmed\`.
Use **疑似泄漏 / Suspected leak** for \`suspected\`.
The **高置信度 / High confidence** badge uses blue text on a light-blue background; it indicates
confidence only, not a problem or leak.

- \`debugger\`: native \`[debugger]\` aggregates debugger allocations; ignore them.
- \`builtin-function\`: verified native intrinsics held by rooted context prototypes/constructors,
  such as Object.valueOf and Array.indexOf. Include their exclusively owned property storage/name
  strings, not arbitrary Function objects or descendants.
- \`object-shape\`: engine object layout metadata; ignore it.
- \`gc-atom-string\`: **GC only**, one raw non-weak holder, \`atom_array\`. Explain the GC implementation,
  measured KiB, temporary exemption and reuse on the next load. RC/unknown never use this exemption.
- \`vm-current-app-id\`: string exclusively held by the rooted VM global's \`currentAppId\` and its
  exclusively owned property storage (atom bookkeeping allowed). Verify \`jscontext → global_obj\`;
  reject other business holders or same-named properties on ordinary objects. Next page load
  replaces the VM-wide value and releases the previous string. Applies in GC, RC and unknown mode.
  Do not extend this rule to other VM caches without verified replacement/release contracts.

A string with another holder does not qualify from that snapshot alone. For the same-page sequence,
the analyzer can preserve an earlier atom-only match for a unique value of the same slot/size when
later additional holders all belong to other slots. Cite \`reused_values\` and the earlier observation;
do not claim object identity from IDs or exempt strings without that prior evidence.
Use the disjoint shallow bytes in \`snapshots[].residual.rules\`; preserve raw totals and unclassified
targets. Unmatched objects require separate analysis and are not automatically leaks.
Brief bilingual reasons and ignorable bytes belong in the outer report, outside leak candidate counts.

## Result import and rerender

Create this JSON manifest beside the analyzer results. Relative paths resolve against this manifest.

\`\`\`json
{
  "schemaVersion": 1,
  "translations": {
    "<original finding title>": {"zh": "<Chinese title>", "en": "<English title>"},
    "<original finding conclusion>": {"zh": "<Chinese conclusion>", "en": "<English conclusion>"}
  },
  "pages": [{
    "analysisId": "<residualAnalyses[].id>",
    "inputDigest": "<residualAnalyses[].inputDigest>",
    "analyzerVersion": "<actual analyzer revision or script hash>",
    "rulesVersion": "none",
    "evidencePath": "instance-1-final.json",
    "reportPath": "instance-1.html",
    "decisions": [{
      "findingId": "<analysis.findings[].id>",
      "disposition": "suspected",
      "confidence": "medium"
    }]
  }]
}
\`\`\`

Every finding requires exactly one explicit disposition: \`confirmed\`, \`suspected\`, \`retained\`, \`excluded\`, \`known-non-leak\`
or \`information\`. This classification is an analyst decision supported by the finding text, never a
counter threshold or automatic statistical verdict. Use \`information\` for observations without an
established retention finding; these do not establish absence of leaks.

Supply \`translations\` for every original finding title, conclusion, limitation, analyzer gap,
exclusion reason and optional \`leakSizeBasis\`. Each exact source string maps to \`{zh, en}\`; entries can
be shared across pages. Missing or empty translations are rejected during import. Preserve object names,
numbers, evidence references and conclusion strength in both languages. Translations are presentation
data and never overwrite the analyzer's original findings. They also drive confirmed-issue text and
leak-size tooltip text, so these remain consistent with the residual cards.

\`excluded\` additionally requires \`exclusion: {ruleId, version, reason, evidenceRefs}\` with pointers into
the finalized evidence. Rules come from the user; do not invent business exemptions.
\`known-non-leak\` uses the same exclusion object plus \`bytes\`, with a supported rule ID/version and
a reference to the latest \`/snapshots/N/residual/rules/M\`. Its bytes must match analyzer evidence.
Set \`rulesVersion\` to \`bts-residual-2\`. Fully covered pages with complete observations show
“Known non-leak”; remaining gaps keep their actual status.
Optional \`leakBytes\` requires confirmed findings and a \`leakSizeBasis\` describing non-overlap and bounds.

\`\`\`bash
node <skill-dir>/scripts/trace_query.bundle.cjs --source-preparation "<work-dir>/source-preparation.json" memory-report \\
  --data "<delivery-dir>/analysis.json" \\
  --residual-results "<work-dir>/residual-results.json" \\
  --output "<delivery-dir>"
\`\`\`

The API validates input digests, finalization, latest valid snapshot hash, findings, pointers and
versioned exclusions before modifying results. Each import replaces that page's earlier findings.
When rules change, reanalyze affected pages, regenerate both finalized evidence and HTML, then import
the replacements. Confirmed markers, issue counts and exclusions are rebuilt; no implicit cache reuse.
Partial imports leave other page states unchanged and visibly incomplete where applicable.
Unavailable/failed analyzer work can be recorded as
\`failures: [{analysisId, inputDigest, error}]\` alongside \`pages\`, with a translation entry for \`error\`; it clears that page's stale findings
and shows the failure without stopping other pages.

## Report and delivery

Deliver the **whole directory**, keeping \`report.html\`, \`analysis.json\`, \`residual-results.json\`,
per-page HTML/evidence JSON, extracted \`snapshots/\`, the source Trace and \`assets/\` together.
The directory can be moved or compressed later; no automatic archive or external publication is needed.
The master report embeds per-page HTML and offers a standalone child-report download.
The master report also embeds the Trace's extracted heap snapshots as inert JSON for offline inspection.
The original Trace remains a separate file in the directory. No automatic upload is performed.

Issue/finding links identify evidence snapshots through validated JSON pointers and snapshot hashes.
Representative object labels link directly to selected nodes and their Retainers, including zero-size
holders omitted from class summaries. The viewer checks the node ID at the supplied ordinal before
selection. Both report languages preserve these links; labels absent from translated prose appear on
a separate representative-object line. Opening the panel reserves the report's scrollbar gutter.
Clicking opens the shared Trace UI snapshot panel over the right side of the report. The viewer reads
the embedded snapshots and reuses the existing object, reference,
Retainers, comparison and download interactions. Click the uncovered left area, Close, or Escape to
collapse it. Metrics-only issues have no invented object-evidence link; zero-byte clearing metadata
has no heap graph. Snapshot sequence rows also link to captured profiles.
Embed the viewer shell with a same-origin \`srcdoc\` iframe and load its runtime assets from \`assets/\`.
A separate file:// HTML iframe has a different opaque origin and cannot open save-file or directory
pickers. Verify single-snapshot saving, directory export, cancellation, and ordinary download fallback.

Double-clicking \`report.html\` works offline without selecting a Trace or starting a local server.
Generation verifies the source Trace SHA-256 and existing snapshot hashes, and extracts missing
snapshot files from the Trace with chunk, length and JSON validation. Failed or metadata-only captures
show an explanation instead of an object graph. Embedded data is escaped and loaded into the viewer
only on first use; it is not duplicated in \`analysis.json\`. Runtime code and fonts stay in \`assets/\`;
the report does not include or require a Perfetto WASM Trace processor.
Rerendering legacy JSON without \`artifacts.trace\` requires \`memory-report --path "<source-trace>"\`.

Default Chinese with English toggle. Page and VM headings collapse charts and results. Shared VM name
filters span all generations, page cards, residual cards and issues, updating visible issue/page/confirmed/
suspected/incomplete counts. Language changes and folding preserve filters and chart legend selections.
Use eight peer sections: notes, page instances, abnormal MTS VM pool attribution, shared BTS VM slot
memory, BTS post-exit residual analysis, optional Graphic memory analysis (only with global Krypton tracks),
JS heap snapshots, and conclusion.
Eligible page cards include Graphic areas and Canvas resource counts. Global Graphic headings also collapse;
its process curves stay global while its Graphic-page Shell bubbles follow page visibility.
Omit the Further analysis heading.
A sticky left contents navigator follows this order, with creation-ordered Page 1/2/... children and
actual instance IDs under residual analysis. Clicking expands the target card and scrolls to it;
highlight the current reading position and support direct hashes and browser history. Keep page
numbering stable when filtering; hide filtered page/residual entries while retaining section entries.
Translate navigation labels with the report. At widths <=1000px, use a collapsed sticky menu above
the report; collapse it after navigation and keep the target heading unobscured.
Verify the main report in both languages, including dynamic findings, limitations, gaps, exclusion
reasons, capture reasons and integrity labels, rather than checking only headings and navigation.

For specific user-selected snapshots, resolve the VM-generation-local 1-based number to a unique ID,
then extract it:

\`\`\`bash
node <skill-dir>/scripts/trace_query.bundle.cjs --source-preparation "<work-dir>/source-preparation.json" memory-snapshot \\
  --path "<trace>" --snapshot-id "<id>" --output "<work-dir>/selected.heapsnapshot"
\`\`\`

Finish with the directory and entry report links, key measurements and actual conclusion strength. Distinguish general
memory issues, confirmed leaks, findings needing verification and unavailable evidence. A completed
statistical check with no issue does not prove all residual objects are released.`,
};

export default prompt;
