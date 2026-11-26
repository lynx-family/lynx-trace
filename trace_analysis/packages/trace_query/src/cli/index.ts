// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { Command } from 'commander';

import { queryAggregate } from '../queries/query_aggregate';
import { queryAncestors } from '../queries/query_ancestors';
import { queryById } from '../queries/query_by_id';
import { queryByRawSql } from '../queries/query_by_raw_sql';
import { queryBySearchText } from '../queries/query_by_search_text';
import { queryByTimeWindow } from '../queries/query_by_time_window';
import { queryDescendants } from '../queries/query_descendants';
import { queryFlowEvents } from '../queries/query_flow_events';
import { queryLongTasks } from '../queries/query_long_tasks';
import { queryLynxView } from '../queries/query_lynxviews';
import { queryMemoryAnalysis } from '../queries/query_memory_analysis';
import { extractMemorySnapshot } from '../queries/query_memory_snapshot';
import { queryMetrics } from '../queries/query_metrics';
import { queryPipelineIds } from '../queries/query_pipeline_ids';
import { queryPipelineOverviewEvents } from '../queries/query_pipeline_overview_events';
import { queryThreads } from '../queries/query_threads';
import { queryTraceMetadata } from '../queries/query_trace_metadata';
import {
  confirmFrontend,
  PreparedFrontend,
  prepareFrontend,
  readFrontend,
  readLynxSources,
} from '../reports/frontend_sources';
import {
  LYNX_SOURCE_REPOSITORIES,
  MINIMUM_TRACE_LYNX_VERSION,
  queryLynxEngineVersions,
  requestedLynxSource,
} from '../reports/lynx_source_selection';
import {
  generateMemoryAnalysisArtifacts,
  memoryReportPaths,
  writeMemoryAnalysisData,
} from '../reports/memory_analysis_artifacts';
import { applyMemoryResidualResults, prepareMemoryResidualAnalysis } from '../reports/memory_residual_analysis';
import { checkSourcePreparation, discardOptedOutSources, SourcePreparation } from '../reports/source_preparation';
import { CommandHooks } from '../types/hook';
import { MemoryAnalysisResult } from '../types/memory_analysis';
import { getTreeStyleTraceEvents } from '../utils/convert_trace_event_style';
import { TraceQuery } from '../utils/trace_query';

