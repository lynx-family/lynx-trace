---
name: frontend-sources
description: Prepare frontend sources and independently supplied artifacts, diagnose mismatches, and map Trace locations through generated JS to the specified source project.
---

# Caller checkpoint

For memory analysis, use [source-preparation](./source-preparation.md) at entry and final delivery.
An analyzer preflight reporting a real conflict must return to the frontend failure loop below.
Do not convert `unresolved`/`skipped` into the user's decision to continue without artifacts.

# Frontend sources and the analysis prerequisite

First load [source-inputs](./source-inputs.md). Business sources accept a complete Git URL, a commit
hash, a branch name or an existing local directory, including URL/path plus a revision. Resolve a bare
commit/branch against its identified repository; ask for the repository if missing or ambiguous.
Briefly state the resolved project and build action; ask only for missing inputs or actual failures.

Treat **source project** and **generated artifacts** as independent inputs. Either may be local,
in a Git repository at a specified revision, or acquired from an explicit download/archive URL.
Do not assume co-location, matching repository identities or shared revisions. A download URL is
not a Git URL and does not require a branch/commit. Ask only when the role or project association
is ambiguous. Acquire supplied artifacts as-is and preserve their bytes and filenames.

When the user supplies frontend projects, apply this workflow **before any Trace download, processor
initialization, metadata query or analysis**. It applies to all analysis scenarios, not only memory.
Reading project instructions and preparing builds are allowed before the prerequisite is satisfied.
The sole exception is the [Lynx version preflight](./lynx-sources.md): memory analysis may read
`LynxEngineVersion.version` before this gate to resolve public runtime builds automatically. That exception permits
no memory/heap analysis. With no frontend project supplied, still apply the Lynx source selection step
for memory requests.

## Prepare every project

1. Inventory all supplied pages/projects and their separately supplied artifacts; assign a stable
   project ID and retain both original locators, resolved paths and any requested/resolved revisions.
   Expand relative/home paths and
   resolve revision-only inputs using the source-input contract. Several pages may share one repository.
2. **If artifacts were explicitly supplied, do not install dependencies or build the frontend by
   default, even when its source is a remote Git repository.** Read project instructions/config,
   acquire the specified JS/maps, and go directly to preparation and matching. Do not substitute
   local `dist`, cached outputs or a rebuild if these inputs fail. Use the recovery loop below.
   Otherwise, only for an explicitly supplied local project path, inspect its README, project instructions, package manager/lockfile and build
   configuration. If the user requests a rebuild, build fresh outputs; otherwise reuse complete outputs when valid or install/build using those
   instructions, including sourcemap generation. Preserve existing user changes.
3. For a git project, use a new empty directory for this analysis, clone/fetch the remote and check out the requested
   branch/commit. Record `git rev-parse HEAD`, origin and the requested ref. Build from that checkout
   only when no artifacts were supplied (or the user explicitly requests a replacement rebuild).
   Do not inspect local repositories, reuse checkouts/worktrees or look for cached builds/maps/manifests.
   A matching local HEAD is not an exception. Save acquisition, installation and build commands,
   exit statuses and full logs in the preparation ledger required by source-inputs.
   Do not assume the default branch or use a different revision after a failure. If ref is missing,
   resolve it with the user before proceeding. Do not publish or commit build fixes.
   For hosts other than GitHub/GitLab, use the provider's supported CLI/docs to verify a source-file
   permalink and record `origin.linkTemplate` before presenting the artifact list. Do not leave a
   supplied git project with an unknown link format when a verified template can be obtained.
4. For source preparation (not explicit-artifact recovery below), on any clone/fetch/checkout,
   dependency installation or build failure, error or timeout,
   **immediately pause the analysis** and follow the source-input contract. Name the failed business
   project and phase and show the concrete error and logs. For Git acquisition failures, ask for
   the exact git URL/ref and other acquisition methods; keep resolving until usable source arrives,
   the user explicitly abandons that project or explicitly aborts analysis. Do not force skip/abort.
   For dependency installation/build failures, ask only **终止整个分析流程** or
   **跳过当前失败的对应源码，继续使用其余可用的代码完成后续分析**, then wait for the explicit choice.
   Do not silently repair/retry, skip, terminate or accept partial outputs. Continue only under the
   phase-specific user response, until every remaining active project has valid outputs.
   A later source failure requires a new interaction appropriate to its phase.
