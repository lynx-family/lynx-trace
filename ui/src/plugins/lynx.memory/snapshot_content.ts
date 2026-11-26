// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import {sqliteString} from '../../base/string_utils';
import {Engine} from '../../trace_processor/engine';
import {NUM_NULL, STR_NULL} from '../../trace_processor/query_result';
import {SnapshotProfile, isExternalSnapshot} from './snapshot_profile';

export function loadSnapshotProfileContent(
  engine: Engine,
  profile: SnapshotProfile,
): Promise<string> {
  return isExternalSnapshot(profile)
    ? profile.file.text()
    : loadSnapshotContent(engine, profile);
}

/** Reads just this profile's chunks, for both the viewer and downloads. */
export async function loadSnapshotContent(
  engine: Engine,
  profile: {id: string; snapshotId: string},
): Promise<string> {
  const result = await engine.query(`
    SELECT
      s.id,
      CAST(MAX(CASE WHEN a.flat_key IN ('chunk_index', 'debug.chunk_index', 'args.chunk_index')
        THEN a.display_value END) AS INT) AS chunkIndex,
      CAST(MAX(CASE WHEN a.flat_key IN ('offset', 'debug.offset', 'args.offset')
        THEN a.display_value END) AS INT) AS chunkOffset,
      MAX(CASE WHEN a.flat_key IN ('content', 'debug.content', 'args.content')
        THEN a.string_value END) AS content
    FROM slice s
    JOIN args a ON a.arg_set_id = s.arg_set_id
    WHERE s.name = 'snapshot_chunk'
      AND EXISTS (
        SELECT 1 FROM args identity
        WHERE identity.arg_set_id = s.arg_set_id
          AND identity.flat_key IN ('id', 'debug.id', 'args.id')
          AND identity.display_value = ${sqliteString(profile.id)}
      )
      AND EXISTS (
        SELECT 1 FROM args identity
        WHERE identity.arg_set_id = s.arg_set_id
          AND identity.flat_key IN ('snapshot_id', 'debug.snapshot_id', 'args.snapshot_id')
          AND identity.display_value = ${sqliteString(profile.snapshotId)}
      )
    GROUP BY s.id
    ORDER BY chunkIndex, chunkOffset, s.id
  `);
  const chunks: string[] = [];
  for (
    const row = result.iter({
      chunkIndex: NUM_NULL,
      chunkOffset: NUM_NULL,
      content: STR_NULL,
    });
    row.valid();
    row.next()
  ) {
    if (row.chunkIndex !== chunks.length || row.content === null) {
      throw new Error(
        'Snapshot chunks are missing or duplicated in this trace.',
      );
    }
    chunks.push(row.content);
  }
  if (chunks.length === 0) {
    throw new Error('No snapshot content was captured in this trace.');
  }
  return chunks.join('');
}
