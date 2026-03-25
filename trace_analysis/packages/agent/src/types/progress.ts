// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

/**
 * Types of progress events that can be reported
 */
export type ProgressEventType = 'agent_start' | 'agent_end' | 'tool_call' | 'error' | 'finish' | 'summary';

/**
 * Specific details for each type of progress event
 */
export type ProgressEventDetails = {
  agent_start: {
    initialMessages?: Array<{ role: string; content: any }>;
  };
  agent_end: {
    result?: any;
  };
  tool_call: {
    args: Record<string, any>;
    result?: any;
    error?: any;
    toolName: string;
  };
  error: {
    errorMessage: string;
  };
  finish: {
    result: string;
  };
  summary: {
    summaryMessage: string;
  };
};

/**
 * Generic progress event interface with type-specific details
 */
export type ProgressEvent<T extends ProgressEventType = ProgressEventType> = {
  type: T;
  agentId: string;
  parentAgentId?: string;
  agentName: string;
  details: T extends keyof ProgressEventDetails ? ProgressEventDetails[T] : Record<string, any>;
};

/**
 * Interface for reporting progress events
 */
export interface ProgressReporter {
  /**
   * Report a progress event
   * @param event The progress event to report
   */
  report<T extends ProgressEventType>(event: ProgressEvent<T>): Promise<void>;
}
