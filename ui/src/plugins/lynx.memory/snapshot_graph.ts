// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import type {SnapshotClassChange} from './snapshot_comparison';

export interface SnapshotSourceLocation {
  script: string;
  scriptId: number;
  offset?: number;
  generatedLine?: number;
  generatedColumn?: number;
  generatedUrl?: string;
  projectId?: string;
  file?: string;
  line?: number;
  column?: number;
  url?: string;
  snippet?: string;
  snippetStartLine?: number;
  generatedSnippet?: {
    before: string;
    after: string;
    truncatedBefore: boolean;
    truncatedAfter: boolean;
  };
  error?: string;
}

export interface SnapshotObject {
  sourceLocation?: SnapshotSourceLocation;
  index: number;
  id: number;
  name: string;
  type: string;
  distance: number;
  shallowSize: number;
  retainedSize: number;
  referenceCount: number;
}

export interface SnapshotClass {
  key: string;
  name: string;
  type: string;
  count: number;
  distance: number;
  shallowSize: number;
  retainedSize: number;
}

export interface SnapshotScript {
  scriptId: number;
  name: string;
}

export interface SnapshotSummary {
  nodeCount: number;
  edgeCount: number;
  totalSize: number;
  unreachableCount: number;
  classes: SnapshotClass[];
  scripts: SnapshotScript[];
}

export interface SnapshotReference {
  edgeIndex: number;
  name: string;
  type: string;
  weak: boolean;
  object: SnapshotObject;
}

export interface SnapshotObjectPage {
  items: SnapshotObject[];
  total: number;
}

export interface SnapshotObjectLocation {
  object: SnapshotObject;
  group?: {key: string; position: number};
}

export interface SnapshotReferencePage {
  items: SnapshotReference[];
  total: number;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Incompatible snapshot: missing ${label}.`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Incompatible snapshot: missing ${label}.`);
  }
  return value;
}

