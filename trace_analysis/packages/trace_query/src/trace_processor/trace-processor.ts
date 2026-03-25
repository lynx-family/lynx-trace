// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { ChildProcess } from 'child_process';
import * as fs from 'fs';

import { TraceProcessorConfig } from './config';
import { TraceProcessorException } from './exceptions';
import { TraceProcessorHttpClient } from './http';
import { QueryResultIterator, Row } from './query-result-iterator';
import { loadShell } from './shell';

/**
 * Reference to a trace that can be loaded.
 * Can be a file path, Buffer, or stream.
 */
export type TraceReference = string | Buffer | NodeJS.ReadableStream;

/**
 * Main TraceProcessor class for querying Perfetto traces.
 * Corresponds to Python's TraceProcessor class.
 */
export class TraceProcessor {
  public static readonly QueryResultIterator = QueryResultIterator;
  public static readonly Row = Row;

  private config: TraceProcessorConfig;
  private http?: TraceProcessorHttpClient;
  private subprocess?: ChildProcess;

  /**
   * Create a new TraceProcessor instance.
   *
   * @param trace Trace file path, Buffer, or stream
   * @param addr Optional address to connect to existing instance
   * @param config Configuration options
   * @param filePath Deprecated parameter for compatibility
   * @returns Promise<TraceProcessor>
   */
  static async create(
    trace?: TraceReference,
    addr?: string,
    config: TraceProcessorConfig = new TraceProcessorConfig(),
    filePath?: string, // deprecated parameter for compatibility
  ): Promise<TraceProcessor> {
    if (trace && filePath) {
      throw new TraceProcessorException('trace and filePath cannot both be specified.');
    }

    const tp = new TraceProcessor(config);

    // Initialize HTTP client
    await tp.initializeHttp(addr);

    // Load trace if provided
    if (trace || filePath) {
      await tp.parseTrace(trace || filePath!);
    }

    return tp;
  }

  /**
   * Constructor for TraceProcessor.
   * Note: For proper async initialization, use TraceProcessor.create() instead.
   */
  constructor(config: TraceProcessorConfig = new TraceProcessorConfig()) {
    this.config = config;
  }

  /**
   * Execute a SQL query against the loaded trace.
   *
   * @param sql SQL query string
   * @returns QueryResultIterator for iterating through results
   */
  async query(sql: string): Promise<QueryResultIterator> {
    if (!this.http) {
      throw new TraceProcessorException('TraceProcessor not initialized');
    }

    try {
      const response = await this.http.executeQuery(sql);

      if (response.error) {
        throw new TraceProcessorException(response.error);
      }

      return new QueryResultIterator(response.columnNames || [], response.batch || []);
    } catch (error) {
      if (error instanceof TraceProcessorException) {
        throw error;
      }
      throw new TraceProcessorException(`Query failed: ${error}`);
    }
  }

  /**
   * Compute metrics for the loaded trace.
   *
   * @param metrics Array of metric names to compute
   * @returns Metrics data
   */
  async metric(metrics: string[]): Promise<any> {
    if (!this.http) {
      throw new TraceProcessorException('TraceProcessor not initialized');
    }

    try {
      const response = await this.http.computeMetric(metrics);

      if (response.error) {
        throw new TraceProcessorException(response.error);
      }

      return response.metrics;
    } catch (error) {
      if (error instanceof TraceProcessorException) {
        throw error;
      }
      throw new TraceProcessorException(`Metric computation failed: ${error}`);
    }
  }

  /**
   * Enable metatrace for the currently running trace processor.
   */
  async enableMetatrace(): Promise<void> {
    if (!this.http) {
      throw new TraceProcessorException('TraceProcessor not initialized');
    }

    await this.http.enableMetatrace();
  }

  /**
   * Disable and return the metatrace data.
   */
  async disableAndReadMetatrace(): Promise<any> {
    if (!this.http) {
      throw new TraceProcessorException('TraceProcessor not initialized');
    }

    try {
      const response = await this.http.disableAndReadMetatrace();

      if (response.error) {
        throw new TraceProcessorException(response.error);
      }

      return response.metatrace;
    } catch (error) {
      if (error instanceof TraceProcessorException) {
        throw error;
      }
      throw new TraceProcessorException(`Metatrace read failed: ${error}`);
    }
  }

  /**
   * Close the trace processor and clean up resources.
   */
  close(): void {
    if (this.subprocess) {
      this.subprocess.kill();
      this.subprocess = undefined;
    }
  }

  /**
   * Initialize HTTP client, either connecting to existing instance or starting new one.
   */
  private async initializeHttp(addr?: string): Promise<void> {
    if (addr) {
      // Connect to existing trace processor instance
      this.http = new TraceProcessorHttpClient(addr);
    } else {
      // Start new trace processor instance
      try {
        const { url, subprocess } = await loadShell(
          this.config.binPath,
          this.config.uniquePort,
          this.config.verbose,
          this.config.ingestFtraceInRaw,
          this.config.enableDevFeatures,
          this.config.loadTimeout,
          this.config.extraFlags,
        );

        this.http = new TraceProcessorHttpClient(url);
        this.subprocess = subprocess;
      } catch (error) {
        throw new TraceProcessorException(`Failed to start trace processor: ${error}`);
      }
    }
  }

  /**
   * Parse and load trace data.
   */
  private async parseTrace(trace: TraceReference): Promise<void> {
    if (!this.http) {
      throw new TraceProcessorException('HTTP client not initialized');
    }

    try {
      if (typeof trace === 'string') {
        // File path
        if (!fs.existsSync(trace)) {
          throw new TraceProcessorException(`Trace file not found: ${trace}`);
        }

        await this.http.parse({
          source: 'FILE',
          file: trace,
        });
      } else if (Buffer.isBuffer(trace)) {
        // Buffer data - write to temp file first
        const tempFile = `/tmp/trace_${Date.now()}.pftrace`;
        fs.writeFileSync(tempFile, trace);

        await this.http.parse({
          source: 'FILE',
          file: tempFile,
        });

        // Clean up temp file
        fs.unlinkSync(tempFile);
      } else {
        // Stream - read chunks and send them
        const chunks: Buffer[] = [];

        for await (const chunk of trace) {
          chunks.push(Buffer.from(chunk));
        }

        const data = Buffer.concat(chunks);
        const tempFile = `/tmp/trace_${Date.now()}.pftrace`;
        fs.writeFileSync(tempFile, data);

        await this.http.parse({
          source: 'FILE',
          file: tempFile,
        });

        // Clean up temp file
        fs.unlinkSync(tempFile);
      }

      // Notify that parsing is complete
      await this.http.notifyEof();
    } catch (error) {
      if (error instanceof TraceProcessorException) {
        throw error;
      }
      throw new TraceProcessorException(`Failed to parse trace: ${error}`);
    }
  }
}
