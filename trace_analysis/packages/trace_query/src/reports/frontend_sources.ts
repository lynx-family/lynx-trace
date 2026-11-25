// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0.

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import { RawSourceMap, SourceMapConsumer } from 'source-map-js';
import { parse } from 'acorn';
import {
  canonicalRepositoryUrl,
  isLynxSourceRepository,
  LynxSourceSelection,
  MINIMUM_TRACE_LYNX_VERSION,
  requestedLynxSource,
  traceLynxVersionInvalidReason,
} from './lynx_source_selection';

export interface FrontendProject {
  id: string;
  root: string;
  outputDirs?: string[];
  /** Explicit prebuilt inputs, relative to the config directory; replaces output scanning. */
  artifactFiles?: { script: string; map?: string }[];
  /** Acquisition provenance, independent of the original source repository. */
  artifactOrigin?: { kind: 'local' | 'git' | 'url'; locator: string; ref?: string; commit?: string };
  /** Exact runtime URL prefixes; use when pages produce identical script names. */
  scriptPrefixes?: string[];
  /** Public runtime names can hide prod/dev variants; aliases always require offset verification. */
  scriptAliases?: Record<string, string[]>;
  lynx?: {
    selection: LynxSourceSelection;
    /** Source-selection provenance; automatic Trace resolution needs no user approval. */
    consent: 'user-specified' | 'trace-version-resolved' | 'trace-version-approved';
    statement: string;
    platform: string;
  };
  origin?: { kind: 'local' | 'git'; url?: string; ref?: string; linkTemplate?: string };
  abandoned?: { reason: string; userConfirmed: true };
}

interface FrontendConfig {
  version: 1;
  projects: FrontendProject[];
}

interface SourceFile {
  file: string;
  sha256: string;
  /** File bytes match project.commit, so a remote permalink is accurate. */
  tracked?: boolean;
}

interface FrontendArtifact {
  projectId: string;
  script: string;
  map?: string;
  inlineMap?: true;
  scriptSha256: string;
  mapSha256?: string;
  sources: Record<string, SourceFile>;
}

export interface PreparedFrontend {
  version: 1;
  projects: (FrontendProject & { commit?: string })[];
  artifacts: FrontendArtifact[];
  warnings: string[];
  digest: string;
  confirmation?: { digest: string; statement: string; at: string };
}

export interface NodeSourceLocation {
  script: string;
  scriptId: number;
  offset?: number;
  generatedLine?: number;
  generatedColumn?: number;
  generatedUrl?: string;
  projectId?: string;
  file?: string;
  line?: number;
  column?: number;
  url?: string;
  snippet?: string;
  snippetStartLine?: number;
  generatedSnippet?: {
    before: string;
    after: string;
    truncatedBefore: boolean;
    truncatedAfter: boolean;
  };
  error?: string;
}

export interface SnapshotSourceLocations {
  nodes: Record<string, NodeSourceLocation>;
  /** Snapshot-scoped script inventory, including entries without object locations. */
  bindings?: Record<
    string,
    {
      script: string;
      candidates: { projectId: string; script: string }[];
      selected?: { projectId: string; script: string };
    }
  >;
  runtimeMatches?: Record<
    string,
    {
      selected?: string;
      error?: string;
      candidates: { script: string; sha256: string; bytes: number; matched: number; total: number }[];
    }
  >;
}

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const SOURCE_CACHE_VERSION = 7;
const hashFile = (file: string) => hash(fs.readFileSync(file));
const git = (root: string, args: string[]) =>
  execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function contained(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function filesIn(directory: string): string[] {
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    throw new Error(`Frontend output directory is missing: ${directory}`);
  }
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const file = path.join(directory, entry.name);
      return entry.isDirectory() ? filesIn(file) : entry.isFile() ? [file] : [];
    });
}

