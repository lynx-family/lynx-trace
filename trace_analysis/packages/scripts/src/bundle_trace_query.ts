// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { execSync } from 'child_process';
import { join } from 'path';

const rootDir = join(__dirname, '../../..');

function main() {
  console.log('Starting to bundle trace_query...');

  try {
    // Execute webpack command to bundle
    execSync(`npx webpack --config ${join(__dirname, '../webpack.config.js')}`, {
      stdio: 'inherit',
      cwd: rootDir,
    });

    console.log('Bundle completed!');
  } catch (error) {
    console.error('Bundle failed:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
