---
name: source-inputs
description: Resolve business and Lynx sources for Trace analysis, continue successful builds automatically, retry fresh Lynx setup once, and ask only about unresolved inputs or failures.
---

# Source inputs, acquisition recovery and failure decisions

Apply this contract to both business/frontend sources and Lynx runtime sources. Load it before
cloning, installing dependencies or building either source type. Briefly state the resolved source
and next action; do not add an input-format briefing or hypothetical-failure confirmation gate.
These are conversational inputs that the Agent resolves into existing project/manifest fields,
not new CLI flags. The user does not need to write a manifest.

For memory work, enforce [source-preparation](./source-preparation.md) before analysis and
again before final delivery. The Agent records actual user decisions; tool diagnostics and
analyzer optional-source fallbacks cannot resolve a pending source failure.

## Accepted inputs

| Input | Accepted forms | Resolution |
| --- | --- | --- |
| Complete Git repository URL | `https://host/owner/repo.git`, `ssh://git@host/owner/repo.git`, `git@host:owner/repo.git`; `.git` may be omitted when the host accepts it | Retain the supplied repository and transport. Ask for the intended branch/commit if neither the input nor established context specifies it. |
| Commit | Full hash or a uniquely resolvable abbreviated hash | Resolve in the associated repository and record the full commit. Ambiguous short hashes require clarification. |
| Branch | A branch name, including names with `/`, such as `main` or `release/1.2` | Resolve in the associated repository and record both the requested branch and the resolved full commit. |
| Existing local code directory | Absolute path, workspace-relative path such as `./app`, or home-relative path such as `~/code/lynx` | Expand to an absolute path. With no requested revision, use the current source tree and record its available Git identity and source hashes. Preserve user changes. |
| Repository URL or local directory plus commit/branch | `业务源码 <URL/path>，commit <hash>` or `Lynx 源码 <URL/path>，分支 <branch>` | Bind the revision to that exact source. Use an isolated checkout/build workspace if selecting another revision would change the user's checkout. |
| Frontend source archive/download | An explicit source archive URL or local archive | Acquire/extract to a separate directory; record the locator and hashes. Do not claim Git provenance without verification. |
| Independently supplied frontend artifacts | Local JS/map files or directory, Git URL plus ref, downloadable JS/map/archive URL | Associate with the intended source project; preserve original bytes and filenames. Source and artifacts may use different acquisition methods and directories. Do not build the frontend by default. A non-Git URL needs no Git ref. |

A commit or branch is a revision selector. Resolve its repository using the source-specific rule:

- For business sources, use the already identified repository. If it is missing or multiple
  repositories could apply, ask for the URL/local directory or the intended project before fetching.