5. Write the JSON below and run `frontend-prepare`. A normal RSpeedy output is `dist/.rspeedy/main/`
   (or another named entry). This includes
   hashed names such as `background.a3deaafc.js`. `main-thread.js`, `debug-info.json`, CSS and bundle
   metadata can also exist; debug-info is not a BTS sourcemap. For locally built/reused outputs, the
   validator recursively discovers nonempty JS/v3 sourcemap pairs in `outputDirs`, including hidden
   `.rspeedy` directories. For explicit prebuilt inputs, list `artifactFiles` instead: each entry has
   a `script` and optional `map` path; these can be in different directories. This list replaces
   output scanning. Without an explicit map, inline or adjacent `<script>.map` is discovered;
   otherwise JS-only preparation succeeds with a generated-only warning. An explicitly named
   missing/invalid map is a preparation failure, not a silent JS-only fallback.
6. Record **every project, source locator/path/ref/commit, separate artifact locator/ref/commit when
   applicable, acquisition logs, generated JS/map paths and hashes**, warnings and explicit
   abandonments. Record missing maps explicitly. After successful preparation, continue
   automatically. Do not ask whether the artifacts should be used or expect the user to judge whether
   a sourcemap matches the Trace; the Skill validates that using snapshot evidence later.
7. Pass `--frontend-manifest` on **every** subsequent Trace CLI invocation. Source/build/selector
   changes require `frontend-prepare` again and invalidate location caches, not user approval.
   `frontend-confirm` is optional legacy bookkeeping and is not part of this workflow.
   For memory requests, also complete [Lynx preparation](./lynx-sources.md): a resolvable Trace tag
   leads directly to acquisition/build without a consent question.
8. After extracting snapshots, inspect filename/binding, JS/map pairing, `sourcesContent` and recorded
   offsets. A changed generated hash is not something the user can approve away: retain the actual
   new filenames and inspect the mismatch. Never rename an artifact or invent a frontend alias to
   force a match. On a real mismatch, inspect the project configuration and apply the three-choice
   recovery loop below. Exclude conflicting source evidence until resolved or explicitly abandoned.
   Unreferenced outputs, missing location metadata and unmapped generated code are evidence gaps,
   not by themselves proof that the supplied build is wrong.

```json
{
  "version": 1,
  "projects": [
    {
      "id": "local-page",
      "root": "/absolute/local/project",
      "outputDirs": ["dist"],
      "scriptPrefixes": ["file://view3/"],
      "origin": {"kind": "local"}
    },
    {
      "id": "git-page",
      "root": "/absolute/cloned/repository",
      "outputDirs": ["dist"],
      "origin": {
        "kind": "git",
        "url": "https://github.com/owner/repository.git",
        "ref": "release-branch"
      }
    },
    {
      "id": "prebuilt-page",
      "root": "/absolute/original/project",
      "artifactFiles": [
        {
          "script": "/absolute/downloads/background.captured.js",
          "map": "/absolute/separate-maps/background.captured.js.map"
        }
      ],
      "artifactOrigin": {"kind": "url", "locator": "https://example.com/captured-build.zip"},
      "origin": {"kind": "local"}
    },
    {
      "id": "dropped-page",
      "root": "",
      "abandoned": {"reason": "User explicitly dropped this project after build failure", "userConfirmed": true}
    }
  ]
}
```

`root` is always the original source project and resolves relative to the config; `outputDirs`
resolve relative to that root (absolute external directories also work). `artifactFiles` paths resolve
relative to the config, not the source root; preparation normalizes them to absolute paths. Keep
source `origin`/resolved commit separate from `artifactOrigin` (`kind`: `local`, `git` or `url`;
`locator`, and Git `ref`/resolved `commit`). The Agent verifies acquisition provenance; the CLI
fingerprints the acquired files. Never use the artifact repository's commit for original-source links.
Omit `map` for a JS-only input; do not invent a map or use one from a different build.

