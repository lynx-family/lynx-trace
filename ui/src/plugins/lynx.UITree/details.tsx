// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import m from 'mithril';
import {TrackEventDetailsPanel} from '../../public/details_panel';
import {TrackEventSelection} from '../../public/selection';
import {UIDetailView} from './element_detail_panel';
import UIManager from './ui_manager';
import {eventLoggerState} from '../../event_logger';
import { LynxUI } from '../../lynx_perf/common_components/ui_tree/types';

export class UIDetailsPanel implements TrackEventDetailsPanel {
  private uiTreeDetails: LynxUI[] | undefined;
  private loading: boolean;

  constructor() {
    this.loading = false;
    this.uiTreeDetails = undefined;
  }

  async load({eventId}: TrackEventSelection) {
    this.loading = true;

    this.uiTreeDetails = UIManager.getTraceIssueUI(eventId);

    if (this.uiTreeDetails) {
      eventLoggerState.state.eventLogger.logEvent('lynx_feature_usage', {
        type: 'UI'
      });
    }

    this.loading = false;
  }

  render() {
    if (this.loading) {
      return m('h2', 'Loading');
    }

    if (this.uiTreeDetails) {
      return m(UIDetailView, {details: this.uiTreeDetails});
    } else {
      return m('h2', 'No issue UI nodes');
    }
  }
}