function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Incompatible snapshot: invalid ${label}.`);
  }
  return value;
}

function field(fields: unknown[], name: string): number {
  const index = fields.indexOf(name);
  if (index < 0) throw new Error(`Incompatible snapshot: missing ${name}.`);
  return index;
}

function parseSnapshot(content: string): Record<string, unknown> {
  if (content.trim() === '') {
    throw new Error('This snapshot contains no data.');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new Error(
      'Invalid snapshot JSON. The captured chunks may be incomplete.',
    );
  }
  return record(raw, 'snapshot data');
}

function nodeSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error('Incompatible snapshot: invalid self_size.');
  }
  return value;
}

/** Reads the same shallow-size total without building a reference graph. */
export function snapshotTotalSize(content: string): number {
  const data = parseSnapshot(content);
  const header = record(data.snapshot, 'snapshot');
  const fields = array(
    record(header.meta, 'snapshot.meta').node_fields,
    'node_fields',
  );
  const nodes = array(data.nodes, 'nodes');
  const count = integer(header.node_count, 'node_count');
  const sizeIndex = field(fields, 'self_size');
  if (count === 0 || nodes.length !== count * fields.length) {
    throw new Error(
      'Incompatible snapshot: node count does not match the data.',
    );
  }
  let total = 0;
  for (let node = 0; node < count; node++) {
    total += nodeSize(nodes[node * fields.length + sizeIndex]);
  }
  return total;
}

/** A heap graph. Weak edges are visible but do not establish reachability. */
export class SnapshotGraph {
  private readonly names: Uint32Array;
  private readonly types: Uint16Array;
  private readonly ids: Float64Array;
  private readonly sizes: Float64Array;
  private readonly distances: Int32Array;
  private readonly retained: Float64Array;
  private readonly outgoing: Uint32Array;
  private readonly targets: Uint32Array;
  private readonly sources: Uint32Array;
  private readonly edgeNames: Uint32Array;
  private readonly edgeTypes: Uint16Array;
  private readonly incoming: Uint32Array;
  private readonly incomingEdges: Uint32Array;
  private readonly nodeTypes: string[];
  private readonly referenceTypes: string[];
  private readonly strings: string[];
  private readonly root: number;
  private readonly groups = new Map<string, number[]>();
  private readonly locations = new Map<number, SnapshotSourceLocation>();
  readonly summary: SnapshotSummary;

  constructor(
    content: string,
    resolvedSources?: Record<string, SnapshotSourceLocation>,
  ) {
    const data = parseSnapshot(content);
    const header = record(data.snapshot, 'snapshot');
    const meta = record(header.meta, 'snapshot.meta');
    const nodes = array(data.nodes, 'nodes');
    const edges = array(data.edges, 'edges');
    this.strings = array(data.strings, 'strings') as string[];
    if (!this.strings.every((value) => typeof value === 'string')) {
      throw new Error('Incompatible snapshot: invalid string table.');
    }
    const nf = array(meta.node_fields, 'node_fields');
    const ef = array(meta.edge_fields, 'edge_fields');
    this.nodeTypes = array(
      array(meta.node_types, 'node_types')[field(nf, 'type')],
      'node type names',
    ) as string[];
    this.referenceTypes = array(
      array(meta.edge_types, 'edge_types')[field(ef, 'type')],
      'edge type names',
    ) as string[];
    if (
      !this.nodeTypes.every((type) => typeof type === 'string') ||
      !this.referenceTypes.every((type) => typeof type === 'string') ||
      this.nodeTypes.length > 65536 ||
      this.referenceTypes.length > 65536
    ) {
      throw new Error('Incompatible snapshot: invalid type table.');
    }
    const count = integer(header.node_count, 'node_count');
    const edgeCount = integer(header.edge_count, 'edge_count');
    if (
      count === 0 ||
      count >= 0x7fffffff ||
      edgeCount >= 0xffffffff ||
      nodes.length !== count * nf.length ||
      edges.length !== edgeCount * ef.length
    ) {
      throw new Error(
        'Incompatible snapshot: node/edge counts do not match the data.',
      );
    }
    const nt = field(nf, 'type');
    // Optional location metadata must not make legacy/V8 heaps unreadable.
    const lf = Array.isArray(meta.location_fields) ? meta.location_fields : [];
    const oi = lf.indexOf('object_index');
    const si = lf.indexOf('script_id');
    const so = lf.indexOf('source_offset');
    const li = lf.indexOf('line');
    const co = lf.indexOf('column');
    const locations = Array.isArray(data.locations) ? data.locations : [];
    const table = data.primjs_sources as
      | {
          version?: number;
          fields?: string[];
          scripts?: number[];
        }
      | undefined;
    const scriptNames = new Map<number, string>();
    const scripts: SnapshotScript[] = [];
    if (
      table?.version === 1 &&
      Array.isArray(table.fields) &&
      Array.isArray(table.scripts)
    ) {
      const id = table.fields.indexOf('script_id');
      const name = table.fields.indexOf('name');
      if (id >= 0 && name >= 0) {
        for (
          let i = 0;
          i + table.fields.length <= table.scripts.length;
          i += table.fields.length
        ) {
          const scriptId = table.scripts[i + id];
          const nameIndex = table.scripts[i + name];
          if (
            !Number.isSafeInteger(scriptId) ||
            scriptId < 0 ||
            !Number.isSafeInteger(nameIndex) ||
            nameIndex < 0 ||
            nameIndex >= this.strings.length
          ) {
            continue;
          }
          const scriptName = this.strings[nameIndex];
          scriptNames.set(scriptId, scriptName);
          scripts.push({scriptId, name: scriptName});
        }
      }
    }
    if (oi >= 0 && si >= 0 && (so >= 0 || (li >= 0 && co >= 0))) {
      for (let i = 0; i + lf.length <= locations.length; i += lf.length) {
        const node = Number(locations[i + oi]) / nf.length;
        if (!Number.isSafeInteger(node) || node < 0 || node >= count) continue;
        const scriptId = Number(locations[i + si]);
        const location: SnapshotSourceLocation = {
          scriptId,
          script: scriptNames.get(scriptId) ?? `script_id:${scriptId}`,
          error: 'No frontend source mapping is available for this node.',
        };
        if (so >= 0) {
          const offset = Number(locations[i + so]);
          if (!Number.isSafeInteger(offset) || offset < 0) continue;
          location.offset = offset;
        } else {
          location.generatedLine = Number(locations[i + li]) + 1;
          location.generatedColumn = Number(locations[i + co]);
        }
        const resolved = resolvedSources?.[node];
        this.locations.set(node, resolved ?? location);
      }
    }
    const nn = field(nf, 'name');
    const ni = field(nf, 'id');
    const ns = field(nf, 'self_size');
    const ne = field(nf, 'edge_count');
    const et = field(ef, 'type');
    const en = field(ef, 'name_or_index');
    const to = field(ef, 'to_node');
    this.names = new Uint32Array(count);
    this.types = new Uint16Array(count);
    this.ids = new Float64Array(count);
    this.sizes = new Float64Array(count);
    this.distances = new Int32Array(count).fill(-1);
    this.retained = new Float64Array(count);
    this.outgoing = new Uint32Array(count + 1);
    this.targets = new Uint32Array(edgeCount);
    this.sources = new Uint32Array(edgeCount);
    this.edgeNames = new Uint32Array(edgeCount);
    this.edgeTypes = new Uint16Array(edgeCount);
    this.incoming = new Uint32Array(count + 1);
    this.incomingEdges = new Uint32Array(edgeCount);
    let cursor = 0;
    for (let node = 0; node < count; node++) {
      const offset = node * nf.length;
      const name = integer(nodes[offset + nn], 'node name');
      const type = integer(nodes[offset + nt], 'node type');
      if (name >= this.strings.length || type >= this.nodeTypes.length) {
        throw new Error('Incompatible snapshot: node name/type out of bounds.');
      }
      this.names[node] = name;
      this.types[node] = type;
      this.ids[node] = integer(nodes[offset + ni], 'object ID');
      this.sizes[node] = nodeSize(nodes[offset + ns]);
      this.outgoing[node] = cursor;
      cursor += integer(nodes[offset + ne], 'node edge_count');
      if (cursor > edgeCount) {
        throw new Error('Incompatible snapshot: too many node edges.');
      }
      for (let edge = this.outgoing[node]; edge < cursor; edge++) {
        this.sources[edge] = node;
      }
    }
    this.outgoing[count] = cursor;
    if (cursor !== edgeCount) {
      throw new Error('Incompatible snapshot: edge_count mismatch.');
    }
    for (let edge = 0; edge < edgeCount; edge++) {
      const offset = edge * ef.length;
      const targetOffset = integer(edges[offset + to], 'edge target');
      const target = targetOffset / nf.length;
      const type = integer(edges[offset + et], 'edge type');
      const name = integer(edges[offset + en], 'edge name');
      if (
        !Number.isInteger(target) ||
        target >= count ||
        type >= this.referenceTypes.length
      ) {
        throw new Error(
          'Incompatible snapshot: edge target/type out of bounds.',
        );
      }
      if (
        !['element', 'hidden'].includes(this.referenceTypes[type]) &&
        name >= this.strings.length
      ) {
        throw new Error('Incompatible snapshot: edge name out of bounds.');
      }
      this.targets[edge] = target;
      this.edgeTypes[edge] = type;
      this.edgeNames[edge] = name;
      this.incoming[target + 1]++;
    }
    for (let node = 1; node <= count; node++) {
      this.incoming[node] += this.incoming[node - 1];
    }
    const next = this.incoming.slice();
    for (let edge = 0; edge < edgeCount; edge++) {
      this.incomingEdges[next[this.targets[edge]]++] = edge;
    }
    const rootOffset = header.root_index ?? 0;
    this.root = integer(rootOffset, 'root_index') / nf.length;
    if (!Number.isInteger(this.root) || this.root >= count) {
      throw new Error('Invalid snapshot root.');
    }
    const queue = new Uint32Array(count);
    let first = 0;
    let last = 1;
    queue[0] = this.root;
    this.distances[this.root] = 0;
    while (first < last) {
      const node = queue[first++];
      for (
        let edge = this.outgoing[node];
        edge < this.outgoing[node + 1];
        edge++
      ) {
        const target = this.targets[edge];
        if (this.isStrong(edge) && this.distances[target] === -1) {
          this.distances[target] = this.distances[node] + 1;
          queue[last++] = target;
        }
      }
    }
    const dominators = this.buildDominators();
    this.retained.set(this.sizes);
    // Dominator depth order ensures children are accumulated before ancestors.
    const children = new Uint32Array(count + 1);
    for (let node = 0; node < count; node++) {
      if (dominators[node] >= 0 && node !== this.root) {
        children[dominators[node] + 1]++;
      }
    }
    for (let node = 1; node <= count; node++) {
      children[node] += children[node - 1];
    }
    const childNodes = new Uint32Array(count);
    const positions = children.slice();
    for (let node = 0; node < count; node++) {
      if (dominators[node] >= 0 && node !== this.root) {
        childNodes[positions[dominators[node]]++] = node;
      }
    }
    first = 0;
    last = 1;
    queue[0] = this.root;
    while (first < last) {
      const node = queue[first++];
      for (let i = children[node]; i < children[node + 1]; i++) {
        queue[last++] = childNodes[i];
      }
    }
    for (let i = last - 1; i > 0; i--) {
      this.retained[dominators[queue[i]]] += this.retained[queue[i]];
    }
    const classes = new Map<string, SnapshotClass>();
    let totalSize = 0;
    const classKeys: Array<string | undefined> = new Array(count);
    for (let node = 0; node < count; node++) {
      totalSize += this.sizes[node];
      const type = this.nodeTypes[this.types[node]];
      // Zero-size holder metadata stays available in retainer chains.
      if (type === 'synthetic' || this.sizes[node] === 0) continue;
      const name = this.className(node);
      const key = JSON.stringify([type, name]);
      classKeys[node] = key;
      const group = classes.get(key) ?? {
        key,
        name,
        type,
        count: 0,
        distance: -1,
        shallowSize: 0,
        retainedSize: 0,
      };
      group.count++;
      group.shallowSize += this.sizes[node];
      const distance = this.distances[node];
      if (distance >= 0 && (group.distance < 0 || distance < group.distance)) {
        group.distance = distance;
      }
      classes.set(key, group);
      const indexes = this.groups.get(key) ?? [];
      indexes.push(node);
      this.groups.set(key, indexes);
    }
    // Sum disjoint dominator subtrees for each class, avoiding nested doubles.
    const seenClasses = new Set<string>();
    const stack: Array<{node: number; exit: boolean; added?: string}> = [
      {node: this.root, exit: false},
    ];
    while (stack.length) {
      const entry = stack.pop()!;
      if (entry.exit) {
        if (entry.added !== undefined) seenClasses.delete(entry.added);
        continue;
      }
      const key = classKeys[entry.node];
      let added: string | undefined;
      if (key !== undefined && !seenClasses.has(key)) {
        classes.get(key)!.retainedSize += this.retained[entry.node];
        seenClasses.add(key);
        added = key;
      }
      stack.push({node: entry.node, exit: true, added});
      for (let i = children[entry.node]; i < children[entry.node + 1]; i++) {
        stack.push({node: childNodes[i], exit: false});
      }
    }
    for (let node = 0; node < count; node++) {
      const key = classKeys[node];
      if (this.distances[node] < 0 && key !== undefined) {
        classes.get(key)!.retainedSize += this.sizes[node];
      }
    }
    for (const indexes of this.groups.values()) {
      indexes.sort(
        (a, b) =>
          this.retained[b] - this.retained[a] || this.ids[a] - this.ids[b],
      );
    }
    this.summary = {
      nodeCount: count,
      edgeCount,
      totalSize,
      unreachableCount: count - last,
      classes: [...classes.values()].sort(
        (a, b) =>
          b.retainedSize - a.retainedSize || a.name.localeCompare(b.name),
      ),
      scripts,
    };
  }

  private isStrong(edge: number): boolean {
    const type = this.referenceTypes[this.edgeTypes[edge]];
    return (
      type !== 'weak' &&
      (type !== 'shortcut' || this.sources[edge] === this.root)
    );
  }

  /** Lengauer–Tarjan immediate dominators, with iterative DFS/path compression. */
  private buildDominators(): Int32Array {
    const n = this.names.length;
    const order = new Uint32Array(n);
    const rank = new Int32Array(n).fill(-1);
    const parent = new Int32Array(n).fill(-1);
    const semi = new Int32Array(n).fill(-1);
    const ancestor = new Int32Array(n).fill(-1);
    const label = new Int32Array(n);
    const idom = new Int32Array(n).fill(-1);
    const bucket = new Int32Array(n).fill(-1);
    const nextBucket = new Int32Array(n).fill(-1);
    const stack: number[] = [this.root];
    const nextEdge: number[] = [this.outgoing[this.root]];
    let count = 1;
    order[0] = this.root;
    rank[this.root] = semi[this.root] = 0;
    label[this.root] = this.root;
    while (stack.length) {
      const pos = stack.length - 1;
      const node = stack[pos];
      const edge = nextEdge[pos]++;
      if (edge >= this.outgoing[node + 1]) {
        stack.pop();
        nextEdge.pop();
        continue;
      }
      const target = this.targets[edge];
      if (!this.isStrong(edge) || rank[target] >= 0) continue;
      parent[target] = node;
      order[count] = target;
      rank[target] = semi[target] = count++;
      label[target] = target;
      stack.push(target);
      nextEdge.push(this.outgoing[target]);
    }
    const path: number[] = [];
    const evaluate = (node: number): number => {
      if (ancestor[node] < 0) return label[node];
      path.length = 0;
      let current = node;
      while (ancestor[current] >= 0 && ancestor[ancestor[current]] >= 0) {
        path.push(current);
        current = ancestor[current];
      }
      for (let i = path.length - 1; i >= 0; i--) {
        current = path[i];
        if (semi[label[ancestor[current]]] < semi[label[current]]) {
          label[current] = label[ancestor[current]];
        }
        ancestor[current] = ancestor[ancestor[current]];
      }
      return label[node];
    };
    for (let i = count - 1; i > 0; i--) {
      const node = order[i];
      for (let p = this.incoming[node]; p < this.incoming[node + 1]; p++) {
        const edge = this.incomingEdges[p];
        const from = this.sources[edge];
        if (!this.isStrong(edge) || rank[from] < 0) continue;
        semi[node] = Math.min(semi[node], semi[evaluate(from)]);
      }
      const owner = order[semi[node]];
      nextBucket[node] = bucket[owner];
      bucket[owner] = node;
      ancestor[node] = parent[node];
      for (
        let member = bucket[parent[node]];
        member >= 0;
        member = nextBucket[member]
      ) {
        const best = evaluate(member);
        idom[member] = semi[best] < semi[member] ? best : parent[node];
      }
      bucket[parent[node]] = -1;
    }
    idom[this.root] = this.root;
    for (let i = 1; i < count; i++) {
      const node = order[i];
      if (idom[node] !== order[semi[node]]) idom[node] = idom[idom[node]];
    }
    return idom;
  }

  private className(index: number): string {
    const type = this.nodeTypes[this.types[index]];
    if (['string', 'concatenated string', 'sliced string'].includes(type)) {
      return `(${type})`;
    }
    if (type === 'code') return '(compiled code)';
    if (type === 'object shape') return '(object shape)';
    if (type === 'closure') return 'Function';
    return this.strings[this.names[index]] || `(${type})`;
  }

  object(index: number): SnapshotObject {
    if (!Number.isInteger(index) || index < 0 || index >= this.names.length) {
      throw new Error('Invalid heap object.');
    }
    return {
      index,
      sourceLocation: this.locations.get(index),
      id: this.ids[index],
      name:
        this.strings[this.names[index]] ||
        `(${this.nodeTypes[this.types[index]]})`,
      type: this.nodeTypes[this.types[index]],
      distance: this.distances[index],
      shallowSize: this.sizes[index],
      retainedSize: this.retained[index],
      referenceCount: this.outgoing[index + 1] - this.outgoing[index],
    };
  }

  locateObject(index: number): SnapshotObjectLocation {
    const object = this.object(index);
    const key = JSON.stringify([object.type, this.className(index)]);
    const position = this.groups.get(key)?.indexOf(index) ?? -1;
    return {
      object,
      group: position < 0 ? undefined : {key, position},
    };
  }

  objects(key: string, offset: number, limit = 100): SnapshotObjectPage {
    const indexes = this.groups.get(key) ?? [];
    return {
      total: indexes.length,
      items: indexes
        .slice(offset, offset + limit)
        .map((index) => this.object(index)),
    };
  }

  changesFrom(baseline: SnapshotGraph): SnapshotClassChange[] {
    if (baseline === this) return [];
    const classes = new Map(
      [...baseline.summary.classes, ...this.summary.classes].map((group) => [
        group.key,
        group,
      ]),
    );
    const changes: SnapshotClassChange[] = [];
    for (const group of classes.values()) {
      const current = this.groups.get(group.key) ?? [];
      const previous = baseline.groups.get(group.key) ?? [];
      const previousIds = new Set(previous.map((index) => baseline.ids[index]));
      const currentIds = new Set(current.map((index) => this.ids[index]));
      const added = current.filter(
        (index) => !previousIds.has(this.ids[index]),
      );
      const deleted = previous.filter(
        (index) => !currentIds.has(baseline.ids[index]),
      );
      if (added.length === 0 && deleted.length === 0) continue;
      added.sort(
        (a, b) => this.sizes[b] - this.sizes[a] || this.ids[a] - this.ids[b],
      );
      deleted.sort(
        (a, b) =>
          baseline.sizes[b] - baseline.sizes[a] ||
          baseline.ids[a] - baseline.ids[b],
      );
      const allocatedSize = added.reduce(
        (total, index) => total + this.sizes[index],
        0,
      );
      const freedSize = deleted.reduce(
        (total, index) => total + baseline.sizes[index],
        0,
      );
      changes.push({
        summary: {
          key: group.key,
          name: group.name,
          type: group.type,
          newCount: added.length,
          deletedCount: deleted.length,
          delta: added.length - deleted.length,
          allocatedSize,
          freedSize,
          sizeDelta: allocatedSize - freedSize,
        },
        added,
        deleted,
      });
    }
    return changes.sort(
      (a, b) =>
        b.summary.allocatedSize - a.summary.allocatedSize ||
        b.summary.freedSize - a.summary.freedSize ||
        a.summary.name.localeCompare(b.summary.name),
    );
  }

  retainers(index: number, offset: number, limit = 100): SnapshotReferencePage {
    this.object(index);
    const from = this.incoming[index];
    const end = this.incoming[index + 1];
    const items: SnapshotReference[] = [];
    for (let p = from + offset; p < Math.min(end, from + offset + limit); p++) {
      const edge = this.incomingEdges[p];
      const type = this.referenceTypes[this.edgeTypes[edge]];
      items.push({
        edgeIndex: edge,
        type,
        name: ['element', 'hidden'].includes(type)
          ? `[${this.edgeNames[edge]}]`
          : this.strings[this.edgeNames[edge]],
        weak: !this.isStrong(edge),
        object: this.object(this.sources[edge]),
      });
    }
    return {total: end - from, items};
  }

  references(
    index: number,
    offset: number,
    limit = 100,
  ): SnapshotReferencePage {
    this.object(index);
    const from = this.outgoing[index];
    const end = this.outgoing[index + 1];
    const items: SnapshotReference[] = [];
    for (
      let edge = from + offset;
      edge < Math.min(end, from + offset + limit);
      edge++
    ) {
      const type = this.referenceTypes[this.edgeTypes[edge]];
      items.push({
        edgeIndex: edge,
        type,
        name: ['element', 'hidden'].includes(type)
          ? `[${this.edgeNames[edge]}]`
          : this.strings[this.edgeNames[edge]],
        weak: !this.isStrong(edge),
        object: this.object(this.targets[edge]),
      });
    }
    return {total: end - from, items};
  }
}
