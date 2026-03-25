// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const path = require('path');

module.exports = {
  mode: 'production',
  entry: './packages/trace_query/dist/cli/index.js',
  output: {
    path: path.resolve(__dirname, 'dist', 'bundles'),
    filename: 'trace_query.bundle.js',
    libraryTarget: 'commonjs2',
    globalObject: 'this',
  },
  target: 'node',
  externals: {},
  resolve: {
    extensions: ['.js'],
  },
};
