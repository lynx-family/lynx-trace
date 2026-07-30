// Copyright (C) 2026 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import {Time} from '../base/time';
import {TrackEventSelection} from '../public/selection';
import {lynxPerfGlobals} from './lynx_perf_globals';

function trackEventSelection(
  trackUri: string,
  eventId: number,
): TrackEventSelection {
  return {
    kind: 'track_event',
    trackUri,
    eventId,
    ts: Time.ZERO,
  };
}

describe('Lynx counter track background highlight', () => {
  beforeEach(() => {
    lynxPerfGlobals.reset();
  });

  it('matches target track IDs only for the source selection', () => {
    const source = trackEventSelection('/source', 7);
    lynxPerfGlobals.updateCounterTrackBackgroundHighlight(source, [11, 12]);

    expect(
      lynxPerfGlobals.shouldHighlightCounterTrackBackground(11, source),
    ).toBe(true);
    expect(
      lynxPerfGlobals.shouldHighlightCounterTrackBackground(13, source),
    ).toBe(false);
    expect(
      lynxPerfGlobals.shouldHighlightCounterTrackBackground(
        11,
        trackEventSelection('/source', 8),
      ),
    ).toBe(false);
    expect(
      lynxPerfGlobals.shouldHighlightCounterTrackBackground(
        11,
        trackEventSelection('/other', 7),
      ),
    ).toBe(false);
  });
});
