// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { TraceQuery } from '../utils/trace_query';

export interface ExtractedMemorySnapshot {
  snapshotId: string;
  outputPath: string;
  chunkCount: number;
  totalLength: number;
  sha256: string;
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function extractMemorySnapshot(
  traceQuery: TraceQuery,
  snapshotId: string,
  outputPath: string,
): Promise<ExtractedMemorySnapshot> {
  const escapedSnapshotId = escapeSqlLiteral(snapshotId);
  const metadataRows = await traceQuery.query(`
    SELECT
      COUNT(DISTINCT s.id) capture_count,
      MAX(CASE WHEN a.flat_key = 'debug.id' THEN a.display_value END) scope_id,
      MAX(CASE WHEN a.flat_key = 'debug.total_length' THEN a.display_value END) total_length,
      MAX(CASE WHEN a.flat_key = 'debug.chunk_count' THEN a.display_value END) chunk_count
    FROM slice s
    JOIN args a ON a.arg_set_id = s.arg_set_id
    WHERE s.name = 'capture_snapshot'
      AND EXISTS (
        SELECT 1
        FROM args snapshot_arg
        WHERE snapshot_arg.arg_set_id = s.arg_set_id
          AND snapshot_arg.flat_key = 'debug.snapshot_id'
          AND snapshot_arg.string_value = '${escapedSnapshotId}'
      )
  `);
  const metadata = metadataRows[0];
  if (toNumber(metadata?.['capture_count']) !== 1) {
    throw new Error(`Snapshot ID must identify exactly one capture: ${snapshotId}`);
  }
  if (!metadata?.['scope_id']) throw new Error(`Snapshot capture has no scope ID: ${snapshotId}`);
  const declaredLength = toNumber(metadata?.['total_length']);
  const declaredChunkCount = toNumber(metadata?.['chunk_count']);
  if (declaredChunkCount === 0) {
    throw new Error(`Snapshot not found or has no chunks: ${snapshotId}`);
  }

  const chunkRows = await traceQuery.query(`
    SELECT
      CAST(COALESCE(chunk_index.int_value, chunk_index.string_value) AS INT) chunk_index,
      CAST(COALESCE(chunk_offset.int_value, chunk_offset.string_value) AS INT) chunk_offset,
      content.string_value content
      , scope.display_value scope_id
    FROM slice s
    JOIN args snapshot_arg
      ON snapshot_arg.arg_set_id = s.arg_set_id
      AND snapshot_arg.flat_key = 'debug.snapshot_id'
    JOIN args chunk_index
      ON chunk_index.arg_set_id = s.arg_set_id
      AND chunk_index.flat_key = 'debug.chunk_index'
    LEFT JOIN args chunk_offset
      ON chunk_offset.arg_set_id = s.arg_set_id
      AND chunk_offset.flat_key = 'debug.offset'
    JOIN args content
      ON content.arg_set_id = s.arg_set_id
      AND content.flat_key = 'debug.content'
    LEFT JOIN args scope
      ON scope.arg_set_id = s.arg_set_id AND scope.flat_key = 'debug.id'
    WHERE s.name = 'snapshot_chunk'
      AND snapshot_arg.string_value = '${escapedSnapshotId}'
    ORDER BY chunk_index, chunk_offset
  `);
  if (chunkRows.length !== declaredChunkCount) {
    throw new Error(
      `Snapshot chunk count mismatch for ${snapshotId}: expected ${declaredChunkCount}, got ${chunkRows.length}`,
    );
  }

  let byteOffset = 0;
  const content = chunkRows
    .map((row, index) => {
      if (row['scope_id'] !== metadata?.['scope_id']) throw new Error(`Snapshot chunk scope mismatch: ${snapshotId}`);
      if (
        row['chunk_index'] === null ||
        row['chunk_index'] === undefined ||
        toNumber(row['chunk_index']) !== index ||
        (row['chunk_offset'] !== null &&
          row['chunk_offset'] !== undefined &&
          toNumber(row['chunk_offset']) !== byteOffset)
      ) {
        throw new Error(`Snapshot chunk index or byte offset mismatch for ${snapshotId}, chunk ${index}`);
      }
      const chunk = String(row['content'] ?? '');
      byteOffset += Buffer.byteLength(chunk, 'utf8');
      return chunk;
    })
    .join('');
  if (byteOffset !== declaredLength) {
    throw new Error(`Snapshot length mismatch for ${snapshotId}: expected ${declaredLength}, got ${byteOffset}`);
  }
  const parsed = JSON.parse(content);
  if (
    !parsed.snapshot?.meta ||
    !Array.isArray(parsed.nodes) ||
    !Array.isArray(parsed.edges) ||
    !Array.isArray(parsed.strings)
  ) {
    throw new Error(`Invalid heap snapshot structure: ${snapshotId}`);
  }

  const resolvedOutputPath = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolvedOutputPath), { recursive: true });
  fs.writeFileSync(resolvedOutputPath, content, 'utf8');
  return {
    snapshotId,
    outputPath: resolvedOutputPath,
    chunkCount: chunkRows.length,
    totalLength: byteOffset,
    sha256: createHash('sha256').update(content).digest('hex'),
  };
}
