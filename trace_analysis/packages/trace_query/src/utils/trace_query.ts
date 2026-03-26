// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import TraceProcessor, { TraceProcessorConfig, TraceProcessorException } from '../trace_processor';
import fetch from 'node-fetch';

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

interface BinaryConfig {
  url: string;
  sha256: string;
}

interface TraceProcessorShellConfig {
  [platform: string]: {
    [arch: string]: BinaryConfig;
  };
}

const binaryCache: Map<string, string> = new Map();

export class TraceQuery {
  private traceProcessor: TraceProcessor | undefined;
  
  private traceFileCache: Map<string, string> = new Map();

  /**
   * Initialize the trace processor with the given trace path
   */
  async initProcessor(tracePath: string): Promise<void> {
    if (this.traceProcessor) {
      return;
    }

    try {
      // Determine the correct binary path based on the current system
      const binPath = await this.getBinaryPath();

      // Initialize the trace processor with the determined binary path
      const config = new TraceProcessorConfig({
        binPath: binPath,
        verbose: false,
        uniquePort: true,
        loadTimeout: 30,
      });

      // Check if trace_url is a local file path
      let traceFile: string;
      if (this.isLocalFilePath(tracePath)) {
        if (!fs.existsSync(tracePath)) {
          throw new Error(`Trace file does not exist: ${tracePath}`);
        }
        traceFile = tracePath;
      } else {
        // Download trace file and get local path
        traceFile = await this.downloadTraceFile(tracePath);
      }

      this.traceProcessor = await TraceProcessor.create(traceFile, undefined, config);
    } catch (error) {
      console.error('Error initializing TraceProcessor:', error);
      throw error;
    }
  }

  /**
   * Get the appropriate binary path for the current system
   */
  private async getBinaryPath(): Promise<string> {
    let config: BinaryConfig | undefined;

    // Check if URL and SHA256 are provided via environment variables
    const envUrl = process.env['TRACE_PROCESSOR_SHELL_URL'];
    const envSha256 = process.env['TRACE_PROCESSOR_SHELL_SHA256'];

    if (envUrl) {
      // Check if envUrl is a local file path
      try {
        // Try to parse as URL - if it fails, it's a local path
        new URL(envUrl);
        // It's a URL
        if (envSha256) {
          config = {
            url: envUrl,
            sha256: envSha256,
          };
        } else {
          throw new Error(`TRACE_PROCESSOR_SHELL_URL is set but TRACE_PROCESSOR_SHELL_SHA256 is missing. Both are required when using a custom URL.`);
        }
      } catch {
        // It's a local file path
        if (fs.existsSync(envUrl)) {
          // Use the local file directly, no need to download
          binaryCache.set(envUrl, envUrl);
          return envUrl;
        } else {
          throw new Error(`Local file specified in TRACE_PROCESSOR_SHELL_URL does not exist: ${envUrl}`);
        }
      }
    }

    if (!config) {
      const trace_processor_shell: TraceProcessorShellConfig = {
        darwin: {
          arm64: {
            url: 'https://github.com/lynx-family/lynx-trace/releases/download/trace_processor_shell-21d0b01/trace_processor_shell_darwin_arm64',
            sha256: 'c443069229f3e63e21dea29ec32151724aa88f7adfda5f8ce7887c59ffc7ce74',
          },
          x64: {
            url: 'https://github.com/lynx-family/lynx-trace/releases/download/trace_processor_shell-21d0b01/trace_processor_shell_darwin_x64',
            sha256: 'fb49570afc842c90f07d9d4f3104a2c7da8e00482849e360866b10c57cd5dd42',
          },
        },
        linux: {
          arm64: {
            url: 'https://github.com/lynx-family/lynx-trace/releases/download/trace_processor_shell-21d0b01/trace_processor_shell_linux_arm64',
            sha256: '4eb05a3472302c9256dc23df0e102ac78e1c3aedfbf45fa1f41b43c0a89c3d10',
          },
          x64: {
            url: 'https://github.com/lynx-family/lynx-trace/releases/download/trace_processor_shell-21d0b01/trace_processor_shell_linux_x64',
            sha256: 'b0851455a0aea40a524e42445c775281a3b07f4adaa664f33959fb4d1b03836f',
          },
        },
        win32: {
          x64: {
            url: 'https://github.com/lynx-family/lynx-trace/releases/download/trace_processor_shell-21d0b01/trace_processor_shell_win32.exe',
            sha256: '530bae7d289a4de67b558876ce8de16d8f72a9b1a891b363533f96002787651c',
          },
        },
      };

      const platform = os.platform();
      const arch = os.arch();

      if (trace_processor_shell[platform] && trace_processor_shell[platform][arch]) {
        config = trace_processor_shell[platform][arch];
      }

      if (!config) {
        throw new Error(`No prebuilt trace_processor_shell available for ${platform}-${arch}`);
      }
    }

    // Determine cache key based on config
    const cacheKey = envUrl && envSha256 
      ? `${config.url}-${config.sha256}` 
      : `${os.platform()}-${os.arch()}`;

    // Check if we already have a cached binary path
    if (binaryCache.has(cacheKey)) {
      return binaryCache.get(cacheKey)!;
    }

    // Generate local file path in tmp directory
    const fileName = path.basename(config.url);
    const localPath = path.join(os.tmpdir(), 'lynx-trace', fileName);

    // Check if file already exists and has correct SHA256
    if (await this.fileExistsAndValid(localPath, config.sha256)) {
      binaryCache.set(cacheKey, localPath);
      return localPath;
    }

    // Download file from remote URL with 30-second timeout
    await this.downloadBinary(config.url, localPath, config.sha256, 30000);

    // Cache the binary path
    binaryCache.set(cacheKey, localPath);

    return localPath;
  }

