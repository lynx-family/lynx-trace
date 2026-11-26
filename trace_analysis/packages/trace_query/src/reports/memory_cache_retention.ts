// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { BtsResidualContext, ResidualFinding } from '../types/memory_analysis';

type Json = Record<string, unknown>;
function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid cache evidence object');
  return value as Json;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Invalid cache evidence array');
  return value;
}
function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('Invalid cache evidence number');
  return value as number;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('Invalid cache evidence text');
  return value;
}

/** Recompute mutually exclusive rows from measured allocations, never prose or sampled objects. */
export function importCacheBreakdown(
  evidence: Json,
  finding: Json,
  refs: string[],
  context: BtsResidualContext,
): ResidualFinding['allocationBreakdown'] {
  if (finding['allocation_breakdown'] === undefined) return undefined;
  const spec = object(finding['allocation_breakdown']);
  const ref = text(spec['evidence_ref']);
  const match = /^\/snapshots\/(\d+)\/residual\/cache_retention$/.exec(ref);
  if (!match || !refs.includes(ref)) throw new Error('Cache breakdown must reference its measured evidence');
  const snapshot = object(array(evidence['snapshots'])[Number(match[1])]);
  const identities = context.snapshots.filter((s) => s.sha256 === snapshot['sha256']);
  if (identities.length !== 1) throw new Error('Cache breakdown requires unique snapshot identity');
  const nodeCount = count(snapshot['node_count']);
  const residual = object(snapshot['residual']);
  const measured = object(residual['cache_retention']);
  const generic = measured['version'] === 'holder-retention-2';
  if (!generic && measured['version'] !== 'vm-cache-retention-1') throw new Error('Unsupported retention evidence');
  const node = (raw: unknown) => {
    const n = object(raw);
    const result = { nodeIndex: count(n['ord']), nodeId: count(n['id']), bytes: count(n['self']) };
    if (result.nodeIndex >= nodeCount) throw new Error('Cache node ordinal out of bounds');
    return result;
  };
  const owners = new Map<number, { label: string; labels: string[]; nodeIndex: number; nodeId: number }>();
  const declared = new Map<string, ReturnType<typeof node>>();
  if (generic) {
    // All findings for this snapshot contribute their explicit holder
    // selections. The representative_objects display limit does not apply.
    for (const raw of array(object(evidence['analysis'])['findings'])) {
      const related = object(raw);
      if (!related['allocation_breakdown']) continue;
      const selection = object(related['allocation_breakdown']);
      if (selection['evidence_ref'] !== ref) continue;
      const relatedRefs = array(related['evidence_refs']).map(text);
      const seen = new Set<string>();
      for (const rawHolder of array(selection['holders'])) {
        const holder = object(rawHolder);
        const label = text(holder['label']);
        const pointer = text(holder['evidence_ref']);
        if (
          !label.trim() ||
          label.length > 80 ||
          !/^\/(?:snapshots|queries)\/\d+\//.test(pointer) ||
          /~(?![01])/u.test(pointer) ||
          /\/residual\/cache_retention(?:\/|$)/.test(pointer) ||
          !relatedRefs.some((parent) => pointer === parent || pointer.startsWith(`${parent}/`))
        )
          throw new Error('Invalid declared holder evidence reference');
        let current: unknown = evidence;
        let hash: unknown;
        for (const token of pointer.slice(1).split('/')) {
          if (!current || typeof current !== 'object') throw new Error('Unresolved holder evidence reference');
          const entry = current as Json;
          hash = entry['snapshot_sha256'] ?? entry['sha256'] ?? hash;
          const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
          if (!Object.prototype.hasOwnProperty.call(entry, key))
            throw new Error('Unresolved holder evidence reference');
          current = entry[key];
        }
        const n = node(current);
        const identity = JSON.stringify([n.nodeIndex, label]);
        if (hash !== snapshot['sha256'] || seen.has(identity))
          throw new Error('Ambiguous or duplicate declared holder');
        seen.add(identity);
        declared.set(JSON.stringify([label, pointer]), n);
      }
    }
  }
  const verified = new Set<string>();
  for (const raw of array(measured['owners'])) {
    const owner = object(raw);
    const n = node(owner['node']);
    const labels = array(owner['labels']).map(text);
    if (
      owners.has(n.nodeIndex) ||
      !labels.length ||
      new Set(labels).size !== labels.length ||
      labels.some((label) => !label.trim() || label.length > 80) ||
      !array(owner['root_path']).length
    )
      throw new Error('Invalid cache owner identity');
    if (generic) {
      const sources = array(owner['sources']).map(object);
      if (!sources.length || labels.some((label) => !sources.some((source) => source['label'] === label)))
        throw new Error('Missing holder selection evidence');
      for (const source of sources) {
        const key = JSON.stringify([text(source['label']), text(source['evidence_ref'])]);
        const selected = declared.get(key);
        if (
          !labels.includes(source['label'] as string) ||
          !selected ||
          selected.nodeId !== n.nodeId ||
          selected.nodeIndex !== n.nodeIndex
        )
          throw new Error('Measured holder differs from the declared evidence');
        verified.add(key);
      }
      let from = 0;
      const visited = new Set([from]);
      for (const rawStep of array(owner['root_path'])) {
        const step = object(rawStep),
          to = node(step['to']);
        if (
          node(step['from']).nodeIndex !== from ||
          visited.has(to.nodeIndex) ||
          object(step['edge'])['type'] === 'weak'
        )
          throw new Error('Invalid holder root path');
        from = to.nodeIndex;
        visited.add(from);
      }
      if (from !== n.nodeIndex || node(object(array(owner['root_path']).at(-1))['to']).nodeId !== n.nodeId)
        throw new Error('Holder root path does not reach the selected node');
    } else if (!array(owner['identity_edges']).length) throw new Error('Missing legacy cache identity');
    owners.set(n.nodeIndex, { label: labels.join(' / '), labels, nodeIndex: n.nodeIndex, nodeId: n.nodeId });
  }
  if (verified.size !== declared.size) throw new Error('Declared holders have not been measured');
  const labelCounts = new Map<string, number>();
  for (const owner of owners.values()) labelCounts.set(owner.label, (labelCounts.get(owner.label) ?? 0) + 1);
  for (const owner of owners.values()) {
    if (labelCounts.get(owner.label)! > 1) owner.label += ` @${owner.nodeId}`;
  }
  const pending = new Map<number, ReturnType<typeof node>>();
  for (const raw of array(residual['unclassified'])) {
    const n = node(raw);
    if (pending.has(n.nodeId)) throw new Error('Duplicate unclassified allocation');
    pending.set(n.nodeId, n);
  }
  if (
    [...pending.values()].reduce((sum, n) => sum + n.bytes, 0) !== count(residual['unclassified_bytes']) ||
    count(residual['target_bytes']) !== count(residual['known_non_leak_bytes']) + count(residual['unclassified_bytes'])
  )
    throw new Error('Cache allocation totals do not reconcile');
  const selected = array(spec['node_ids']).map(count);
  if (new Set(selected).size !== selected.length) throw new Error('Duplicate selected cache allocation');
  const wanted = new Set(selected);
  type Row = NonNullable<ResidualFinding['allocationBreakdown']>['rows'][number];
  const rows = new Map<string, Row>();
  const ords = new Set<number>();
  for (const raw of array(measured['allocations'])) {
    const allocation = object(raw);
    const n = node(allocation['node']);
    const expected = pending.get(n.nodeId);
    const type = text(object(allocation['node'])['type']);
    let stringPreview: { text: string; truncated: boolean } | undefined;
    if (allocation['string_preview'] !== undefined) {
      const preview = object(allocation['string_preview']);
      if (
        !['string', 'concatenated string', 'sliced string'].includes(type) ||
        typeof preview['text'] !== 'string' ||
        preview['text'].length > 256 ||
        typeof preview['truncated'] !== 'boolean'
      )
        throw new Error('Invalid allocation string preview');
      const length = [...preview['text']].length;
      if (length > 128 || (preview['truncated'] && length !== 128))
        throw new Error('Invalid allocation string preview length');
      stringPreview = { text: preview['text'], truncated: preview['truncated'] };
    }
    const otherRoot = allocation['other_root'];
    const gcAtom = allocation['gc_atom'];
    if (
      !expected ||
      expected.nodeIndex !== n.nodeIndex ||
      expected.bytes !== n.bytes ||
      ords.has(n.nodeIndex) ||
      typeof otherRoot !== 'boolean' ||
      typeof gcAtom !== 'boolean' ||
      (gcAtom && (context.engineMode !== 'gc' || type !== 'string'))
    )
      throw new Error('Cache allocation identity or engine mode mismatch');
    pending.delete(n.nodeId);
    ords.add(n.nodeIndex);
    const routes = array(allocation['owner_paths'])
      .map((rawRoute) => {
        const route = object(rawRoute);
        const owner = owners.get(count(route['owner_ord']));
        if (!owner) throw new Error('Unknown cache owner');
        let from = owner.nodeIndex;
        const visited = new Set([from]);
        const names = array(route['edges']).map((rawEdge) => {
          const edge = object(rawEdge);
          count(edge['index']);
          const to = count(edge['to_ord']);
          if (edge['from_ord'] !== from || to >= nodeCount || visited.has(to) || edge['type'] === 'weak')
            throw new Error('Invalid cache retention path');
          from = to;
          visited.add(to);
          return text(edge['name']);
        });
        if (from !== n.nodeIndex) throw new Error('Cache path does not reach allocation');
        return { owner, path: `${owner.label} → ${names.join(' → ') || `@${n.nodeId}`}` };
      })
      .sort((a, b) => a.owner.nodeIndex - b.owner.nodeIndex);
    const ownerOrds = routes.map((r) => r.owner.nodeIndex);
    if (new Set(ownerOrds).size !== ownerOrds.length) throw new Error('Duplicate cache owner path');
    if (!wanted.delete(n.nodeId)) continue;
    const key = JSON.stringify([ownerOrds, otherRoot, gcAtom]);
    if (!rows.has(key))
      rows.set(key, { bytes: 0, count: 0, owners: routes.map((r) => r.owner), otherRoot, gcAtom, samples: [] });
    const row = rows.get(key)!;
    row.bytes += n.bytes;
    row.count++;
    if (row.samples.length < 10) row.samples.push({ ...n, type, stringPreview, paths: routes.map((r) => r.path) });
  }
  if (pending.size || wanted.size) throw new Error('Incomplete cache allocation coverage');
  return {
    snapshotId: identities[0]!.snapshotId,
    bytes: [...rows.values()].reduce((sum, row) => sum + row.bytes, 0),
    nodeIds: selected,
    rows: [...rows.values()],
  };
}