`scriptPrefixes` is optional:
use exact runtime URL prefixes only when known from the user/capture setup, especially when projects
have identical generated filenames. Do not infer a page from a Function name. Unresolved ambiguity
remains visible in the report and never selects an arbitrary project.
For several entries in one repository with identical script names, register separate project IDs
with their own entry `outputDirs` and known runtime prefixes.

```bash
node <skill-dir>/scripts/trace_query.bundle.cjs frontend-prepare \
  --config /absolute/frontend-projects.json --output /absolute/frontend-manifest.json
# Continue immediately with the prepared manifest; no artifact approval step.
node <skill-dir>/scripts/trace_query.bundle.cjs --frontend-manifest /absolute/frontend-manifest.json \
  --source-preparation /absolute/source-preparation.json \
  memory-analysis --path "<trace>" --output "<delivery-directory>"
```

The CLI checks fingerprints before starting its Trace processor; snapshot binding checks run later.
Clone/build, inspecting binding failures and asking about a real mismatch are Agent responsibilities.
If the user explicitly abandons all projects, retain those records and proceed with Trace evidence.

## Frontend mismatch diagnosis and artifact recovery

This section overrides the generic two-choice source failure rule for **frontend artifact
mismatches and failures while obtaining/validating explicitly supplied frontend artifacts**.
It does not change the Lynx runtime workflow or the ordinary frontend dependency/build-failure rule.

Before asking for a decision, show the binding evidence: Trace script URL, actual JS/map paths and
hashes, function-position matches/conflicts with the counting unit, and source-content discrepancies.
Filename hash differences alone do not prove byte or position differences. When comparison data is
available, compare generated bytes/lengths and offsets; distinguish changed code, shifted prefixes,
map/footer differences and an unproven mismatch. Do not rename files or loosen checks to force binding.

Inspect the supplied project's actual config, imported config modules and build scripts. Follow the
values and conditional branches that can change generated output, including:

- `process.env`, `.env*`, CLI flags, `NODE_ENV`/mode and dev/prod branches.
- `ASSET_PREFIX`, `assetPrefix`/`publicPath`, URL/runtime prefixes and injected bootstraps.
- `define`/replacement constants, platform/target, minifier, sourcemap mode and output naming.
- Lockfile/toolchain/plugin versions and config imports where they affect the observed difference.

Report **config file:line → variable/condition → known current value and selected branch → possible
generated-code/offset effect → capture-time value/evidence or unknown**. Cite available build logs,
maps and generated code; label plausible causes as hypotheses. Redact secret values. The current
shell is not evidence of the capture-time build environment. If no config cause is established,
say so and list what evidence is missing. For example, a conditional public path may change an
injected string and shift later byte offsets despite identical business `sourcesContent`; report
this only as confirmed when the actual artifacts/config support it. Do not auto-edit config or
rebuild explicitly supplied artifacts while diagnosing.

Then pause and offer these three actions (none is the default):

1. **终止整个分析流程** — stop and retain diagnostics; no completed-report claim.
2. **放弃对应前端产物辅助，继续分析** — remove only that project's conflicting artifact/map/location
   evidence and caches, record the user's actual response and attribution limits, and continue with
   Trace/heap evidence and other validated sources.
3. **提供明确的产物地址** — accept a local directory/file, Git URL plus ref, or downloadable JS/map/archive
   URL. Retain the already specified original source project unless the user explicitly changes it.

On action 3, acquire the new input, record provenance and hashes, rerun `frontend-prepare` and the
same Trace matching checks. A matching input continues analysis automatically with no approval.
If it still mismatches or cannot be obtained/validated, update the evidence/config diagnosis and
ask the same three-way decision again. **Repeat until matched, explicitly aborted, or explicitly
continued without the affected artifacts; never impose a retry limit or infer opt-out from silence.**
A corrected locator authorizes another acquisition/check, not a skip. Invalidate prior source
results, including serialized results in a draft report, before rerendering with new or abandoned inputs.

