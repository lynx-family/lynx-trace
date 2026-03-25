// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import z from 'zod';

export const PROMPT_SCHEMA = z.object({
  name: z.string(),
  description: z.string(),
  prompt: z.string(),
  tools: z.array(z.string()).optional(),
  sub_agents: z.array(z.string()).optional(),
});

export type Prompt = z.infer<typeof PROMPT_SCHEMA>;
