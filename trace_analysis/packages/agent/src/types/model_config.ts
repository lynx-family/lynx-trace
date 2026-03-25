// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import z from 'zod';

export const MODEL_CONFIG_SCHEMA = z.object({
  model: z.string(),
  apiKey: z.string(),
  provider: z.string(),
  baseUrl: z.url(),
  parallelToolCalls: z.boolean().optional(),
  maxRetries: z.number().optional(),
});

export type ModelConfig = z.infer<typeof MODEL_CONFIG_SCHEMA>;
