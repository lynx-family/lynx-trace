// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import z from 'zod';

export const SkillSchema = z.object({
  name: z.string(),
  description: z.string(),
  content: z.string(),
});
