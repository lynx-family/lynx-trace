// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.
/**
 * Custom exception raised if any trace_processor functions return a
 * response with an error defined.
 * Corresponds to Python's TraceProcessorException.
 */
export class TraceProcessorException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TraceProcessorException';

    // Maintains proper stack trace for where our error was thrown (only available on V8)
    if ((Error as any).captureStackTrace) {
      (Error as any).captureStackTrace(this, TraceProcessorException);
    }
  }
}
