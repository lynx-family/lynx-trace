// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0.

import type { MemoryAnalysisResult } from '../types/memory_analysis';

import type { PreparedFrontend } from './frontend_sources';

type SourceKind = 'frontend' | 'lynx';

export interface SourceDecision {
  state: 'prepared' | 'not-provided' | 'opted-out' | 'pending' | 'aborted';
  reason?: string;
  /** Verbatim user decision; tool diagnostics are not user decisions. */
  userStatement?: string;
  manifestDigest?: string;
  binding?: {
    state: 'verified' | 'limited' | 'pending' | 'mismatch';
    /** All exported snapshot hashes reviewed for this source group. */
    snapshotSha256s: string[];
    reason: string;
    limitation?: 'no-locations' | 'insufficient-evidence' | 'unused-artifacts' | 'no-snapshots' | 'no-map';
  };
}

/** Agent-authored conversation ledger. Never infer consent from missing files or tool output. */
export interface SourcePreparation {
  version: 1;
  frontend: SourceDecision;
  lynx: SourceDecision;
}

const kinds: SourceKind[] = ['frontend', 'lynx'];
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

export function checkSourcePreparation(
  value: SourcePreparation | undefined,
  phase: 'analysis' | 'report',
  manifests: { frontend?: PreparedFrontend; lynx?: PreparedFrontend },
  result?: MemoryAnalysisResult,
): SourcePreparation {
  const fail: (message: string) => never = (message) => {
    throw new Error(`Source preparation blocked: ${message}`);
  };
  if (!value || value.version !== 1) {
    fail('provide --source-preparation <json> with frontend and lynx decisions; missing input is not an opt-out.');
  }
  const ledger = value;
  for (const kind of kinds) {
    const decision = ledger[kind];
    const manifest = manifests[kind];
    const previous = result?.sourcePreparation?.[kind];
    const savedProjects = result?.frontendSources?.projects?.filter(
      (project) => Boolean(project.lynx) === (kind === 'lynx'),
    );
    if (!decision || !['prepared', 'not-provided', 'opted-out', 'pending', 'aborted'].includes(decision.state)) {
      fail(`${kind}: missing or invalid decision.`);
    }
    if (decision.state === 'pending' || decision.state === 'aborted') {
      fail(`${kind}: ${decision.state}; resolve the source failure with the user before continuing.`);
    }
    if (decision.state === 'not-provided') {
      if (kind === 'lynx' || manifest || savedProjects?.length || (previous && previous.state !== 'not-provided')) {
        fail(`${kind}: not-provided cannot replace runtime preparation or a supplied source.`);
      }
      continue;
    }
    if (decision.state === 'opted-out') {
      if (!nonempty(decision.userStatement) || !nonempty(decision.reason)) {
        fail(`${kind}: an opt-out requires the user's actual statement and the affected scope/reason.`);
      }
      if (manifest) fail(`${kind}: do not pass a manifest for an opted-out source group.`);
      continue;
    }
    if (!nonempty(decision.manifestDigest)) fail(`${kind}: prepared requires manifestDigest.`);
    if (phase === 'report' && (manifests.frontend || manifests.lynx) && !manifest) {
      fail(
        `${kind}: pass every prepared group's manifest when refreshing sources, or omit all manifests for offline reuse.`,
      );
    }
    if (manifest) {
      if (manifest.digest !== decision.manifestDigest) fail(`${kind}: manifest digest changed; prepare/recheck it.`);
      if (!manifest.artifacts.length) fail(`${kind}: prepared requires active artifacts; record an opt-out instead.`);
    } else if (
      phase === 'analysis' ||
      previous?.state !== 'prepared' ||
      previous.manifestDigest !== decision.manifestDigest ||
      !savedProjects?.length
    ) {
      fail(
        `${kind}: prepared requires its verified manifest (or the same saved report inventory for offline rerender).`,
      );
    }
    if (decision.binding && ['pending', 'mismatch'].includes(decision.binding.state)) {
      fail(`${kind}: known binding failure requires the caller's failure interaction before continuing.`);
    }
    if (phase === 'report') {
      const binding = decision.binding;
      if (!binding || !['verified', 'limited'].includes(binding.state) || !nonempty(binding.reason)) {
        fail(`${kind}: snapshot binding review is pending or mismatched; complete the caller's failure interaction.`);
      }
      if (
        binding.state === 'limited' &&
        !['no-locations', 'insufficient-evidence', 'unused-artifacts', 'no-snapshots', 'no-map'].includes(
          binding.limitation || '',
        )
      ) {
        fail(
          `${kind}: limited requires an evidence-gap category; conflicts/acquisition failures are not evidence gaps.`,
        );
      }
      const expected = [
        ...new Set([
          ...(result?.snapshots.flatMap((snapshot) => (snapshot.sha256 ? [snapshot.sha256] : [])) || []),
          ...Object.values(result?.frontendSources?.snapshots || {}).flatMap((snapshot) =>
            snapshot.sha256 ? [snapshot.sha256] : [],
          ),
        ]),
      ].sort();
      if (
        !Array.isArray(binding.snapshotSha256s) ||
        binding.snapshotSha256s.some((hash) => !nonempty(hash)) ||
        JSON.stringify([...new Set(binding.snapshotSha256s)].sort()) !== JSON.stringify(expected)
      ) {
        fail(`${kind}: binding review must cover the current exported snapshot hashes.`);
      }
    }
  }
  return structuredClone(ledger);
}

/** Remove cached attribution when the user withdraws a whole source group. */
export function discardOptedOutSources(result: MemoryAnalysisResult, ledger: SourcePreparation): void {
  for (const kind of kinds) {
    if (ledger[kind].state !== 'opted-out') continue;
    const warning = `${kind} source assistance opted out by the user: ${ledger[kind].reason}`;
    if (!result.warnings.includes(warning)) result.warnings.push(warning);
  }
  const inventory = result.frontendSources;
  if (!inventory) return;
  const removed = new Set(
    inventory.projects
      ?.filter((project) => ledger[project.lynx ? 'lynx' : 'frontend'].state === 'opted-out')
      .map((project) => project.id) || [],
  );
  if (!removed.size) return;
  const removedScripts = new Set(
    inventory.artifacts?.filter((artifact) => removed.has(artifact.projectId)).map((artifact) => artifact.script),
  );
  inventory.projects = inventory.projects?.filter((project) => !removed.has(project.id));
  inventory.artifacts = inventory.artifacts?.filter((artifact) => !removed.has(artifact.projectId));
  for (const { locations } of Object.values(inventory.snapshots)) {
    for (const [key, location] of Object.entries(locations.nodes)) {
      if (!location.projectId || removed.has(location.projectId)) delete locations.nodes[key];
    }
    const bindings = locations.bindings || {};
    for (const [key, binding] of Object.entries(bindings)) {
      binding.candidates = binding.candidates.filter((candidate) => !removed.has(candidate.projectId));
      if (binding.selected && removed.has(binding.selected.projectId)) delete binding.selected;
      if (!binding.candidates.length) delete bindings[key];
    }
    const runtimeMatches = locations.runtimeMatches || {};
    for (const [key, match] of Object.entries(runtimeMatches)) {
      match.candidates = match.candidates.filter((candidate) => !removedScripts.has(candidate.script));
      if (match.selected && removedScripts.has(match.selected)) delete match.selected;
      if (!match.candidates.length) delete runtimeMatches[key];
    }
  }
}
