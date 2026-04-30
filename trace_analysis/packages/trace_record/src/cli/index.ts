#!/usr/bin/env node
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Writable } from 'node:stream';
import { ReadableStream } from 'node:stream/web';

import { Connector as DevtoolConnector } from '@lynx-js/devtool-connector';
import type { Connector } from '@lynx-js/devtool-connector';
import { AndroidTransport, DesktopTransport, iOSTransport, type Transport } from '@lynx-js/devtool-connector/transport';
import { Command } from 'commander';

type IOReadResponse = {
  data: string;
  eof: boolean;
};

type TracingComplete = {
  stream: number | string;
};

async function listClients(connector: Connector): Promise<any[]> {
  const clients = await connector.listClients();
  return clients.map((client) => ({
    id: client.id,
    info: client.info,
  }));
}

function createIOReadStream(handle: number) {
  let requestId = 0;
  let eof = false;
  let controller: ReadableStreamDefaultController<any> | null = null;

  const stream = new ReadableStream({
    start(c) {
      controller = c;
      sendReadRequest();
    },
  });

  function sendReadRequest() {
    if (!controller || eof) return;
    requestId++;
    controller.enqueue({
      id: requestId,
      method: 'IO.read',
      params: {
        handle,
        size: 5 * 1024 * 1024,
      },
      sessionId: -1,
    });
  }

  function onResponse(ioResult: IOReadResponse) {
    if (ioResult.eof) {
      eof = true;
      requestId++;
      controller?.enqueue({
        id: requestId,
        method: 'IO.close',
        params: {
          handle,
        },
        sessionId: -1,
      });
      controller?.close();
    } else {
      sendReadRequest();
    }
  }

  return { stream, onResponse };
}

interface CommandOptions {
  client: string;
  enableSystrace?: boolean;
  jsProfileInterval?: string;
  jsProfileType?: 'quickjs' | 'v8';
  stream?: string;
  output?: string;
}

const transports: Transport[] = [new AndroidTransport(), new DesktopTransport(), new iOSTransport()];

