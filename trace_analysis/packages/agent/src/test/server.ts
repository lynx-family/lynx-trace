// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import express, { Express } from 'express';

import { TraceAnalysis } from '../index';
import { ProgressReporter, ProgressEvent } from '../types/progress';

export class ConsoleProgressReporter implements ProgressReporter {
  private logFilePath: string;
  private logStream: fs.WriteStream;
  private events: ProgressEvent[] = [];

  constructor() {
    // Create a temporary file for logging
    const tmpDir = path.join(os.tmpdir(), 'lynx-trace-analysis-logs');
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
    const logFileName = `trace-analysis-${crypto.randomUUID()}.json`;
    this.logFilePath = path.join(tmpDir, logFileName);
    this.logStream = fs.createWriteStream(this.logFilePath);

    // Start JSON array
    this.logStream.write('[\n');
  }

  async report(event: ProgressEvent): Promise<void> {
    const logMessage = `${event.type} ${event.agentName}`;
    const detailsMessage = event.details ? JSON.stringify(event.details, null, 2) : '';

    // Log to console
    console.log(logMessage);
    if (detailsMessage) {
      console.dir(event.details);
    }

    // Store event for JSON output
    this.events.push(event);

    // Log to file as JSON object
    const eventJson = JSON.stringify(event, null, 2);
    this.logStream.write(`${eventJson},\n`);
  }

  getLogFilePath(): string {
    return this.logFilePath;
  }

  close(): void {
    // Remove trailing comma and close JSON array
    this.logStream.write(']\n');
    this.logStream.end();
  }
}

const app: Express = express();
const port = process.env['PORT'] ? parseInt(process.env['PORT']) : 3000;

app.use(express.json());

app.post('/trace_analysis', async (req, res) => {
  try {
    const { tracePath, modelConfig, language = 'Chinese', prompt = undefined } = req.body;

    if (!tracePath) {
      res.status(400).json({ error: 'tracePath is required' });
      return;
    }

    const config = modelConfig;
    const reporter = new ConsoleProgressReporter();
    const result = await TraceAnalysis(tracePath, config, language, reporter, prompt);

    // Get log file path and close the reporter
    const logPath = reporter.getLogFilePath();
    console.log(`Log file path: ${logPath}`);
    reporter.close();

    res.json({
      success: result.success,
      data: result.success ? result.result : result.errorMessage,
      logFilePath: logPath,
    });
  } catch (error) {
    console.error('Error in trace_analysis:', error);
    res
      .status(500)
      .json({ error: 'Internal server error', details: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/health', (_req, res) => {
  res.json({
    success: true,
  });
});

const server = app.listen(port, () => {
  console.log(`🚀 Lynx AI Node Server is running on http://localhost:${port}`);
  console.log(`📊 Health check: http://localhost:${port}/health`);
});

const gracefulShutdown = () => {
  console.log('🛑 Received shutdown signal, closing server...');
  server.close(() => {
    console.log('✅ Server closed gracefully');
    process.exit(0);
  });

  setTimeout(() => {
    console.error('⚠️  Server shutdown timed out, forcing exit');
    process.exit(1);
  }, 5000);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
process.on('SIGQUIT', gracefulShutdown);

export default app;
