// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const path = require('path');

module.exports = {
  mode: 'production',
  entry: {
    trace_query: './packages/trace_query/dist/cli/index.js',
    trace_record: './packages/trace_record/dist/cli/index.js',
  },
  output: {
    path: path.resolve(__dirname, 'dist', 'bundles'),
    filename: '[name].bundle.cjs',
    libraryTarget: 'commonjs2',
    globalObject: 'this',
  },
  target: 'node',
  externals: [
    (context, request, callback) => {
      if (request === './hook.cjs' || request === './hook') {
        return callback(null, `commonjs ${request}`);
      }
      callback();
    },
  ],
  resolve: {
    extensions: ['.js'],
  },
  optimization: {
    minimize: false,
    concatenateModules: false,
    splitChunks: {
      chunks: 'all',
      name: 'shared',
    },
  },
  devtool: 'source-map',
};
