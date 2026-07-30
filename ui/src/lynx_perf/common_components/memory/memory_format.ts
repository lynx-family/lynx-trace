// Copyright (C) 2026 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

export function formatMemoryBytes(bytes: number, decimals = 2): string {
  if (!Number.isFinite(bytes)) {
    return String(bytes);
  }
  if (bytes === 0) {
    return '0 B';
  }

  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const absBytes = Math.abs(bytes);
  const unitIndex = Math.min(
    Math.floor(Math.log(absBytes) / Math.log(1024)),
    units.length - 1,
  );
  const normalizedUnitIndex = Math.max(0, unitIndex);
  const scaledValue = bytes / Math.pow(1024, normalizedUnitIndex);
  const precision = Math.max(0, decimals);
  return `${parseFloat(scaledValue.toFixed(precision))} ${
    units[normalizedUnitIndex]
  }`;
}

export function formatMemoryDeltaBytes(bytes: number, decimals = 2): string {
  const sign = bytes > 0 ? '+' : bytes < 0 ? '-' : '';
  return `${sign}${formatMemoryBytes(Math.abs(bytes), decimals)}`;
}

export function formatMemoryCounterValue(value: number, unit: string): string {
  const rateSuffix = unit.endsWith('/s') ? '/s' : '';
  return `${formatMemoryBytes(value)}${rateSuffix}`;
}

export function isMemoryCounterTrackName(trackName: string): boolean {
  return (
    /^memory_\d+$/.test(trackName) ||
    trackName.startsWith('summary.') ||
    trackName.startsWith('bts_vm_acc_')
  );
}
