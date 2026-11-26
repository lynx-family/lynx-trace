// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0.
// Run with: node capture_lynx_piper.cjs <absolute-generator.js> <output-dir> [generator arguments...]
// Executes the checkout's original generator without modifying tracked files.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { createHash } = require('node:crypto');

const [generator, outputDirectory, ...args] = process.argv.slice(2);
if (!path.isAbsolute(generator || '') || !path.isAbsolute(outputDirectory || '')) {
  throw new Error('Expected absolute generator and output-directory paths; run from its package directory.');
}
fs.mkdirSync(outputDirectory, { recursive: true });
const load = Module._load;
const captured = new WeakMap();
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
Module._load = function (request, parent, isMain) {
  const exports = load.apply(this, arguments);
  if (request === 'esbuild') {
    return {
      ...exports,
      buildSync(options) {
        assert.equal(options.write, false, 'Only in-memory piper generators are supported.');
        const original = exports.buildSync(options);
        assert.equal(original.outputFiles.length, 1);
        const outfile = path.resolve('.trace-source-map/generated.js');
        const mapped = exports.buildSync({ ...options, outfile, sourcemap: 'external', sourcesContent: true });
        const js = mapped.outputFiles.find((file) => file.path === outfile);
        const map = mapped.outputFiles.find((file) => file.path === `${outfile}.map`);
        assert.ok(js && map, 'Generator did not produce JS and map.');
        assert.deepEqual(js.contents, original.outputFiles[0].contents, 'Source map build changed runtime bytes.');
        const raw = JSON.parse(map.text);
        raw.sources = raw.sources.map((source) => path.resolve(path.dirname(outfile), raw.sourceRoot || '', source));
        delete raw.sourceRoot;
        captured.set(original, { raw, bytes: js.contents, options, esbuildVersion: exports.version });
        return original;
      },
    };
  }
  if (request.endsWith('/write_piper_cc')) {
    return {
      ...exports,
      writePiper(result, header, symbol) {
        const record = captured.get(result);
        assert.ok(record, 'Piper output was not captured.');
        const filename = header.replace(/_piper\.h$/, '.js').replace(/\.h$/, '.js');
        record.raw.file = filename;
        const script = path.join(outputDirectory, filename);
        fs.writeFileSync(script, record.bytes);
        fs.writeFileSync(`${script}.map`, JSON.stringify(record.raw));
        fs.writeFileSync(
          `${script}.build.json`,
          JSON.stringify(
            {
              generator,
              cwd: process.cwd(),
              args,
              header,
              symbol,
              esbuildVersion: record.esbuildVersion,
              options: record.options,
              scriptSha256: sha256(record.bytes),
              byteIdenticalToPiperInput: true,
            },
            null,
            2,
          ),
        );
        return exports.writePiper(result, header, symbol);
      },
    };
  }
  return exports;
};
process.argv = [process.execPath, generator, ...args];
require(generator);