- For Lynx, retain an explicitly selected URL/local path. Otherwise, use the
  [automatic remote resolution procedure](./lynx-sources.md#automatic-remote-repository-resolution)
  for the Trace-derived version tag or supplied version/commit/branch. Probe internal first:
  **if its Git URL is accessible, select internal**. Only an inaccessible internal remote permits
  checking OSS. Do not ask internal/OSS or request a URL merely because it was omitted; do not
  fall back to OSS when an accessible internal repository lacks the requested ref.
- A Git URL alone is supported, but a missing remote revision must be clarified; do not silently use
  the default branch. A local directory alone uses its current tree, not a guessed remote HEAD.
- Retain the requested locator and actual origin. Normalize equivalent Git URL spellings only after
  verifying they identify the same repository; never label a different repository as the default.
- An explicit Lynx version remains supported. `A_<version>` is an internal tag convention, not a
  universal internal/OSS mapping. Verify the tag in the selected repository. Retain its actual ref
  and resolved full commit alongside the original requested version, and record the version-to-ref
  evidence in the selection statement. When neither Lynx source nor revision was provided, use the
  [automatic Trace-version preparation workflow](./lynx-sources.md) and resolve the repository.
  A local Trace Skill/packages or `js-memory-analyzer` path is a tool choice, not a Lynx runtime
  source. First reject any Trace-derived version below `4.5.0`, even if its tag exists: these
  memory-analysis capabilities started in Lynx 4.5. Treat it as a missing tag and request usable
  source/revision; do not silently upgrade it or treat tag existence as validation.
  Verify an eligible Trace-derived tag remotely and build automatically when it exists. Ask for
  missing source/revision input only when no unique usable tag can be resolved; do not ask for build
  consent. Honor explicit runtime inputs and opt-outs already given for this analysis.
- When selectors conflict, ask which source/revision is intended before preparation.

Inventory each source separately with its role (business or Lynx), project ID, requested locator/ref,
resolved path/commit and preparation state. Multiple build variants from the same source do not turn
a partially failed preparation into a successful one.

## Remote inputs require fresh acquisition and applicable builds

**For both frontend and Lynx repositories, a Git URL, commit or branch means fresh remote
acquisition for this analysis unless the user explicitly supplies a local source path.**
Do not search, inspect or probe local repositories to resolve remote inputs. Do not inspect or reuse
old checkouts, worktrees, Git mirrors/object caches, previous reports' manifests, generated JS/maps
or source-location caches, even when origin and HEAD appear to match. Do not create a worktree from
an existing checkout or use `--reference`, `--shared` or alternates as a substitute for acquisition.

Resolve a revision-only business input using its established URL; ask when that locator is missing.
For Lynx, automatically query the known remotes as described above. Never discover either source by
searching local directories. Clone/fetch the selected remote into
a new empty workspace, resolve the requested revision there, install the locked dependencies and
run the required builds in this attempt. **Exception: explicitly supplied frontend artifacts replace
the frontend build step.** Acquire the requested source revision freshly for original-code mapping,
acquire the supplied artifacts independently, and validate them without installing/building the
source project by default. This exception does not permit searching for unsupplied local caches and
does not change Lynx runtime preparation. Record acquisition/build commands, exit statuses, full log
paths, requested/resolved revision, platform/flags and output hashes. File existence, timestamps and
matching HEAD alone do not prove a build was run.

Only an explicit local source path permits inspection of that checkout and reuse of its verified
outputs. This permission is per source: a local frontend path does not authorize local Lynx lookup,
and paths to analysis tools do not authorize either. Preserve local changes and record whether
outputs were rebuilt or reused and how they were verified. An alternate local path after a remote
failure must come from the user's explicit response; never search for one autonomously.

Keep a preparation ledger in the analysis output directory. Every selected source/component must
end in **built and validated**, **verified local reuse**, **supplied artifacts prepared without build**,
**not applicable with evidence**, or
**explicitly skipped by the user with the actual response**. Pending, failed or missing entries block
completion. This ledger records Agent execution evidence; `frontend-prepare` validates files and
fingerprints, not the history of clone/build commands.
For separate frontend inputs, the ledger must distinguish source and artifact locators/paths,
requested/resolved Git revisions where applicable, download/extraction logs, JS/map hashes and
whether a map is available. “Prepared” precedes Trace binding validation; it does not assert a match.
Keep artifact acquisition provenance in `artifactOrigin` and original-source identity in `origin`.

Successful frontend and runtime preparation leads directly to analysis. Record artifact paths and
fingerprints without requesting approval or asking the user to determine source-map correctness.
The Skill checks snapshot bindings later. For a frontend mismatch, inspect project config and offer
abort, continue without affected artifacts, or supply an explicit artifact locator; repeat acquisition/
validation and the decision on each failing replacement. Follow
[frontend mismatch recovery](./frontend-sources.md#frontend-mismatch-diagnosis-and-artifact-recovery).
Lynx mismatches retain the two-choice source-assistance decision. A rebuild requires re-preparation and matching,
not `frontend-confirm`. Never fabricate a user statement for automatic preparation.

## Internal and OSS Lynx repositories

| Repository | URL | Lynx source root relative to checkout |
| --- | --- | --- |
| internal | `https://code.byted.org/lynx/template-assembler` | `lynx/` |
| OSS | `https://github.com/lynx-family/lynx.git` | `./` |

**The OSS repository root corresponds to internal's `lynx/` directory. Trace events and Trace
analysis capabilities are the same for internal and OSS.** Apply the same event interpretation,
queries, memory/snapshot rules and reports; repository choice does not enable or disable an analysis.
Availability still depends on the recorded Trace evidence.

Use checkout-relative build and source-link paths: internal `lynx/js_libraries/...` corresponds to
OSS `js_libraries/...`. Internal-only sibling components, such as a kernel or Krypton build present
outside `lynx/`, must be discovered in the actual checkout; do not invent them in OSS.
Equivalent Trace semantics do not prove identical commits, tags, build outputs or snapshot offsets.
Do not silently switch repositories or reuse a commit/map across them.

Classify internal versus OSS from the explicit locator or automatic remote probes, verify origin/HEAD
after fresh acquisition, and carry the classification and probe evidence into the build ledger.
Use exact remote tag/branch refs; verify commits with a shallow fetch into a fresh directory because
`ls-remote` does not list every commit. Separate remote accessibility from requested-ref availability:
accessible internal remains internal even if the ref is missing. Do not ask the user to identify the
family, choose one from the current subdirectory, or silently substitute another repository/ref.
For public SDK core, internal uses `tools/oliver/lynx-kernel/build.py` → `@byted-lynx/kernel` →
`oliver/lynx-kernel/output/`; OSS uses `tools/js_tools/build.py` → `@lynx-js/lynx-core` →
`js_libraries/lynx-core/output/`. Internal's nested `lynx/tools/js_tools/build.py` produces standalone
shared core, not the internal SDK's final kernel. Confirm the requested revision's SDK consumer rule
and retain its file/line before installing/building. Missing tooling cannot justify switching entry
families. Follow [the build-entry selection procedure](./lynx-sources.md#choose-the-build-entry-from-the-repository-and-sdk-consumer).

## Fresh Lynx setup failure: diagnose and retry once

A freshly acquired Lynx checkout is expected to build its public scripts successfully. If bootstrap,
initialization, dependency synchronization/installation (including Git fetches inside those steps),
or a public-script build fails or times out, **inspect the cause and retry once automatically before
asking the user**. This exception takes precedence over the generic failure pause below.

1. Save the complete first stdout/stderr, exit status, command and working directory. A tool moving a
   still-running command to the background is not a build failure. For a real timeout, stop that
   attempt before retrying; do not leave two builds running.
2. Read the first error and relevant repository initialization instructions. Check actual executable
   resolution, shell initialization and inherited environment: `PATH`, Python/Node/corepack/pnpm,
   `VIRTUAL_ENV`, `PYTHONHOME`, `PYTHONPATH`, proxy settings and required SDK build variables. Inspect
   only relevant values, redact credentials, and distinguish inherited-shell contamination from
   missing tools, inaccessible dependencies or a genuine build error.
3. Apply a targeted, reversible correction in the build subprocess and retry the failed stage once,
   then run its remaining required stages. Use the same repository, ref, SDK entry, platform and
   intended flags. Preserve the user's shell configuration and existing files. Do not dump all
   environment variables, disable security checks or substitute a different source/build target.
   Record the diagnosis, environment adjustment and retry log; do not blindly repeat the command.
4. If recovery succeeds, continue without confirmation. If the retry still cannot complete the
   required public-script build, report both attempts and ask **放弃 Lynx 源码辅助继续分析** or
   **终止整个分析流程** using the decision contract below. Do not restart the retry allowance
   indefinitely for the same failing preparation.

Fresh clone/bootstrap/dependency/build steps can modify tracked files or create temporary files.
After successful public-script builds, these changes are **not a preparation failure**. Do not run
a clean-tree gate, investigate unrelated changes, clean/reset, request a commit, or ask the user
whether to continue. Keep origin/ref/HEAD and artifact/source fingerprints. Only emit a remote
source permalink when that particular file's bytes match the recorded commit; changed/generated
files may retain verified local source evidence without a remote link. That link limitation alone
is not a snapshot mismatch and must not interrupt analysis.

## Other preparation failures, errors or timeouts

For explicitly supplied frontend artifacts, including artifacts acquired from Git, use the
[frontend three-choice recovery loop](./frontend-sources.md#frontend-mismatch-diagnosis-and-artifact-recovery)
instead of the source acquisition/build decisions below.

The initial Lynx availability probes are part of automatic repository selection: an inaccessible
internal remote triggers the OSS probe without pausing or asking. Apply the recovery below if both
remotes are inaccessible, the selected repository cannot resolve the requested revision, or actual
clone/fetch/checkout fails. A missing ref in accessible internal never triggers OSS fallback.

1. **Pause the current analysis workflow immediately.** Do not start another preparation or analysis
   step while waiting. Stop any still-running commands belonging to this preparation attempt,
   including a command left running in the background after a reported timeout. Preserve existing
   user files and all completed evidence; do not clean the workspace destructively.
2. Save full stdout/stderr. Report the source role/project, repository or local path, requested
   revision, failed phase, concrete error/exit status or timeout, and log path. Use an explicit
   phase label such as **业务源码克隆失败**, **Lynx 仓库依赖安装失败** or **业务项目构建超时**.
   Do not hide a known error behind “environment issue.”
3. Follow the phase-specific interaction below. For fresh Lynx setup/build failures, first apply
   the automatic diagnostic retry above. Incidental tracked build changes do not enter this workflow.
   Partial outputs do not stand in for a required completed build.

### Clone, fetch or checkout failure: keep resolving the source

Do not end the analysis or force a skip/abort choice after a Git acquisition failure. This applies
to business sources as well as Lynx.

- Show the exact attempted `git_url`, ref and remote evidence. For business sources, ask for
  missing/ambiguous locators and revisions. For Lynx, retain the repository classification from
  the explicit locator or probes; ask only for the corrected revision or access/acquisition
  information needed by the actual failure, not whether the repository is internal or OSS.
- Also ask how else the source can be obtained: an existing local checkout, an accessible mirror
  with verifiable provenance, a source archive/export (preferably retaining Git metadata), or
  matching generated JS and sourcemaps with repository, revision, platform and build records.
  Explain any authentication/access error precisely; do not ask the user to paste credentials.
- Use corrected inputs or an alternative explicitly supplied by the user to start the next
  acquisition attempt. Inspect it and retain the actual origin, requested and resolved revision,
  hashes and provenance. Do not blindly repeat the same failing command, silently change transport,
  revision or repository, or pretend an archive/artifact is a verified Git checkout.
- The runtime validator still requires a verified Git checkout/origin/ref and matching build
  provenance. An archive without Git identity or standalone JS/map files are recovery inputs, not
  an automatic validation bypass. Explain the remaining evidence needed and keep asking for a
  usable checkout/provenance; do not fabricate a commit or relabel a mirror as an official origin.
- **Keep this interaction open until source acquisition succeeds, the user explicitly declines
  Lynx artifact assistance (or explicitly abandons the affected business source), or the user
  explicitly aborts the entire analysis.** Exhausted retries, inaccessible internal hosting,
  silence or a statement that one method failed do not imply opt-out. Ask targeted follow-up
  questions about still-missing inputs or other acquisition methods; never skip by retry count.

Example user-facing prompt (adapt to the actual failure and user's language):

> **Lynx 源码克隆失败，分析已暂停，尚未终止。**
>
> 尝试来源：`<internal/OSS, git_url>`；版本：`<commit/branch>`。
> 错误：`<actual error>`；日志：`<log path>`。
> `<针对实际错误，请补充修正后的版本或可用的访问／获取方式；不重复询问仓库类型>`。
> 也可以提供本地 checkout、可访问的镜像、源码归档，或匹配的 JS/map 及构建来源记录。
> 我会继续核实获取方式，直到拿到可用源码；若你明确不需要 Lynx 产物辅助分析或要中止本次
> 分析，请直接说明。

Use the interaction tool when available; otherwise ask in conversation and wait. A corrected URL,
revision or alternative is input to continue preparation, not a skip decision. A later acquisition
failure returns to this same recovery interaction.

### Persistent build failure or Lynx source mismatch: explicit two-choice decision

Apply this to business installation/build failures, fresh Lynx setup/build failures that persist
after the diagnostic retry, and actual Lynx source validation failures such as required JS/maps
missing or snapshot/script/offset conflicts. **Frontend artifact mismatch or explicit-artifact
acquisition/validation failure uses the three-choice loop in frontend-sources instead.** Explicit
JS-only frontend input is valid at the generated-code layer; absent maps alone do not trigger this
failure rule. Successful builds require no approval before these later checks.
The Skill must establish and explain the mismatch; never ask the user to certify map correctness.
Use the available user-interaction tool with **exactly two choices** when supported.
Neither choice is preselected or a default. If no interaction tool is available, ask the same
question in the conversation and wait for the reply.

> **Lynx 仓库依赖安装失败**
>
> 源码：`<project / repository / path>`；版本：`<requested ref / resolved commit>`。
> 错误：`<actual error or timeout>`；日志：`<log path>`。
> 当前分析已暂停。请选择：
>
> 1. **终止整个分析流程**
> 2. **跳过当前失败的对应源码，继续使用其余可用的代码完成后续分析**
>
> 选择 2 将跳过 `<exact source scope>`；相关源码定位和归因会受限，其余源码仍可使用。

Replace the example's phase label with the actual phase, and explain the exact scope to be skipped.
Keep the same meaning in the user's language. For a source mismatch, describe the affected source
assistance and mismatch evidence; for persistent Lynx failures, include the diagnostic retry result.
The automatic retry has already happened and is not a third option.

**Wait for an explicit selection.** Silence, a successful unrelated build, the original analysis
authorization, a prior source's skip decision, or a vague reply is not a choice. Ask for clarification
if necessary and remain paused. Do not retry, repair, change mirrors/toolchains/revisions, accept
partial outputs, skip the failed source or terminate the analysis on the user's behalf.

Apply only the selected action:

- **Choice 1 — terminate the entire analysis:** stop all remaining work for this analysis and
  state that it ended at the reported phase. Keep existing files and failure logs; do not call a
  partial report complete.
- **Choice 2 — skip this source and continue:** exclude only the failed source scope identified
  in the question, including its partial artifacts and corresponding source-location caches.
  Preserve the other sources, finish preparation for the remaining active sources, then continue
  analysis with the available code. Do not keep one successful build variant from the skipped
  source as if the source had passed. If no source remains, continue with Trace/snapshot evidence
  and explicitly limit source-level conclusions; this is not an implicit termination.

## Record the outcome

For all phases, record the failed phase, attempted/corrected source inputs, error/log, acquisition
method, skipped scope (if any) and actual user response. For business sources,
use the existing `abandoned` project record with the actual reason and `userConfirmed: true`;
prepare the remaining artifact list and continue without another confirmation. For Lynx, distinguish an explicit
opt-out after acquisition failure from a skip after installation/build failure; neither is successful
preparation or an initial “not requested.” Remove the skipped source's
artifacts from the active runtime manifest; omit `--lynx-manifest` if no valid runtime project remains.
Keep this decision in the delivered report's source limitations.

A later failure of another source follows its own recovery and decision rules.
A later explicit user request to retry installation/build starts a new preparation attempt; do not
infer it from either of those two choices. Initial repository acquisition uses the acquisition
recovery loop; bootstrap/dependency/build failures inside a fresh Lynx checkout use the one-retry rule.