async function main() {
  const program = new Command();

  program.version('0.0.1').description('Trace Record CLI Tool');

  program
    .command('list-clients')
    .description('List available clients (connected apps)')
    .action(async () => {
      const connector = new DevtoolConnector(transports);
      try {
        const clients = await listClients(connector);

        if (clients.length === 0) {
          console.log(
            JSON.stringify({
              success: true,
              message: 'No available clients found.',
              clients: [],
            }),
          );
        } else {
          console.log(
            JSON.stringify({
              success: true,
              message: `Found ${clients.length} client(s):`,
              clients: clients,
            }),
          );
        }

        await Promise.allSettled(transports.map((t) => t.close()));
      } catch (error: any) {
        console.error(JSON.stringify({ success: false, error: error.message }));
        process.exit(1);
      }
    });

  program
    .command('start')
    .description('Start trace events collection')
    .requiredOption('-c, --client <clientId>', 'Client ID')
    .option('--enable-systrace', 'Enable systrace', true)
    .option('--js-profile-interval <interval>', 'JS profile interval', '-1')
    .option('--js-profile-type <type>', 'JS profile type (quickjs or v8)', 'quickjs')
    .action(async (options: CommandOptions) => {
      const connector = new DevtoolConnector(transports);
      const clientId = options.client;

      try {
        const config = {
          recordMode: 'recordContinuously',
          includedCategories: ['*'],
          excludedCategories: ['*'],
          enableSystrace: options.enableSystrace,
          bufferSize: 200 * 1024,
          JSProfileInterval: Number(options.jsProfileInterval),
          JSProfileType: options.jsProfileType,
          enableCompress: true,
        };
        await connector.sendCDPMessage(clientId, -1, 'Tracing.start', {
          traceConfig: config,
        });
        console.log(JSON.stringify({ success: true, message: 'Tracing started successfully' }));

        await Promise.allSettled(transports.map((t) => t.close()));
      } catch (error: any) {
        let errorMessage = error.message;
        if (
          errorMessage.includes('Failed to get trace controller') ||
          errorMessage.includes('Not implemented:') ||
          errorMessage.includes('Tracing not enabled') ||
          errorMessage.includes('Failed to start tracing')
        ) {
          errorMessage = 'Tracing functionality is not supported in the current version.';
        } else {
          errorMessage = `Trace command error: ${errorMessage}`;
        }
        console.error(JSON.stringify({ success: false, error: errorMessage }));
        process.exit(1);
      }
    });

  program
    .command('end')
    .description('Stop trace events collection')
    .requiredOption('-c, --client <clientId>', 'Client ID')
    .action(async (options: CommandOptions) => {
      const connector = new DevtoolConnector(transports);
      const clientId = options.client;
      const signal = AbortSignal.timeout(30_000);

      try {
        await using stream = await connector.sendCDPStream(
          clientId,
          ReadableStream.from([{ method: 'Tracing.end', sessionId: -1 }]),
          { signal },
        );

        for await (const { method, params: eventParams } of stream) {
          if (method === 'Tracing.tracingComplete') {
            const streamResult = eventParams as TracingComplete;
            console.log(
              JSON.stringify({
                success: true,
                message: 'Tracing completed successfully',
                stream: streamResult.stream,
              }),
            );
            await Promise.allSettled(transports.map((t) => t.close()));
            return;
          }
        }

        throw new Error('Failed to stop tracing, no Tracing.tracingComplete event received within 30 seconds.');
      } catch (error: any) {
        let errorMessage = error.message;
        if (errorMessage.includes('Failed to get trace controller')) {
          errorMessage =
            'Tracing functionality is not supported in the current version. Please integrate the Lynx development version (with -dev suffix) to enable tracing. For more information, visit: https://lynxjs.org/en/guide/start/integrate-lynx-dev-version.html';
        } else if (errorMessage.includes('Tracing is not started')) {
          errorMessage = 'Tracing is not started, please start tracing first.';
        }
        console.error(JSON.stringify({ success: false, error: errorMessage }));
        process.exit(1);
      }
    });

  program
    .command('readData')
    .description('Read data from a trace stream')
    .requiredOption('-s, --stream <stream>', 'Stream handle')
    .requiredOption('-c, --client <clientId>', 'Client ID')
    .option('-o, --output <path>', 'Output file path. If not provided, saves to temporary directory')
    .action(async (options: CommandOptions) => {
      const connector = new DevtoolConnector(transports);
      const clientId = options.client;
      const streamHandle = Number(options.stream);

      let outputFilePath = '';
      if (options.output) {
        outputFilePath = options.output;
      } else {
        const tempDir = os.tmpdir();
        const timestamp = Date.now();
        const tempFileName = `trace-${timestamp}.pftrace`;
        outputFilePath = path.join(tempDir, tempFileName);
      }

      const writeStream = fs.createWriteStream(outputFilePath);
      const fileWritable = Writable.toWeb(writeStream);

      try {
        const { stream: ioReadStream, onResponse } = createIOReadStream(streamHandle);

        await using stream = await connector.sendCDPStream(clientId, ioReadStream, {
          signal: AbortSignal.timeout(30000),
        });

        let eofReceived = false;

        for await (const message of stream) {
          if ('error' in message) {
            const errorMsg = (message.error as any)?.message || 'Unknown CDP error';
            console.error(JSON.stringify({ success: false, error: errorMsg }));
            process.exit(1);
          }

          if ('id' in message && 'result' in message) {
            const ioResult = message.result as IOReadResponse;
            if (ioResult.data) {
              const buffer = Buffer.from(ioResult.data, 'base64');
              const writer = fileWritable.getWriter();
              await writer.write(buffer);
              writer.releaseLock();
            }

            if (ioResult.eof) {
              eofReceived = true;
              await fileWritable.close();
              onResponse(ioResult);
              console.log(
                JSON.stringify({
                  success: true,
                  message: 'Data read successfully',
                  filePath: outputFilePath,
                }),
              );
              await Promise.allSettled(transports.map((t) => t.close()));
              return;
            } else {
              onResponse(ioResult);
            }
          }
        }

        if (!eofReceived) {
          const errorMessage = 'Failed to read data, no EOF received within 30 seconds.';
          console.error(JSON.stringify({ success: false, error: errorMessage }));
          process.exit(1);
        }
      } catch (error: any) {
        console.error(JSON.stringify({ success: false, error: error.message }));
        process.exit(1);
      }
    });

  await program.parseAsync(process.argv);
}

main().catch((error) => {
  console.error(JSON.stringify({ success: false, error: error.message }));
  process.exit(1);
});
