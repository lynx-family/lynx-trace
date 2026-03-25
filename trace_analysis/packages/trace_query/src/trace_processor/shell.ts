// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

import fetch from 'node-fetch';

import { TraceProcessorException } from './exceptions';

// Default port that trace_processor_shell runs on
const TP_PORT = 9001;

/**
 * Result of loading the trace processor shell.
 */
export interface ShellLoadResult {
  url: string;
  subprocess: ChildProcess;
}

/**
 * Load and start the trace processor shell.
 * Corresponds to Python's load_shell function.
 */
export async function loadShell(
  binPath?: string,
  uniquePort: boolean = true,
  verbose: boolean = false,
  ingestFtraceInRaw: boolean = true,
  enableDevFeatures: boolean = false,
  loadTimeout: number = 2,
  extraFlags: string[] = [],
): Promise<ShellLoadResult> {
  // Get available port
  const port = uniquePort ? await getAvailablePort() : TP_PORT;
  const addr = 'localhost';
  const url = `http://${addr}:${port}`;

  // Get shell path
  const shellPath = getShellPath(binPath);

  // Build command arguments
  const args = ['-D', '--http-port', port.toString()];

  if (!ingestFtraceInRaw) {
    args.push('--no-ftrace-raw');
  }

  if (enableDevFeatures) {
    args.push('--dev');
  }

  if (extraFlags.length > 0) {
    args.push(...extraFlags);
  }

  // Start the subprocess
  const subprocess = spawn(shellPath, args, {
    stdio: verbose ? 'inherit' : 'ignore',
    detached: false,
  });
  subprocess.on('error', () => {});

  // Wait for the server to be ready
  const success = await waitForServer(url, loadTimeout);

  if (!success) {
    subprocess.kill();
    throw new TraceProcessorException(`Failed to start trace processor shell at ${url} within ${loadTimeout} seconds`);
  }

  return { url, subprocess };
}

/**
 * Get the path to the trace processor shell binary.
 */
function getShellPath(binPath?: string): string {
  if (binPath) {
    if (fs.existsSync(binPath)) {
      return binPath;
    }
    throw new TraceProcessorException(`Binary not found at ${binPath}`);
  }

  // Try to find trace_processor_shell in common locations
  const possiblePaths = [
    'trace_processor_shell',
    './trace_processor_shell',
    '../tools/trace_processor_shell',
    path.join(process.cwd(), 'trace_processor_shell'),
  ];

  // Add platform-specific extensions
  const extensions = os.platform() === 'win32' ? ['.exe', ''] : [''];

  for (const basePath of possiblePaths) {
    for (const ext of extensions) {
      const fullPath = basePath + ext;
      if (fs.existsSync(fullPath)) {
        return fullPath;
      }
    }
  }

  throw new TraceProcessorException('trace_processor_shell binary not found. Please specify binPath in config.');
}

/**
 * Get an available port for the trace processor.
 */
async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.listen(0, () => {
      const addrInfo = server.address();
      if (!addrInfo || typeof addrInfo === 'string') {
        throw new Error('Failed to get available port');
      }
      const port = addrInfo.port;
      server.close(() => {
        if (port) {
          resolve(port);
        } else {
          reject(new Error('Failed to get available port'));
        }
      });
    });

    server.on('error', reject);
  });
}

/**
 * Wait for the trace processor server to be ready.
 */
async function waitForServer(url: string, timeoutSeconds: number): Promise<boolean> {
  const startTime = Date.now();
  const timeoutMs = timeoutSeconds * 1000;

  while (Date.now() - startTime < timeoutMs) {
    try {
      // Use dynamic fetch to avoid import issues
      const response = await fetch(`${url}/status`, {
        method: 'GET',
        signal: AbortSignal.timeout(1000),
      });

      if (response.ok) {
        return true;
      }
    } catch {
      // Server not ready yet, continue waiting
    }

    // Wait 100ms before next attempt
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return false;
}
