// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0.

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { extractMemorySnapshot } from '../queries/query_memory_snapshot';
import { MemoryAnalysisResult, MemoryReportSnapshotData } from '../types/memory_analysis';
import { TraceQuery } from '../utils/trace_query';
import { generateMemoryAnalysisReport } from './memory_analysis_report';
import { combineSources, FrontendSourceResolver, PreparedFrontend } from './frontend_sources';

export function memoryReportPaths(output: string) {
  const resolved = path.resolve(output);
  const reportPath = /\.html?$/i.test(resolved) ? resolved : path.join(resolved, 'report.html');
  return {
    directory: path.dirname(reportPath),
    reportPath,
    dataPath: path.join(path.dirname(reportPath), 'analysis.json'),
  };
}

/** Additional JSON exports keep references relative to their own location. */
export function writeMemoryAnalysisData(result: MemoryAnalysisResult, output: string, baseDirectory: string) {
  const directory = path.dirname(path.resolve(output));
  const data = structuredClone(result);
  const relative = (file: string) => path.relative(directory, path.resolve(baseDirectory, file));
  if (data.artifacts) data.artifacts.trace.file = relative(data.artifacts.trace.file);
  for (const snapshot of data.snapshots) {
    if (snapshot.outputPath) snapshot.outputPath = relative(snapshot.outputPath);
  }
  for (const analysis of data.residualAnalyses) {
    if (analysis.reportPath) analysis.reportPath = relative(analysis.reportPath);
    if (analysis.evidencePath) analysis.evidencePath = relative(analysis.evidencePath);
    if (analysis.contextPath) analysis.contextPath = relative(analysis.contextPath);
  }
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(output, JSON.stringify(data, null, 2));
}