interface CommandOptions {
  path?: string;
  id?: string;
  text?: string;
  start?: string;
  end?: string;
  track?: string;
  duration?: string;
  names?: string[];
  query?: string;
  instanceId?: string;
  pipelineId?: string;
  url?: string;
  scenario?: string;
  output?: string;
  snapshotId?: string;
  outputData?: string;
  residualDir?: string;
  data?: string;
  residualResults?: string;
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

async function getTraceUUID(traceQuery: TraceQuery): Promise<string> {
  try {
    const uuidResult = await traceQuery.query("select str_value from metadata where name = 'trace_uuid'");
    if (!uuidResult || uuidResult.length === 0 || !uuidResult[0]) {
      return '';
    }
    return uuidResult[0]['str_value'] || '';
  } catch {
    return '';
  }
}

function wrapCommandAction(
  commandName: string,
  action: (options: CommandOptions, traceQuery: TraceQuery) => Promise<void>,
): (options: CommandOptions) => Promise<void> {
  return async (options: CommandOptions) => {
    let success = false;
    let error: Error | undefined;
    let traceUUID = '';
    const tracePath = options.path || '';
    try {
      if (hooks.beforeCommand) {
        await Promise.resolve(hooks.beforeCommand(commandName, tracePath));
      }
      await withTraceQuery(tracePath, async (tq) => {
        await action(options, tq);
        traceUUID = await getTraceUUID(tq);
      });
      success = true;
    } catch (e) {
      error = e as Error;
      throw e;
    } finally {
      if (hooks.afterCommand) {
        await Promise.resolve(
          hooks.afterCommand(commandName, tracePath, success, error?.message || undefined, traceUUID),
        );
      }
    }
  };
}

async function main() {
  const program = new Command();

  program.version('0.0.1').description('Trace Query CLI Tool');
  program.option(
    '--frontend-manifest <path>',
    'Prepared frontend artifact manifest; required when frontend projects were supplied',
  );
  program.option('--lynx-manifest <path>', 'Prepared Lynx runtime build manifest with verified revision provenance');
  program.option('--source-preparation <path>', 'Source preparation and explicit user-decision ledger (version 1)');
  let frontend: PreparedFrontend | undefined;
  let lynx: PreparedFrontend | undefined;
  let sourcePreparation: SourcePreparation | undefined;
  program.hook('preAction', (_command, action) => {
    const manifest = program.opts()['frontendManifest'] as string | undefined;
    if (manifest && !action.name().startsWith('frontend-') && action.name() !== 'lynx-source-version') {
      // This runs before hooks, Trace downloads or processor initialization.
      frontend = readFrontend(manifest);
    }
    const runtime = program.opts()['lynxManifest'] as string | undefined;
    if (runtime && !action.name().startsWith('frontend-') && action.name() !== 'lynx-source-version') {
      lynx = readLynxSources(runtime);
    }
    if (['memory-analysis', 'memory-snapshot', 'memory-report'].includes(action.name())) {
      const ledger = program.opts()['sourcePreparation'] as string | undefined;
      if (ledger) sourcePreparation = JSON.parse(fs.readFileSync(ledger, 'utf8'));
      if (action.name() !== 'memory-report') {
        // Fail before hooks, downloads, Trace queries, extraction or report side effects.
        sourcePreparation = checkSourcePreparation(sourcePreparation, 'analysis', { frontend, lynx });
      }
    }
  });

  program
    .command('lynx-source-version')
    .description('Select an explicit Lynx revision or inspect recorded versions before memory analysis')
    .option('-p, --path <path>', 'Trace path, used only when no explicit Lynx revision is supplied')
    .option('--lynx-version <version>', 'User-selected Lynx version; A_<version> is an internal tag hint to verify')
    .option('--lynx-version-ref <ref>', 'Verified version tag/ref in the selected internal or OSS repository')
    .option('--lynx-commit <commit>', 'User-selected Lynx commit')
    .option('--lynx-branch <branch>', 'User-selected Lynx branch')
    .option('-o, --output <path>', 'Optional version-selection JSON')
    .action(
      async (options: {
        path?: string;
        lynxVersion?: string;
        lynxVersionRef?: string;
        lynxCommit?: string;
        lynxBranch?: string;
        output?: string;
      }) => {
        const selection = requestedLynxSource(options);
        const candidates = selection
          ? undefined
          : await withTraceQuery(requireOption(options.path, 'path'), queryLynxEngineVersions);
        const result = {
          repositories: LYNX_SOURCE_REPOSITORIES,
          repositorySelection:
            'Preserve an explicit URL/local path. Otherwise query Git remotes without asking the user: probe internal with git ls-remote <url> HEAD; accessible internal always selects internal. Only if internal is inaccessible, probe OSS. Record probe results and verify the requested revision in the selected repository; a missing internal ref never permits OSS fallback. This command does not run Git probes.',
          versionRefGuidance:
            'For an explicit user version or an eligible Trace candidate, form A_<version> and query the exact tag plus its peeled ref in the selected remote. Trace versions below 4.5.0 are invalid even if their tags exist: treat them as missing tags and request source/revision input. Verify any different OSS version-to-tag mapping from remote evidence. ls-remote does not enumerate every commit: verify a supplied commit with a depth-one fetch into a new empty checkout and rev-parse FETCH_HEAD^{commit}. Record the full commit and logs; do not inspect local repositories or caches.',
          ...(selection
            ? { source: 'user', selection, requiresConsent: false }
            : {
                source: 'trace',
                minimumTraceVersion: MINIMUM_TRACE_LYNX_VERSION,
                candidates,
                requiresConsent: false,
                nextStep: candidates?.some((candidate) => candidate.status === 'candidate')
                  ? 'Only status=candidate versions may proceed to remote tag verification and automatic builds. Resolve versions for the requested process/page scope; never substitute a valid version for another scope with invalid metadata. Invalid versions follow missing-tag recovery even if their tags exist. Ask for source/revision when no unique usable tag can be resolved; validate JS/maps against snapshots later.'
                  : 'No eligible Trace version. Treat invalid or below-minimum versions as missing tags even if the remote tags exist; memory analysis support starts at Lynx 4.5.0. Ask for Lynx source/revision input and keep preparation pending until usable input or an explicit opt-out/abort is received.',
              }),
        };
        if (options.output) {
          fs.mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true });
          fs.writeFileSync(options.output, JSON.stringify(result, null, 2));
        }
        console.log(JSON.stringify(result, null, 2));
      },
    );

  program
    .command('frontend-prepare')
    .description('Validate frontend or runtime outputs and write a manifest ready for analysis')
    .requiredOption('--config <path>', 'Frontend projects JSON (version 1)')
    .requiredOption('-o, --output <path>', 'Prepared manifest JSON')
    .action((options: { config: string; output: string }) => {
      const manifest = prepareFrontend(
        JSON.parse(fs.readFileSync(options.config, 'utf8')),
        path.dirname(path.resolve(options.config)),
      );
      fs.mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true });
      fs.writeFileSync(options.output, JSON.stringify(manifest, null, 2));
      console.log(JSON.stringify(manifest, null, 2));
    });

  program
    .command('frontend-confirm')
    .description('Optionally record an explicit artifact approval for compatibility; not required for analysis')
    .requiredOption('--manifest <path>', 'Prepared manifest JSON')
    .requiredOption('--digest <sha256>', 'Digest of the artifact list shown to the user')
    .requiredOption('--statement <text>', 'The user statement approving the artifact paths')
    .action((options: { manifest: string; digest: string; statement: string }) => {
      console.log(JSON.stringify(confirmFrontend(options.manifest, options.digest, options.statement), null, 2));
    });

  program
    .command('id')
    .description('Execute trace query by slice ID')
    .option('-i, --id <id>', 'Slice ID')
    .option('-p, --path <path>', 'Trace file path (can be URL or local file)')
    .action(
      wrapCommandAction('id', async (options: CommandOptions, tq: TraceQuery) => {
        requireOption(options.path, 'path');
        const id = parseInteger(requireOption(options.id, 'id'))!;

        const events = await queryById(tq, id);
        const result = getTreeStyleTraceEvents(events);

        console.log('Query result:', JSON.stringify(result, null, 2));
      }),
    );

  program
    .command('search')
    .description('Search trace events by text')
    .option('--text <text>', 'Search text')
    .option('-p, --path <path>', 'Trace file path (can be URL or local file)')
    .action(
      wrapCommandAction('search', async (options: CommandOptions, traceQuery: TraceQuery) => {
        requireOption(options.path, 'path');
        const text = requireOption(options.text, 'text');

        const events = await queryBySearchText(traceQuery, text);
        const result = getTreeStyleTraceEvents(events);

        console.log('Search result:', JSON.stringify(result, null, 2));
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
      wrapCommandAction('time-window', async (options: CommandOptions, tq: TraceQuery) => {
        requireOption(options.path, 'path');
        const start = parseNumber(requireOption(options.start, 'start'))!;
        const end = parseNumber(requireOption(options.end, 'end'))!;
        const track = parseInteger(options.track);

        const events = await queryByTimeWindow(tq, start, end, track);
        const result = getTreeStyleTraceEvents(events);

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
      wrapCommandAction('aggregate', async (options: CommandOptions, tq: TraceQuery) => {
        requireOption(options.path, 'path');
        const start = parseNumber(requireOption(options.start, 'start'))!;
        const end = parseNumber(requireOption(options.end, 'end'))!;
        const track = parseInteger(options.track);
        const names = options.names || [];

        const result = await queryAggregate(tq, start, end, names, track);

        console.log('Aggregate:', JSON.stringify(result, null, 2));
      }),
    );

  program
    .command('ancestors')
    .description('Query ancestors of a slice')
    .option('-i, --id <id>', 'Slice ID')
    .option('-p, --path <path>', 'Trace file path (can be URL or local file)')
    .action(
      wrapCommandAction('ancestors', async (options: CommandOptions, tq: TraceQuery) => {
        requireOption(options.path, 'path');
        const id = parseInteger(requireOption(options.id, 'id'))!;

        const events = await queryAncestors(tq, id);
        const result = getTreeStyleTraceEvents(events);

        console.log('Ancestors:', JSON.stringify(result, null, 2));
      }),
    );

  program
    .command('descendants')
    .description('Query descendants of a slice')
    .option('-i, --id <id>', 'Slice ID')
    .option('-p, --path <path>', 'Trace file path (can be URL or local file)')
    .action(
      wrapCommandAction('descendants', async (options: CommandOptions, tq: TraceQuery) => {
        requireOption(options.path, 'path');
        const id = parseInteger(requireOption(options.id, 'id'))!;

        const events = await queryDescendants(tq, id);
        const result = getTreeStyleTraceEvents(events);

        console.log('Descendants:', JSON.stringify(result, null, 2));
      }),
    );

  program
    .command('flow')
    .description('Query flow events of a slice')
    .option('-i, --id <id>', 'Slice ID')
    .option('-p, --path <path>', 'Trace file path (can be URL or local file)')
    .action(
      wrapCommandAction('flow', async (options: CommandOptions, tq: TraceQuery) => {
        requireOption(options.path, 'path');
        const id = parseInteger(requireOption(options.id, 'id'))!;

        const events = await queryFlowEvents(tq, id);
        const result = getTreeStyleTraceEvents(events);

        console.log('Flow events:', JSON.stringify(result, null, 2));
      }),
    );

  program
    .command('metadata')
    .description('Query trace metadata like system info, trace start time, end time, Lynx SDK version etc.')
    .option('-p, --path <path>', 'Trace file path (can be URL or local file)')
    .action(
      wrapCommandAction('metadata', async (options: CommandOptions, tq: TraceQuery) => {
        requireOption(options.path, 'path');

        const result = await queryTraceMetadata(tq);

        console.log('Metadata result:', JSON.stringify(result, null, 2));
      }),
    );

  program
    .command('sql')
    .description('Execute raw SQL query')
    .option('-q, --query <sql>', 'SQL query')
    .option('-p, --path <path>', 'Trace file path (can be URL or local file)')
    .action(
      wrapCommandAction('sql', async (options: CommandOptions, tq: TraceQuery) => {
        requireOption(options.path, 'path');
        const sqlQuery = requireOption(options.query, 'query');

        const result = await queryByRawSql(tq, sqlQuery);

        console.log('SQL result:', JSON.stringify(result, null, 2));
      }),
    );

  program
    .command('metrics')
    .description('Query metrics information from trace')
    .option('-p, --path <path>', 'Trace file path (can be URL or local file)')
    .action(
      wrapCommandAction('metrics', async (options: CommandOptions, tq: TraceQuery) => {
        requireOption(options.path, 'path');

        const result = await queryMetrics(tq);

        console.log('Metrics result:', JSON.stringify(result, null, 2));
      }),
    );

  program
    .command('threads')
    .description('Query all threads from trace')
    .option('-p, --path <path>', 'Trace file path (can be URL or local file)')
    .action(
      wrapCommandAction('threads', async (options: CommandOptions, tq: TraceQuery) => {
        requireOption(options.path, 'path');

        const result = await queryThreads(tq);

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
      wrapCommandAction('long-tasks', async (options: CommandOptions, tq: TraceQuery) => {
        requireOption(options.path, 'path');
        const track = parseInteger(requireOption(options.track, 'track'))!;
        const duration = parseNumber(options.duration, 16)!;

        const events = await queryLongTasks(tq, track, duration);
        const result = getTreeStyleTraceEvents(events);

        console.log('Long tasks:', JSON.stringify(result, null, 2));
      }),
    );

  program
    .command('lynxview')
    .description('Query LynxView instances')
    .option('-p, --path <path>', 'Trace file path (can be URL or local file)')
    .action(
      wrapCommandAction('lynxview', async (options: CommandOptions, tq: TraceQuery) => {
        requireOption(options.path, 'path');

        const result = await queryLynxView(tq);

        console.log('LynxView instances:', JSON.stringify(result, null, 2));
      }),
    );

  program
    .command('pipeline')
    .description('Query pipeline IDs for an instance')
    .option('--instance-id <id>', 'LynxView instance ID')
    .option('-p, --path <path>', 'Trace file path (can be URL or local file)')
    .action(
      wrapCommandAction('pipeline', async (options: CommandOptions, tq: TraceQuery) => {
        requireOption(options.path, 'path');
        const instanceId = requireOption(options.instanceId, 'instance-id');

        const result = await queryPipelineIds(tq, instanceId);

        console.log('Pipeline IDs:', JSON.stringify(result, null, 2));
      }),
    );

  program
    .command('pipeline-overview')
    .description('Query pipeline overview events')
    .option('--pipeline-id <id>', 'Pipeline ID')
    .option('-p, --path <path>', 'Trace file path (can be URL or local file)')
    .action(
      wrapCommandAction('pipeline-overview', async (options: CommandOptions, tq: TraceQuery) => {
        requireOption(options.path, 'path');
        const pipelineId = requireOption(options.pipelineId, 'pipeline-id');

        const result = await queryPipelineOverviewEvents(tq, pipelineId);

        console.log('Pipeline overview:', JSON.stringify(result, null, 2));
      }),
    );

  program
    .command('memory-analysis')
    .description('Analyze Lynx memory and generate a portable report directory with the source Trace')
    .option('-p, --path <path>', 'Trace file path (can be URL or local file)')
    .option('--url <url>', 'Only select pages whose URL contains this value')
    .option('--instance-id <id>', 'Only select this Lynx page instance ID')
    .option('--scenario <scenario>', 'Analysis scenario: default or scroll', 'default')
    .option('-s, --start <start>', 'Scroll scenario start timestamp in ms')
    .option('-e, --end <end>', 'Scroll scenario end timestamp in ms')
    .option('-o, --output <output>', 'Report directory (or explicit HTML entry path)', 'memory-analysis-report')
    .option('--output-data <path>', 'Additional copy of the full analysis JSON')
    .option('--residual-dir <path>', 'Directory for all residual snapshots')
    .action(
      wrapCommandAction('memory-analysis', async (options: CommandOptions, tq: TraceQuery) => {
        requireOption(options.path, 'path');
        const scenario = options.scenario === 'scroll' ? 'scroll' : 'default';
        const result = await queryMemoryAnalysis(tq, {
          url: options.url,
          instanceId: parseInteger(options.instanceId),
          scenario,
          startTsMs: parseNumber(options.start),
          endTsMs: parseNumber(options.end),
        });
        result.sourcePreparation = sourcePreparation;
        const output = path.resolve(options.output || 'memory-analysis-report');
        const directory = memoryReportPaths(output).directory;
        await prepareMemoryResidualAnalysis(tq, result, options.residualDir || path.join(directory, 'snapshots'));
        const { reportPath, dataPath } = await generateMemoryAnalysisArtifacts(result, output, {
          tracePath: tq.sourceTracePath,
          traceQuery: tq,
          frontend,
          lynx,
        });
        if (options.outputData) {
          writeMemoryAnalysisData(result, options.outputData, directory);
        }
        console.log(
          'Memory analysis:',
          JSON.stringify(
            {
              valid: result.valid,
              error: result.error,
              reportPath,
              directory,
              dataPath,
              summary: result.summary,
              warnings: result.warnings,
              issues: result.issues,
              pages: result.pages.map((page) => ({
                instanceId: page.instanceId,
                url: page.url,
                selected: page.selected,
                classification: page.classification,
                mtsVmType: page.mtsVmType,
                btsVmType: page.btsVmType,
                btsVmName: page.btsVmName,
                btsSlot: page.btsSlot,
                sharedBts: page.sharedBts,
                mtsPool: page.analysis.mtsPool,
                residualAnalysisId: page.analysis.residualAnalysisId,
              })),
              mtsPoolGrowthEvents: result.mtsPoolGrowthEvents,
              residualAnalyses: result.residualAnalyses,
              snapshots: result.snapshots.map((snapshot) => ({
                vmId: snapshot.vmId,
                index: snapshot.index,
                snapshotId: snapshot.snapshotId,
                captureTsMs: snapshot.captureTsMs,
              })),
              sharedBtsVmAnalyses: result.sharedBtsVmAnalyses.map((analysis) => ({
                vmId: analysis.vmId,
                instanceIds: analysis.instanceIds,
                createdAfterTraceStart: analysis.createdAfterTraceStart,
                destroyed: analysis.destroyed,
                endRssBytes: analysis.endRssBytes,
                notDestroyedIssue: analysis.notDestroyedIssue,
                gcAccumulateTrend: analysis.gcAccumulateTrend,
              })),
            },
            null,
            2,
          ),
        );
      }),
    );

  program
    .command('memory-report')
    .description('Import finalized residual findings and rerender a memory report offline')
    .requiredOption('--data <path>', 'Full memory-analysis JSON')
    .option('--residual-results <path>', 'Versioned per-page analyzer result manifest')
    .requiredOption('-o, --output <path>', 'Report directory (or explicit HTML entry path)')
    .option('-p, --path <path>', 'Source Trace for legacy analysis JSON without a bundled Trace')
    .option('--output-data <path>', 'Updated full JSON output')
    .action(async (options: CommandOptions) => {
      const result = JSON.parse(fs.readFileSync(requireOption(options.data, 'data'), 'utf8')) as MemoryAnalysisResult;
      if (result.schemaVersion !== 4) throw new Error('Expected memory analysis schemaVersion 4');
      sourcePreparation = checkSourcePreparation(
        sourcePreparation || result.sourcePreparation,
        'report',
        { frontend, lynx },
        result,
      );
      discardOptedOutSources(result, sourcePreparation);
      result.sourcePreparation = sourcePreparation;
      if (!result.artifacts && options.path) {
        await withTraceQuery(options.path, async (tq) => {
          const [bounds] = await tq.query('SELECT start_ts, end_ts FROM trace_bounds');
          if (
            !bounds ||
            Math.abs(Number(bounds['start_ts']) / 1e6 - result.trace.startTsMs) > 0.0001 ||
            Math.abs(Number(bounds['end_ts']) / 1e6 - result.trace.endTsMs) > 0.0001
          ) {
            throw new Error('Source Trace bounds do not match the legacy analysis.');
          }
          options.path = tq.sourceTracePath;
        });
      }
      if (options.residualResults) {
        const file = path.resolve(options.residualResults);
        applyMemoryResidualResults(result, JSON.parse(fs.readFileSync(file, 'utf8')), path.dirname(file));
      }
      const { reportPath, dataPath, directory } = await generateMemoryAnalysisArtifacts(
        result,
        requireOption(options.output, 'output'),
        {
          tracePath: options.path,
          baseDirectory: path.dirname(path.resolve(options.data!)),
          residualResultsPath: options.residualResults,
          frontend,
          lynx,
        },
      );
      if (options.outputData) {
        writeMemoryAnalysisData(result, options.outputData, directory);
      }
      console.log(JSON.stringify({ directory, reportPath, dataPath, summary: result.summary }, null, 2));
    });

  program
    .command('memory-snapshot')
    .description('Extract a JS heap snapshot embedded in a trace')
    .option('-p, --path <path>', 'Trace file path (can be URL or local file)')
    .option('--snapshot-id <id>', 'Snapshot ID returned by memory-analysis')
    .option('-o, --output <output>', 'Heap snapshot output path')
    .action(
      wrapCommandAction('memory-snapshot', async (options: CommandOptions, tq: TraceQuery) => {
        requireOption(options.path, 'path');
        const snapshotId = requireOption(options.snapshotId, 'snapshot-id');
        const safeName = snapshotId.replace(/[^a-zA-Z0-9._-]+/g, '_');
        const output = options.output || path.join(os.tmpdir(), 'lynx-memory-snapshots', `${safeName}.heapsnapshot`);
        const result = await extractMemorySnapshot(tq, snapshotId, output);
        console.log('Memory snapshot:', JSON.stringify(result, null, 2));
      }),
    );

  await program.parseAsync(process.argv);
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
