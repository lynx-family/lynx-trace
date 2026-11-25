// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import type {SnapshotSourceLocation} from './snapshot_graph';

const IDENTIFIER = String.raw`[#$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*`;
const MODIFIERS =
  /^\s*(?:(?:export|default|declare|abstract|public|private|protected|static|override|readonly|async|return)\s+)*/;
const NAMED_DECLARATION = new RegExp(
  String.raw`^(?:async\s+)?(?:function\s*\*?\s*|class\s+)(${IDENTIFIER})(?=\s|[({<]|$)`,
  'u',
);
const METHOD = new RegExp(
  String.raw`^(?:(?:get|set)\s+)?\*?\s*(${IDENTIFIER})\s*(?:<[^<>]*>)?\s*\(`,
  'u',
);
const ASSIGNMENT = new RegExp(
  String.raw`^\s*(?:(?:const|let|var|public|private|protected|static|readonly|override)\s+)*(${IDENTIFIER}(?:\s*\.\s*${IDENTIFIER}|\s*\[\s*['"]${IDENTIFIER}['"]\s*\])*)(?:\s*:\s*[^=]+)?\s*=\s*(?:async\s+)?$`,
  'u',
);
const PROPERTY = new RegExp(String.raw`^\s*(${IDENTIFIER})\s*:\s*$`, 'u');
const MEMBER_NAME = new RegExp(
  String.raw`(${IDENTIFIER})(?:['"]\s*\])?\s*$`,
  'u',
);
const NON_METHODS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'with',
  'function',
  'import',
  'super',
]);

function nameAt(line: string, column: number): string | undefined {
  if (!Number.isInteger(column) || column < 1 || column > line.length + 1) {
    return undefined;
  }
  const offset = column - 1;
  const prefix = MODIFIERS.exec(line)![0];
  const declaration = line.slice(prefix.length);
  const match = NAMED_DECLARATION.exec(declaration) ?? METHOD.exec(declaration);
  if (match && !NON_METHODS.has(match[1])) {
    const nameEnd =
      prefix.length + match[0].lastIndexOf(match[1]) + match[1].length;
    // A later column may point to an anonymous callback on the same line.
    if (offset <= nameEnd) return match[1];
  }

  const after = line.slice(offset).trimStart();
  const named = NAMED_DECLARATION.exec(after);
  if (named) return named[1];

  // Only infer anonymous functions from an immediately adjacent assignment.
  // In `const onTap = useCallback(() => ...)`, onTap names the call result.
  if (
    !/^(?:async\s+)?(?:function\b|[(<]|[$_\p{ID_Start}][$_\p{ID_Continue}]*\s*=>)/u.test(
      after,
    )
  ) {
    return undefined;
  }
  const before = line.slice(0, offset);
  const assigned = ASSIGNMENT.exec(before) ?? PROPERTY.exec(before);
  return assigned ? MEMBER_NAME.exec(assigned[1])?.[1] : undefined;
}

/** Best-effort name at the exact mapped position; never search nearby lines. */
export function sourceFunctionName(
  source: SnapshotSourceLocation,
): string | undefined {
  if (source.snippet !== undefined) {
    if (
      source.line === undefined ||
      source.column === undefined ||
      source.snippetStartLine === undefined
    ) {
      return undefined;
    }
    const line =
      source.snippet.split('\n')[source.line - source.snippetStartLine];
    return line === undefined ? undefined : nameAt(line, source.column);
  }
  const generated = source.generatedSnippet;
  if (!generated) return undefined;
  const before = generated.before.slice(generated.before.lastIndexOf('\n') + 1);
  const after = generated.after.split('\n', 1)[0];
  return nameAt(before + after, before.length + 1);
}
