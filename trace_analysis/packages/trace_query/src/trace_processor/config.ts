// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

export interface TraceProcessorConfigOptions {
  binPath?: string;
  uniquePort?: boolean;
  verbose?: boolean;
  ingestFtraceInRaw?: boolean;
  enableDevFeatures?: boolean;
  loadTimeout?: number;
  extraFlags?: string[];
}

/**
 * Configuration for TraceProcessor instances.
 * Corresponds to Python's TraceProcessorConfig.
 */
export class TraceProcessorConfig {
  public readonly binPath?: string;
  public readonly uniquePort: boolean;
  public readonly verbose: boolean;
  public readonly ingestFtraceInRaw: boolean;
  public readonly enableDevFeatures: boolean;
  public readonly loadTimeout: number;
  public readonly extraFlags: string[];

  constructor(options: TraceProcessorConfigOptions = {}) {
    this.binPath = options.binPath;
    this.uniquePort = options.uniquePort ?? true;
    this.verbose = options.verbose ?? false;
    this.ingestFtraceInRaw = options.ingestFtraceInRaw ?? false;
    this.enableDevFeatures = options.enableDevFeatures ?? false;
    this.loadTimeout = options.loadTimeout ?? 2;
    this.extraFlags = options.extraFlags ?? [];
  }
}
