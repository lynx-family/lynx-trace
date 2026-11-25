// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { Prompt } from '../../types/prompt';

export const prompt: Prompt = {
  name: 'lynx-sources',
  description:
    'Select the requested Lynx revision, build public runtime scripts and maps before memory analysis, and verify snapshot offsets against core prod/dev and Krypton variants.',
  prompt: `# Lynx runtime source preparation

Apply this step to every memory analysis, independently of whether frontend repositories were supplied.
**Resolve and build public scripts automatically unless the user has explicitly opted out.**
Public runtime maps and frontend maps participate in the same snapshot source resolver, while their
preparation records remain separate. Neither successful build requires an artifact approval step.

First load [source-inputs](./source-inputs.md). Lynx sources accept a complete Git repository URL,
a commit hash, a branch name or an existing local code directory, including URL/path plus a revision.
Briefly state the resolved source and next action; ask only for missing inputs or actual failures.

## Internal and OSS

| Repository | URL | Lynx source root |
| --- | --- | --- |
| internal | \`https://code.byted.org/lynx/template-assembler\` | \`<checkout>/lynx/\` |
| OSS | \`https://github.com/lynx-family/lynx.git\` | \`<checkout>/\` |

**OSS root corresponds to internal's \`lynx/\`. Trace events and analysis capabilities are identical
for internal and OSS.** Use the same query, memory/snapshot and reporting rules, subject to the
evidence recorded in the Trace. Repository choice changes source acquisition, paths and available
build components; it does not change Trace interpretation. Commits/tags, generated JS/maps and
snapshot offsets are not assumed interchangeable.

**Resolve and retain \`internal\` versus \`OSS\` when selecting the repository, before building.**
Preserve an explicitly selected URL/local path. Otherwise, resolve a Trace-derived version tag or
user-provided version/commit/branch by querying Git remotes using the procedure below; **do not ask
the user to choose internal/OSS or supply a repository URL just because it is missing**.
**When the internal Git URL is accessible, select internal.** This remains true when OSS is also
accessible or advertises the same ref. Verify origin and the requested commit in the fresh checkout
and retain the classification and remote evidence in the preparation ledger.
Entering an internal checkout's \`lynx/\` subdirectory does not turn the selected SDK into OSS.
An explicitly supplied local path follows the same classification using its actual Git root/origin.

## Automatic remote repository resolution

Run this procedure when preparing runtime sources, unless the user has already
selected a URL/local path. A later commit input reuses an established repository; it does not require
another repository question. Never inspect local repositories or cached objects for this resolution.

1. Probe \`https://code.byted.org/lynx/template-assembler\` with
   \`GIT_TERMINAL_PROMPT=0 git ls-remote "<internal-url>" HEAD\`, saving the command, exit status and
   stdout/stderr. A successful remote query establishes accessibility independently of whether the
   requested tag/branch/commit exists. **Accessible internal always selects internal**; do not probe
   OSS to choose a better ref match or ask the user to confirm this classification.
2. Only if the internal availability probe fails, record the actual access/authentication/network
   error and probe \`https://github.com/lynx-family/lynx.git\` the same way. If OSS is accessible, select
   OSS and verify the requested revision there. This initial internal probe failure is an expected
   selection outcome: continue to the OSS probe without a user question or the preparation-failure
   pause. If neither remote is accessible, report both logs and enter acquisition recovery for the
   actual access blocker; do not ask the user to guess which repository family applies.
3. Resolve the requested revision **in the selected repository**:
   - For a usable Trace/user version, first form \`A_<version>\` and query the exact
     \`refs/tags/A_<version>\` and \`refs/tags/A_<version>^{}\` refs with \`git ls-remote --exit-code\`.
     Retain the peeled commit for an annotated tag. This is the internal tag convention; for OSS,
     use its actual remote release/tag records to establish any different version-to-ref mapping,
     preserving the original version and the mapping evidence. Do not invent an equivalent tag.
   - For a branch, query the exact \`refs/heads/<branch>\` and record its full commit.
   - \`git ls-remote\` does **not** enumerate every commit. A hash absent from advertised refs does
     not prove the commit is missing or belongs to OSS. Verify it with a depth-one fetch in a new
     empty checkout of the selected remote, then \`git rev-parse 'FETCH_HEAD^{commit}'\` and a detached
     checkout. Resolve short hashes to a unique full commit from verifiable remote evidence before
     fetching; if that cannot be established, report the unresolved revision, not an unknown family.
4. Keep repository accessibility separate from revision availability. If internal is accessible
   but the requested ref is missing or cannot be fetched, **retain internal and report that exact
   ref failure; never fall back to OSS**. Missing/ambiguous refs and failed acquisition use the
   existing recovery workflow for a corrected revision/access method, not a repository-choice
   question. Likewise, do not silently substitute a branch, version or another commit.
5. Record the selected URL/kind, availability and ref-query results, original version/requested ref,
   resolved full commit and complete logs. Reuse the checkout freshly fetched in this attempt for
   the build; it is not an old cache. Verify origin/HEAD before choosing the build entry below.

## Select the revision and continue automatically

**Trace-derived versions must be at least \`4.5.0\`.** The relevant Trace memory-analysis capabilities
were introduced in Lynx 4.5. Any recorded version below \`4.5.0\` is invalid **even if \`A_<version>\`
or an OSS equivalent tag exists**. Treat it exactly like a missing tag: explain the minimum-version
failure and request usable Lynx source/revision input, keeping preparation pending until resolved or
explicitly opted out/aborted. Do not probe/build that tag to override the invalid result, silently
upgrade to \`4.5.0\`, or substitute another page's valid version. Compare semantic version components
numerically (\`4.10.0\` is above the floor; \`4.5.0\` is included; \`4.5.0-rc.1\` is below it).
This rule applies to metadata-derived selection; explicit user-selected sources/revisions retain priority.

1. A user-specified Lynx **repository URL/local directory and version, commit or branch win**.
   Resolve a bare version/commit/branch in the already identified repository, or apply automatic
   remote resolution above without asking for internal/OSS or a URL. A URL without a revision requires clarification; a
   local directory without a revision uses its current tree and records its identity/source hashes.
   Do not replace explicit inputs with Trace metadata. If selectors conflict or a local revision
   cannot be identified, ask for the missing selection before preparation. An explicit selection
   authorizes preparation for this analysis; record the request and do not ask the same question again.
   Likewise, reuse an explicit acceptance/refusal already given for this analysis; do not re-ask an
   unchanged decision. Resolve any still-missing source/revision on acceptance.
2. When no runtime source/revision or explicit decision was supplied, run the preparatory command below.
   It reads only \`LynxEngineVersion\` and its \`version\`
   argument (including Perfetto's \`debug.version\`/\`args.version\` key prefixes).
   This metadata preflight is allowed before frontend preparation; complete the required source
   builds before memory analysis. Paths to analysis tools or frontend projects are not runtime sources.
3. Apply the minimum-version rule first, then resolve eligible candidates using the remote procedure above:
   - One usable version: form its tag, verify the exact remote ref and full commit, then acquire
     and build \`lynx_core.js\`, \`krypton.js\` and other applicable public scripts automatically.
     Do not ask whether to build or use the artifacts, even when their names/hashes have changed.
   - Missing tag, missing/local/invalid version, or any Trace version below \`4.5.0\` (even with an
     existing tag): report the version and actual validation/remote evidence, then ask for a Lynx
     source locator/revision. For a below-minimum version, the local validation is sufficient; do
     not claim that a remote query found no tag. Do not substitute a sample commit
     or treat an unresolved version as refusal.
   - Multiple versions: use recorded process/page identity to disambiguate when possible; if the
     requested scope still has no unique revision, ask for the unresolved source/revision only.
     Never take the first candidate silently or add a separate build-consent question.
4. Retain the actual selection evidence: explicit user input or Trace event/version, verified tag,
   remote query and resolved commit. Automatic resolution is not user approval. Complete the
   component ledger and builds, then continue with snapshot extraction and source matching.
   Honor an explicit refusal by recording the gap and continuing with remaining sources.
5. For a fresh Lynx checkout's initialization, dependency sync/install or build failure, inspect
   shell/toolchain/environment factors and retry once automatically as specified in source-inputs.
   Ask **放弃 Lynx 源码辅助继续分析** or **终止整个分析流程** only if that retry cannot complete.
   Initial clone/fetch/checkout failures use the acquisition recovery loop for the actual missing
   revision/access information. Do not confuse a dependency fetch inside bootstrap with initial
   repository acquisition.
6. After public scripts build successfully, continue even if clone/bootstrap/build generated tracked
   changes or temporary files. No clean-tree check, cleanup, commit or user confirmation is required.
   Source-map and snapshot matching still run later; a real mismatch requires the same skip-source
   or abort decision after explaining the evidence.

\`\`\`bash
node <skill-dir>/scripts/trace_query.bundle.cjs lynx-source-version --path "<trace>"
# Explicit input skips Trace access, including invalid local-build version metadata:
node <skill-dir>/scripts/trace_query.bundle.cjs lynx-source-version --lynx-commit "<commit>"
# Alternatives: --lynx-version "<version>" or --lynx-branch "<branch>"
# If the selected repository uses another verified version tag/ref:
node <skill-dir>/scripts/trace_query.bundle.cjs lynx-source-version \\
  --lynx-version "<version>" --lynx-version-ref "<verified-tag-or-commit>"
\`\`\`

The command returns revision metadata and the remote-resolution instructions; it does not execute
Git or establish remote accessibility. The Agent must perform the automatic probes above when no
explicit locator exists, without asking the user to choose a repository. Its default \`A_<version>\`
refs for eligible candidates require remote verification and are not universal tags.
Trace results include \`minimumTraceVersion: "4.5.0"\`; candidates preserve the recorded version and
slice IDs. Invalid entries have \`status: "invalid"\`, \`ref: null\` and \`invalidReason: "below-minimum"\`
or \`"invalid-format"\`; they cannot authorize acquisition. \`status: "candidate"\` only passes local
version validation, not remote tag validation.
Keep the resolved repository/local directory and the selection evidence in the inventory and manifest.

## Shallow checkout and exact build

Use the explicit URL/local directory or the repository selected by the remote procedure.
**\`A_<lynx_version>\` is an internal tag convention**; verify the tag/ref in the selected remote.
For OSS, establish version correspondence from actual remote release/tag records, retaining the
evidence and original requested version. A genuinely unresolved revision enters acquisition recovery;
it does not reopen repository classification. Do not assume cross-repository commit identity.
For remote URL/commit/branch input, acquire the remote into a new empty workspace for this analysis.
Do not inspect local repositories, create a worktree from them, or reuse cached checkouts, builds,
maps or manifests; matching origin/HEAD does not permit reuse. A revision alone never authorizes
local discovery. Resolve a missing Lynx URL through the internal-first remote procedure.
Only for an explicitly supplied local source path, inspect that checkout; preserve its branch and changes and use an
isolated build workspace when needed. Do not clone another repository instead of using the supplied
local source. In the commands below, substitute the user's actual URL and verified tag/branch/commit.

\`\`\`bash
GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 --branch "<verified-tag-or-branch>" \\
  "<git_url>" "<checkout>"
# A branch uses --branch "<branch>". For commits, Git supporting --revision can use:
GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 --revision "<commit>" \\
  "<git_url>" "<checkout>"
# Older Git: init an empty checkout, add origin, fetch --depth 1 origin "<commit>",
# then checkout --detach FETCH_HEAD. Do not clone full history.
# Choose the strategy before acquisition; a failed attempt enters the user recovery loop.
git -C "<checkout>" rev-parse HEAD
git -C "<checkout>" rev-parse --is-shallow-repository
\`\`\`

Inspect this revision's AGENTS/README, workspace files, lockfiles, JS build scripts and native loaders.
Use its prescribed environment/toolchain and locked dependencies. Skip LFS assets initially because
JS builds normally do not need native sample resources; fetch individual required assets if needed.
Do not modify the user's repositories, publish build fixes, or claim a failed build succeeded.
Save logs, requested/ref/resolved commit, platform, feature defines, compiler versions and JS/map hashes.

### Choose the build entry from the repository and SDK consumer

**Repository classification determines the SDK build family. These are not interchangeable ways
to produce a file named \`lynx_core.js\`.** Select the row below before dependency installation, then
verify its wiring in the requested revision's SDK build configuration. Paths are relative to the
selected Git checkout root, not the shell's current directory.

| Selected repository / SDK | Required SDK entry | Workspace and build chain | Generated JS/map directory |
| --- | --- | --- | --- |
| internal \`lynx/template-assembler\` | \`tools/oliver/lynx-kernel/build.py\` | From checkout root: \`@lynx-js/runtime-shared build\` → \`@lynx-js/lynx-core build:lib\` → \`@byted-lynx/kernel build:<platform>\` | \`oliver/lynx-kernel/output/\` |
| OSS \`lynx-family/lynx\` | \`tools/js_tools/build.py\` | From checkout root: \`@lynx-js/runtime-shared build\` → \`@lynx-js/lynx-core build:<platform>\` | \`js_libraries/lynx-core/output/\` |

For iOS in revisions with these files, inspect \`platform/darwin/ios/lynx/BUILD.gn\` and
\`build_overrides/darwin.gni\`: the internal \`prepare_command\` / devtool preparation invokes
\`tools/oliver/lynx-kernel/build.py\`, while OSS invokes \`tools/js_tools/build.py\`. For another platform
or a revision that moved these files, follow its actual SDK packaging/build rule to the JS producer.
Record the evidence file and line, entry script, workspace, package targets and output directory
before building. Do not select an entry merely because its package exists or its command succeeds.

The internal checkout also contains **\`lynx/tools/js_tools/build.py\`**, which builds the standalone
shared/OSS core under \`lynx/js_libraries/lynx-core/output/\`. Its existence is not an alternative to
the internal SDK row. **For an internal SDK, \`@lynx-js/lynx-core build\` alone is incomplete and the
wrong final artifact producer; \`build:lib\` is an intermediate dependency of the kernel build.**
A standalone OSS target within an internal checkout is an exception only when the user explicitly
requests it or the captured SDK's actual consumer rule proves it; record that evidence, do not infer
it from having entered \`lynx/\`. Never run internal kernel paths in a standalone OSS checkout.

Initialize this checkout's toolchain as its AGENTS/README requires. A missing \`buildtools/corepack\`,
node or wrapper is an environment problem, not permission to switch build families. If expanding a
wrapper into direct pnpm steps is necessary, first verify the complete package chain, workspace,
platform, version substitutions and feature environment against that wrapper; retain every stage,
especially internal \`lynx-core build:lib\` and \`@byted-lynx/kernel build:<platform>\`. Calling standalone
core \`build\` is never an equivalent expansion of the kernel wrapper. An actual installation/build
failure still follows source-inputs; do not silently work around it by changing the target.

The following commands show iOS for each family **after its own environment initialization**.
Run only the selected row's commands from that checkout's root and use the captured platform.

\`\`\`bash
# Internal checkout only:
tools/env.sh pnpm --filter @byted-lynx/kernel... install --frozen-lockfile
tools/env.sh python3 tools/oliver/lynx-kernel/build.py --platform ios
# OSS checkout only, using that checkout's documented toolchain:
python3 tools/js_tools/build.py --platform ios
\`\`\`

For OSS, install the locked \`@lynx-js/lynx-core...\` workspace dependencies using its documented pnpm
environment first. The internal command includes \`@byted-lynx/kernel...\` from the root workspace;
installing only \`lynx/\`'s core dependencies does not prepare the internal kernel.

Inspect the map's \`sources\`: the default internal build can stop at untracked
\`lynx-core/dist/*.js\` because \`build:lib\` did not emit TypeScript maps. In that case,
keep the baseline outputs, enable maps with that revision's TypeScript compiler,
then rerun only the final kernel bundler so it consumes the intermediate maps:

\`\`\`bash
tools/env.sh pnpm --filter @lynx-js/lynx-core build:lib --sourceMap --inlineSources
tools/env.sh pnpm --filter @byted-lynx/kernel build:ios
\`\`\`

Keep the same platform/version/feature environment. Verify executable JavaScript is unchanged
apart from the generated timestamp banner and trailing map comment; retain both builds and hashes.
Never rewrite the banner or compensate offsets. Repeat snapshot offset validation on the final
outputs, and require mappings to tracked \`src/*.ts\` before claiming original TypeScript locations.
If intermediate map generation changes executable code, reject the source build and investigate.

Use the capture platform and build flags when known. Otherwise preserve separate candidate builds and
validate against snapshot locations. **\`LynxEngineVersion.version\` is an SDK version observation,
not proof that JS was built with \`version=<that value>\`.** Inspect the selected wrapper/SDK consumer
and record whether the JS version variable is unset/default or explicitly supplied. If the captured
build environment is unknown, keep the selected family's default build and evidence-supported
version-injected candidates separately; do not replace the default solely from Trace metadata.
Reproduce verified version substitutions when present; never adjust
snapshot offsets or prepend padding to make an unrelated build fit. Save both **\`lynx_core.js\` +
\`lynx_core.js.map\`** and **\`lynx_core_dev.js\` with its inline map**. Keep the original generated
text, including banner and UTF-8 encoding. Copying a map requires preserving/rebasing its source paths.
The native loader may give dev code the URL \`file://shared/lynx_core.js\`; filename alone proves nothing.

Where the captured SDK uses Krypton and that component is available, it has its own
\`krypton/pnpm-workspace.yaml\`. Do not assume this internal sibling exists in the OSS repository;
ask for that component's source or matching build artifacts if needed, following source-inputs.
Inspect \`krypton/tools/js/build_piper.py\`,
package generators and \`write_piper_cc.js\`: JS is compressed into C++ headers and then native binaries.
Keep the intermediate text and map before compression. Do not try to map byte offsets into a header.
When an older generator has no source map output, the bundled helper executes the original generator,
captures an additional external-map build, and **asserts that JS bytes are identical to the original
piper input**. It passes the original output unchanged to the native header writer:

\`\`\`bash
# After installing the locked Krypton workspace dependencies:
tools/env.sh pnpm --dir krypton --filter @byted-krypton/krypton-full build:ts
# Run from krypton/js/krypton-full; absolute paths below:
node <skill-dir>/scripts/capture_lynx_piper.cjs \\
  "<checkout>/krypton/js/krypton-full/scripts/gen_cc_file.js" \\
  "<checkout>/.trace-artifacts/krypton-webgpu" true
\`\`\`

The final argument is that revision's WebGPU flag (\`true\`/\`false\`). Build separate candidates if unknown.
The helper emits \`krypton.js\`, \`.js.map\` and \`.js.build.json\`; it makes map source paths absolute and
checks byte identity before accepting outputs. Follow the revision's original TS→JS maps so the bundle
map reaches TypeScript. Apply the same capture helper to relevant gl-commandbuffer, remote, worker and
other piper generators with their own original arguments; resolve each runtime URL from its native loader.
Retain flags and unresolved scripts. Different feature settings can share a filename but have different offsets.

## Register builds and resolve snapshots

### Preparation completion gate

Before \`memory-analysis\`, save a component ledger beside the manifests. At minimum it must contain
separate rows for **core prod**, **core dev** and **Krypton**, plus other public scripts identified by
the selected SDK's native loaders. For each row record applicability evidence, source/ref/full commit,
platform and flags, acquisition method, build commands/exit statuses/logs, generated JS/map paths and
hashes, and the registered project ID. If the user explicitly supplied a local path and valid outputs
are reused, say so and record verification evidence; never describe reuse as a new build.
The core rows must also retain repository kind, SDK consumer file/line, selected entry script,
working directory, full package build chain and version-variable state. For an internal SDK, reject
a core row whose only final build is standalone \`@lynx-js/lynx-core build\`, even if JS/maps exist.
These are preparation ledger records, not new CLI flags or manifest fields.

All applicable rows need successful builds and registered JS/maps. A core-only manifest does not
complete a build request covering Krypton. An omitted component is not a successful preparation:
record evidence that it is not used by the captured SDK, or resolve its missing source/build through
source-inputs. Absence from the chosen repository is not evidence that the captured SDK does not use
it. Only the user's explicit source opt-out permits skipping a required component.
Keep skipped/unavailable rows and their actual reasons in the report's source limitations.

Check the ledger against the manifest before proceeding: each expected generated script/variant
must have a JS/map artifact in the active projects. \`frontend-prepare\` success alone checks only the
files submitted to it; it cannot detect a component that the Agent omitted from the config.
Do not close this gate based only on a matching commit or “JS/map prepared” in a report.
Incidental tracked changes from bootstrap/build do not close or block the gate; assess public-script
build completion and JS/map evidence, not repository cleanliness.

Use \`frontend-prepare\` as the shared JS/map validator; save runtime projects in a **separate manifest**.
Its \`lynx.statement\` records either the explicit revision request or the automatic Trace-version,
remote tag and full-commit resolution evidence. Do not fabricate a user approval statement.

\`\`\`json
{
  "version": 1,
  "projects": [{
    "id": "lynx-core-ios",
    "root": "/absolute/checkout",
    "outputDirs": ["oliver/lynx-kernel/output"],
    "scriptAliases": {
      "lynx_core.js": ["lynx_core.js"],
      "lynx_core_dev.js": ["lynx_core.js", "lynx_core_dev.js"]
    },
    "origin": {
      "kind": "git",
      "url": "https://code.byted.org/lynx/template-assembler",
      "ref": "<requested-ref>",
      "linkTemplate": "{repo}/blob/{commit}/{path}#L{line}"
    },
    "lynx": {
      "selection": {"kind": "commit", "requested": "<commit>", "ref": "<commit>"},
      "consent": "user-specified",
      "statement": "<actual user revision request>",
      "platform": "ios"
    }
  }]
}
\`\`\`

This is an internal kernel example. For OSS, use its actual repository root/URL and output directory,
such as \`js_libraries/lynx-core/output\`; GitHub source links must not include an extra \`lynx/\`.
Supported HTTPS, \`git@host:path\` and \`ssh://git@host/path\` forms compare by repository identity;
the validator still checks actual origin, requested ref, HEAD, provenance and file fingerprints.
It permits tracked changes for runtime projects and emits commit links only for matching file bytes.
For a version, set selection kind \`version\`, requested \`<version>\`, ref to the **verified tag/ref**
(\`A_<version>\` for internal where confirmed); for a branch use kind \`branch\` and its name in both fields.
Keep the evidence connecting a nonstandard ref to the requested version in the statement.
For automatic Trace-derived versions set \`lynx.consent\` to \`trace-version-resolved\`; the field records
provenance, not a required approval. Legacy \`trace-version-approved\` manifests remain readable.
Add Krypton projects using the same root/origin/selection and distinct IDs,
with \`outputDirs\` pointing at captured JS/map pairs. Verify the provider's source link format.
The JSON above illustrates only the core project; it is not a complete component checklist.
Record prepared paths and the resolved revision, then continue automatically.

\`\`\`bash
node <skill-dir>/scripts/trace_query.bundle.cjs frontend-prepare \\
  --config "<lynx-projects.json>" --output "<lynx-manifest.json>"
node <skill-dir>/scripts/trace_query.bundle.cjs \\
  --lynx-manifest "<lynx-manifest.json>" --frontend-manifest "<frontend-manifest.json>" \\
  --source-preparation "<source-preparation.json>" \\
  memory-analysis --path "<trace>" --output "<report-directory>"
\`\`\`

Complete [source-preparation](./source-preparation.md) with both decisions before running this command.
Omit only the frontend flag when no frontend project was supplied. Neither manifest requires an
artifact confirmation. Pass the runtime manifest to source-enabled \`memory-report\` as well.
After an explicit choice to skip a failed Lynx source, retain the failure/decision record, remove
that source's partial artifacts from active inputs and continue with the remaining sources. If no
valid runtime project remains, omit \`--lynx-manifest\`; do not present the skipped build as successful.

For each snapshot/script, the resolver parses every candidate and compares **all distinct recorded
UTF-8 function/class/method offsets** with the generated JavaScript syntax tree. At least three offsets
and a unique complete match are required before selecting a runtime candidate. It does not rely on
names, “offset is within file size”, or a successful sourcemap lookup. Insufficient locations, unsupported
syntax, mismatched builds and ambiguous variants remain unresolved; preserve those diagnostics.
This validates structural alignment, not a claim that the captured script's full hash is known.

### Post-extraction binding gate

Offset checks require extracted snapshots; they are a separate gate after preparation. Before
finalizing a report, reconcile every snapshot's Scripts inventory with the component ledger,
including \`krypton.js\` and scripts without object locations. A newly discovered required script
without a candidate reopens preparation: build it under the existing authorization, or follow the
source-input failure interaction. Do not silently leave it out of the manifest or report.

Record each runtime script as uniquely matched, insufficient locations, conflicting/ambiguous
variants, missing artifact or explicitly skipped, with candidate matched/total counts.
Missing required artifacts, a failed build or clear offset conflicts cannot be reported as completed
source assistance. Treat conflicts as source validation failures and follow source-inputs before
continuing with that source excluded. Too few recorded locations may remain an explicit evidence
gap; do not invent a binding or claim source-level responsibility from an unbound candidate.
“JS/map prepared” describes preparation only; it never proves snapshot binding.
Before attributing a conflict to the requested commit, perform a read-only check of the recorded
repository kind → SDK consumer → entry/workspace/package chain → platform, prod/dev and version
parameters. Report an incorrectly selected build entry as such. A failed candidate proves that
candidate is unusable, not that the user supplied the wrong commit; do not request another revision
without independent revision evidence. Fresh-checkout build failures follow the one diagnostic
retry in source-inputs; actual snapshot mismatches require the skip-source/abort decision and never
override an explicit user decision to stop.

\`analysis.json\` retains requested/resolved revision and each snapshot's \`runtimeMatches\` with candidate
paths, generated hashes, byte sizes, matched/total offsets and selection/error. Snapshot hashes bind
source evidence to heap content; source/build changes invalidate caches. Review these records before
claiming core source locations. Then inspect mapped allocation/retainer functions together with frontend
sources, while keeping lifecycle, retention and release responsibility as separate conclusions.

In a historical sample reanalysis with invalid local-build \`LynxEngineVersion.version\`, the user
explicitly selected internal commit \`710b41823ed73572117b7b6852ed5df6995d4646\`. This record is not
authorization or a default revision for a new request, including another analysis of the same sample
Trace. Apply source selection using the current conversation; do not treat this as an OSS commit.`,
};

export default prompt;
