// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0.

// Injected by build_report_viewer.mjs, using the same shell as the standalone asset.
declare const MEMORY_REPORT_VIEWER_DOCUMENT: string;

const config = document.getElementById('memory-report-snapshots');
if (config) {
  let frame: HTMLIFrameElement | undefined;
  let ready = false;
  let initialized = false;
  let active: HTMLAnchorElement | undefined;
  let previousOverflow = '';
  const send = () => {
    frame?.contentWindow?.postMessage(
      {
        type: 'memory-snapshot-open',
        request: {
          // Parse and transfer once, only when the user opens the viewer.
          data: initialized
            ? undefined
            : JSON.parse(config.textContent ?? '{}'),
          language: document.documentElement.lang,
          selection: active?.dataset.snapshotId
            ? {
                id: active.dataset.snapshotVm,
                snapshotId: active.dataset.snapshotId,
                node:
                  active.dataset.nodeIndex !== undefined
                    ? {
                        index: Number(active.dataset.nodeIndex),
                        id: Number(active.dataset.nodeId),
                      }
                    : undefined,
              }
            : undefined,
        },
      },
      '*',
    );
    initialized = true;
  };
  document.addEventListener('click', (event) => {
    const link = (event.target as Element).closest<HTMLAnchorElement>(
      'a[data-snapshot-viewer]',
    );
    if (!link) return;
    event.preventDefault();
    active = link;
    if (!frame) {
      frame = document.createElement('iframe');
      // srcdoc inherits the report's origin, including for local file:// reports.
      // Loading a separate file gives the frame a different opaque origin and
      // prevents the browser's save-file and directory pickers from opening.
      frame.srcdoc = MEMORY_REPORT_VIEWER_DOCUMENT;
      frame.title = '快照详情 / Snapshot details';
      frame.className = 'pf-memory-report-frame';
      frame.hidden = true;
      document.body.appendChild(frame);
    }
    if (frame.hidden) {
      previousOverflow = document.body.style.overflow;
    }
    document.body.style.overflow = 'hidden';
    frame.hidden = false;
    if (ready) send();
  });
  window.addEventListener('message', ({source, data}) => {
    if (source !== frame?.contentWindow) return;
    if (data?.type === 'memory-snapshot-ready') {
      ready = true;
      initialized = false;
      send();
    } else if (data?.type === 'memory-snapshot-closed' && frame !== undefined) {
      frame.hidden = true;
      document.body.style.overflow = previousOverflow;
      active?.focus({preventScroll: true});
    }
  });
}
