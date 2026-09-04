import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { type Server } from 'http';
import { join, dirname, isAbsolute, resolve, sep } from 'path';
import { fileURLToPath } from 'url';

import express, { type Express } from 'express';
import open from 'open';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { DiffMode } from '../types/watch.js';
import { formatCommentsOutput } from '../utils/commentFormatting.js';
import {
  mergeCommentImports,
  normalizeCommentImports,
  serializeCommentImports,
} from '../utils/commentImports.js';
import {
  buildEditorSpawnSpec,
  CUSTOM_EDITOR_ID,
  NONE_EDITOR_ID,
  resolveEditorOption,
} from '../utils/editorOptions.js';
import { getFileExtension } from '../utils/fileUtils.js';
import { determineDiffMode } from '../utils/watchMode.js';
import {
  createDiffEntryId,
  deriveDiffTitle,
  isValidDiffEntryId,
  normalizeDiffTitle,
} from '../utils/diffEntries.js';

import {
  CommentStore,
  createCommentStoreKeyForSelection,
  encodeCommentStoreComponent,
  resolveCommentStoreRoot,
} from './comment-store.js';
import { FileWatcherService } from './file-watcher.js';
import { GitDiffParser } from './git-diff.js';
import { parseUserSettingsPatch, readUserConfig, updateUserClientSettings } from './user-config.js';

import {
  type BaseMode,
  type CommentImport,
  type Comment,
  type CommentThread,
  type DiffCommentThread,
  type DiffEntrySummary,
  type DiffResponse,
  type DiffSelection,
  type DiffsResponse,
  type GeneratedStatusResponse,
  type RevisionsResponse,
} from '@/types/diff.js';
import { createDiffSelection, getDiffSelectionKey } from '../utils/diffSelection.js';

interface ServerOptions {
  selection?: DiffSelection;
  stdinDiff?: string;
  preferredPort?: number;
  host?: string;
  openBrowser?: boolean;
  ignoreWhitespace?: boolean;
  clearComments?: boolean;
  commentImports?: CommentImport[];
  keepAlive?: boolean;
  diffMode?: DiffMode;
  repoPath?: string;
  contextLines?: number;
  title?: string;
  /**
   * Overrides the persistent comment store key of the initial stdin diff. `--pr` passes
   * the PR URL so comments follow the pull request instead of the exact patch text.
   */
  commentStoreKey?: string;
}

const GENERATED_STATUS_CACHE_TTL_MS = 60_000;
const MAX_DIFF_CACHE_ENTRIES = 8;

function createDiffCacheKey(selection: DiffSelection, ignoreWhitespace: boolean) {
  return `${getDiffSelectionKey(selection)}\u0000${ignoreWhitespace ? '1' : '0'}`;
}

function getCachedDiffResponse(
  cache: Map<string, DiffResponse>,
  key: string,
): DiffResponse | undefined {
  const cached = cache.get(key);
  if (!cached) {
    return undefined;
  }

  // Refresh insertion order to keep the most recently used entry.
  cache.delete(key);
  cache.set(key, cached);
  return cached;
}

function setCachedDiffResponse(cache: Map<string, DiffResponse>, key: string, value: DiffResponse) {
  if (cache.has(key)) {
    cache.delete(key);
  }
  cache.set(key, value);

  while (cache.size > MAX_DIFF_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (typeof oldestKey !== 'string') {
      break;
    }
    cache.delete(oldestKey);
  }
}

interface CommentSessionState {
  threads: DiffCommentThread[];
  /** In-process change counter; clients echo it back so conflicting writes are detectable. */
  version: number;
  /** File name (without extension) inside the repository's comment store. */
  storeKey: string;
}

/**
 * One reviewable diff hosted by the server. A single server can hold several of
 * them; each is addressable under `/api/d/:diffId/...` (or `?diffId=`) and keeps
 * its own comment sessions.
 */
interface DiffEntryState {
  id: string;
  title: string;
  createdAt: string;
  /** Selection currently displayed for this entry; updated by `/api/diff`. */
  selection: DiffSelection;
  commentSelection: DiffSelection;
  stdinDiff?: string;
  stdinDiffData?: DiffResponse;
  /** Store key used for the stdin session, which has no meaningful (base, target). */
  stdinCommentStoreKey?: string;
}

function createResolvedCommentSelection(
  responseDiffData: DiffResponse,
  fallbackSelection: DiffSelection,
  stdinDiff: boolean,
): DiffSelection {
  const baseCommitish =
    responseDiffData.baseCommitish ?? (stdinDiff ? 'stdin' : fallbackSelection.baseCommitish);
  const targetCommitish =
    responseDiffData.targetCommitish ?? (stdinDiff ? 'stdin' : fallbackSelection.targetCommitish);
  const baseMode = responseDiffData.requestedBaseMode ?? fallbackSelection.baseMode;

  return createDiffSelection(baseCommitish, targetCommitish, baseMode);
}

function createCommentSessionKey(diffId: string, selection: DiffSelection): string {
  return `${diffId}\u0000${getDiffSelectionKey(selection)}`;
}

