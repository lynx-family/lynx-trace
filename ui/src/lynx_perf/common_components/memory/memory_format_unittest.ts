// Copyright (C) 2026 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import {
  formatMemoryBytes,
  formatMemoryCounterValue,
  formatMemoryDeltaBytes,
  isMemoryCounterTrackName,
} from './memory_format';

describe('memory counter formatting', () => {
  it('formats bytes with binary units', () => {
    expect(formatMemoryBytes(0)).toBe('0 B');
    expect(formatMemoryBytes(512)).toBe('512 B');
    expect(formatMemoryBytes(1536)).toBe('1.5 KiB');
    expect(formatMemoryBytes(12 * 1024 * 1024)).toBe('12 MiB');
    expect(formatMemoryBytes(-1.5 * 1024 * 1024)).toBe('-1.5 MiB');
    expect(formatMemoryDeltaBytes(1.5 * 1024 * 1024)).toBe('+1.5 MiB');
    expect(formatMemoryDeltaBytes(-1.5 * 1024 * 1024)).toBe('-1.5 MiB');
    expect(formatMemoryDeltaBytes(0)).toBe('0 B');
    expect(formatMemoryCounterValue(2 * 1024 * 1024, 'bytes')).toBe('2 MiB');
    expect(formatMemoryCounterValue(2 * 1024 * 1024, 'bytes/s')).toBe(
      '2 MiB/s',
    );
  });

  it('recognizes Lynx memory counter track names', () => {
    expect(isMemoryCounterTrackName('memory_12')).toBe(true);
    expect(isMemoryCounterTrackName('summary.total-pss')).toBe(true);
    expect(isMemoryCounterTrackName('summary.some-memory')).toBe(true);
    expect(isMemoryCounterTrackName('bts_vm_acc_1234')).toBe(true);
    expect(isMemoryCounterTrackName('memory_invalid')).toBe(false);
    expect(isMemoryCounterTrackName('cpu.frequency')).toBe(false);
  });
});