## Independent source and artifact mapping

For “前端工程在 `xxxx`，产物已构建好，在 `yyyy` 下载，开始分析”:

1. Resolve/acquire `xxxx` as the original source root and download/extract `yyyy` as the supplied
   artifact set. Do not build `xxxx` by default.
2. Bind the Trace script URL/location to the exact supplied generated JS and validate the recorded
   positions. Convert a snapshot UTF-8 byte offset using those JS bytes to generated line/UTF-16 column.
3. Use that JS's matching map to find original source coordinates, then resolve the map path inside
   `xxxx` using unique suffixes and matching `sourcesContent`. Leading `../` and build-machine
   absolute paths may be rebased safely; ambiguous, escaping or content-mismatched paths remain unavailable.
   Never use files in the download directory as the original project merely because the map is there.
4. Link original source to `xxxx` (or its verified source Git commit) and generated code to the acquired
   JS file. JS-only input can supply generated location/excerpt after validation; without a matching
   map it cannot supply original coordinates. This does not force a rebuild; apply the binding decision below.

## Generated-only frontend locations

At source binding, if the user supplied the frontend project and a business location **used in this
analysis** resolves only to generated JS, name the script/location and explain the gap (e.g. the JS
was retrieved but its map returned 404, or the map has no segment for this position). Ask whether to
**provide the matching sourcemap or release artifacts** or **continue at generated-JS precision**, and
wait. This applies to any investigation, before a leak verdict exists. A script listed in the inventory
but not used in the analysis does not trigger the question.

Validate supplied replacements against the recorded JS and original project; continue automatically if
the location maps. If the user accepts generated-only precision, keep the verified JS location, record the
affected scope and the user's words, and do not ask again for that scope. Text matches remain `unverified`.
Obtaining JS from the deployment URL is not acceptance. A conflicting build or an explicitly supplied
artifact that fails validation still follows the three-choice mismatch recovery above.

## Snapshot source positions

- `snapshot.meta.location_fields` defines the layout; do not hardcode record widths.
  `object_index` is an offset in the flattened `nodes` array, so divide by `node_fields.length`.
- PrimJS `primjs_sources` v1 has `fields: ["script_id", "name"]`; `scripts` is a flattened table,
  and `name` indexes snapshot `strings`. Scope script IDs to each snapshot.
- The snapshot mode dropdown includes **Scripts** in both Trace and report viewers. Show Script ID
  and full name in table order, with filtering by name or ID. Read only `primjs_sources`, including
  entries with no object location; retain equal names with different IDs. Skip invalid rows and show
  an empty state for absent, unsupported or empty tables without affecting object browsing.
- **Raw** displays the original snapshot as an indented JSON tree, including unknown fields, with
  `+ / −` node toggles. Open the top level initially, page large containers by 100 entries, and let
  users expand truncated string previews to their full values. Parse JSON on demand in the worker,
  send only requested nodes, and release the parsed raw data when leaving this mode.
- PrimJS `source_offset` is a **zero-based UTF-8 byte offset into generated script text**.
  Convert it with the exact generated JS to a one-based generated line and zero-based UTF-16 column,
  then use the v3 sourcemap. Chinese text, emoji and newlines make direct use as a column invalid.
  `sourcesContent` contains original source, not generated script. In general a sourcemap alone cannot
  convert byte offsets; it suffices for trace events that already carry normalized generated line/column.
- Resolve every node with actual location metadata, including Function/closure and code/bytecode nodes;
  do not filter by heap type or display name. Equal script positions reuse the same cached result.
  Missing names, unmatched builds, source-content mismatch and ambiguous projects are reported as
  unavailable, not guessed.
  Legacy heaps without locations remain fully browsable. V8 line/column locations can be displayed,
  but absent script-name metadata cannot be invented.
