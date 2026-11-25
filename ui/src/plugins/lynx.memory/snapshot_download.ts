// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import {downloadData} from '../../base/download_utils';
import {SnapshotProfile} from './snapshot_profile';
import type {SnapshotTreeNode} from './snapshot_viewer_state';

interface SnapshotWritable {
  write(content: string): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

interface SnapshotFile {
  createWritable(): Promise<SnapshotWritable>;
}

interface SnapshotDirectory {
  getDirectoryHandle(
    name: string,
    options: {create: boolean},
  ): Promise<SnapshotDirectory>;
  getFileHandle(
    name: string,
    options?: {create: boolean},
  ): Promise<SnapshotFile>;
}

interface SnapshotPickers {
  showSaveFilePicker?: (
    options: SaveFilePickerOptions,
  ) => Promise<SnapshotFile>;
  showDirectoryPicker?: (options: {
    mode: 'readwrite';
  }) => Promise<SnapshotDirectory>;
}

export interface SnapshotExportEntry {
  directories: string[];
  fileName: string;
  snapshot: SnapshotProfile;
}

function pathName(value: string): string {
  const name = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/, '')
    .trim();
  return name || 'Snapshots';
}

export function snapshotDownloadFileName(id: string, ordinal: number): string {
  return `${pathName(id)}#${ordinal}.heapsnapshot`;
}

function uniqueName(name: string, used: Set<string>): string {
  let candidate = name;
  for (let index = 2; used.has(candidate.toLowerCase()); index++) {
    candidate = `${name} (${index})`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

/** Captures the displayed subtree, including collapsed descendants. */
export function snapshotExportEntries(
  node: SnapshotTreeNode,
): SnapshotExportEntry[] {
  const entries: SnapshotExportEntry[] = [];
  const visit = (current: SnapshotTreeNode, directories: string[]) => {
    if (current.snapshot) {
      entries.push({
        directories,
        fileName: snapshotDownloadFileName(
          current.snapshot.id,
          current.sequence!.ordinal,
        ),
        snapshot: current.snapshot,
      });
      return;
    }
    const childrenPath = [...directories, pathName(current.name)];
    const used = new Set<string>();
    for (const child of current.children ?? []) {
      if (child.snapshot) visit(child, childrenPath);
      else {
        visit(
          {...child, name: uniqueName(pathName(child.name), used)},
          childrenPath,
        );
      }
    }
  };
  visit(node, []);
  return entries;
}

function isCancelled(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

async function writeSnapshot(file: SnapshotFile, content: string) {
  const stream = await file.createWritable();
  try {
    await stream.write(content);
    await stream.close();
  } catch (error) {
    await stream.abort().catch(() => {});
    throw error;
  }
}

/** Chooses an unused name so duplicate identifiers and existing files survive. */
async function newSnapshotFile(
  directory: SnapshotDirectory,
  name: string,
): Promise<SnapshotFile> {
  const stem = name.slice(0, -'.heapsnapshot'.length);
  for (let index = 1; ; index++) {
    const candidate = index === 1 ? name : `${stem} (${index}).heapsnapshot`;
    try {
      await directory.getFileHandle(candidate);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') {
        return directory.getFileHandle(candidate, {create: true});
      }
      // A directory with this name must also be preserved.
      if (
        !(error instanceof DOMException && error.name === 'TypeMismatchError')
      ) {
        throw error;
      }
    }
  }
}

export function snapshotDirectoryDownloadsSupported(): boolean {
  return (
    (window as unknown as SnapshotPickers).showDirectoryPicker !== undefined
  );
}

export class SnapshotTreeDownloader {
  busy = false;
  status?: string;
  error?: string;
  private disposed = false;

  constructor(
    private readonly loadContent: (profile: SnapshotProfile) => Promise<string>,
    private readonly redraw: () => void,
  ) {}

  dispose() {
    this.disposed = true;
  }

  async download(node: SnapshotTreeNode): Promise<void> {
    if (this.busy || this.disposed) return;
    const entries = snapshotExportEntries(node);
    if (entries.length === 0) return;
    const pickers = window as unknown as SnapshotPickers;
    if (!node.snapshot && !pickers.showDirectoryPicker) return;
    this.busy = true;
    this.error = undefined;
    this.status = `Downloading 0/${entries.length}...`;
    this.redraw();
    let completed = 0;
    try {
      if (node.snapshot) {
        // Invoke the picker before querying chunks to retain click activation.
        const file = await pickers.showSaveFilePicker?.({
          suggestedName: entries[0].fileName,
          types: [
            {
              description: 'Heap Snapshot',
              accept: {'application/json': ['.heapsnapshot']},
            },
          ],
        });
        if (this.disposed) return;
        const content = await this.loadContent(node.snapshot);
        if (this.disposed) return;
        if (file) await writeSnapshot(file, content);
        else {
          downloadData(
            entries[0].fileName,
            new TextEncoder().encode(content).buffer,
          );
        }
        completed = 1;
      } else {
        const root = await pickers.showDirectoryPicker!({mode: 'readwrite'});
        const directories = new Map<string, SnapshotDirectory>([['[]', root]]);
        for (const entry of entries) {
          if (this.disposed) return;
          let directory = root;
          const path: string[] = [];
          for (const name of entry.directories) {
            if (this.disposed) return;
            path.push(name);
            const key = JSON.stringify(path);
            let child = directories.get(key);
            if (!child) {
              child = await directory.getDirectoryHandle(name, {create: true});
              directories.set(key, child);
            }
            directory = child;
          }
          // Read and write one snapshot at a time.
          const content = await this.loadContent(entry.snapshot);
          if (this.disposed) return;
          const file = await newSnapshotFile(directory, entry.fileName);
          if (this.disposed) return;
          await writeSnapshot(file, content);
          completed++;
          this.status = `Downloading ${completed}/${entries.length}...`;
          this.redraw();
        }
      }
      this.status = `Downloaded ${completed}/${entries.length} snapshots.`;
    } catch (error) {
      this.status = undefined;
      if (!isCancelled(error) && !this.disposed) {
        this.error = `Download failed after saving ${completed}/${entries.length} snapshots: ${error}`;
      }
    } finally {
      this.busy = false;
      if (!this.disposed) this.redraw();
    }
  }
}