  /**
   * Check if a file exists and has the correct SHA256 hash
   */
  private async fileExistsAndValid(filePath: string, expectedSha256: string): Promise<boolean> {
    try {
      if (!fs.existsSync(filePath)) {
        return false;
      }

      const fileBuffer = fs.readFileSync(filePath);
      const hash = crypto.createHash('sha256');
      hash.update(fileBuffer);
      const actualSha256 = hash.digest('hex');

      return actualSha256 === expectedSha256;
    } catch (error) {
      console.error('Error checking file validity:', error);
      return false;
    }
  }

  /**
   * Safely delete a file, ignoring errors
   */
  private safeUnlink(filePath: string): void {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Ignore errors when deleting
    }
  }

  /**
   * Download a file from a URL to a local path
   */
  private async downloadFile(url: string, filePath: string, timeout: number = 60000): Promise<void> {
    // Ensure directory exists
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Use temporary file to avoid file lock issues
    const tempFilePath = `${filePath}.tmp.${Date.now()}.${Math.floor(Math.random() * 10000)}`;
    const file = fs.createWriteStream(tempFilePath);
    let timer: NodeJS.Timeout | null = null;

    try {
      const response = await fetch(url, { redirect: 'follow' });

      if (!response.ok) {
        throw new Error(`Failed to download: ${response.status}`);
      }

      if (!response.body) {
        throw new Error('No response body');
      }

      // Pipe response to file
      response.body.pipe(file);

      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => {
          file.destroy();
          this.safeUnlink(tempFilePath);
          reject(new Error(`Download timeout after ${timeout}ms for ${url}. You can also set TRACE_PROCESSOR_SHELL_URL environment variable to specify a local path to avoid downloading.`));
        }, timeout);

        file.on('finish', () => {
          if (timer) {
            clearTimeout(timer);
          }
          file.close();
          // Rename temporary file to final file - use atomic rename
          try {
            // First try to rename directly, will overwrite on Unix-like systems
            fs.renameSync(tempFilePath, filePath);
            resolve();
          } catch (renameErr: any) {
            // On Windows, remove existing file first then rename
            if (renameErr.code === 'EEXIST') {
              try {
                fs.unlinkSync(filePath);
                fs.renameSync(tempFilePath, filePath);
                resolve();
              } catch (retryErr) {
                this.safeUnlink(tempFilePath);
                reject(new Error(`Failed to rename temporary file after retry: ${retryErr}`));
              }
            } else {
              this.safeUnlink(tempFilePath);
              reject(new Error(`Failed to rename temporary file: ${renameErr}`));
            }
          }
        });

        file.on('error', (err) => {
          if (timer) {
            clearTimeout(timer);
          }
          this.safeUnlink(tempFilePath);
          reject(err);
        });

        file.on('close', () => {
          if (timer) {
            clearTimeout(timer);
          }
        });
      });
    } catch (error) {
      // Clean up on error
      file.destroy();
      this.safeUnlink(tempFilePath);
      throw error;
    }
  }

  /**
   * Download and verify a binary file
   */
  private async downloadBinary(url: string, localPath: string, expectedSha256: string, timeout: number = 60000): Promise<void> {
    await this.downloadFile(url, localPath, timeout);

    // Verify SHA256
    try {
      const fileBuffer = fs.readFileSync(localPath);
      const hash = crypto.createHash('sha256');
      hash.update(fileBuffer);
      const actualSha256 = hash.digest('hex');

      if (actualSha256 !== expectedSha256) {
        this.safeUnlink(localPath); // Remove invalid file
        throw new Error(`SHA256 mismatch. Expected: ${expectedSha256}, Got: ${actualSha256}`);
      }

      // Make file executable
      fs.chmodSync(localPath, 0o755);
    } catch (error) {
      this.safeUnlink(localPath); // Clean up on error
      throw new Error(`Error verifying downloaded file: ${error}`);
    }
  }

  /**
   * Extract the actual trace URL from a potentially encoded URL
   */
  private getTraceUrl(url: string): string {
    try {
      const parsed = new URL(url);

      // Search from query parameters
      const urlParam = parsed.searchParams.get('url');
      if (urlParam) {
        return decodeURIComponent(urlParam);
      }

      // Search from fragment
      const queryUrlIndex = url.indexOf('?');
      if (queryUrlIndex !== -1) {
        const queryString = url.substring(queryUrlIndex + 1);
        const params = new URLSearchParams(queryString);
        const encodedUrl = params.get('url');
        if (encodedUrl) {
          return decodeURIComponent(encodedUrl);
        }
      }
      return url;
    } catch {
      return url;
    }
  }

  /**
   * Generate a temporary path for a trace file based on its URL
   */
  private traceTmpPath(url: string): string {
    const tmpDir = path.join(os.tmpdir(), 'lynx-trace-files');
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }

    // Generate a unique filename based on the URL to avoid conflicts
    const urlHash = crypto.createHash('md5').update(url).digest('hex');
    const originalFilename = path.basename(new URL(url).pathname) || 'trace_file';
    const filename = `${urlHash}_${originalFilename}`;

    return path.join(tmpDir, filename);
  }

  /**
   * Check if a trace file already exists locally
   */
  private urlToFilenameExist(url: string): boolean {
    const filePath = this.traceTmpPath(url);
    return fs.existsSync(filePath);
  }

  /**
   * Download a trace file from a URL
   */
  private async downloadTrace(url: string): Promise<void> {
    const filePath = this.traceTmpPath(url);
    await this.downloadFile(url, filePath);
  }

  /**
   * Check if a path is a local file path
   */
  private isLocalFilePath(path: string): boolean {
    // Check if path is a valid local file path by checking for protocol
    try {
      // First decode the URL to handle encoded characters
      const decodedPath = decodeURI(path);
      // If it's a valid URL with protocol, it's not a local file
      new URL(decodedPath);
      return false;
    } catch {
      // If URL parsing fails, treat it as a local file path
      return true;
    }
  }

  /**
   * Download a trace file and return its local path
   */
  private async downloadTraceFile(url: string): Promise<string> {
    // Check cache first
    if (this.traceFileCache.has(url)) {
      return this.traceFileCache.get(url)!;
    }

    const traceUrl = this.getTraceUrl(url);

    if (!this.urlToFilenameExist(traceUrl)) {
      await this.downloadTrace(traceUrl);
    }

    const traceFilePath = this.traceTmpPath(traceUrl);

    // Cache the trace file path
    this.traceFileCache.set(url, traceFilePath);

    return traceFilePath;
  }

  /**
   * Execute a SQL query on the trace
   */
  async query(sql: string): Promise<Record<string, any>[]> {
    if (!this.traceProcessor) {
      throw new TraceProcessorException('TraceProcessor is not initialized. Call initProcessor first.');
    }

    try {
      const result = await this.traceProcessor.query(sql);
      const rows = result.toArray();
      return rows;
    } catch (error) {
      console.error('Error executing query:', error);
      throw error;
    }
  }

  /**
   * Destroy the trace processor and clean up resources
   */
  async destroyProcessor(): Promise<void> {
    if (this.traceProcessor) {
      try {
        this.traceProcessor.close();
      } catch (error) {
        console.error('Error closing TraceProcessor:', error);
      }
      this.traceProcessor = undefined;
    }
  }

  /**
   * Check if the trace processor is initialized
   */
  isInitialized(): boolean {
    return this.traceProcessor !== undefined;
  }

  /**
   * Clear all cached data
   */
  clearCache(): void {
    this.traceFileCache.clear();
  }
}