- The generated frontend script filename (including hash) must match the runtime URL. Public Lynx scripts
  use [verified runtime aliases and variant selection](./lynx-sources.md), including inline dev maps.
  A stale `map.file`
  is a warning requiring build-pair verification, not proof of identity or an automatic rejection.
  User confirmation cannot establish that an unrelated map is correct: compare mapping points,
  sourcesContent and the recorded build provenance when there is a discrepancy.
- Local source matching uses a unique suffix within the project and validates `sourcesContent`.
  A build-machine path such as `file:///tmp_wrkspc/.../Project/src/App.tsx` can resolve to local
  `src/App.tsx`. Dependencies in `node_modules` are not attributed to app repository files.

Clicking a report object link first opens the correct snapshot, validates node ID/index and selects
and expands it. A node with a location also displays its source result automatically in the
details/Retainers area. Every located snapshot node has a blue link: show `file:line:column` when
original source is resolved; otherwise show the last path segment of the runtime script (such as
`krypton.js`), excluding query/fragment and decoding URL escapes. Use **Source** only when no script
filename is known. Apply the same labels in object rows and retainer trees. A script-name label does
not imply its local artifact or original source is available.
The source panel displays layers from original source to VM-loaded code, pairing each source link
with its own excerpt: **original path:line:column → original excerpt → runtime URL + byte offset →
generated JS excerpt**. Do not add a `Source ·` heading or repeat the runtime path above its
URL/offset row when original source is unavailable. Keep the existing node label and original link coordinates.
When only generated JS can be located, show its runtime URL/offset and excerpt first, then the
diagnostic explaining why original source cannot be located. Place the **Generated JavaScript ·
line:column** metadata after the excerpt and any diagnostic; do not interleave one file's link with
another file's excerpt.
The current resolver performs one sourcemap lookup and stores two layers. A composed map can point
through multiple compilation stages directly to the final source; separate maps are not recursively
followed, and intermediate stages are not retained or displayed.
For a resolved source, draw a rounded connector in the left gutter from the center of the generated
path row upwards to a right-pointing arrow at the center of the original path row. Keep the connector
aligned when paths wrap or the panel resizes; do not draw a mapping arrow when the target is unresolved.
Keep it secondary to the source text: short 8px horizontal spans, a 1px stroke, small arrowhead and
corners, and a muted color at 60% opacity.
Source paths and both excerpts wrap naturally without an internal height limit or scrollbar.
The source details and retainer tree share one scrollable body with hidden scrollbars in both
Summary and Comparison views; wheel, touch and keyboard scrolling keep all content accessible.
Always retain the generated excerpt when its script and byte offset are valid, including successful
original-source mappings. The excerpt contains up to 80 Unicode code
points before the byte offset and 160 after it, highlighting from that exact offset. Truncated ends
are marked with ellipses. Invalid offsets or ambiguous/missing artifacts do not produce guessed text.
For a uniquely matched local generated JS with a valid position, the displayed runtime URL (such as
`file://view4/.rspeedy/main/background.a3deaafc.js`) is also a link to the actual local JS file with
its generated one-based line/column anchor, even when no original-source mapping exists.
Local links use `file:///...#L<line>:<column>`; browsers may restrict opening them, so the absolute path,
one-based line/column and embedded excerpts remain available offline. Git links use the **resolved
commit**, even when input was a branch, so later branch movement does not change the evidence.
GitHub and GitLab are supported directly. Other hosts require a verified `origin.linkTemplate`,
for example `"{repo}/blob/{commit}/{path}#L{line}"`. Placeholders include `repo`, `commit`, `ref`,
`path`, `line`, `column`; verify the provider's real URL format instead of guessing.

Resolved source excerpts and diagnostics persist in `analysis.json`, bound to each snapshot SHA-256.
`lynx-source-location-cache-<digest>.json` in the OS temporary directory caches successes and failures
by manifest fingerprint and raw position, keeping rebuild caches out of the delivered report;
source/build/selector changes or a resolver cache version upgrade invalidate it.
Both new analysis and offline `memory-report --frontend-manifest ...` accept prepared sources without
user confirmation and revalidate their fingerprints. Inspect new binding results for mismatches before
source-assisted conclusions. A rerender without the manifest retains the prior source evidence.
