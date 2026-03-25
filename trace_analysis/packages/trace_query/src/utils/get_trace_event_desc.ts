// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { eventDescriptionList } from './event_description';

let eventDocsMap: Record<string, string> | null = null;
let regexEventDocs: Array<{ regex: RegExp; description: string }> = [];

/**
 * Find the meaning based on trace event name. Automatically loads event description list on first call, reuses cache on subsequent calls.
 * @param eventName Event name string
 * @returns Event meaning description, returns null if not found
 */
export function getTraceEventDesc(eventName: string): string | null {
  ensureEventDocsMapLoaded();

  if (eventDocsMap?.[eventName]) {
    return eventDocsMap[eventName];
  }

  for (const { regex, description } of regexEventDocs) {
    if (regex.test(eventName)) {
      return description;
    }
  }

  return null;
}

/**
 * Ensure event description map is loaded
 */
function ensureEventDocsMapLoaded(): void {
  if (eventDocsMap !== null) {
    return;
  }

  const docsMap: Record<string, string> = {};
  const regexDocs: Array<{ regex: RegExp; description: string }> = [];

  for (const item of eventDescriptionList) {
    if (item.name && item.description) {
      if (item.name.startsWith('/') && item.name.endsWith('/')) {
        try {
          const regexPattern = item.name.slice(1, -1);
          const regex = new RegExp(regexPattern);
          regexDocs.push({ regex, description: item.description });
        } catch (error) {
          console.error(`Invalid regex pattern: ${item.name}`, error);
        }
      } else {
        docsMap[item.name] = item.description;
      }
    }

    if (item.historyName?.trim() && item.description) {
      docsMap[item.historyName.trim()] = item.description;
    }
  }

  eventDocsMap = docsMap;
  regexEventDocs = regexDocs;
}

/**
 * Clear cache, force reload
 */
export function clearTraceEventDescCache(): void {
  eventDocsMap = null;
  regexEventDocs = [];
}
