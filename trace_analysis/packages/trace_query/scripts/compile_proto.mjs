// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

/**
 * This script compiles protobuf definitions into JavaScript and TypeScript.
 *
 * Reference: This implementation is based on the `compileProtos()` function in
 * `ui/build.js`. The original function handles protobuf compilation
 * for the Perfetto UI, while this script adapts it for the trace_query package.
 *
 * @see ui/build.js - compileProtos() function
 */

import * as path from 'path';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.dirname(__dirname);
const pjoin = path.join;
const subprocesses = [];

function compileProtos() {
  console.log('Starting protobuf compilation...');
  const outputDir = pjoin(ROOT_DIR, 'dist', 'trace_processor');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
    console.log(`Created output directory: ${outputDir}`);
  }

  const dstJs = pjoin(outputDir, 'protos.js');
  const dstTs = pjoin(outputDir, 'protos.d.ts');

  // change the proto file location when the script file location is changed
  const protoFile = pjoin(ROOT_DIR, '../../../protos/perfetto/trace_processor/trace_processor.proto');
  console.log(`ROOT_DIR: ${ROOT_DIR}`);
  console.log(`Full proto file path: ${protoFile}`);
  if (!fs.existsSync(protoFile)) {
    console.error(`Proto file not found: ${protoFile}`);
    process.exit(1);
  }

  console.log(`Proto file: ${protoFile}`);
  console.log(`Output JS: ${dstJs}`);
  console.log(`Output TS: ${dstTs}`);

  // Can't put --no-comments here - The comments are load bearing for
  // the pbts invocation which follows.
  const pbjsArgs = [
    '--no-beautify',
    '--force-number',
    '--no-delimited',
    '--no-verify',
    '-t',
    'static-module',
    '-w',
    'commonjs',
    '-p',
    pjoin(ROOT_DIR, '../../..'),
    '-o',
    dstJs,
    protoFile,
  ];

  console.log('Running pbjs...');
  execModule('pbjs', pbjsArgs);

  if (!fs.existsSync(dstJs)) {
    console.error(`Failed to generate JS file: ${dstJs}`);
    process.exit(1);
  }
  // Note: If you are looking into slowness of pbts it is not pbts
  // itself that is slow. It invokes jsdoc to parse the comments out of
  // the |dstJs| with https://github.com/hegemonic/catharsis which is
  // pinning a CPU core the whole time.
  const pbtsArgs = ['--no-comments', '-p', pjoin(ROOT_DIR, '../../../'), '-o', dstTs, dstJs];

  console.log('Running pbts...');
  execModule('pbts', pbtsArgs);

  if (!fs.existsSync(dstTs)) {
    console.error(`Failed to generate TS file: ${dstTs}`);
    process.exit(1);
  }
  console.log('Protobuf compilation completed successfully!');
}

function execModule(module, args, opts) {
  const modPath = pjoin(ROOT_DIR, 'node_modules/.bin', module);
  if (!fs.existsSync(modPath)) {
    console.error(`Tool not found: ${modPath}`);
    console.error('Please ensure protobufjs-cli is installed');
    process.exit(1);
  }
  console.log(`Executing: ${modPath} ${args.join(' ')}`);
  return exec(modPath, args || [], opts);
}

function exec(cmd, args, opts) {
  opts = opts || {};
  opts.stdout = opts.stdout || 'inherit';
  const spwOpts = { cwd: ROOT_DIR, stdio: ['ignore', opts.stdout, 'inherit'] };
  const checkExitCode = (code, signal) => {
    if (signal === 'SIGINT' || signal === 'SIGTERM') return;
    if (code !== 0 && !opts.noErrCheck) {
      console.error(`${cmd} ${args.join(' ')} failed with code ${code}`);
      process.exit(1);
    }
  };
  if (opts.async) {
    const proc = spawn(cmd, args, spwOpts);
    const procIndex = subprocesses.length;
    subprocesses.push(proc);
    return new Promise((resolve) => {
      proc.on('exit', (code, signal) => {
        delete subprocesses[procIndex];
        checkExitCode(code, signal);
        resolve();
      });
    });
  } else {
    const spawnRes = spawnSync(cmd, args, spwOpts);
    checkExitCode(spawnRes.status, spawnRes.signal);
    return spawnRes;
  }
}

compileProtos();