/** Build machines often embed absolute paths. Require a unique suffix and matching content. */
function findSource(root: string, source: string, expected?: string | null, mapFile?: string): string | undefined {
  let normalized: string;
  try {
    normalized = source.startsWith('file:') ? fileURLToPath(source) : decodeURIComponent(source);
  } catch {
    return undefined;
  }
  const segments = normalized.replace(/\\/g, '/').split('/').filter(Boolean);
  const matches = new Set<string>();
  if (mapFile) {
    const candidate = path.resolve(path.dirname(mapFile), normalized);
    if (contained(root, candidate) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      const real = fs.realpathSync(candidate);
      // A workspace symlink may traverse node_modules but resolve to tracked repository source.
      // Installed dependencies remain excluded, even when their store lives under the root.
      if (
        contained(root, real) &&
        !path.relative(root, real).split(path.sep).includes('node_modules') &&
        (expected == null || fs.readFileSync(real, 'utf8') === expected)
      )
        matches.add(real);
    }
  }
  // Maps acquired separately still refer to their original build layout (e.g. ../src/App.tsx).
  // Rebase only leading traversal; every candidate must remain inside the specified source root.
  while (segments[0] === '..' || segments[0] === '.') segments.shift();
  if (segments.includes('..') || segments.includes('node_modules'))
    return matches.size === 1 ? [...matches][0] : undefined;
  for (let start = 0; start < segments.length; start++) {
    const candidate = path.resolve(root, ...segments.slice(start));
    if (!contained(root, candidate) || !fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) continue;
    const real = fs.realpathSync(candidate);
    if (!contained(root, real) || path.relative(root, real).split(path.sep).includes('node_modules')) continue;
    if (expected !== undefined && expected !== null && fs.readFileSync(real, 'utf8') !== expected) continue;
    matches.add(real);
  }
  return matches.size === 1 ? [...matches][0] : undefined;
}

