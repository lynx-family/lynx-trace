// Copyright (C) 2025 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import {enableMapSet} from 'immer';
import {ArgsDict} from '../components/sql_utils/args';
import {Description, DescriptionState} from './description_state';
import {getDescription, handleArgs} from './get_description';

function strToReg(str: string): RegExp | string {
  try {
    return eval(str);
  } catch (error) {
    return str;
  }
}

function addDescription(desc: Description[]) {
  DescriptionState.edit((draft) => {
    desc.forEach((desc) => {
      let name: string | RegExp = desc.name;
      if (name.startsWith('/')) {
        name = strToReg(name);
      }
      if (name instanceof RegExp) {
        draft.descReg.set(name, desc.description);
      } else {
        draft.descStr.set(name, desc.description);
      }
    });
  });
}

describe('getDescription', () => {
  beforeAll(() => {
    enableMapSet();
    addDescription([
      {name: '/^test/', description: '/^test/'},
      {name: '/hello/', description: '/hello/'},
      {name: '/world$/', description: '/world$/'},
      {name: 'foo', description: 'foo'},
      {name: 'bar', description: 'bar'},
      {name: 'baz', description: 'baz'},
      {name: 'test', description: 'test'},
      {name: 'withArgs', description: 'Hello @args{name}!'},
    ]);
  });

  test('should return "" when name is undefined', () => {
    expect(getDescription(undefined)).toBe('');
  });

  test('should return "" when name is an empty string', () => {
    expect(getDescription('')).toBe('');
  });

  test('should return the matched regex pattern when name matches a regex', () => {
    expect(getDescription('test123')).toBe('/^test/');
  });

  test('should return the matched string when name is in the string array', () => {
    expect(getDescription('foo')).toBe('foo');
  });

  test('should return "" when name matches neither regex nor string array', () => {
    expect(getDescription('nonexistent')).toBe('');
  });

  test('should give precedence to string match over regex match', () => {
    expect(getDescription('test')).toBe('test');
  });

  test('should replace args from a description lookup', () => {
    expect(getDescription('withArgs', {args: {name: 'World'}})).toBe(
      'Hello World!',
    );
  });
});

describe('handleArgs', () => {
  test('should return original desc when args is undefined', () => {
    expect(handleArgs('Hello @args{name}!', undefined)).toBe(
      'Hello @args{name}!',
    );
  });

  test('should handle empty args dict correctly', () => {
    expect(handleArgs('Hello @args{name}!', {})).toBe('Hello @args{name}!');
  });

  test('should replace proto debug args', () => {
    const args: ArgsDict = {
      debug: {
        name: 'World',
        place: 'Perfetto',
      },
    };
    expect(
      handleArgs('Hello @args{name}, welcome to @args{place}!', args),
    ).toBe('Hello World, welcome to Perfetto!');
  });

  test('should replace json trace args', () => {
    const args: ArgsDict = {
      args: {
        name: 'Alice',
        place: 'Wonderland',
      },
    };
    expect(
      handleArgs('Hello @args{name}, welcome to @args{place}!', args),
    ).toBe('Hello Alice, welcome to Wonderland!');
  });

  test('should prefer debug args over json trace args', () => {
    const args: ArgsDict = {
      debug: {name: 'Debug'},
      args: {name: 'Json'},
    };
    expect(handleArgs('Hello @args{name}!', args)).toBe('Hello Debug!');
  });

  test('should leave placeholder intact if no matching value is found', () => {
    expect(
      handleArgs('Hello @args{name}!', {args: {place: 'Wonderland'}}),
    ).toBe('Hello @args{name}!');
  });

  test('should handle multiple occurrences of the same placeholder', () => {
    expect(
      handleArgs('@args{name} and @args{name}', {args: {name: 'Alice'}}),
    ).toBe('Alice and Alice');
  });
});
