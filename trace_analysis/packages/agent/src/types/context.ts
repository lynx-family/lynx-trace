// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import z from 'zod';

import { MODEL_CONFIG_SCHEMA } from './model_config';

export const LANGUAGE_SCHEMA = z.enum(['Chinese', 'English']);
export type Language = z.infer<typeof LANGUAGE_SCHEMA>;

export const AGENT_CONTEXT_SCHEMA = z.object({
  modelConfig: MODEL_CONFIG_SCHEMA,
  language: LANGUAGE_SCHEMA,
  agentName: z.string().describe('The name of the agent.'),
  parentAgentId: z.string().describe('The id of the parent agent.').optional(),
  agentId: z.string().describe('The id of the agent.'),
  depth: z.number().describe('The depth of the agent in the agent tree.').default(0),
});

export type AgentContext = z.infer<typeof AGENT_CONTEXT_SCHEMA>;
