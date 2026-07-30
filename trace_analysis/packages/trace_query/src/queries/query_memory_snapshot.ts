// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import * as fs from 'fs';
import * as path from 'path';

import { TraceQuery } from '../utils/trace_query';

export interface ExtractedMemorySnapshot {
  snapshotId: string;
  outputPath: string;
  chunkCount: number;
  totalLength: number;
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
  const declaredLength = toNumber(metadata?.['total_length']);
  const declaredChunkCount = toNumber(metadata?.['chunk_count']);
  if (declaredChunkCount === 0) {
    throw new Error(`Snapshot not found or has no chunks: ${snapshotId}`);
  }

  const chunkRows = await traceQuery.query(`
    SELECT
      CAST(chunk_index.string_value AS INT) chunk_index,
      CAST(COALESCE(chunk_offset.string_value, '0') AS INT) chunk_offset,
      content.string_value content
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
    WHERE s.name = 'snapshot_chunk'
      AND snapshot_arg.string_value = '${escapedSnapshotId}'
    ORDER BY CAST(chunk_index.string_value AS INT), CAST(COALESCE(chunk_offset.string_value, '0') AS INT)
  `);
  if (chunkRows.length !== declaredChunkCount) {
    throw new Error(
      `Snapshot chunk count mismatch for ${snapshotId}: expected ${declaredChunkCount}, got ${chunkRows.length}`,
    );
  }

  const content = chunkRows.map((row) => String(row['content'] ?? '')).join('');
  if (content.length !== declaredLength) {
    throw new Error(`Snapshot length mismatch for ${snapshotId}: expected ${declaredLength}, got ${content.length}`);
  }

  const resolvedOutputPath = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolvedOutputPath), { recursive: true });
  fs.writeFileSync(resolvedOutputPath, content, 'utf8');
  return {
    snapshotId,
    outputPath: resolvedOutputPath,
    chunkCount: chunkRows.length,
    totalLength: content.length,
  };
}