/** Make all inspection inputs portable. Paths in analysis.json are directory-relative. */
export async function generateMemoryAnalysisArtifacts(
  result: MemoryAnalysisResult,
  output: string,
  options: {
    tracePath?: string;
    baseDirectory?: string;
    residualResultsPath?: string;
    traceQuery?: TraceQuery;
    frontend?: PreparedFrontend;
    lynx?: PreparedFrontend;
  } = {},
) {
  const paths = memoryReportPaths(output);
  const base = options.baseDirectory ?? paths.directory;
  const source = options.tracePath ?? (result.artifacts && path.resolve(base, result.artifacts.trace.file));
  if (!source || !fs.statSync(source).isFile()) {
    throw new Error(
      'A source Trace is required for a portable report. Use --path <trace> when importing legacy analysis JSON.',
    );
  }
  const bytes = fs.readFileSync(source);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (result.artifacts && sha256 !== result.artifacts.trace.sha256) {
    throw new Error('Source Trace does not match the analysis Trace SHA-256.');
  }
  const assets = [path.resolve(__dirname, '../report-assets'), path.resolve(__dirname, 'report-assets')].find(
    (candidate) => fs.existsSync(path.join(candidate, 'viewer.js')),
  );
  if (!assets)
    throw new Error('Report viewer assets are missing. Run the trace-query build including build:report-viewer.');
  fs.mkdirSync(paths.directory, { recursive: true });
  const traceFile = 'trace' + (path.extname(source) || '.pftrace');
  const copy = (sourcePath: string, relativePath: string) => {
    const target = path.join(paths.directory, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (path.resolve(sourcePath) !== target) fs.copyFileSync(sourcePath, target);
    return relativePath;
  };
  copy(source, traceFile);
  fs.cpSync(assets, path.join(paths.directory, 'assets'), { recursive: true });
  result.artifacts = { trace: { file: traceFile, size: bytes.length, sha256 } };
  const embedded: MemoryReportSnapshotData = { snapshots: [], vms: result.vms };
  const sources = combineSources(options.frontend, options.lynx);
  const resolver =
    sources &&
    new FrontendSourceResolver(sources, path.join(os.tmpdir(), `lynx-source-location-cache-${sources.digest}.json`));
  if (sources) {
    result.frontendSources = {
      digest: sources.digest,
      warnings: sources.warnings,
      snapshots: {},
      projects: sources.projects.map(({ id, root, origin, commit, artifactOrigin, lynx, abandoned }) => ({
        id,
        root,
        origin,
        commit,
        artifactOrigin,
        lynx,
        abandoned,
      })),
      artifacts: sources.artifacts.map(({ sources, ...artifact }) => ({
        ...artifact,
        sourceFileCount: new Set(Object.values(sources).map((source) => source.file)).size,
      })),
    };
  }
  let ownedQuery: TraceQuery | undefined;
  try {
    for (const snapshot of result.snapshots) {
      const item: MemoryReportSnapshotData['snapshots'][number] = { ...snapshot };
      embedded.snapshots.push(item);
      if (snapshot.chunkCount === 0) {
        item.contentError =
          snapshot.integrity === 'metadata-only'
            ? 'Residual memory was cleared; this event has metadata only, with no heap graph.'
            : 'No snapshot content was captured in this trace.';
        continue;
      }
      const relativePath = `snapshots/${snapshot.sliceId}.heapsnapshot`;
      const sourcePath = snapshot.outputPath && path.resolve(base, snapshot.outputPath);
      if (sourcePath && snapshot.sha256 && fs.existsSync(sourcePath)) {
        const content = fs.readFileSync(sourcePath, 'utf8');
        if (createHash('sha256').update(content).digest('hex') !== snapshot.sha256) {
          throw new Error(`Snapshot SHA-256 mismatch: ${snapshot.snapshotId}`);
        }
        item.content = content;
        snapshot.outputPath = copy(sourcePath, relativePath);
      } else {
        // Reuse the analysis processor, or initialize lazily on a JSON rerender.
        if (!options.traceQuery && !ownedQuery) {
          ownedQuery = new TraceQuery();
          await ownedQuery.initProcessor(source);
        }
        let extracted;
        try {
          extracted = await extractMemorySnapshot(
            options.traceQuery ?? ownedQuery!,
            snapshot.snapshotId,
            path.join(paths.directory, relativePath),
          );
        } catch (error) {
          item.contentError = String(error instanceof Error ? error.message : error);
          snapshot.outputPath = undefined;
          continue;
        }
        if (snapshot.sha256 && extracted.sha256 !== snapshot.sha256) {
          throw new Error(`Snapshot SHA-256 mismatch: ${snapshot.snapshotId}`);
        }
        item.content = fs.readFileSync(extracted.outputPath, 'utf8');
        snapshot.outputPath = relativePath;
      }
      // Preserve analysis metadata and evidence digests. Packaging is not a new
      // residual analysis, even when a previously absent heap file is recovered.
      item.outputPath = snapshot.outputPath;
      const contentHash = createHash('sha256').update(item.content!).digest('hex');
      if (resolver) {
        item.sourceLocations = resolver.snapshot(item.content!);
        result.frontendSources!.snapshots[snapshot.snapshotId] = {
          sha256: contentHash,
          locations: item.sourceLocations,
        };
      } else {
        const saved = result.frontendSources?.snapshots[snapshot.snapshotId];
        if (saved?.sha256 === contentHash) item.sourceLocations = saved.locations;
        else if (saved) delete result.frontendSources!.snapshots[snapshot.snapshotId];
      }
    }
  } finally {
    await ownedQuery?.destroyProcessor();
  }
  resolver?.save();
  for (const analysis of result.residualAnalyses) {
    if (analysis.analyzerContext) {
      analysis.contextPath = `snapshots/${analysis.reportAnchor}.context.json`;
      fs.mkdirSync(path.join(paths.directory, 'snapshots'), { recursive: true });
      fs.writeFileSync(
        path.join(paths.directory, analysis.contextPath),
        JSON.stringify(analysis.analyzerContext, null, 2),
      );
    }
    if (analysis.reportHtml) {
      analysis.reportPath = `instance-${analysis.instanceId}.html`;
      fs.writeFileSync(path.join(paths.directory, analysis.reportPath), analysis.reportHtml);
      // Large exhaustive allocation reports must not be duplicated in the
      // parent HTML or analysis JSON; load the portable child file on demand.
      analysis.reportHtml = undefined;
    } else if (analysis.reportPath) {
      analysis.reportPath = copy(path.resolve(base, analysis.reportPath), `instance-${analysis.instanceId}.html`);
    }
    if (analysis.evidencePath) {
      const evidence = JSON.parse(fs.readFileSync(path.resolve(base, analysis.evidencePath), 'utf8'));
      for (const snapshot of evidence.snapshots ?? []) {
        const metadata = result.snapshots.find((item) => item.sha256 === snapshot.sha256 && item.outputPath);
        if (metadata) snapshot.file = metadata.outputPath;
      }
      analysis.evidencePath = `instance-${analysis.instanceId}-evidence.json`;
      fs.writeFileSync(path.join(paths.directory, analysis.evidencePath), JSON.stringify(evidence, null, 2));
    }
  }
  const manifestPath = options.residualResultsPath ?? path.join(base, 'residual-results.json');
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    for (const page of manifest.pages) {
      const analysis = result.residualAnalyses.find((item) => item.id === page.analysisId);
      if (analysis) {
        page.evidencePath = analysis.evidencePath;
        page.reportPath = analysis.reportPath;
      }
    }
    fs.writeFileSync(path.join(paths.directory, 'residual-results.json'), JSON.stringify(manifest, null, 2));
  }
  generateMemoryAnalysisReport(result, paths.reportPath, embedded);
  fs.writeFileSync(paths.dataPath, JSON.stringify(result, null, 2));
  return paths;
}
