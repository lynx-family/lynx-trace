---
name: source-preparation
description: Enforce source readiness and explicit failure decisions before memory analysis and final report delivery.
---

# Source preparation and failure decisions

This is the shared caller contract for Trace and delegated `js-memory-analyzer` work. It takes
precedence over the analyzer's standalone optional-source fallback. Tool output is evidence,
never a user decision. `unresolved`, `skipped`, “not prepared” or a disclaimer in the final report
does not authorize continuing after a source failure.

## Two checkpoints

1. **Before `memory-analysis`, `memory-snapshot` or delegated heap analysis**: resolve every
   supplied frontend project and Lynx runtime preparation. Record prepared manifests or the
   user's explicit opt-out. An absent runtime selection is **pending**, not `not-provided`:
   automatically read the Trace version, require `>= 4.5.0`, select/probe the remote and prepare public scripts.
   A recorded version below `4.5.0` is invalid even if its tag exists: these memory-analysis capabilities
   started in Lynx 4.5. Use the missing-tag recovery flow and request usable source/revision, without
   silently upgrading or building the invalid tag.
   Ask for missing source/revision only when automatic resolution fails. Tool directories and
   a frontend checkout never count as a Lynx checkout.
2. **Before analyzer finalization, `memory-report` and delivery**: review snapshot bindings,
   including preflight returned by the analyzer. A real mismatch reopens the source decision.
   Pause affected analysis and finalization until that decision is resolved. Returning a
   preliminary report, `source_materials: skipped` or “sources unavailable” cannot close it.

`memory-analysis` emits preliminary artifacts so their snapshots can be checked; those files
are not the final delivery. Version/source preflight and the config inspection needed to resolve
a failure are allowed while the analysis checkpoint is pending.

## One failure policy for both skills

- **Frontend mismatch or supplied-artifact acquisition/validation failure**: inspect project
  configuration, imports and build scripts. Show file/line evidence for variables, conditional
  branches, asset prefix/public path, mode, define, minification and platform inputs that may
  explain the difference. Separate proven causes from hypotheses and unknown recording inputs.
  Ask the user to abort, continue without the affected artifact assistance, or provide an
  explicit artifact locator. **Wait for the answer.** Recheck each replacement and repeat
  these choices until matched or explicitly aborted/opted out. No replacement retry cap.
- **Source and prebuilt artifacts supplied separately**: acquire both as specified, do not
  build the frontend by default. Bind Trace locations → supplied generated JS → matching map →
  the specified original source project. A replacement locator does not replace that project.
- **Lynx acquisition/selection failure**: follow the source/revision recovery loop. Fresh
  initialization/dependency/build failure gets environment diagnosis and one automatic retry;
  after that ask skip-runtime-assistance or abort. Later runtime mismatch uses the same
  skip/abort decision. Successful automatic preparation needs no extra approval.
- **Evidence gap**: missing locations, sparse/ambiguous candidates, an unreferenced prod/dev
  variant or absent map do not prove a mismatch. Keep unverified locations unused and record
  the limitation. Do not label a real offset/name conflict or unreadable required input as an
  evidence gap. For a supplied frontend project, keep `frontend.binding.state` **pending** if a
  business location used in the analysis is generated-only and the user has not accepted that scope.
  Follow the [binding question](./frontend-sources.md#generated-only-frontend-locations) before
  finalization. On acceptance record the script/scope and the user's words in `binding.reason`, use
  `limited` with the applicable limitation, and keep the validated JS. This is not a project opt-out.

The analyzer returns binding facts (`status`, `failure_kind`, candidates, counts, hashes and
reason) to the caller. The caller owns config diagnosis, questions, source decisions and the
continuation checkpoint. Neither skill may reinterpret a technical skip as user consent.

## CLI ledger

The Agent writes `source-preparation.json`; never ask the user to author it. Pass the global
`--source-preparation <path>` alongside active `--frontend-manifest` / `--lynx-manifest`.
Both `frontend` and `lynx` are mandatory:

```json
{
  "version": 1,
  "frontend": { "state": "prepared", "manifestDigest": "<frontend manifest digest>" },
  "lynx": { "state": "prepared", "manifestDigest": "<runtime manifest digest>" }
}
```

States:

| State | Required evidence / allowed use |
| --- | --- |
| `prepared` | Current validated manifest and its digest; before final report, completed `binding` review below. |
| `not-provided` | Frontend only, when the user supplied no frontend source/artifacts. Never use for Lynx. |
| `opted-out` | `reason` naming scope and limits, plus `userStatement` quoting the actual user answer. Omit that group's manifest. |
| `pending` | Missing inputs, preparation/validation failure or unanswered question. Blocks analysis and delivery. |
| `aborted` | User terminated this analysis. Blocks further analysis and delivery. |

Opt-outs apply only to the scope named by the user. For a single failed project in a multi-project
manifest, use its existing `abandoned: {reason, userConfirmed: true}` entry and preserve other active
projects; include the actual user statement in `reason`. Reprepare the manifest and update its digest.
A whole-group opt-out must not be inferred from a per-project answer. Existing decisions remain valid
for unchanged inputs and do not need another question. A replacement resets its binding review.

For each prepared group, after reviewing every exported snapshot, add:

```json
{
  "state": "verified",
  "snapshotSha256s": ["<each unique exported snapshot SHA-256>"],
  "reason": "<preflight evidence paths, hashes, candidates/counts and verified binding scope>"
}
```

as its `binding`. Use `state: "limited"` only for a documented evidence gap, with `limitation` set
to `no-locations`, `insufficient-evidence`, `unused-artifacts`, `no-snapshots` or `no-map`.
Record all gaps in `reason`; unused variants may coexist with matched artifacts. With no exported
snapshots use `snapshotSha256s: []` and `no-snapshots`. A mismatch uses `binding.state: "mismatch"`
until resolved; unanswered review uses `pending`. Do not mark them limited to bypass a question.

The CLI checks decisions before Trace initialization and before final report side effects, checks
manifest digests and final snapshot coverage, and persists the ledger in `analysis.json`.
Offline rerender may reuse a completed ledger and the same saved inventory. Legacy data requires
an explicit ledger and manifests for prepared groups; legacy absence is not consent.
When refreshing sources, pass every prepared group's manifest together; otherwise omit all manifests
to reuse the saved inventory. Before importing results after an opt-out, refinalize affected analyzer
findings without the abandoned attribution. The report records group opt-out reasons and removes that
group's cached source links while retaining other verified locations.
The ledger records conversation evidence; it cannot independently authenticate user quotations
or prove a binding review was honest.
