// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { prompt as diff_analysis } from './references/diff_analysis';
import { prompt as frontend_sources } from './references/frontend_sources';
import { prompt as jank_analysis } from './references/jank_analysis';
import { prompt as lynx_sources } from './references/lynx_sources';
import { prompt as memory_analysis } from './references/memory_analysis';
import { prompt as metrics_analysis } from './references/metrics_analysis';
import { prompt as nativemodule_analysis } from './references/nativemodule_analysis';
import { prompt as render_pipeline } from './references/render_pipeline';
import { prompt as source_inputs } from './references/source_inputs';
import { prompt as source_preparation } from './references/source_preparation';
import { prompt as sql_guide } from './references/sql_guide';
import { prompt as timing_flag } from './references/timing_flag';

export const skills = [
  diff_analysis,
  frontend_sources,
  jank_analysis,
  lynx_sources,
  memory_analysis,
  metrics_analysis,
  nativemodule_analysis,
  render_pipeline,
  source_inputs,
  source_preparation,
  sql_guide,
  timing_flag,
];
