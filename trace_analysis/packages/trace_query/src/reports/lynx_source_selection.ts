// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0.

import { TraceQuery } from '../utils/trace_query';

export const LYNX_SOURCE_REPOSITORIES = [
  { kind: 'internal', url: 'https://code.byted.org/lynx/template-assembler', sourceRoot: 'lynx/' },
  { kind: 'oss', url: 'https://github.com/lynx-family/lynx.git', sourceRoot: './' },
] as const;

const TRACE_LYNX_VERSION_FLOOR = [4, 5, 0] as const;
export const MINIMUM_TRACE_LYNX_VERSION = TRACE_LYNX_VERSION_FLOOR.join('.');

/** Only Trace-derived versions use this floor; explicit source selections remain authoritative. */
export function traceLynxVersionInvalidReason(version: string): 'invalid-format' | 'below-minimum' | undefined {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      version,
    );
  if (!match) return 'invalid-format';
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  if (!parts.every(Number.isSafeInteger) || match[4]?.split('.').some((part) => /^0\d+$/.test(part)))
    return 'invalid-format';
  for (const index of [0, 1, 2] as const) {
    if (parts[index] < TRACE_LYNX_VERSION_FLOOR[index]) return 'below-minimum';
    if (parts[index] > TRACE_LYNX_VERSION_FLOOR[index]) return undefined;
  }
  // A prerelease of 4.5.0 precedes the supported 4.5.0 release.
  return match[4] ? 'below-minimum' : undefined;
}

/** Compare supported Git transports without changing the recorded or fetched URL. */
export function canonicalRepositoryUrl(url: string): string {
  return url
    .replace(/^git@([^/:]+):/, 'https://$1/')
    .replace(/^ssh:\/\/git@([^/:]+)(?::22)?\//, 'https://$1/')
    .replace(/\.git\/?$/, '')
    .replace(/\/$/, '');
}

export function isLynxSourceRepository(url: string): boolean {
  return LYNX_SOURCE_REPOSITORIES.some(
    (repository) => canonicalRepositoryUrl(repository.url) === canonicalRepositoryUrl(url),
  );
}

export interface LynxSourceSelection {
  kind: 'version' | 'commit' | 'branch';
  requested: string;
  ref: string;
}

export interface LynxVersionCandidate {
  version: string;
  /** Invalid Trace metadata must never become a tag lookup/build candidate. */
  ref: string | null;
  status: 'candidate' | 'invalid';
  invalidReason?: 'invalid-format' | 'below-minimum';
  sliceIds: number[];
}

/** An explicit user selection wins without consulting possibly local-build Trace metadata. */
export function requestedLynxSource(options: {
  lynxVersion?: string;
  /** Verified version tag/ref in the selected repository; A_<version> is only an internal hint. */
  lynxVersionRef?: string;
  lynxCommit?: string;
  lynxBranch?: string;
}): LynxSourceSelection | undefined {
  const selections = [
    options.lynxVersion && { kind: 'version' as const, requested: options.lynxVersion },
    options.lynxCommit && { kind: 'commit' as const, requested: options.lynxCommit },
    options.lynxBranch && { kind: 'branch' as const, requested: options.lynxBranch },
  ].filter((selection): selection is { kind: LynxSourceSelection['kind']; requested: string } => !!selection);
  if (selections.length > 1) throw new Error('Specify only one Lynx version, commit or branch.');
  const selected = selections[0];
  if (options.lynxVersionRef !== undefined && selected?.kind !== 'version') {
    throw new Error('A Lynx version ref requires --lynx-version.');
  }
  if (!selected) return undefined;
  const requested = selected.requested.trim();
  const ref = selected.kind === 'version' ? (options.lynxVersionRef ?? `A_${requested}`).trim() : requested;
  if ([requested, ref].some((value) => !value || value.startsWith('-') || /[\s~^:?*[\\]/.test(value))) {
    throw new Error('Invalid Lynx source revision.');
  }
  return { ...selected, requested, ref };
}

/** This is a preparatory version query, not a memory analysis. Preserve multiple recorded versions. */
export async function queryLynxEngineVersions(traceQuery: TraceQuery): Promise<LynxVersionCandidate[]> {
  const rows = await traceQuery.query(`
    SELECT s.id AS slice_id, a.display_value AS version
    FROM slice s JOIN args a ON s.arg_set_id = a.arg_set_id
    WHERE s.name = 'LynxEngineVersion'
      AND a.key IN ('version', 'debug.version', 'args.version')
    ORDER BY s.ts, s.id
  `);
  const candidates = new Map<string, LynxVersionCandidate>();
  for (const row of rows) {
    if (row['version'] === undefined || row['version'] === null) continue;
    const version = String(row['version']).trim();
    if (!version) continue;
    let candidate = candidates.get(version);
    if (!candidate) {
      const invalidReason = traceLynxVersionInvalidReason(version);
      candidate = {
        version,
        ref: invalidReason ? null : `A_${version}`,
        status: invalidReason ? 'invalid' : 'candidate',
        ...(invalidReason ? { invalidReason } : {}),
        sliceIds: [],
      };
      candidates.set(version, candidate);
    }
    const sliceId = Number(row['slice_id']);
    if (Number.isSafeInteger(sliceId) && !candidate.sliceIds.includes(sliceId)) candidate.sliceIds.push(sliceId);
  }
  return [...candidates.values()];
}