export async function startServer(
  options: ServerOptions,
): Promise<{ port: number; url: string; isEmpty?: boolean; server?: Server }> {
  const app = express();
  const repositoryPath = resolve(options.repoPath ?? process.cwd());
  const repositoryId = createHash('sha256').update(repositoryPath).digest('hex');
  const initialCommentImports = options.commentImports || [];
  const initialSelection = options.selection ?? createDiffSelection('', '');
  const commentStore = new CommentStore(resolveCommentStoreRoot(repositoryPath), repositoryId);
  const parser = new GitDiffParser(repositoryPath);
  const fileWatcher = new FileWatcherService();
  const generatedStatusCache = new Map<
    string,
    { value: GeneratedStatusResponse; expiresAt: number }
  >();
  const diffDataCache = new Map<string, DiffResponse>();
  const initialIgnoreWhitespace = options.ignoreWhitespace || false;
  const parseBaseMode = (value: unknown): BaseMode | undefined => {
    if (value === 'merge-base') {
      return 'merge-base';
    }

    return undefined;
  };

  app.use(express.json());
  app.use(express.text()); // For sendBeacon text/plain requests

  app.use((_req, res, next) => {
    res.header('Access-Control-Allow-Origin', 'http://localhost:*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
  });

  // Skip validation if using stdin diff
  if (!options.stdinDiff) {
    const isValidCommit = await parser.validateCommit(initialSelection.targetCommitish);
    if (!isValidCommit) {
      throw new Error(`Invalid or non-existent commit: ${initialSelection.targetCommitish}`);
    }
  }

  // Generate initial diff data for isEmpty check
  let initialDiffData: DiffResponse;
  if (options.stdinDiff) {
    // Parse stdin diff directly
    initialDiffData = parser.parseStdinDiff(options.stdinDiff);
  } else {
    initialDiffData = await parser.parseDiff(
      initialSelection,
      initialIgnoreWhitespace,
      options.contextLines,
    );
    setCachedDiffResponse(
      diffDataCache,
      createDiffCacheKey(initialSelection, initialIgnoreWhitespace),
      initialDiffData,
    );
  }

  // Function to invalidate cache when file changes are detected
  const invalidateCache = () => {
    diffDataCache.clear();
    generatedStatusCache.clear();
    parser.clearResolvedCommitCache();
  };

  const diffEntries = new Map<string, DiffEntryState>();
  let activeDiffId = '';

  function uniqueDiffEntryId(): string {
    let id = createDiffEntryId();
    while (diffEntries.has(id)) {
      id = createDiffEntryId();
    }
    return id;
  }

  function createDiffEntry(input: {
    selection: DiffSelection;
    diffData: DiffResponse;
    title?: string;
    stdinDiff?: string;
    commentStoreKey?: string;
  }): DiffEntryState {
    const id = uniqueDiffEntryId();
    const entry: DiffEntryState = {
      id,
      title:
        normalizeDiffTitle(input.title) ??
        deriveDiffTitle(input.selection, { stdin: Boolean(input.stdinDiff) }),
      createdAt: new Date().toISOString(),
      selection: input.selection,
      commentSelection: createResolvedCommentSelection(
        input.diffData,
        input.selection,
        Boolean(input.stdinDiff),
      ),
      stdinDiff: input.stdinDiff,
      stdinDiffData: input.stdinDiff ? input.diffData : undefined,
      stdinCommentStoreKey: input.stdinDiff
        ? input.commentStoreKey
          ? encodeCommentStoreComponent(input.commentStoreKey)
          : `stdin_${createHash('sha256').update(input.stdinDiff).digest('hex').slice(0, 16)}`
        : undefined,
    };
    diffEntries.set(id, entry);
    activeDiffId = id;
    return entry;
  }

  function toDiffEntrySummary(entry: DiffEntryState): DiffEntrySummary {
    return {
      id: entry.id,
      title: entry.title,
      createdAt: entry.createdAt,
      selection: entry.selection,
      isStdin: Boolean(entry.stdinDiff),
      url: `/d/${entry.id}`,
    };
  }

  const initialEntry = createDiffEntry({
    selection: initialSelection,
    diffData: initialDiffData,
    title: options.title,
    stdinDiff: options.stdinDiff,
    commentStoreKey: options.commentStoreKey,
  });

  const DIFF_SCOPE_KEY = '__difitDiffEntry';
  type ScopedRequest = express.Request & { [DIFF_SCOPE_KEY]?: DiffEntryState };

  // Namespaced routes: `/api/d/:diffId/<rest>` is rewritten onto the flat `/api/<rest>`
  // handlers with the resolved diff attached to the request.
  app.use((req, res, next) => {
    const [pathname, query] = req.url.split('?');
    const match = /^\/api\/d\/([^/]+)(\/.*)?$/.exec(pathname ?? '');
    if (!match) {
      next();
      return;
    }

    const entry = isValidDiffEntryId(match[1]) ? diffEntries.get(match[1]) : undefined;
    if (!entry) {
      res.status(404).json({ error: `Unknown diff id: ${match[1]}` });
      return;
    }

    (req as ScopedRequest)[DIFF_SCOPE_KEY] = entry;
    req.url = `/api${match[2] ?? '/'}${query === undefined ? '' : `?${query}`}`;
    next();
  });

  // Flat `/api/...` routes accept `?diffId=` as an equivalent scope selector.
  app.use('/api', (req, res, next) => {
    const scoped = (req as ScopedRequest)[DIFF_SCOPE_KEY];
    if (scoped) {
      next();
      return;
    }

    const requestedId = req.query.diffId;
    if (requestedId === undefined) {
      next();
      return;
    }

    const entry = typeof requestedId === 'string' ? diffEntries.get(requestedId) : undefined;
    if (!entry) {
      res.status(404).json({ error: `Unknown diff id: ${String(requestedId)}` });
      return;
    }

    (req as ScopedRequest)[DIFF_SCOPE_KEY] = entry;
    next();
  });

  /** Resolves the diff a request targets, defaulting to the most recently added one. */
  function resolveDiffEntry(req: express.Request): DiffEntryState {
    return (req as ScopedRequest)[DIFF_SCOPE_KEY] ?? diffEntries.get(activeDiffId) ?? initialEntry;
  }

  function parseRepositoryRelativePath(filepath: unknown):
    | { ok: true; path: string }
    | {
        ok: false;
        error: 'Invalid file path' | 'File path outside repository';
      } {
    if (typeof filepath !== 'string' || filepath.length === 0) {
      return { ok: false, error: 'Invalid file path' };
    }

    const normalizedFilepath = filepath.replace(/\\/g, '/');
    const hasParentTraversal = normalizedFilepath.split('/').some((segment) => segment === '..');
    if (isAbsolute(filepath) || normalizedFilepath.startsWith('/') || hasParentTraversal) {
      return { ok: false, error: 'File path outside repository' };
    }

    const resolvedPath = resolve(repositoryPath, normalizedFilepath);
    if (resolvedPath !== repositoryPath && !resolvedPath.startsWith(`${repositoryPath}${sep}`)) {
      return { ok: false, error: 'File path outside repository' };
    }

    return { ok: true, path: normalizedFilepath };
  }

  interface EditorRequest {
    readonly id: string | undefined;
    readonly command: string | undefined;
    readonly argsTemplate: string | undefined;
  }

  function parseEditorRequest(value: unknown): EditorRequest {
    if (!value || typeof value !== 'object') {
      return { id: undefined, command: undefined, argsTemplate: undefined };
    }
    const candidate = value as {
      id?: unknown;
      command?: unknown;
      argsTemplate?: unknown;
    };
    return {
      id: typeof candidate.id === 'string' ? candidate.id : undefined,
      command: typeof candidate.command === 'string' ? candidate.command : undefined,
      argsTemplate: typeof candidate.argsTemplate === 'string' ? candidate.argsTemplate : undefined,
    };
  }

  const commentSessions = new Map<string, CommentSessionState>();

  function createCommentStoreKey(entry: DiffEntryState, selection: DiffSelection): string {
    if (
      entry.stdinCommentStoreKey &&
      getDiffSelectionKey(selection) === getDiffSelectionKey(entry.commentSelection)
    ) {
      return entry.stdinCommentStoreKey;
    }
    return createCommentStoreKeyForSelection(selection);
  }

  function getCommentSelectionFromQuery(
    entry: DiffEntryState,
    query: Record<string, unknown>,
  ): DiffSelection {
    const hasBase = typeof query.base === 'string';
    const hasTarget = typeof query.target === 'string';
    const hasBaseMode = typeof query.baseMode === 'string';

    if (!hasBase && !hasTarget && !hasBaseMode) {
      return entry.commentSelection;
    }

    return createDiffSelection(
      hasBase ? (query.base as string) : entry.commentSelection.baseCommitish,
      hasTarget ? (query.target as string) : entry.commentSelection.targetCommitish,
      hasBaseMode
        ? parseBaseMode(query.baseMode)
        : hasBase || hasTarget
          ? undefined
          : entry.commentSelection.baseMode,
    );
  }

  function getOrCreateCommentSession(
    entry: DiffEntryState,
    selection: DiffSelection,
  ): CommentSessionState {
    const key = createCommentSessionKey(entry.id, selection);
    const existing = commentSessions.get(key);
    if (existing) {
      return existing;
    }

    // First touch of a session in this process: restore whatever an earlier process saved.
    const storeKey = createCommentStoreKey(entry, selection);
    const nextSession: CommentSessionState = {
      threads: commentStore.read(storeKey)?.threads ?? [],
      version: 0,
      storeKey,
    };
    commentSessions.set(key, nextSession);
    return nextSession;
  }

  // The server is the source of truth for comments: `--clean` wipes the persisted session
  // and `--comment` imports are merged in before any client can observe the session.
  {
    const startupSelection = initialEntry.commentSelection;
    if (options.clearComments) {
      commentStore.remove(createCommentStoreKey(initialEntry, startupSelection));
    }
    const startupSession = getOrCreateCommentSession(initialEntry, startupSelection);
    if (initialCommentImports.length > 0) {
      const merged = mergeCommentImports(startupSession.threads, initialCommentImports);
      for (const warning of merged.warnings) {
        console.warn(`⚠️  ${warning}`);
      }
      if (JSON.stringify(merged.threads) !== JSON.stringify(startupSession.threads)) {
        startupSession.threads = merged.threads;
        startupSession.version += 1;
        commentStore.write(startupSession.storeKey, startupSelection, startupSession.threads);
      }
    }
  }

  let watchMode: DiffMode | undefined;

  /**
   * Diffs added after startup may need broader watching than the server booted
   * with; widen to DOT (the superset) rather than juggling per-diff watchers.
   */
  async function ensureWatchCoverage(mode: DiffMode): Promise<void> {
    if (mode === DiffMode.SPECIFIC || watchMode === mode || watchMode === DiffMode.DOT) {
      return;
    }

    const nextMode = watchMode === undefined ? mode : DiffMode.DOT;
    try {
      await fileWatcher.start(nextMode, repositoryPath, 300, invalidateCache);
      watchMode = nextMode;
    } catch (error) {
      console.warn('⚠️  File watcher failed to start:', error);
    }
  }

  function resolveAddedBaseCommitish(target: string, base: unknown): string {
    if (typeof base === 'string' && base.length > 0) {
      return base;
    }

    if (target === 'working') {
      return 'staged';
    }

    if (target === 'staged' || target === '.') {
      return 'HEAD';
    }

    return `${target}^`;
  }

  app.get('/api/diffs', (_req, res) => {
    const response: DiffsResponse = {
      diffs: [...diffEntries.values()].map(toDiffEntrySummary),
      activeDiffId,
    };
    res.json(response);
  });

  // Register an additional diff on this running server.
  app.post('/api/diffs', async (req, res) => {
    const body: unknown = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const payload = (body ?? {}) as {
      target?: unknown;
      base?: unknown;
      baseMode?: unknown;
      title?: unknown;
    };

    if (typeof payload.target !== 'string' || payload.target.trim().length === 0) {
      res.status(400).json({ error: 'target is required' });
      return;
    }

    const target = payload.target.trim();
    const selection = createDiffSelection(
      resolveAddedBaseCommitish(target, payload.base),
      target,
      parseBaseMode(payload.baseMode),
    );

    try {
      if (!(await parser.validateCommit(target))) {
        res.status(400).json({ error: `Invalid or non-existent commit: ${target}` });
        return;
      }

      const diffData = await parser.parseDiff(selection, false, options.contextLines);
      setCachedDiffResponse(diffDataCache, createDiffCacheKey(selection, false), diffData);

      const entry = createDiffEntry({
        selection,
        diffData,
        title: typeof payload.title === 'string' ? payload.title : undefined,
      });

      await ensureWatchCoverage(
        determineDiffMode(selection, typeof payload.base === 'string' && payload.base.length > 0),
      );

      res.status(201).json({
        ...toDiffEntrySummary(entry),
        isEmpty: diffData.isEmpty ?? false,
      });
    } catch (error) {
      console.error('Error adding diff:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to add diff',
      });
    }
  });

  app.get('/api/diff', async (req, res) => {
    const entry = resolveDiffEntry(req);
    const ignoreWhitespace = req.query.ignoreWhitespace === 'true';
    const hasBase = typeof req.query.base === 'string';
    const hasTarget = typeof req.query.target === 'string';
    const hasBaseMode = typeof req.query.baseMode === 'string';
    const requestedSelection = createDiffSelection(
      hasBase ? (req.query.base as string) : entry.selection.baseCommitish,
      hasTarget ? (req.query.target as string) : entry.selection.targetCommitish,
      hasBaseMode
        ? parseBaseMode(req.query.baseMode)
        : hasBase || hasTarget
          ? undefined
          : entry.selection.baseMode,
    );
    let responseDiffData = entry.stdinDiffData ?? initialDiffData;
    if (!entry.stdinDiff) {
      const cacheKey = createDiffCacheKey(requestedSelection, ignoreWhitespace);
      const cached = getCachedDiffResponse(diffDataCache, cacheKey);
      if (cached) {
        responseDiffData = cached;
      } else {
        try {
          responseDiffData = await parser.parseDiff(
            requestedSelection,
            ignoreWhitespace,
            options.contextLines,
          );
        } catch (error) {
          console.error('Error fetching diff:', error);
          res.status(500).json({
            error: error instanceof Error ? error.message : 'Failed to fetch diff',
          });
          return;
        }
        setCachedDiffResponse(diffDataCache, cacheKey, responseDiffData);
        generatedStatusCache.clear();
      }
    }

    entry.selection = requestedSelection;

    entry.commentSelection = createResolvedCommentSelection(
      responseDiffData,
      requestedSelection,
      Boolean(entry.stdinDiff),
    );

    const baseCommitish = responseDiffData.baseCommitish ?? (entry.stdinDiff ? 'stdin' : undefined);
    const targetCommitish =
      responseDiffData.targetCommitish ?? (entry.stdinDiff ? 'stdin' : undefined);
    const requestedBaseCommitish =
      responseDiffData.requestedBaseCommitish ??
      (requestedSelection.baseCommitish || (entry.stdinDiff ? 'stdin' : undefined));
    const requestedTargetCommitish =
      responseDiffData.requestedTargetCommitish ??
      (requestedSelection.targetCommitish || (entry.stdinDiff ? 'stdin' : undefined));
    const requestedBaseMode = responseDiffData.requestedBaseMode ?? requestedSelection.baseMode;

    res.json({
      ...responseDiffData,
      diffId: entry.id,
      ignoreWhitespace,
      openInEditorAvailable: !entry.stdinDiff,
      baseCommitish,
      targetCommitish,
      requestedBaseCommitish,
      requestedTargetCommitish,
      requestedBaseMode,
      clearComments: options.clearComments,
      repositoryId,
    });
  });

  app.get(/^\/api\/generated-status\/(.*)$/, async (req, res) => {
    const entry = resolveDiffEntry(req);
    if (entry.stdinDiff) {
      res.status(400).json({ error: 'Generated status is not available for stdin diff' });
      return;
    }

    try {
      const filepathResult = parseRepositoryRelativePath(req.params[0]);
      if (!filepathResult.ok) {
        res.status(400).json({ error: filepathResult.error });
        return;
      }
      const normalizedFilepath = filepathResult.path;

      const ref = (req.query.ref as string) || entry.selection.targetCommitish || 'HEAD';
      const cacheKey = `${ref}:${normalizedFilepath}`;
      const now = Date.now();
      const cached = generatedStatusCache.get(cacheKey);
      if (cached && cached.expiresAt > now) {
        res.json(cached.value);
        return;
      }

      const status = await parser.getGeneratedStatus(normalizedFilepath, ref);
      const response: GeneratedStatusResponse = {
        path: normalizedFilepath,
        ref,
        ...status,
      };
      generatedStatusCache.set(cacheKey, {
        value: response,
        expiresAt: now + GENERATED_STATUS_CACHE_TTL_MS,
      });

      res.json(response);
    } catch (error) {
      console.error('Error fetching generated status:', error);
      res.status(500).json({ error: 'Failed to get generated status' });
    }
  });

  // Get available revisions for revision selector
  app.get('/api/revisions', async (req, res) => {
    const entry = resolveDiffEntry(req);
    if (entry.stdinDiff) {
      res.status(400).json({ error: 'Revision selection not available for stdin diff' });
      return;
    }

    try {
      const { branches, commits, originDefaultBranch, resolvedBase, resolvedTarget } =
        await parser.getRevisionOptions(
          entry.selection.baseCommitish,
          entry.selection.targetCommitish,
        );

      const response: RevisionsResponse = {
        specialOptions: [
          { value: '.', label: 'All Uncommitted Changes' },
          { value: 'staged', label: 'Staging Area' },
          { value: 'working', label: 'Working Directory' },
        ],
        branches,
        commits,
        originDefaultBranch,
        resolvedBase,
        resolvedTarget,
      };

      res.json(response);
    } catch (error) {
      console.error('Error fetching revisions:', error);
      res.status(500).json({ error: 'Failed to fetch revisions' });
    }
  });

  app.get(/^\/api\/line-count\/(.*)$/, async (req, res) => {
    try {
      if (resolveDiffEntry(req).stdinDiff) {
        res.status(404).json({ error: 'Line count not available for stdin diff' });
        return;
      }

      const filepathResult = parseRepositoryRelativePath(req.params[0]);
      if (!filepathResult.ok) {
        res.status(400).json({ error: filepathResult.error });
        return;
      }
      const filepath = filepathResult.path;
      const oldRef = req.query.oldRef as string | undefined;
      const oldPathResult = req.query.oldPath
        ? parseRepositoryRelativePath(req.query.oldPath)
        : { ok: true as const, path: filepath };
      if (!oldPathResult.ok) {
        res.status(400).json({ error: oldPathResult.error });
        return;
      }
      const newRef = req.query.newRef as string | undefined;
      const oldPath = oldPathResult.path;

      const result: { oldLineCount?: number; newLineCount?: number } = {};

      if (oldRef) {
        try {
          result.oldLineCount = await parser.getLineCount(oldPath, oldRef);
        } catch {
          result.oldLineCount = 0;
        }
      }
      if (newRef) {
        try {
          result.newLineCount = await parser.getLineCount(filepath, newRef);
        } catch {
          result.newLineCount = 0;
        }
      }

      res.json(result);
    } catch (error) {
      console.error('Error fetching line count:', error);
      res.status(500).json({ error: 'Failed to get line count' });
    }
  });

  app.get(/^\/api\/blob\/(.*)$/, async (req, res) => {
    try {
      // If using stdin diff, blob content is not available
      if (resolveDiffEntry(req).stdinDiff) {
        res.status(404).json({ error: 'Blob content not available for stdin diff' });
        return;
      }

      const filepathResult = parseRepositoryRelativePath(req.params[0]);
      if (!filepathResult.ok) {
        res.status(400).json({ error: filepathResult.error });
        return;
      }
      const filepath = filepathResult.path;
      const ref = (req.query.ref as string) || 'HEAD';

      const blob = await parser.getBlobContent(filepath, ref);

      // Determine content type based on file extension
      const ext = getFileExtension(filepath);
      const contentTypes: { [key: string]: string } = {
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        gif: 'image/gif',
        bmp: 'image/bmp',
        svg: 'image/svg+xml',
        webp: 'image/webp',
        ico: 'image/x-icon',
        tiff: 'image/tiff',
        tif: 'image/tiff',
        avif: 'image/avif',
        heic: 'image/heic',
        heif: 'image/heif',
      };

      const contentType = contentTypes[ext || ''] || 'application/octet-stream';

      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.send(blob);
    } catch (error) {
      console.error('Error fetching blob:', error);
      res.status(404).json({ error: 'File not found' });
    }
  });

  function normalizeLineValue(line: unknown): DiffCommentThread['position']['line'] {
    if (Array.isArray(line) && line.length === 2) {
      const start = line[0] as unknown;
      const end = line[1] as unknown;
      if (
        typeof start === 'number' &&
        typeof end === 'number' &&
        Number.isInteger(start) &&
        Number.isInteger(end) &&
        start > 0 &&
        end > 0 &&
        start <= end
      ) {
        return { start, end };
      }
    }

    if (typeof line === 'number' && Number.isInteger(line) && line > 0) {
      return line;
    }

    return 1;
  }

  function normalizeComment(comment: Comment): DiffCommentThread {
    const now = new Date().toISOString();
    const timestamp = typeof comment.timestamp === 'string' ? comment.timestamp : now;
    const threadId =
      typeof comment.id === 'string' && comment.id.length > 0
        ? comment.id
        : createHash('sha256').update(JSON.stringify(comment)).digest('hex').slice(0, 12);
    const filePath =
      typeof comment.file === 'string' && comment.file.length > 0 ? comment.file : '<unknown file>';

    return {
      id: threadId,
      filePath,
      createdAt: timestamp,
      updatedAt: timestamp,
      position: {
        side: comment.side ?? 'new',
        line: normalizeLineValue(comment.line),
      },
      codeSnapshot:
        typeof comment.codeContent === 'string'
          ? {
              content: comment.codeContent,
            }
          : undefined,
      messages: [
        {
          id: threadId,
          body: comment.body,
          author: comment.author,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
    };
  }

  function toCommentThread(thread: DiffCommentThread): CommentThread {
    return {
      id: thread.id,
      file: thread.filePath,
      line:
        typeof thread.position.line === 'number'
          ? thread.position.line
          : ([thread.position.line.start, thread.position.line.end] as [number, number]),
      side: thread.position.side,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      codeContent: thread.codeSnapshot?.content,
      messages: thread.messages,
    };
  }

  function normalizeThreadPayload(thread: CommentThread | DiffCommentThread): DiffCommentThread {
    if ('filePath' in thread && 'position' in thread) {
      return thread;
    }

    const threadId =
      typeof thread.id === 'string' && thread.id.length > 0
        ? thread.id
        : createHash('sha256').update(JSON.stringify(thread)).digest('hex').slice(0, 12);
    const now = new Date().toISOString();
    const messages =
      Array.isArray(thread.messages) && thread.messages.length > 0
        ? thread.messages.map((message, index) => ({
            id:
              typeof message.id === 'string' && message.id.length > 0
                ? message.id
                : `${threadId}:${index}`,
            body: message.body,
            author: message.author,
            createdAt: message.createdAt || thread.createdAt || now,
            updatedAt: message.updatedAt || message.createdAt || thread.updatedAt || now,
          }))
        : [
            {
              id: threadId,
              body: '',
              createdAt: thread.createdAt || now,
              updatedAt: thread.updatedAt || thread.createdAt || now,
            },
          ];
    const firstMessage = messages[0];
    const lastMessage = messages[messages.length - 1];

    return {
      id: threadId,
      filePath:
        typeof thread.file === 'string' && thread.file.length > 0 ? thread.file : '<unknown file>',
      createdAt: thread.createdAt || firstMessage?.createdAt || now,
      updatedAt: thread.updatedAt || lastMessage?.updatedAt || thread.createdAt || now,
      position: {
        side: thread.side ?? 'new',
        line: normalizeLineValue(thread.line),
      },
      codeSnapshot:
        typeof thread.codeContent === 'string'
          ? {
              content: thread.codeContent,
            }
          : undefined,
      messages,
    };
  }

  function parseCommentsPayload(body: unknown): DiffCommentThread[] {
    const payload =
      typeof body === 'string'
        ? (JSON.parse(body) as {
            comments?: Comment[];
            threads?: Array<CommentThread | DiffCommentThread>;
          })
        : (body as {
            comments?: Comment[];
            threads?: Array<CommentThread | DiffCommentThread>;
          });

    if (Array.isArray(payload.threads)) {
      return payload.threads.map(normalizeThreadPayload);
    }

    if (Array.isArray(payload.comments)) {
      return payload.comments.map(normalizeComment);
    }

    return [];
  }

  // Version the client based its full-replace push on.
  function parseBaseVersion(payload: unknown): number | undefined {
    if (!payload || typeof payload !== 'object') return undefined;
    const value = (payload as { baseVersion?: unknown }).baseVersion;
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
  }

  function parseCommentImportsPayload(body: unknown): CommentImport[] {
    if (typeof body === 'string') {
      return normalizeCommentImports(JSON.parse(body));
    }

    return normalizeCommentImports(body);
  }

  function updateCommentSession(
    entry: DiffEntryState,
    selection: DiffSelection,
    nextThreads: DiffCommentThread[],
  ): boolean {
    const session = getOrCreateCommentSession(entry, selection);
    const previous = JSON.stringify(session.threads);
    const next = JSON.stringify(nextThreads);
    session.threads = nextThreads;

    if (previous === next) {
      return false;
    }

    session.version += 1;
    commentStore.write(session.storeKey, selection, session.threads);
    fileWatcher.broadcast({
      type: 'commentsChanged',
      version: session.version,
      timestamp: new Date().toISOString(),
    });
    return true;
  }

  /**
   * Full replacement of a session, guarded by compare-and-set on `baseVersion`. Clients that
   * want to change one thread should use PUT/DELETE `/api/comments/:threadId` instead; this
   * endpoint exists for whole-list operations such as "clear all".
   */
  app.post('/api/comments', (req, res) => {
    let body: unknown;
    let nextThreads: DiffCommentThread[];
    try {
      body = typeof req.body === 'string' ? (JSON.parse(req.body) as unknown) : req.body;
      nextThreads = parseCommentsPayload(body);
    } catch (error) {
      console.error('Error parsing comments:', error);
      res.status(400).json({ error: 'Invalid comment data' });
      return;
    }

    const baseVersion = parseBaseVersion(body);
    if (baseVersion === undefined) {
      res.status(400).json({
        error:
          'baseVersion is required: read it from GET /api/comments-json and echo it back so a stale client cannot overwrite newer comments',
      });
      return;
    }

    const entry = resolveDiffEntry(req);
    const selection = getCommentSelectionFromQuery(entry, req.query as Record<string, unknown>);
    const session = getOrCreateCommentSession(entry, selection);

    if (baseVersion !== session.version) {
      // Someone else (another tab, an agent, the startup import) wrote since this client last
      // read. Refuse rather than merge: a merge cannot express deletions and would resurrect
      // threads the other writer removed. The client re-reads and retries.
      res.status(409).json({
        error: 'Comment session changed since baseVersion; reload and retry',
        version: session.version,
        threads: session.threads,
      });
      return;
    }

    updateCommentSession(entry, selection, nextThreads);

    res.json({
      success: true,
      version: session.version,
      threads: session.threads,
    });
  });

  /** Creates or replaces a single thread; the unit of change the browser client uses. */
  app.put('/api/comments/:threadId', (req, res) => {
    const threadId = req.params.threadId;
    let thread: DiffCommentThread;
    try {
      const body: unknown =
        typeof req.body === 'string' ? (JSON.parse(req.body) as unknown) : req.body;
      const payload = (body ?? {}) as { thread?: unknown };
      const candidate = (payload.thread ?? body) as CommentThread | DiffCommentThread | null;
      if (!candidate || typeof candidate !== 'object' || !Array.isArray(candidate.messages)) {
        throw new Error('thread payload must include messages');
      }
      thread = normalizeThreadPayload({ ...candidate, id: threadId });
    } catch (error) {
      console.error('Error parsing comment thread:', error);
      res.status(400).json({ error: 'Invalid comment thread data' });
      return;
    }

    const entry = resolveDiffEntry(req);
    const selection = getCommentSelectionFromQuery(entry, req.query as Record<string, unknown>);
    const session = getOrCreateCommentSession(entry, selection);
    const existingIndex = session.threads.findIndex((item) => item.id === threadId);
    const nextThreads =
      existingIndex < 0
        ? [...session.threads, thread]
        : session.threads.map((item, index) => (index === existingIndex ? thread : item));

    updateCommentSession(entry, selection, nextThreads);

    res.status(existingIndex < 0 ? 201 : 200).json({
      success: true,
      version: session.version,
      thread,
    });
  });

  app.post('/api/comment-imports', (req, res) => {
    try {
      const entry = resolveDiffEntry(req);
      const selection = getCommentSelectionFromQuery(entry, req.query as Record<string, unknown>);
      const session = getOrCreateCommentSession(entry, selection);
      const commentImports = parseCommentImportsPayload(req.body);
      const importId = createHash('sha256')
        .update(serializeCommentImports(commentImports))
        .digest('hex');
      const merged = mergeCommentImports(session.threads, commentImports);
      const changed = updateCommentSession(entry, selection, merged.threads);

      res.json({
        success: true,
        changed,
        count: commentImports.length,
        importId,
        warnings: merged.warnings,
      });
    } catch (error) {
      console.error('Error parsing comment imports:', error);
      res.status(400).json({ error: 'Invalid comment import data' });
    }
  });

  app.delete('/api/comments/:threadId', (req, res) => {
    const entry = resolveDiffEntry(req);
    const selection = getCommentSelectionFromQuery(entry, req.query as Record<string, unknown>);
    const session = getOrCreateCommentSession(entry, selection);
    const threadId = req.params.threadId;
    const nextThreads = session.threads.filter((thread) => thread.id !== threadId);

    if (nextThreads.length === session.threads.length) {
      res.status(404).json({ error: `Thread not found: ${threadId}` });
      return;
    }

    updateCommentSession(entry, selection, nextThreads);

    res.json({
      success: true,
      threadId,
      version: session.version,
    });
  });

  app.get('/api/comments-json', (req, res) => {
    const entry = resolveDiffEntry(req);
    const selection = getCommentSelectionFromQuery(entry, req.query as Record<string, unknown>);
    const session = getOrCreateCommentSession(entry, selection);
    res.json({
      version: session.version,
      threads: session.threads,
    });
  });

  /**
   * Text output for humans and for the CLI's shutdown dump. An unscoped request on a
   * server hosting several diffs reports all of them, each under its own heading.
   */
  app.get('/api/comments-output', (req, res) => {
    res.type('text/plain');

    const isScoped =
      (req as ScopedRequest)[DIFF_SCOPE_KEY] !== undefined ||
      typeof req.query.base === 'string' ||
      typeof req.query.target === 'string' ||
      typeof req.query.baseMode === 'string';

    if (!isScoped) {
      res.send(buildAllCommentsOutput());
      return;
    }

    const entry = resolveDiffEntry(req);
    const selection = getCommentSelectionFromQuery(entry, req.query as Record<string, unknown>);
    const session = getOrCreateCommentSession(entry, selection);

    if (session.threads.length > 0) {
      res.send(formatCommentsOutput(session.threads.map(toCommentThread)));
    } else {
      res.send('');
    }
  });

  app.get('/api/user-settings', async (_req, res) => {
    const config = await readUserConfig();
    res.json(config);
  });

  app.put('/api/user-settings', async (req, res) => {
    let patch: Record<string, unknown> | null;
    try {
      const body: unknown = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      patch = parseUserSettingsPatch(body);
    } catch {
      patch = null;
    }

    if (!patch) {
      res.status(400).json({ error: 'Invalid user settings payload' });
      return;
    }

    try {
      const config = await updateUserClientSettings(patch);
      res.json(config);
    } catch (error) {
      console.error('Error saving user settings:', error);
      res.status(500).json({ error: 'Failed to save user settings' });
    }
  });

  app.post('/api/open-in-editor', async (req, res) => {
    if (resolveDiffEntry(req).stdinDiff) {
      res.status(400).json({ error: 'Open in editor is not available for stdin diff' });
      return;
    }

    const { filePath, line, editor } = (req.body ?? {}) as {
      filePath?: unknown;
      line?: unknown;
      editor?: unknown;
    };

    if (typeof filePath !== 'string') {
      res.status(400).json({ error: 'Invalid request payload' });
      return;
    }

    const filepathResult = parseRepositoryRelativePath(filePath);
    if (!filepathResult.ok) {
      res.status(400).json({ error: filepathResult.error });
      return;
    }
    const resolvedPath = resolve(repositoryPath, filepathResult.path);

    const editorRequest = parseEditorRequest(editor);
    const editorId =
      editorRequest.id ?? process.env.DIFIT_EDITOR ?? process.env.EDITOR ?? undefined;

    if (editorId?.toLowerCase() === NONE_EDITOR_ID) {
      res.status(400).json({ error: 'Open in editor is disabled' });
      return;
    }

    // The browser always sends command + argsTemplate in the body, so we use
    // those directly. We only fall back to the preset table when neither is
    // provided (for example, when DIFIT_EDITOR is set and there's no body).
    let command: string;
    let argsTemplate: string;
    if (editorRequest.command !== undefined || editorRequest.argsTemplate !== undefined) {
      command = (editorRequest.command ?? '').trim();
      argsTemplate = (editorRequest.argsTemplate ?? '').trim();
    } else {
      const preset = resolveEditorOption(editorId);
      command = preset.command;
      argsTemplate = preset.argsTemplate;
    }

    if (!command || !argsTemplate) {
      const isCustom = editorId?.toLowerCase() === CUSTOM_EDITOR_ID;
      res.status(400).json({
        error: isCustom
          ? 'Custom editor is not configured. Set a command and arguments in Settings > System.'
          : 'Open in editor is not configured',
      });
      return;
    }

    const lineNumber = (() => {
      const parsed = Number.parseInt(String(line ?? ''), 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    })();

    const spawnSpec = buildEditorSpawnSpec({
      command,
      argsTemplate,
      filePath: resolvedPath,
      lineNumber,
    });

    if (!spawnSpec) {
      res.status(500).json({ error: 'Invalid editor configuration' });
      return;
    }

    const launched = await new Promise<boolean>((resolvePromise) => {
      const child = spawn(spawnSpec.command, [...spawnSpec.args], {
        stdio: 'ignore',
        detached: true,
      });
      child.once('error', (error) => {
        const code = (error as NodeJS.ErrnoException).code;
        if (code && code !== 'ENOENT') {
          console.error('Failed to launch editor CLI:', error);
        }
        resolvePromise(false);
      });
      child.once('spawn', () => {
        child.unref();
        resolvePromise(true);
      });
    });

    if (!launched) {
      res.status(500).json({
        error: `Failed to launch editor: command "${spawnSpec.command}" is not available on PATH`,
      });
      return;
    }

    res.json({ success: true });
  });

  // Function to output comments when server shuts down
  /** Comments of every hosted diff, labelled per diff once more than one exists. */
  function buildAllCommentsOutput(): string {
    const entries = [...diffEntries.values()];
    const sections: string[] = [];

    for (const entry of entries) {
      const session = getOrCreateCommentSession(entry, entry.commentSelection);
      if (session.threads.length === 0) {
        continue;
      }

      const output = formatCommentsOutput(session.threads.map(toCommentThread));
      sections.push(entries.length > 1 ? `# ${entry.title}  (${entry.id})\n${output}` : output);
    }

    return sections.join('\n');
  }

  function outputFinalComments() {
    const output = buildAllCommentsOutput();
    if (output) {
      console.log(output);
    }
  }

  // SSE endpoint for file watching
  app.get('/api/watch', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    fileWatcher.addClient(res);

    req.on('close', () => {
      fileWatcher.removeClient(res);
    });
  });

  // SSE endpoint to detect when tab is closed
  app.get('/api/heartbeat', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    // Send initial heartbeat
    res.write('data: connected\n\n');

    // Send heartbeat every 5 seconds
    const heartbeatInterval = setInterval(() => {
      res.write('data: heartbeat\n\n');
    }, 5000);

    // When client disconnects (tab closed, navigation, etc.)
    req.on('close', () => {
      clearInterval(heartbeatInterval);
      if (options.keepAlive) {
        console.log('Client disconnected, but server is staying alive (--keep-alive)');
        console.log('Press Ctrl+C to stop the server');
      } else {
        // Add a small delay to ensure any pending sendBeacon requests are processed
        setTimeout(async () => {
          console.log('Client disconnected, shutting down server...');

          // Stop file watcher
          await fileWatcher.stop();

          outputFinalComments();
          process.exit(0);
        }, 100);
      }
    });
  });

  // Always runs in production mode when distributed as a CLI tool
  const isProduction =
    process.env.NODE_ENV === 'production' || process.env.NODE_ENV !== 'development';

  if (isProduction) {
    // Find client files relative to the CLI executable location
    const distPath = join(__dirname, '..', 'client');
    app.use(express.static(distPath));
    // `/d/:diffId` is a client-side route; serve the SPA shell for it.
    app.get(/^\/d\/[^/]+\/?$/, (_req, res) => {
      res.sendFile(join(distPath, 'index.html'));
    });
  } else {
    app.get('/', (_req, res) => {
      res.send(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>difit - Dev Mode</title>
          </head>
          <body>
            <div id="root"></div>
            <script>
              console.log('difit development mode');
              console.log('Diff data available at /api/diff');
            </script>
          </body>
        </html>
      `);
    });
  }

  const { port, url, server } = await startServerWithFallback(
    app,
    options.preferredPort || 4966,
    options.host || 'localhost',
  );

  // Security warning for non-localhost binding
  if (options.host && options.host !== '127.0.0.1' && options.host !== 'localhost') {
    console.warn('\n⚠️  WARNING: Server is accessible from external network!');
    console.warn(`   Binding to: ${options.host}:${port}`);
    console.warn('   Make sure this is intended and your network is secure.\n');
  }

  // Start file watcher
  if (options.diffMode) {
    try {
      await fileWatcher.start(options.diffMode, repositoryPath, 300, invalidateCache);
      watchMode = options.diffMode;
    } catch (error) {
      console.warn('⚠️  File watcher failed to start:', error);
      console.warn('   Continuing without file watching...');
    }
  }

  // Check if diff is empty and skip browser opening
  if (initialDiffData.isEmpty) {
    // Don't open browser if no differences found
  } else if (options.openBrowser) {
    try {
      await open(url);
    } catch {
      console.warn('Failed to open browser automatically');
    }
  }

  return { port, url, isEmpty: initialDiffData.isEmpty || false, server };
}

async function startServerWithFallback(
  app: Express,
  preferredPort: number,
  host: string,
): Promise<{ port: number; url: string; server: Server }> {
  return new Promise((resolve, reject) => {
    // express's listen() method uses listen() method in node:net Server instance internally
    // https://expressjs.com/en/5x/api.html#app.listen
    // so, an error will be an instance of NodeJS.ErrnoException
    const server = app.listen(preferredPort, host, (err: NodeJS.ErrnoException | undefined) => {
      const displayHost = host === '0.0.0.0' ? 'localhost' : host;
      const url = `http://${displayHost}:${preferredPort}`;
      if (!err) {
        resolve({ port: preferredPort, url, server });
        return;
      }

      // Handling errors when failed to launch a server
      switch (err.code) {
        // Try another port until it succeeds
        case 'EADDRINUSE': {
          console.log(`Port ${preferredPort} is busy, trying ${preferredPort + 1}...`);
          return startServerWithFallback(app, preferredPort + 1, host)
            .then(({ port, url, server }) => {
              resolve({ port, url, server });
            })
            .catch(reject);
        }
        // Unexpected error
        default: {
          reject(new Error(`Failed to launch a server: ${err.message}`));
        }
      }
    });
  });
}
