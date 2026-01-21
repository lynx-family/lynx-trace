// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import {LynxIssueTrack} from '../../lynx_perf/base_issue_track';
import {UIDetailsPanel} from '../../plugins/lynx.UITree/details';
import {TrackEventDetailsPanel} from '../../public/details_panel';
import {TrackEventSelection} from '../../public/selection';

export class LynxUIIssueTrack extends LynxIssueTrack {
  detailsPanel?(_: TrackEventSelection): TrackEventDetailsPanel {
    return new UIDetailsPanel();
  }
}
