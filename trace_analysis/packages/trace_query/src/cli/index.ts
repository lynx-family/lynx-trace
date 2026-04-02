// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { Command } from 'commander';

import { queryAggregate } from '../queries/query_aggregate';
import { queryAncestors } from '../queries/query_ancestors';
import { queryById } from '../queries/query_by_id';
import { queryByRawSql } from '../queries/query_by_raw_sql';
import { queryByTimeWindow } from '../queries/query_by_time_window';
import { queryDescendants } from '../queries/query_descendants';
import { queryFlowEvents } from '../queries/query_flow_events';
import { queryLongTasks } from '../queries/query_long_tasks';
import { queryLynxView } from '../queries/query_lynxviews';
import { queryMetrics } from '../queries/query_metrics';
import { queryPipelineIds } from '../queries/query_pipeline_ids';
import { queryPipelineOverviewEvents } from '../queries/query_pipeline_overview_events';
import { queryThreads } from '../queries/query_threads';
import { queryTraceMetadata } from '../queries/query_trace_metadata';
import { CommandHooks } from '../types/hook';
import { getTreeStyleTraceEvents } from '../utils/convert_trace_event_style';
import { TraceQuery } from '../utils/trace_query';

interface CommandOptions {
  path?: string;
  id?: string;
  start?: string;
  end?: string;
  track?: string;
  duration?: string;
  names?: string[];
  query?: string;
  instanceId?: string;
  pipelineId?: string;
}

function tryRequireHooks(): CommandHooks | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const hookModule = require('./hook.cjs');
    return hookModule.default || hookModule;
  } catch {
    return null;
  }
}

const hooksModule = tryRequireHooks();
const hooks: CommandHooks = hooksModule || {};

async function withTraceQuery<T>(tracePath: string, action: (traceQuery: TraceQuery) => Promise<T>): Promise<T> {
  const traceQuery = new TraceQuery();
  try {
    await traceQuery.initProcessor(tracePath);
    return await action(traceQuery);
  } finally {
    await traceQuery.destroyProcessor();
  }
}

function requireOption(value: string | undefined, name: string): string {
  if (!value) {
    console.error(`Error: --${name} is required`);
    process.exit(1);
  }
  return value;
}

function parseNumber(value: string | undefined, defaultValue?: number): number | undefined {
  if (!value) return defaultValue;
  return parseFloat(value);
}

function parseInteger(value: string | undefined, defaultValue?: number): number | undefined {
  if (!value) return defaultValue;
  return parseInt(value, 10);
}

function wrapCommandAction(
  commandName: string,
  action: (options: CommandOptions) => Promise<void>,
): (options: CommandOptions) => Promise<void> {
  return async (options: CommandOptions) => {
    let success = false;
    let error: Error | undefined;
    const tracePath = options.path || '';
    try {
      if (hooks.beforeCommand) {
        await Promise.resolve(hooks.beforeCommand(commandName, tracePath));
      }
      await action(options);
      success = true;
    } catch (e) {
      error = e as Error;
      throw e;
    } finally {
      if (hooks.afterCommand) {
        await Promise.resolve(hooks.afterCommand(commandName, tracePath, success, error?.message || undefined));
      }
    }
  };
}