/** Inline maps belong to the unchanged generated script; never strip their data URL. */
function loadSourceMap(
  script: string,
  explicitMap?: string,
): { raw: RawSourceMap; file: string; inlineMap?: true } | undefined {
  if (explicitMap) return { raw: JSON.parse(fs.readFileSync(explicitMap, 'utf8')), file: explicitMap };
  const text = fs.readFileSync(script, 'utf8');
  const inline = /\/\/[#@]\s*sourceMappingURL=(data:application\/json[^\r\n]*)\s*$/.exec(text)?.[1];
  if (inline) {
    const comma = inline.indexOf(',');
    const payload = inline.slice(comma + 1).trim();
    const json = inline.slice(0, comma).includes(';base64')
      ? Buffer.from(payload, 'base64').toString('utf8')
      : decodeURIComponent(payload);
    return { raw: JSON.parse(json), file: script, inlineMap: true };
  }
  const file = `${script}.map`;
  return fs.existsSync(file) ? { raw: JSON.parse(fs.readFileSync(file, 'utf8')), file } : undefined;
}

function manifestDigest(manifest: Omit<PreparedFrontend, 'digest'>): string {
  return hash(
    JSON.stringify({
      version: manifest.version,
      projects: manifest.projects,
      artifacts: manifest.artifacts,
      warnings: manifest.warnings,
    }),
  );
}

export function prepareFrontend(config: FrontendConfig, base: string): PreparedFrontend {
  if (config.version !== 1 || !Array.isArray(config.projects) || !config.projects.length) {
    throw new Error('Expected frontend config version 1 with at least one project.');
  }
  const projects: PreparedFrontend['projects'] = [];
  const artifacts: FrontendArtifact[] = [];
  const warnings: string[] = [];
  const ids = new Set<string>();
  for (const input of config.projects) {
    if (!input.id || ids.has(input.id)) throw new Error('Frontend project IDs must be nonempty and unique.');
    ids.add(input.id);
    if (input.abandoned) {
      if (input.abandoned.userConfirmed !== true || !input.abandoned.reason?.trim()) {
        throw new Error(`Abandoning ${input.id} requires the user's explicit agreement and reason.`);
      }
      projects.push(input);
      continue;
    }
    if (!input.root || (input.origin && !['local', 'git'].includes(input.origin.kind))) {
      throw new Error(`Frontend project ${input.id} requires a root and a valid origin kind.`);
    }
    const root = fs.realpathSync(path.resolve(base, input.root));
    if (input.artifactFiles !== undefined) {
      if (
        input.lynx ||
        !Array.isArray(input.artifactFiles) ||
        !input.artifactFiles.length ||
        input.artifactFiles.some(
          (file) =>
            !file ||
            typeof file.script !== 'string' ||
            !file.script.trim() ||
            (file.map !== undefined && (typeof file.map !== 'string' || !file.map.trim())),
        )
      ) {
        throw new Error(`Explicit frontend artifactFiles require nonempty script paths: ${input.id}`);
      }
    }
    if (
      input.artifactOrigin &&
      (!['local', 'git', 'url'].includes(input.artifactOrigin.kind) ||
        !input.artifactOrigin.locator?.trim() ||
        (input.artifactOrigin.kind === 'git' && !input.artifactOrigin.ref?.trim()))
    ) {
      throw new Error(`Invalid artifact acquisition provenance: ${input.id}`);
    }
    if (input.lynx) {
      const { selection, consent, statement, platform } = input.lynx;
      if (
        consent !== 'user-specified' &&
        selection.kind === 'version' &&
        traceLynxVersionInvalidReason(selection.requested)
      ) {
        throw new Error(
          `Invalid Trace-derived Lynx version ${selection.requested}; minimum is ${MINIMUM_TRACE_LYNX_VERSION}. Treat it as a missing tag even if the tag exists and request source/revision input.`,
        );
      }
      const requested = requestedLynxSource({
        lynxVersion: selection.kind === 'version' ? selection.requested : undefined,
        lynxVersionRef: selection.kind === 'version' ? selection.ref : undefined,
        lynxCommit: selection.kind === 'commit' ? selection.requested : undefined,
        lynxBranch: selection.kind === 'branch' ? selection.requested : undefined,
      });
      if (
        !requested ||
        requested.ref !== selection.ref ||
        !['user-specified', 'trace-version-resolved', 'trace-version-approved'].includes(consent) ||
        !statement?.trim() ||
        !platform?.trim() ||
        (consent !== 'user-specified' && selection.kind !== 'version') ||
        input.origin?.kind !== 'git' ||
        !isLynxSourceRepository(input.origin.url ?? '') ||
        input.origin.ref !== selection.ref
      ) {
        throw new Error(`Invalid Lynx revision, source provenance or origin for ${input.id}.`);
      }
    } else if (input.scriptAliases) {
      throw new Error('Runtime script aliases require Lynx build provenance.');
    }
    const project: PreparedFrontend['projects'][number] = {
      ...input,
      root,
      outputDirs: input.artifactFiles ? [] : (input.outputDirs ?? ['dist']).map((dir) => path.resolve(root, dir)),
      ...(input.artifactFiles
        ? {
            artifactFiles: input.artifactFiles.map((file) => ({
              script: path.resolve(base, file.script),
              ...(file.map ? { map: path.resolve(base, file.map) } : {}),
            })),
          }
        : {}),
    };
    if (input.origin?.kind === 'git') {
      if (!input.origin.url || !input.origin.ref) throw new Error(`Git project ${input.id} requires URL and ref.`);
      if (fs.realpathSync(git(root, ['rev-parse', '--show-toplevel'])) !== root) {
        throw new Error(`${root} must be the requested repository root.`);
      }
      if (
        canonicalRepositoryUrl(git(root, ['remote', 'get-url', 'origin'])) !== canonicalRepositoryUrl(input.origin.url)
      ) {
        throw new Error(`Git origin does not match the requested URL: ${input.id}`);
      }
      project.commit = git(root, ['rev-parse', 'HEAD']);
      const requested = git(root, ['rev-parse', '--verify', `${input.origin.ref}^{commit}`]);
      if (requested !== project.commit) throw new Error(`Checkout does not match requested ref: ${input.id}`);
      if (!input.lynx && git(root, ['status', '--porcelain', '--untracked-files=no'])) {
        throw new Error(`Git project ${input.id} has tracked changes; remote source links would be inaccurate.`);
      }
    }
    projects.push(project);
    let count = 0;
    const entries =
      project.artifactFiles ??
      [...new Set(project.outputDirs!.flatMap(filesIn).filter((file) => /\.(?:c|m)?js$/.test(file)))].map((script) => ({
        script,
        map: undefined,
      }));
    if (new Set(entries.map((entry) => entry.script)).size !== entries.length) {
      throw new Error(`Duplicate generated script in artifactFiles: ${input.id}`);
    }
    for (const { script, map } of entries) {
      const loaded = loadSourceMap(script, map);
      if (!loaded) {
        if (!project.artifactFiles) continue;
        if (!fs.statSync(script).size) throw new Error(`Empty generated script: ${script}`);
        artifacts.push({ projectId: input.id, script, scriptSha256: hashFile(script), sources: {} });
        warnings.push(`${input.id}: no sourcemap for ${script}; generated JavaScript locations only.`);
        count++;
        continue;
      }
      const { raw, file: mapFile, inlineMap } = loaded;
      if (Number(raw.version) !== 3 || !raw.mappings || !Array.isArray(raw.sources)) {
        throw new Error(`Invalid or empty source map: ${mapFile}`);
      }
      if (!fs.statSync(script).size) throw new Error(`Empty generated script: ${script}`);
      const consumer = new SourceMapConsumer(raw);
      // Decode the entire mapping now; lazy parse failures must block preparation.
      consumer.eachMapping(() => {});
      if (raw.file && path.basename(raw.file) !== path.basename(script)) {
        warnings.push(
          `${input.id}: map.file=${raw.file} differs from ${path.basename(script)}; verify the build pair.`,
        );
      }
      const sources: Record<string, SourceFile> = {};
      for (const source of consumer.sources) {
        const file = findSource(root, source, consumer.sourceContentFor(source, true), mapFile);
        if (!file) continue;
        const sha256 = hashFile(file);
        let tracked = false;
        if (project.commit) {
          try {
            const committed = execFileSync(
              'git',
              ['-C', root, 'show', `${project.commit}:${path.relative(root, file)}`],
              {
                stdio: ['ignore', 'pipe', 'pipe'],
              },
            );
            tracked = hash(committed) === sha256;
          } catch {
            /* Generated, changed or unavailable committed content has no remote permalink. */
          }
        }
        sources[source] = { file, sha256, tracked };
      }
      artifacts.push({
        projectId: input.id,
        script,
        map: mapFile,
        ...(inlineMap ? { inlineMap } : {}),
        scriptSha256: hashFile(script),
        mapSha256: hashFile(mapFile),
        sources,
      });
      count++;
    }
    if (!count)
      throw new Error(`No nonempty JS + v3 sourcemap pairs found for ${input.id}. Build with sourcemaps first.`);
    for (const script of Object.keys(input.scriptAliases ?? {})) {
      if (!artifacts.some((artifact) => artifact.projectId === input.id && path.basename(artifact.script) === script)) {
        throw new Error(`Declared runtime script has no validated JS + sourcemap pair: ${input.id}/${script}`);
      }
    }
  }
  const manifest = { version: 1 as const, projects, artifacts, warnings };
  return { ...manifest, digest: manifestDigest(manifest) };
}

export function readLynxSources(file: string): PreparedFrontend {
  const manifest = readFrontend(file);
  if (!manifest.artifacts.length || manifest.projects.some((project) => !project.lynx || project.abandoned)) {
    throw new Error('A Lynx manifest must contain only built Lynx projects with source provenance.');
  }
  return manifest;
}

/** Keep frontend and runtime preparation records independent while resolving sources together. */
export function combineSources(frontend?: PreparedFrontend, lynx?: PreparedFrontend): PreparedFrontend | undefined {
  if (!frontend || !lynx) return frontend ?? lynx;
  const projects = [...frontend.projects, ...lynx.projects];
  if (new Set(projects.map((project) => project.id)).size !== projects.length) {
    throw new Error('Frontend and Lynx project IDs must be distinct.');
  }
  const combined = {
    version: 1 as const,
    projects,
    artifacts: [...frontend.artifacts, ...lynx.artifacts],
    warnings: [...frontend.warnings, ...lynx.warnings],
  };
  return { ...combined, digest: manifestDigest(combined) };
}

export function readFrontend(file: string): PreparedFrontend {
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as PreparedFrontend;
  if (manifest.version !== 1 || manifest.digest !== manifestDigest(manifest)) {
    throw new Error('Frontend manifest was changed. Run frontend-prepare again.');
  }
  const current = prepareFrontend({ version: 1, projects: manifest.projects }, path.dirname(file));
  if (current.digest !== manifest.digest) {
    throw new Error('Frontend artifacts or sources changed. Run frontend-prepare again before analysis.');
  }
  return manifest;
}

export function confirmFrontend(file: string, digest: string, statement: string): PreparedFrontend {
  const manifest = readFrontend(file);
  if (digest !== manifest.digest || !statement.trim())
    throw new Error('Exact artifact digest and user confirmation are required.');
  manifest.confirmation = { digest, statement, at: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
  return manifest;
}

/** PrimJS offsets count UTF-8 bytes; sourcemap columns count UTF-16 code units. */
export function generatedPosition(script: Buffer, offset: number): { line: number; column: number } {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > script.length) throw new Error('Invalid source_offset.');
  if (offset < script.length && (script[offset]! & 0xc0) === 0x80)
    throw new Error('source_offset splits a UTF-8 character.');
  const prefix = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(script.subarray(0, offset));
  const lines = prefix.split(/\r\n|\r|\n|\u2028|\u2029/);
  return { line: lines.length, column: lines[lines.length - 1]!.length };
}

/** Bounded context around a validated UTF-8 byte boundary, without splitting code points. */
function generatedSnippet(script: Buffer, offset: number): NonNullable<NodeSourceLocation['generatedSnippet']> {
  const beforeLimit = 80;
  const afterLimit = 160;
  let start = Math.max(0, offset - beforeLimit * 4);
  let end = Math.min(script.length, offset + afterLimit * 4);
  while (start < offset && (script[start]! & 0xc0) === 0x80) start++;
  while (end < script.length && (script[end]! & 0xc0) === 0x80) end--;
  const before = Array.from(script.subarray(start, offset).toString('utf8')).slice(-beforeLimit).join('');
  const after = Array.from(script.subarray(offset, end).toString('utf8')).slice(0, afterLimit).join('');
  return {
    before,
    after,
    truncatedBefore: Buffer.byteLength(before) < offset,
    truncatedAfter: offset + Buffer.byteLength(after) < script.length,
  };
}

function sourceUrl(
  project: PreparedFrontend['projects'][number],
  file: SourceFile,
  line: number,
  column: number,
): string | undefined {
  if (project.origin?.kind !== 'git') return `${pathToFileURL(file.file).href}#L${line}:${column}`;
  if (!project.commit || !file.tracked) return undefined;
  const relative = path.relative(project.root, file.file).split(path.sep).map(encodeURIComponent).join('/');
  const repo = canonicalRepositoryUrl(project.origin.url!);
  if (project.origin.linkTemplate) {
    const values: Record<string, string> = {
      repo,
      commit: project.commit,
      ref: encodeURIComponent(project.origin.ref!),
      path: relative,
      line: String(line),
      column: String(column),
    };
    const url = project.origin.linkTemplate.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? '');
    return /^https?:\/\//.test(url) ? url : undefined;
  }
  if (/^https:\/\/github\.com\//.test(repo)) return `${repo}/blob/${project.commit}/${relative}#L${line}`;
  if (/^https:\/\/[^/]*gitlab[^/]*\//.test(repo)) return `${repo}/-/blob/${project.commit}/${relative}#L${line}`;
  return undefined;
}

export class FrontendSourceResolver {
  private readonly cache: Record<string, NodeSourceLocation>;
  private readonly consumers = new Map<string, SourceMapConsumer>();
  private readonly scripts = new Map<string, Buffer>();
  private readonly functionOffsets = new Map<string, Set<number>>();
  hits = 0;
  misses = 0;

  constructor(
    private readonly manifest: PreparedFrontend,
    private readonly cachePath: string,
  ) {
    let cache;
    try {
      cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    } catch {
      /* First render. */
    }
    this.cache = cache?.version === SOURCE_CACHE_VERSION && cache.digest === manifest.digest ? cache.entries : {};
  }

  private candidates(name: string): FrontendArtifact[] {
    return this.manifest.artifacts.filter((artifact) => {
      const project = this.manifest.projects.find((item) => item.id === artifact.projectId)!;
      if (project.scriptPrefixes?.length && !project.scriptPrefixes.some((prefix) => name.startsWith(prefix)))
        return false;
      const names = project.scriptAliases?.[path.basename(artifact.script)] ?? [path.basename(artifact.script)];
      return names.some((alias) => name === alias || name.endsWith(`/${alias}`));
    });
  }

  private script(artifact: FrontendArtifact): Buffer {
    if (!this.scripts.has(artifact.script)) this.scripts.set(artifact.script, fs.readFileSync(artifact.script));
    return this.scripts.get(artifact.script)!;
  }

  private offsets(artifact: FrontendArtifact): Set<number> {
    if (!this.functionOffsets.has(artifact.script)) {
      const text = this.script(artifact).toString('utf8');
      const ast = parse(text, { ecmaVersion: 'latest', sourceType: 'script' });
      const starts = new Set<number>();
      const visit = (node: any) => {
        if (!node || typeof node !== 'object') return;
        // PrimJS points class constructors at the `class` token, including synthesized constructors.
        if (
          [
            'FunctionDeclaration',
            'FunctionExpression',
            'ArrowFunctionExpression',
            'ClassDeclaration',
            'ClassExpression',
          ].includes(node.type)
        ) {
          starts.add(node.start);
        }
        if ((node.type === 'Property' && node.method) || node.type === 'MethodDefinition') {
          starts.add(node.start);
          starts.add(node.key.start); // Static method locations omit the `static` keyword.
        }
        for (const value of Object.values(node)) {
          if (Array.isArray(value)) value.forEach(visit);
          else if (value && typeof value === 'object') visit(value);
        }
      };
      visit(ast);
      const bytes = new Set<number>();
      let previous = 0;
      let offset = 0;
      for (const start of [...starts].sort((a, b) => a - b)) {
        offset += Buffer.byteLength(text.slice(previous, start));
        bytes.add(offset);
        previous = start;
      }
      this.functionOffsets.set(artifact.script, bytes);
    }
    return this.functionOffsets.get(artifact.script)!;
  }

  private resolve(
    location: NodeSourceLocation,
    runtime?: NonNullable<SnapshotSourceLocations['runtimeMatches']>[string],
  ): NodeSourceLocation {
    // Runtime decisions are snapshot-scoped, including failure/ambiguity. Never reuse a decision
    // from another snapshot solely because script IDs and one offset happen to coincide.
    const key = hash(JSON.stringify([location, runtime?.selected ?? runtime?.error]));
    const cached = this.cache[key];
    if (cached) {
      this.hits++;
      return cached;
    }
    this.misses++;
    const result = { ...location };
    try {
      const name = location.script.replace(/[?#].*$/, '');
      if (runtime?.error) throw new Error(runtime.error);
      const candidates = this.candidates(name).filter((artifact) => !runtime || artifact.script === runtime.selected);
      if (candidates.length !== 1)
        throw new Error(
          candidates.length
            ? 'Ambiguous script: multiple frontend projects match. Set scriptPrefixes.'
            : 'No matching frontend artifact.',
        );
      const artifact = candidates[0]!;
      const project = this.manifest.projects.find((item) => item.id === artifact.projectId)!;
      result.projectId = project.id;
      const script = this.script(artifact);
      const generated =
        location.offset === undefined
          ? { line: location.generatedLine!, column: location.generatedColumn! }
          : generatedPosition(script, location.offset);
      if (location.offset === undefined) {
        const line = script.toString('utf8').split(/\r\n|\r|\n|\u2028|\u2029/)[generated.line - 1];
        if (
          !Number.isSafeInteger(generated.line) ||
          !Number.isSafeInteger(generated.column) ||
          generated.column < 0 ||
          line === undefined ||
          generated.column > line.length
        ) {
          throw new Error('Invalid generated source position.');
        }
      }
      result.generatedLine = generated.line;
      result.generatedColumn = generated.column;
      result.generatedUrl = `${pathToFileURL(artifact.script).href}#L${generated.line}:${generated.column + 1}`;
      // Keep both source layers; invalid offsets never produce a generated excerpt.
      if (location.offset !== undefined) {
        result.generatedSnippet = generatedSnippet(script, location.offset);
      }
      if (!artifact.map) throw new Error('No sourcemap supplied; generated JavaScript location only.');
      if (!this.consumers.has(artifact.map)) {
        this.consumers.set(
          artifact.map,
          new SourceMapConsumer(loadSourceMap(artifact.script, artifact.inlineMap ? undefined : artifact.map)!.raw),
        );
      }
      const consumer = this.consumers.get(artifact.map)!;
      const original = consumer.originalPositionFor(generated);
      if (!original.source || original.line === null || original.column === null)
        throw new Error('No source mapping for this position.');
      const file = artifact.sources[original.source];
      if (!file)
        throw new Error(`Original source is absent, ambiguous or differs from sourcesContent: ${original.source}`);
      const content = fs.readFileSync(file.file, 'utf8');
      const lines = content.split(/\r\n|\r|\n/);
      if (original.line < 1 || original.line > lines.length || original.column > lines[original.line - 1]!.length) {
        throw new Error('Mapped source position is outside the original file.');
      }
      result.file = project.origin?.kind === 'git' ? path.relative(project.root, file.file) : file.file;
      result.line = original.line;
      result.column = original.column + 1;
      result.url = sourceUrl(project, file, result.line, result.column);
      result.snippetStartLine = Math.max(1, original.line - 2);
      result.snippet = lines.slice(result.snippetStartLine - 1, original.line + 2).join('\n');
      if (!result.url && project.origin?.kind === 'git')
        result.error =
          'Source located; a remote link requires matching committed file bytes and a supported repository link format.';
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
    }
    this.cache[key] = result;
    return result;
  }

  snapshot(content: string): SnapshotSourceLocations {
    const data = JSON.parse(content);
    const meta = data.snapshot?.meta;
    const fields: string[] = meta?.location_fields ?? [];
    const nodeFields: string[] = meta?.node_fields ?? [];
    const width = nodeFields.length;
    const objectField = fields.indexOf('object_index');
    const scriptField = fields.indexOf('script_id');
    const offsetField = fields.indexOf('source_offset');
    const lineField = fields.indexOf('line');
    const columnField = fields.indexOf('column');
    const nodes: SnapshotSourceLocations['nodes'] = {};
    const locations =
      width && objectField >= 0 && scriptField >= 0 && Array.isArray(data.locations) ? data.locations : [];
    const scripts = new Map<number, string>();
    const sourceTable = data.primjs_sources;
    if (sourceTable?.version === 1 && Array.isArray(sourceTable.fields) && Array.isArray(sourceTable.scripts)) {
      const idField = sourceTable.fields.indexOf('script_id');
      const nameField = sourceTable.fields.indexOf('name');
      if (idField >= 0 && nameField >= 0) {
        for (let i = 0; i + sourceTable.fields.length <= sourceTable.scripts.length; i += sourceTable.fields.length) {
          const id = sourceTable.scripts[i + idField];
          const name = data.strings?.[sourceTable.scripts[i + nameField]];
          if (Number.isSafeInteger(id) && id >= 0 && typeof name === 'string') scripts.set(id, name);
        }
      }
    }
    const runtimeMatches: NonNullable<SnapshotSourceLocations['runtimeMatches']> = {};
    for (const [id, name] of scripts) {
      const candidates = this.candidates(name.replace(/[?#].*$/, ''));
      if (
        !candidates.some(
          (artifact) => this.manifest.projects.find((project) => project.id === artifact.projectId)?.lynx,
        )
      )
        continue;
      const offsets = new Set<number>();
      let records = 0;
      for (let i = 0; i < locations.length && i + fields.length <= locations.length; i += fields.length) {
        if (locations[i + scriptField] === id) {
          records++;
          if (offsetField >= 0) offsets.add(locations[i + offsetField]);
        }
      }
      if (!records) continue; // An unused script-table entry has no locations to resolve.
      const evidence = candidates.map((artifact) => {
        let matched = 0;
        try {
          matched = [...offsets].filter((offset) => this.offsets(artifact).has(offset)).length;
        } catch {
          /* Unsupported JS cannot prove a match. */
        }
        return {
          script: artifact.script,
          sha256: artifact.scriptSha256,
          bytes: this.script(artifact).length,
          matched,
          total: offsets.size,
        };
      });
      const valid = evidence.filter((candidate) => candidate.total >= 3 && candidate.matched === candidate.total);
      runtimeMatches[id] = {
        candidates: evidence,
        ...(valid.length === 1
          ? { selected: valid[0]!.script }
          : {
              error:
                valid.length > 1
                  ? 'Ambiguous Lynx runtime variant: multiple builds match snapshot function offsets.'
                  : 'Lynx runtime build does not match all snapshot function offsets (at least three required).',
            }),
      };
    }
    const locatedScripts = new Set<number>();
    for (let i = 0; i < locations.length && i + fields.length <= locations.length; i += fields.length) {
      const index = locations[i + objectField] / width;
      if (!Number.isSafeInteger(index) || index < 0 || index >= data.snapshot.node_count) continue;
      // Location metadata applies to code/bytecode nodes too. Shared positions
      // reuse the same cache entry regardless of the heap object's type.
      const scriptId = locations[i + scriptField];
      const script = scripts.get(scriptId) ?? `script_id:${scriptId}`;
      if (!Number.isSafeInteger(scriptId) || scriptId < 0) continue;
      scripts.set(scriptId, script);
      const location: NodeSourceLocation = { script, scriptId };
      if (offsetField >= 0) location.offset = locations[i + offsetField];
      else if (lineField >= 0 && columnField >= 0) {
        location.generatedLine = locations[i + lineField] + 1;
        location.generatedColumn = locations[i + columnField];
      } else continue;
      nodes[index] = this.resolve(location, runtimeMatches[scriptId]);
      locatedScripts.add(scriptId);
    }
    const bindings: NonNullable<SnapshotSourceLocations['bindings']> = {};
    for (const [id, script] of scripts) {
      const candidates = this.candidates(script.replace(/[?#].*$/, '')).map(({ projectId, script }) => ({
        projectId,
        script,
      }));
      const runtime = runtimeMatches[id];
      const eligible = candidates.filter((candidate) => !runtime || candidate.script === runtime.selected);
      bindings[id] = {
        script,
        candidates,
        ...(locatedScripts.has(id) && eligible.length === 1 ? { selected: eligible[0] } : {}),
      };
    }
    return {
      nodes,
      ...(Object.keys(bindings).length ? { bindings } : {}),
      ...(Object.keys(runtimeMatches).length ? { runtimeMatches } : {}),
    };
  }

  save(): void {
    const temporary = `${this.cachePath}.${process.pid}.tmp`;
    fs.writeFileSync(
      temporary,
      JSON.stringify({ version: SOURCE_CACHE_VERSION, digest: this.manifest.digest, entries: this.cache }),
    );
    fs.renameSync(temporary, this.cachePath);
  }
}
