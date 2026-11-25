// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

export type SnapshotJsonPath = ReadonlyArray<string | number>;

export type SnapshotJsonValue =
  | {type: 'object' | 'array'; size: number}
  | {type: 'value'; text: string; truncated: boolean};

export interface SnapshotJsonPage {
  value: SnapshotJsonValue;
  entries: Array<{key: string | number; value: SnapshotJsonValue}>;
}

const PAGE_SIZE = 100;
const STRING_PREVIEW_LENGTH = 200;

function describe(value: unknown, preview = true): SnapshotJsonValue {
  if (Array.isArray(value)) return {type: 'array', size: value.length};
  if (value !== null && typeof value === 'object') {
    return {type: 'object', size: Object.keys(value).length};
  }
  const truncated =
    preview &&
    typeof value === 'string' &&
    value.length > STRING_PREVIEW_LENGTH;
  return {
    type: 'value',
    text: JSON.stringify(
      truncated ? value.slice(0, STRING_PREVIEW_LENGTH) : value,
    )!,
    truncated,
  };
}

/** Keeps raw JSON in the worker and sends only the requested tree page. */
export class SnapshotRawData {
  private readonly data: unknown;

  constructor(content: string) {
    this.data = JSON.parse(content);
  }

  page(path: SnapshotJsonPath, offset = 0): SnapshotJsonPage {
    let value = this.data;
    for (const key of path) {
      if (
        value === null ||
        typeof value !== 'object' ||
        !Object.hasOwn(value, key)
      ) {
        throw new Error('This JSON node is not available.');
      }
      value = (value as Record<string | number, unknown>)[key];
    }
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error('Invalid JSON page offset.');
    }
    const result: SnapshotJsonPage = {
      value: describe(value, false),
      entries: [],
    };
    if (result.value.type === 'value') return result;
    const keys = Array.isArray(value)
      ? undefined
      : Object.keys(value as object);
    const end = Math.min(offset + PAGE_SIZE, result.value.size);
    for (let index = offset; index < end; index++) {
      const key = keys ? keys[index] : index;
      result.entries.push({
        key,
        value: describe((value as Record<string | number, unknown>)[key]),
      });
    }
    return result;
  }
}