async function main() {
  const program = new Command();

  program.version('0.0.1').description('Trace Query CLI Tool');

  program
    .command('id')
    .description('Execute trace query by slice ID')
    .option('-i, --id <id>', 'Slice ID')
    .option('-p, --path <path>', 'Trace file path (can be URL or local file)')
    .action(
      wrapCommandAction('id', async (options: CommandOptions) => {
        const path = requireOption(options.path, 'path');
        const id = parseInteger(requireOption(options.id, 'id'))!;

        const result = await withTraceQuery(path, async (tq) => {
          const events = await queryById(tq, id);
          return getTreeStyleTraceEvents(events);
        });

        console.log('Query result:', JSON.stringify(result, null, 2));
      }),
    );

  program
    .command('time-window')
    .description('Execute time window query')
    .option('-s, --start <start>', 'Start timestamp in ms')
    .option('-e, --end <end>', 'End timestamp in ms')
    .option('-t, --track <track>', 'Thread Track ID')
    .option('-p, --path <path>', 'Trace file path (can be URL or local file)')
    .action(
      wrapCommandAction('time-window', async (options: CommandOptions) => {
        const path = requireOption(options.path, 'path');
        const start = parseNumber(requireOption(options.start, 'start'))!;
        const end = parseNumber(requireOption(options.end, 'end'))!;
        const track = parseInteger(options.track);

        const result = await withTraceQuery(path, async (tq) => {
          const events = await queryByTimeWindow(tq, start, end, track);
          return getTreeStyleTraceEvents(events);
        });

        console.log('Query result:', JSON.stringify(result, null, 2));
      }),
    );

  program
    .command('aggregate')
    .description('Execute aggregate query')
    .option('-s, --start <start>', 'Start timestamp in ms')
    .option('-e, --end <end>', 'End timestamp in ms')
    .option('-t, --track <track>', 'Thread Track ID')
    .option('-n, --names <names...>', 'Event name patterns (supports SQL LIKE wildcards: % and _)')
    .option('-p, --path <path>', 'Trace file path (can be URL or local file)')
    .action(
      wrapCommandAction('aggregate', async (options: CommandOptions) => {
        const path = requireOption(options.path, 'path');
        const start = parseNumber(requireOption(options.start, 'start'))!;
        const end = parseNumber(requireOption(options.end, 'end'))!;
        const track = parseInteger(options.track);
        const names = options.names || [];

        const result = await withTraceQuery(path, async (tq) => {
          return queryAggregate(tq, start, end, names, track);
        });

        console.log('Aggregate:', JSON.stringify(result, null, 2));
      }),
    );

  program
    .command('ancestors')
    .description('Query ancestors of a slice')
    .option('-i, --id <id>', 'Slice ID')
    .option('-p, --path <path>', 'Trace file path (can be URL or local file)')
    .action(
      wrapCommandAction('ancestors', async (options: CommandOptions) => {
        const path = requireOption(options.path, 'path');
        const id = parseInteger(requireOption(options.id, 'id'))!;

        const result = await withTraceQuery(path, async (tq) => {
          const events = await queryAncestors(tq, id);
          return getTreeStyleTraceEvents(events);
        });

        console.log('Ancestors:', JSON.stringify(result, null, 2));
      }),
    );

  program
    .command('descendants')
    .description('Query descendants of a slice')
    .option('-i, --id <id>', 'Slice ID')
    .option('-p, --path <path>', 'Trace file path (can be URL or local file)')
    .action(
      wrapCommandAction('descendants', async (options: CommandOptions) => {
        const path = requireOption(options.path, 'path');
        const id = parseInteger(requireOption(options.id, 'id'))!;

        const result = await withTraceQuery(path, async (tq) => {
          const events = await queryDescendants(tq, id);
          return getTreeStyleTraceEvents(events);
        });

        console.log('Descendants:', JSON.stringify(result, null, 2));
      }),
    );

  program
    .command('flow')
    .description('Query flow events of a slice')
    .option('-i, --id <id>', 'Slice ID')
    .option('-p, --path <path>', 'Trace file path (can be URL or local file)')
    .action(
      wrapCommandAction('flow', async (options: CommandOptions) => {
        const path = requireOption(options.path, 'path');
        const id = parseInteger(requireOption(options.id, 'id'))!;

        const result = await withTraceQuery(path, async (tq) => {
          const events = await queryFlowEvents(tq, id);
          return getTreeStyleTraceEvents(events);
        });

        console.log('Flow events:', JSON.stringify(result, null, 2));
      }),
    );

  program
    .command('metadata')
    .description('Query trace metadata like system info, trace start time, end time, Lynx SDK version etc.')
    .option('-p, --path <path>', 'Trace file path (can be URL or local file)')
    .action(
      wrapCommandAction('metadata', async (options: CommandOptions) => {
        const path = requireOption(options.path, 'path');

        const result = await withTraceQuery(path, async (tq) => {
          return queryTraceMetadata(tq);
        });

        console.log('Metadata result:', JSON.stringify(result, null, 2));
      }),
    );

  program
    .command('sql')
    .description('Execute raw SQL query')
    .option('-q, --query <sql>', 'SQL query')
    .option('-p, --path <path>', 'Trace file path (can be URL or local file)')
    .action(
      wrapCommandAction('sql', async (options: CommandOptions) => {
        const path = requireOption(options.path, 'path');
        const sqlQuery = requireOption(options.query, 'query');

        const result = await withTraceQuery(path, async (tq) => {
          return queryByRawSql(tq, sqlQuery);
        });

        console.log('SQL result:', JSON.stringify(result, null, 2));
      }),
    );

  program
    .command('metrics')
    .description('Query metrics information from trace')
    .option('-p, --path <path>', 'Trace file path (can be URL or local file)')
    .action(
      wrapCommandAction('metrics', async (options: CommandOptions) => {
        const path = requireOption(options.path, 'path');

        const result = await withTraceQuery(path, async (tq) => {
          return queryMetrics(tq);
        });

        console.log('Metrics result:', JSON.stringify(result, null, 2));
      }),
    );

  program
    .command('threads')
    .description('Query all threads from trace')
    .option('-p, --path <path>', 'Trace file path (can be URL or local file)')
    .action(
      wrapCommandAction('threads', async (options: CommandOptions) => {
        const path = requireOption(options.path, 'path');

        const result = await withTraceQuery(path, async (tq) => {
          return queryThreads(tq);
        });

        console.log('Threads result:', JSON.stringify(result, null, 2));
      }),
    );

  program
    .command('long-tasks')
    .description('Query long tasks on a specific thread')
    .option('-t, --track <track>', 'Thread Track ID')
    .option('-d, --duration <ms>', 'Minimum duration in milliseconds', '16')
    .option('-p, --path <path>', 'Trace file path (can be URL or local file)')
    .action(
      wrapCommandAction('long-tasks', async (options: CommandOptions) => {
        const path = requireOption(options.path, 'path');
        const track = parseInteger(requireOption(options.track, 'track'))!;
        const duration = parseNumber(options.duration, 16)!;

        const result = await withTraceQuery(path, async (tq) => {
          const events = await queryLongTasks(tq, track, duration);
          return getTreeStyleTraceEvents(events);
        });

        console.log('Long tasks:', JSON.stringify(result, null, 2));
      }),
    );

  program
    .command('lynxview')
    .description('Query LynxView instances')
    .option('-p, --path <path>', 'Trace file path (can be URL or local file)')
    .action(
      wrapCommandAction('lynxview', async (options: CommandOptions) => {
        const path = requireOption(options.path, 'path');

        const result = await withTraceQuery(path, async (tq) => {
          return queryLynxView(tq);
        });

        console.log('LynxView instances:', JSON.stringify(result, null, 2));
      }),
    );

  program
    .command('pipeline')
    .description('Query pipeline IDs for an instance')
    .option('--instance-id <id>', 'LynxView instance ID')
    .option('-p, --path <path>', 'Trace file path (can be URL or local file)')
    .action(
      wrapCommandAction('pipeline', async (options: CommandOptions) => {
        const path = requireOption(options.path, 'path');
        const instanceId = requireOption(options.instanceId, 'instance-id');

        const result = await withTraceQuery(path, async (tq) => {
          return queryPipelineIds(tq, instanceId);
        });

        console.log('Pipeline IDs:', JSON.stringify(result, null, 2));
      }),
    );

  program
    .command('pipeline-overview')
    .description('Query pipeline overview events')
    .option('--pipeline-id <id>', 'Pipeline ID')
    .option('-p, --path <path>', 'Trace file path (can be URL or local file)')
    .action(
      wrapCommandAction('pipeline-overview', async (options: CommandOptions) => {
        const path = requireOption(options.path, 'path');
        const pipelineId = requireOption(options.pipelineId, 'pipeline-id');

        const result = await withTraceQuery(path, async (tq) => {
          return queryPipelineOverviewEvents(tq, pipelineId);
        });

        console.log('Pipeline overview:', JSON.stringify(result, null, 2));
      }),
    );

  program.parse(process.argv);
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
