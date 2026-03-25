// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

export type AgentExecutionSuccess = {
  result: string;
  success: true;
};

export type AgentExecutionError = {
  errorMessage: string;
  success: false;
};
/**
 * Simplified Agent Execution Result
 */
export type AgentExecution = AgentExecutionSuccess | AgentExecutionError;
