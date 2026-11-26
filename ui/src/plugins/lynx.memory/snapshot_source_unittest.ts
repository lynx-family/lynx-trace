// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import {SnapshotSourceLocation} from './snapshot_graph';
import {sourceFunctionName} from './snapshot_source';

function location(code: string): SnapshotSourceLocation {
  const offset = code.indexOf('│');
  return {
    script: 'file://shared/lynx_core.js',
    scriptId: 1,
    line: 73,
    column: offset + 1,
    snippetStartLine: 72,
    snippet: `// Previous line\n${code.replace('│', '')}\n// Next line`,
  };
}

describe('sourceFunctionName', () => {
  it.each([
    ['  private static │mergePendingUpdate(', 'mergePendingUpdate'],
    ['│private static mergePendingUpdate(', 'mergePendingUpdate'],
    ['export│ function resolvePageGlobal(params?: {', 'resolvePageGlobal'],
    ['export │function App(props: { onMounted?: () => void }) {', 'App'],
    ['│async function* fetchItems() {', 'fetchItems'],
    ['const handler = │function namedHandler() {', 'namedHandler'],
    ['  return │function WrapTimeout(fn: Function) {', 'WrapTimeout'],
    ['│export default class BaseInstance {', 'BaseInstance'],
    ['export│ abstract class BaseApp<T> {', 'BaseApp'],
    ['  protected │async _connect(): Promise<void> {', '_connect'],
    ['  │get __sourcemap__release__() {', '__sourcemap__release__'],
    ['  │set value(value: string) {', 'value'],
    ['  │*entries(): IterableIterator<string> {', 'entries'],
    ['  private │_$executeJSON<T>(', '_$executeJSON'],
    ['  │constructor(config?: Config) {', 'constructor'],
    ['  │#update() {', '#update'],
    ['  │更新() {', '更新'],
    [
      '  setSharedData = │(dataKey: string, dataVal: unknown): void => {',
      'setSharedData',
    ],
    ['  getSharedData = │<T = unknown>(key: string): T => {', 'getSharedData'],
    ['  const onUnhandled = │(_id: number, reason: Error) => {', 'onUnhandled'],
    ['  const run = │async () => {', 'run'],
    ['  const run = async │() => {', 'run'],
    ['  const twice = │value => value * 2;', 'twice'],
    ['  canvasImpl.prototype.createCanvas = │function (', 'createCanvas'],
    ["  this._apiList['getTextInfo'] = │(", 'getTextInfo'],
    ['  getPromise: │() => {', 'getPromise'],
    ['  load: LoadHandler = │(url: string) => {', 'load'],
  ])('extracts the name at %s', (code, expected) => {
    expect(sourceFunctionName(location(code))).toBe(expected);
  });

  it.each([
    '  useEffect(│() => {',
    '  const onTap = useCallback(│() => {',
    '    lynx.setSharedData((new Date().getTime()).toString(), │() => {',
    'function outer(callback = │() => {}) {',
    'function outer() { invoke(│function () {}); }',
    '  target[name] = │(...args: any[]) => {',
    '  │() => this.nativeApp,',
    '  │function () {',
    '  │if (ready) {',
    '  │for (const item of items) {',
  ])('does not invent a name at %s', (code) => {
    expect(sourceFunctionName(location(code))).toBeUndefined();
  });

  it('requires a valid position within the available snippet', () => {
    const source = location('  private static │mergePendingUpdate(');
    for (const fields of [
      {column: undefined},
      {column: 0},
      {column: 1000},
      {column: 1.5},
      {line: undefined},
      {line: 1},
      {line: 1000},
      {snippet: ''},
      {snippetStartLine: undefined},
    ]) {
      expect(sourceFunctionName({...source, ...fields})).toBeUndefined();
    }
  });

  it('can name generated code when original source is unavailable', () => {
    expect(
      sourceFunctionName({
        script: 'background.js',
        scriptId: 1,
        generatedSnippet: {
          before: '(function(){var e=1;',
          after: 'function t(t){return t}',
          truncatedBefore: false,
          truncatedAfter: true,
        },
      }),
    ).toBe('t');
  });

  it('does not replace an original anonymous callback with a minified name', () => {
    expect(
      sourceFunctionName({
        ...location('  useEffect(│() => {'),
        generatedSnippet: {
          before: '',
          after: 'function t(){}',
          truncatedBefore: false,
          truncatedAfter: false,
        },
      }),
    ).toBeUndefined();
  });
});
