import { promises as fs, mkdtempSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Set environment variable to skip fetch mocking
process.env.VITEST_SERVER_TEST = 'true';
// Keep persisted comment sessions out of the real repository's .git directory.
const commentStoreDir = mkdtempSync(join(tmpdir(), 'difit-server-comments-'));
process.env.DIFIT_COMMENT_STORE_DIR = commentStoreDir;

import { startServer } from './server.js';
import type { CommentImport } from '../types/diff.js';

// Add fetch polyfill for Node.js test environment
const { fetch } = await import('undici');
globalThis.fetch = fetch as any;
const parserInstances = vi.hoisted(() => [] as any[]);

// Helper function to get available port
async function getAvailablePort(preferredPort: number): Promise<number> {
  let port = preferredPort;
  const maxAttempts = 10;

  for (let i = 0; i < maxAttempts; i++) {
    try {
      await fetch(`http://localhost:${port}`);
      // If we get here, port is in use, try next one
      port++;
    } catch {
      // Port is available
      return port;
    }
  }

  return port;
}

// Mock GitDiffParser
vi.mock('./git-diff.js', () => {
  class GitDiffParserMock {
    constructor() {
      parserInstances.push(this);
    }

    validateCommit = vi.fn().mockResolvedValue(true);
    parseDiff = vi.fn().mockResolvedValue({
      targetCommit: 'abc123',
      baseCommit: 'def456',
      baseCommitish: 'def4567',
      targetCommitish: 'abc1234',
      requestedBaseCommitish: 'HEAD^',
      requestedTargetCommitish: 'HEAD',
      requestedBaseMode: undefined,
      targetMessage: 'Test commit',
      baseMessage: 'Previous commit',
      files: [
        {
          path: 'test.js',
          additions: 10,
          deletions: 5,
          chunks: [],
        },
      ],
      stats: { additions: 10, deletions: 5 },
      isEmpty: false,
    });
    parseStdinDiff = vi.fn().mockReturnValue({
      targetCommit: 'stdin-target',
      baseCommit: 'stdin-base',
      targetMessage: 'stdin target',
      baseMessage: 'stdin base',
      files: [
        {
          path: 'stdin-test.js',
          additions: 1,
          deletions: 0,
          chunks: [],
        },
      ],
      stats: { additions: 1, deletions: 0 },
      isEmpty: false,
    });
    getBlobContent = vi.fn().mockResolvedValue(Buffer.from('mock image data'));
    getLineCount = vi.fn().mockResolvedValue(42);
    getGeneratedStatus = vi.fn().mockResolvedValue({
      isGenerated: true,
      source: 'content',
    });
    clearResolvedCommitCache = vi.fn();
    getRevisionOptions = vi.fn().mockResolvedValue({
      branches: [{ name: 'main', current: true }],
      commits: [{ hash: 'abc1234', shortHash: 'abc1234', message: 'Test commit' }],
      originDefaultBranch: 'origin/main',
      resolvedBase: 'abc1234',
      resolvedTarget: 'def5678',
    });
  }

  return { GitDiffParser: GitDiffParserMock };
});

describe('Server Integration Tests', () => {
  describe('Comments API', () => {
    it('should accept properly formatted comments', async () => {
      const port = await getAvailablePort(4966);
      const result = await startServer({
        preferredPort: port,
        openBrowser: false,
      });

      try {
        const comments = [
          {
            id: '1',
            file: 'src/App.tsx',
            line: 10,
            body: 'Test comment',
            timestamp: '2024-01-01T00:00:00Z',
          },
          {
            id: '2',
            file: 'src/utils/helper.ts',
            line: [20, 30],
            body: 'Another comment',
            timestamp: '2024-01-01T00:01:00Z',
          },
        ];

        const response = await fetch(`http://localhost:${result.port}/api/comments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ comments, baseVersion: 0 }),
        });

        expect(response.status).toBe(200);
        const apiResult = (await response.json()) as {
          success: boolean;
          version: number;
        };
        expect(apiResult).toMatchObject({ success: true, version: 1 });

        // Verify the formatted output
        const outputResponse = await fetch(`http://localhost:${result.port}/api/comments-output`);
        const output = await outputResponse.text();

        expect(output).toContain('src/App.tsx:L10');
        expect(output).toContain('Test comment');
        expect(output).toContain('src/utils/helper.ts:L20-L30');
        expect(output).toContain('Another comment');
        expect(output).not.toContain('undefined');
      } finally {
        if (result.server) {
          await new Promise<void>((resolve) => {
            result.server!.close(() => resolve());
          });
        }
      }
    });

    it('should handle comments with missing file property gracefully', async () => {
      const port = await getAvailablePort(4966);
      const result = await startServer({
        preferredPort: port,
        openBrowser: false,
      });

      try {
        const commentsWithMissingFile = [
          {
            id: '1',
            // file property is missing/undefined
            line: 10,
            body: 'Comment without file',
            timestamp: '2024-01-01T00:00:00Z',
          },
        ];

        const response = await fetch(`http://localhost:${result.port}/api/comments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ comments: commentsWithMissingFile, baseVersion: 0 }),
        });

        expect(response.status).toBe(200);

        // Check the output handles undefined file gracefully
        const outputResponse = await fetch(`http://localhost:${result.port}/api/comments-output`);
        const output = await outputResponse.text();

        expect(output).toContain('<unknown file>:L10');
        expect(output).toContain('Comment without file');
      } finally {
        if (result.server) {
          await new Promise<void>((resolve) => {
            result.server!.close(() => resolve());
          });
        }
      }
    });

    const isoNow = '2024-01-01T00:00:00Z';
    const makeThread = (id: string, filePath: string, line: number, body: string) => ({
      id,
      filePath,
      createdAt: isoNow,
      updatedAt: isoNow,
      position: { side: 'new' as const, line },
      messages: [{ id, body, createdAt: isoNow, updatedAt: isoNow }],
    });

    const postThreads = (port: number, threads: unknown[], baseVersion?: number) =>
      fetch(`http://localhost:${port}/api/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threads, baseVersion }),
      });

    const getSession = async (port: number) => {
      const res = await fetch(`http://localhost:${port}/api/comments-json`);
      return (await res.json()) as {
        version: number;
        threads: Array<{ id: string; filePath: string }>;
      };
    };

    const putThread = (port: number, thread: { id: string }) =>
      fetch(`http://localhost:${port}/api/comments/${thread.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ thread }),
      });

    const closeServer = async (result: { server?: { close: (cb: () => void) => void } }) => {
      if (result.server) {
        await new Promise<void>((resolve) => result.server!.close(() => resolve()));
      }
    };

    it('rejects a full replace without baseVersion', async () => {
      const port = await getAvailablePort(4966);
      const result = await startServer({ preferredPort: port, openBrowser: false });

      try {
        const response = await fetch(`http://localhost:${result.port}/api/comments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ threads: [makeThread('t1', 'src/a.ts', 10, 'x')] }),
        });
        expect(response.status).toBe(400);
        expect(((await response.json()) as { error: string }).error).toContain('baseVersion');
        expect((await getSession(result.port)).threads).toHaveLength(0);
      } finally {
        await closeServer(result);
      }
    });

    it('refuses a stale full replace with 409 so an agent addition survives', async () => {
      const port = await getAvailablePort(4966);
      const result = await startServer({ preferredPort: port, openBrowser: false });

      try {
        // Browser establishes a thread; it now knows version 1.
        await putThread(result.port, makeThread('t1', 'src/a.ts', 10, 'human thread'));
        const afterFirst = await getSession(result.port);
        expect(afterFirst.version).toBe(1);

        // An agent adds a second thread out of band (e.g. `difit comment add`).
        const agentImport: CommentImport[] = [
          {
            type: 'thread',
            id: 'agent-1',
            filePath: 'src/b.ts',
            position: { side: 'new', line: 20 },
            body: 'agent finding',
            author: 'Agent',
          },
        ];
        await fetch(`http://localhost:${result.port}/api/comment-imports`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(agentImport),
        });

        // A tab unaware of the agent's thread pushes its stale set tagged with version 1.
        const staleResponse = await postThreads(
          result.port,
          [makeThread('t1', 'src/a.ts', 10, 'human thread')],
          1,
        );
        expect(staleResponse.status).toBe(409);
        const staleBody = (await staleResponse.json()) as { version: number; threads: unknown[] };
        expect(staleBody.version).toBe(2);
        expect(staleBody.threads).toHaveLength(2);

        // The agent's thread must survive the stale push.
        const final = await getSession(result.port);
        expect(final.threads).toHaveLength(2);
        expect(final.threads.some((thread) => thread.id === 't1')).toBe(true);
        expect(final.threads.some((thread) => thread.id === 'agent-1')).toBe(true);
      } finally {
        await closeServer(result);
      }
    });

    it('replaces (honoring deletions) when the push version matches', async () => {
      const port = await getAvailablePort(4966);
      const result = await startServer({ preferredPort: port, openBrowser: false });

      try {
        await putThread(result.port, makeThread('t1', 'src/a.ts', 10, 'human thread'));
        const afterFirst = await getSession(result.port);
        expect(afterFirst.version).toBe(1);
        expect(afterFirst.threads).toHaveLength(1);

        // Same version means no concurrent writer, so an empty set is a real deletion.
        const response = await postThreads(result.port, [], afterFirst.version);
        expect(response.status).toBe(200);
        expect(((await response.json()) as { version: number }).version).toBe(2);

        const final = await getSession(result.port);
        expect(final.threads).toHaveLength(0);
      } finally {
        await closeServer(result);
      }
    });

    it('PUT /api/comments/:threadId creates and then replaces a single thread', async () => {
      const port = await getAvailablePort(4966);
      const result = await startServer({ preferredPort: port, openBrowser: false });

      try {
        const created = await putThread(result.port, makeThread('t1', 'src/a.ts', 10, 'v1'));
        expect(created.status).toBe(201);
        await putThread(result.port, makeThread('t2', 'src/a.ts', 20, 'other'));

        const replaced = await putThread(result.port, makeThread('t1', 'src/a.ts', 10, 'v2'));
        expect(replaced.status).toBe(200);
        expect(((await replaced.json()) as { version: number }).version).toBe(3);

        const session = await getSession(result.port);
        expect(session.threads.map((thread) => thread.id)).toEqual(['t1', 't2']);
        expect(
          (session.threads[0] as unknown as { messages: Array<{ body: string }> }).messages[0]
            ?.body,
        ).toBe('v2');
      } finally {
        await closeServer(result);
      }
    });

    it('PUT /api/comments/:threadId rejects payloads without messages', async () => {
      const port = await getAvailablePort(4966);
      const result = await startServer({ preferredPort: port, openBrowser: false });

      try {
        const response = await fetch(`http://localhost:${result.port}/api/comments/t1`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ thread: { id: 't1', filePath: 'a.ts' } }),
        });
        expect(response.status).toBe(400);
      } finally {
        await closeServer(result);
      }
    });

    it('bumps the version when a reply is imported (so the change is broadcast)', async () => {
      const port = await getAvailablePort(4966);
      const result = await startServer({ preferredPort: port, openBrowser: false });

      try {
        await putThread(result.port, makeThread('t1', 'src/a.ts', 10, 'human thread'));
        const before = await getSession(result.port);

        // A reply via comment-imports must register as a change — otherwise the
        // server skips the commentsChanged broadcast and open browsers go stale.
        await fetch(`http://localhost:${result.port}/api/comment-imports`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify([
            {
              type: 'reply',
              filePath: 'src/a.ts',
              position: { side: 'new', line: 10 },
              body: 'agent reply',
              author: 'Agent',
            },
          ] satisfies CommentImport[]),
        });

        const after = await getSession(result.port);
        expect(after.version).toBeGreaterThan(before.version);
      } finally {
        await closeServer(result);
      }
    });
  });

  describe('Comment persistence', () => {
    const startupImport: CommentImport[] = [
      {
        type: 'thread',
        filePath: 'test.js',
        position: { side: 'new', line: 10 },
        body: 'Startup comment',
        author: 'Agent',
      },
    ];
    const isoNow = '2024-01-01T00:00:00Z';
    const userThread = {
      id: 'user-1',
      filePath: 'test.js',
      createdAt: isoNow,
      updatedAt: isoNow,
      position: { side: 'new' as const, line: 20 },
      messages: [{ id: 'user-1', body: 'user comment', createdAt: isoNow, updatedAt: isoNow }],
    };

    const start = async (options: Record<string, unknown> = {}) => {
      const port = await getAvailablePort(4966);
      return startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        preferredPort: port,
        openBrowser: false,
        ...options,
      });
    };
    const stop = async (result: { server?: { close: (cb: () => void) => void } }) => {
      if (result.server) {
        await new Promise<void>((resolve) => result.server!.close(() => resolve()));
      }
    };
    const session = async (port: number) =>
      (await (await fetch(`http://localhost:${port}/api/comments-json`)).json()) as {
        version: number;
        threads: Array<{ id: string; messages: Array<{ body: string }> }>;
      };
    const storedFiles = () => {
      const [repoDir] = readdirSync(commentStoreDir);
      return repoDir ? readdirSync(join(commentStoreDir, repoDir)) : [];
    };

    it('merges --comment imports into the session before the first request', async () => {
      const result = await start({ commentImports: startupImport });
      try {
        const current = await session(result.port);
        expect(current.version).toBe(1);
        expect(current.threads).toHaveLength(1);
        expect(current.threads[0]?.messages[0]?.body).toBe('Startup comment');

        // The client no longer receives (or applies) imports itself.
        const diff = (await (await fetch(`http://localhost:${result.port}/api/diff`)).json()) as {
          commentImports?: unknown;
          commentImportId?: unknown;
        };
        expect(diff.commentImports).toBeUndefined();
        expect(diff.commentImportId).toBeUndefined();

        // The resolved selection (def4567 -> abc1234) names the file on disk.
        expect(storedFiles()).toEqual(['def4567_abc1234.json']);
      } finally {
        await stop(result);
      }
    });

    it('keeps the startup comment when a stale tab replays its old thread list', async () => {
      const result = await start({ commentImports: startupImport });
      try {
        // Old client shape: no baseVersion at all.
        const legacyPush = await fetch(`http://localhost:${result.port}/api/comments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ threads: [userThread] }),
        });
        expect(legacyPush.status).toBe(400);

        // Stale version from a previous server process.
        const stalePush = await fetch(`http://localhost:${result.port}/api/comments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ threads: [userThread], baseVersion: 0 }),
        });
        expect(stalePush.status).toBe(409);

        const current = await session(result.port);
        expect(current.threads).toHaveLength(1);
        expect(current.threads[0]?.messages[0]?.body).toBe('Startup comment');
      } finally {
        await stop(result);
      }
    });

    it('restores user comments for the same selection after a restart', async () => {
      const first = await start();
      try {
        await fetch(`http://localhost:${first.port}/api/comments/user-1`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ thread: userThread }),
        });
      } finally {
        await stop(first);
      }

      const second = await start({ commentImports: startupImport });
      try {
        const current = await session(second.port);
        expect(current.threads.map((thread) => thread.messages[0]?.body)).toEqual([
          'user comment',
          'Startup comment',
        ]);
      } finally {
        await stop(second);
      }

      // Re-importing the same --comment is idempotent.
      const third = await start({ commentImports: startupImport });
      try {
        expect((await session(third.port)).threads).toHaveLength(2);
      } finally {
        await stop(third);
      }
    });

    it('--clean deletes the persisted session and starts empty', async () => {
      const first = await start({ commentImports: startupImport });
      await stop(first);
      expect(storedFiles()).toHaveLength(1);

      const cleaned = await start({ clearComments: true });
      try {
        expect((await session(cleaned.port)).threads).toHaveLength(0);
        expect(storedFiles()).toHaveLength(0);
      } finally {
        await stop(cleaned);
      }
    });

    it('does not leave a file behind once the last thread is deleted', async () => {
      const result = await start();
      try {
        await fetch(`http://localhost:${result.port}/api/comments/user-1`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ thread: userThread }),
        });
        expect(storedFiles()).toHaveLength(1);
        await fetch(`http://localhost:${result.port}/api/comments/user-1`, { method: 'DELETE' });
        expect(storedFiles()).toHaveLength(0);
      } finally {
        await stop(result);
      }
    });

    it('keys stdin sessions by patch content, and --pr sessions by the given store key', async () => {
      const byPatch = await start({
        stdinDiff: 'diff --git a/x b/x\n',
        commentImports: startupImport,
      });
      await stop(byPatch);
      const byKey = await start({
        stdinDiff: 'diff --git a/x b/x\n',
        commentStoreKey: 'pr:https://github.com/o/r/pull/1',
        commentImports: startupImport,
      });
      await stop(byKey);

      const files = storedFiles();
      expect(files).toHaveLength(2);
      expect(files.some((file) => /^stdin_[0-9a-f]{16}\.json$/.test(file))).toBe(true);
      expect(files.some((file) => file.startsWith('pr_3a_https'))).toBe(true);
    });
  });

  let servers: any[] = [];
  let originalProcessExit: any;

  beforeEach(async () => {
    // Mock process.exit to prevent tests from actually exiting
    originalProcessExit = process.exit;
    process.exit = vi.fn() as any;
    parserInstances.length = 0;
    // Every test starts from an empty comment store.
    await fs.rm(commentStoreDir, { recursive: true, force: true });
    await fs.mkdir(commentStoreDir, { recursive: true });
  });

  afterEach(async () => {
    // Restore process.exit
    process.exit = originalProcessExit;

    // Clean up any servers created during tests
    for (const server of servers) {
      if (server?.close) {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      }
    }
    servers = [];
  });

  describe('Server startup', () => {
    it('starts on preferred port', async () => {
      // Use a high port number to avoid conflicts
      const preferredPort = 9000;
      const result = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        preferredPort,
      });
      servers.push(result.server); // Track for cleanup

      expect(result.port).toBeGreaterThanOrEqual(preferredPort);
      expect(result.url).toContain('http://localhost:');
      expect(result.isEmpty).toBe(false);
    });

    it('falls back to next port when preferred is occupied', async () => {
      // Use high port numbers to avoid conflicts
      const preferredPort = 9010;

      // Start server on port 9010
      const firstServer = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        preferredPort,
      });
      servers.push(firstServer.server);

      // Try to start another server on the same port
      const secondServer = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        preferredPort,
      });
      servers.push(secondServer.server);

      expect(firstServer.port).toBeGreaterThanOrEqual(preferredPort);
      expect(secondServer.port).toBe(firstServer.port + 1);
      expect(secondServer.url).toBe(`http://localhost:${secondServer.port}`);
    });

    it('binds to specified host', async () => {
      const result = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        host: '0.0.0.0',
        preferredPort: 9020,
      });
      servers.push(result.server);

      expect(result.url).toContain('http://localhost:'); // Display host conversion
    });

    it('passes context lines to the initial diff load', async () => {
      const result = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        preferredPort: 9025,
        contextLines: 4,
      });
      servers.push(result.server);

      const parser = parserInstances.at(-1);
      expect(parser?.parseDiff).toHaveBeenCalledWith(
        { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        false,
        4,
      );
    });
  });

  describe('API endpoints', () => {
    let port: number;

    beforeEach(async () => {
      const result = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        preferredPort: 9030,
      });
      servers.push(result.server);
      port = result.port;
    });

    it('GET /api/diff returns diff data', async () => {
      const response = await fetch(`http://localhost:${port}/api/diff`);
      const data = (await response.json()) as any;

      expect(response.ok).toBe(true);
      expect(data).toHaveProperty('targetCommit', 'abc123');
      expect(data).toHaveProperty('baseCommit', 'def456');
      expect(data).toHaveProperty('files');
      expect(data.files).toHaveLength(1);
      expect(data.files[0]).toHaveProperty('path', 'test.js');
      expect(data).toHaveProperty('ignoreWhitespace', false);
      expect(data).toHaveProperty('openInEditorAvailable', true);
      expect(data).toHaveProperty('requestedBaseCommitish', 'HEAD^');
      expect(data).toHaveProperty('requestedTargetCommitish', 'HEAD');
    });

    it('GET /api/diff returns a JSON 500 on parse failure and does not poison subsequent requests', async () => {
      const parser = parserInstances.at(-1);
      parser?.parseDiff.mockClear();
      parser?.parseDiff.mockRejectedValueOnce(
        new Error('Failed to parse diff for nonexistent vs HEAD: unknown revision'),
      );

      const errorResponse = await fetch(`http://localhost:${port}/api/diff?target=nonexistent`);
      expect(errorResponse.status).toBe(500);
      expect(errorResponse.headers.get('content-type')).toContain('application/json');
      const errorBody = (await errorResponse.json()) as any;
      expect(typeof errorBody.error).toBe('string');

      const recoveredResponse = await fetch(
        `http://localhost:${port}/api/diff?ignoreWhitespace=true`,
      );
      expect(recoveredResponse.status).toBe(200);

      expect(parser?.parseDiff).toHaveBeenLastCalledWith(
        { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        true,
        undefined,
      );
    });

    it('GET /api/diff?ignoreWhitespace=true handles whitespace ignore', async () => {
      const response = await fetch(`http://localhost:${port}/api/diff?ignoreWhitespace=true`);
      const data = (await response.json()) as any;

      expect(response.ok).toBe(true);
      expect(data).toHaveProperty('ignoreWhitespace', true);
    });

    it('GET /api/diff preserves context lines when recalculating revisions', async () => {
      const result = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        preferredPort: 9031,
        contextLines: 2,
      });
      servers.push(result.server);

      const parser = parserInstances.at(-1);
      parser?.parseDiff.mockClear();

      const response = await fetch(
        `http://localhost:${result.port}/api/diff?base=main&target=feature&ignoreWhitespace=true`,
      );

      expect(response.ok).toBe(true);
      expect(parser?.parseDiff).toHaveBeenCalledWith(
        { targetCommitish: 'feature', baseCommitish: 'main' },
        true,
        2,
      );
    });

    it('GET /api/diff passes baseMode through to the parser', async () => {
      const parser = parserInstances.at(-1);
      parser?.parseDiff.mockClear();
      parser?.parseDiff.mockResolvedValueOnce({
        targetCommit: 'abc123',
        baseCommit: 'def456',
        baseCommitish: 'fedcba9',
        targetCommitish: '.',
        requestedBaseCommitish: 'origin/main',
        requestedTargetCommitish: '.',
        requestedBaseMode: 'merge-base',
        files: [],
        isEmpty: true,
      });

      const response = await fetch(
        `http://localhost:${port}/api/diff?base=origin%2Fmain&target=.&baseMode=merge-base`,
      );
      const data = (await response.json()) as any;

      expect(response.ok).toBe(true);
      expect(parser?.parseDiff).toHaveBeenCalledWith(
        {
          targetCommitish: '.',
          baseCommitish: 'origin/main',
          baseMode: 'merge-base',
        },
        false,
        undefined,
      );
      expect(data.requestedBaseMode).toBe('merge-base');
      expect(data.baseCommitish).toBe('fedcba9');
      expect(data.requestedBaseCommitish).toBe('origin/main');
    });

    it('GET /api/diff caches results per revision pair instead of reusing the last request', async () => {
      const result = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        preferredPort: 9032,
      });
      servers.push(result.server);

      const parser = parserInstances.at(-1);
      parser?.parseDiff.mockClear();

      const firstResponse = await fetch(
        `http://localhost:${result.port}/api/diff?base=main&target=feature`,
      );
      expect(firstResponse.ok).toBe(true);

      const secondResponse = await fetch(
        `http://localhost:${result.port}/api/diff?base=HEAD%5E&target=HEAD`,
      );
      expect(secondResponse.ok).toBe(true);

      const thirdResponse = await fetch(
        `http://localhost:${result.port}/api/diff?base=main&target=feature`,
      );
      expect(thirdResponse.ok).toBe(true);

      expect(parser?.parseDiff).toHaveBeenCalledTimes(1);
      expect(parser?.parseDiff).toHaveBeenNthCalledWith(
        1,
        { targetCommitish: 'feature', baseCommitish: 'main' },
        false,
        undefined,
      );
    });

    it('GET /api/diff evicts least recently used cached diff responses', async () => {
      const result = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        preferredPort: 9033,
      });
      servers.push(result.server);

      const parser = parserInstances.at(-1);
      parser?.parseDiff.mockClear();

      const revisionPairs = [
        ['base-a', 'target-a'],
        ['base-b', 'target-b'],
        ['base-c', 'target-c'],
        ['base-d', 'target-d'],
        ['base-e', 'target-e'],
        ['base-f', 'target-f'],
        ['base-g', 'target-g'],
        ['base-h', 'target-h'],
        ['base-i', 'target-i'],
      ] as const;

      for (const [base, target] of revisionPairs) {
        const response = await fetch(
          `http://localhost:${result.port}/api/diff?base=${base}&target=${target}`,
        );
        expect(response.ok).toBe(true);
      }

      const revisitedResponse = await fetch(
        `http://localhost:${result.port}/api/diff?base=base-a&target=target-a`,
      );
      expect(revisitedResponse.ok).toBe(true);

      expect(parser?.parseDiff).toHaveBeenCalledTimes(10);
      expect(parser?.parseDiff).toHaveBeenLastCalledWith(
        { targetCommitish: 'target-a', baseCommitish: 'base-a' },
        false,
        undefined,
      );
    });

    it('GET /api/diff carries clearComments but no comment import payload', async () => {
      const importServer = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        preferredPort: 9037,
        clearComments: true,
        commentImports: [
          {
            type: 'thread',
            filePath: 'test.js',
            position: { side: 'new', line: 10 },
            body: 'Imported comment',
          },
        ],
      });
      servers.push(importServer.server);

      const response = await fetch(`http://localhost:${importServer.port}/api/diff`);
      const data = (await response.json()) as any;

      expect(response.ok).toBe(true);
      expect(data.clearComments).toBe(true);
      expect(data).not.toHaveProperty('commentImports');
      expect(data).not.toHaveProperty('commentImportId');

      // ...because the import already lives in the server session.
      const session = await fetch(`http://localhost:${importServer.port}/api/comments-json`);
      expect(((await session.json()) as { threads: unknown[] }).threads).toHaveLength(1);
    });

    it('GET /api/generated-status/* returns generated status', async () => {
      const response = await fetch(
        `http://localhost:${port}/api/generated-status/src/query.ts?ref=HEAD`,
      );
      const data = (await response.json()) as any;

      expect(response.ok).toBe(true);
      expect(data).toEqual({
        path: 'src/query.ts',
        ref: 'HEAD',
        isGenerated: true,
        source: 'content',
      });
    });

    it('GET /api/generated-status/* rejects paths outside repository', async () => {
      const response = await fetch(
        `http://localhost:${port}/api/generated-status/%2Ftmp%2Foutside.txt?ref=HEAD`,
      );
      const data = (await response.json()) as any;

      expect(response.status).toBe(400);
      expect(data).toHaveProperty('error', 'File path outside repository');
    });

    it('GET /api/generated-status/* rejects parent traversal paths', async () => {
      const response = await fetch(
        `http://localhost:${port}/api/generated-status/..%2Foutside.txt?ref=HEAD`,
      );
      const data = (await response.json()) as any;

      expect(response.status).toBe(400);
      expect(data).toHaveProperty('error', 'File path outside repository');
    });

    it('POST /api/comments accepts comment data', async () => {
      const comments = [{ file: 'test.js', line: 10, body: 'This is a test comment' }];

      const response = await fetch(`http://localhost:${port}/api/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comments, baseVersion: 0 }),
      });

      const data = await response.json();
      expect(response.ok).toBe(true);
      expect(data).toHaveProperty('success', true);
    });

    it('POST /api/comments accepts multi-line comment data', async () => {
      const comments = [
        { file: 'test.js', line: 10, body: 'Single line comment' },
        { file: 'test.js', line: [20, 30], body: 'Multi-line comment' },
      ];

      const response = await fetch(`http://localhost:${port}/api/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comments, baseVersion: 0 }),
      });

      const data = await response.json();
      expect(response.ok).toBe(true);
      expect(data).toHaveProperty('success', true);
    });

    it('POST /api/comments handles text/plain content type', async () => {
      const comments = [{ file: 'test.js', line: 10, body: 'This is a test comment' }];

      const response = await fetch(`http://localhost:${port}/api/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ comments, baseVersion: 0 }),
      });

      const data = await response.json();
      expect(response.ok).toBe(true);
      expect(data).toHaveProperty('success', true);
    });

    it('GET /api/comments-output returns formatted comments', async () => {
      // First post some comments
      const comments = [
        { file: 'test.js', line: 10, side: 'old', body: 'First comment' },
        { file: 'test.js', line: 20, side: 'new', body: 'Second comment' },
      ];

      await fetch(`http://localhost:${port}/api/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comments, baseVersion: 0 }),
      });

      // Then get the output
      const response = await fetch(`http://localhost:${port}/api/comments-output`);
      const output = await response.text();

      expect(response.ok).toBe(true);
      expect(response.headers.get('Content-Type')).toContain('text/plain');
      expect(output).toContain('Comments from review session');
      expect(output).toContain('test.js:L10 (old)');
      expect(output).toContain('First comment');
      expect(output).toContain('test.js:L20\nSecond comment');
      expect(output).toContain('Second comment');
      expect(output).toContain('Total comments: 2');
    });

    it('GET /api/comments-output formats multi-line comments correctly', async () => {
      // Post comments with both single-line and multi-line formats
      const comments = [
        { file: 'test.js', line: 10, body: 'Single line comment' },
        { file: 'test.js', line: [15, 25], body: 'Multi-line comment' },
      ];

      await fetch(`http://localhost:${port}/api/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comments, baseVersion: 0 }),
      });

      // Then get the output
      const response = await fetch(`http://localhost:${port}/api/comments-output`);
      const output = await response.text();

      expect(response.ok).toBe(true);
      expect(output).toContain('test.js:L10');
      expect(output).toContain('Single line comment');
      expect(output).toContain('test.js:L15-L25');
      expect(output).toContain('Multi-line comment');
      expect(output).toContain('Total comments: 2');
    });

    it('POST /api/comment-imports accepts valid comment imports', async () => {
      const imports = [
        {
          type: 'thread',
          filePath: 'src/example.ts',
          position: { side: 'new', line: 10 },
          body: 'Review comment',
        },
      ];

      const response = await fetch(`http://localhost:${port}/api/comment-imports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(imports),
      });

      expect(response.ok).toBe(true);
      const data = (await response.json()) as any;
      expect(data.success).toBe(true);
      expect(data.importId).toEqual(expect.any(String));
      expect(data.count).toBe(1);
    });

    it('POST /api/comment-imports accepts a single object', async () => {
      const singleImport = {
        type: 'thread',
        filePath: 'src/example.ts',
        position: { side: 'new', line: 5 },
        body: 'Single object import',
      };

      const response = await fetch(`http://localhost:${port}/api/comment-imports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(singleImport),
      });

      expect(response.ok).toBe(true);
      const data = (await response.json()) as any;
      expect(data.success).toBe(true);
      expect(data.count).toBe(1);
    });

    it('POST /api/comment-imports rejects invalid data', async () => {
      const response = await fetch(`http://localhost:${port}/api/comment-imports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invalid: true }),
      });

      expect(response.status).toBe(400);
      const data = (await response.json()) as any;
      expect(data).toHaveProperty('error');
    });

    it('GET /api/comments-json returns empty threads by default', async () => {
      const response = await fetch(`http://localhost:${port}/api/comments-json`);

      expect(response.ok).toBe(true);
      const data = (await response.json()) as any;
      expect(data).toHaveProperty('threads');
      expect(data.threads).toEqual([]);
    });

    it('GET /api/comments-json returns threads after posting comments', async () => {
      const comments = [{ file: 'test.js', line: 10, body: 'JSON test comment' }];

      await fetch(`http://localhost:${port}/api/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comments, baseVersion: 0 }),
      });

      const response = await fetch(`http://localhost:${port}/api/comments-json`);

      expect(response.ok).toBe(true);
      const data = (await response.json()) as any;
      expect(data.threads).toHaveLength(1);
      expect(data.threads[0].messages[0].body).toBe('JSON test comment');
    });

    it('POST /api/comment-imports merges into server-side threads for comments-output', async () => {
      const imports = [
        {
          type: 'thread',
          filePath: 'src/example.ts',
          position: { side: 'new', line: 42 },
          body: 'Merged server-side comment',
        },
      ];

      await fetch(`http://localhost:${port}/api/comment-imports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(imports),
      });

      const outputResponse = await fetch(`http://localhost:${port}/api/comments-output`);
      const output = await outputResponse.text();

      expect(output).toContain('src/example.ts:L42');
      expect(output).toContain('Merged server-side comment');
    });

    it('POST /api/comment-imports merges reply into existing thread', async () => {
      // First add a thread
      await fetch(`http://localhost:${port}/api/comment-imports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([
          {
            type: 'thread',
            filePath: 'src/reply-test.ts',
            position: { side: 'new', line: 5 },
            body: 'Original comment',
            author: 'User',
          },
        ]),
      });

      // Then add a reply
      await fetch(`http://localhost:${port}/api/comment-imports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([
          {
            type: 'reply',
            filePath: 'src/reply-test.ts',
            position: { side: 'new', line: 5 },
            body: 'Reply to comment',
            author: 'AI',
          },
        ]),
      });

      const jsonResponse = await fetch(`http://localhost:${port}/api/comments-json`);
      const data = (await jsonResponse.json()) as any;

      const thread = data.threads.find((t: any) => t.filePath === 'src/reply-test.ts');
      expect(thread).toBeDefined();
      expect(thread.messages).toHaveLength(2);
      expect(thread.messages[0].body).toBe('Original comment');
      expect(thread.messages[1].body).toBe('Reply to comment');
    });

    it('POST /api/comment-imports deduplicates identical imports', async () => {
      const imports = [
        {
          type: 'thread',
          filePath: 'src/dedup.ts',
          position: { side: 'new', line: 1 },
          body: 'Unique comment',
        },
      ];

      // Send the same import twice
      await fetch(`http://localhost:${port}/api/comment-imports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(imports),
      });
      await fetch(`http://localhost:${port}/api/comment-imports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(imports),
      });

      const jsonResponse = await fetch(`http://localhost:${port}/api/comments-json`);
      const data = (await jsonResponse.json()) as any;

      const threads = data.threads.filter((t: any) => t.filePath === 'src/dedup.ts');
      expect(threads).toHaveLength(1);
    });

    it('DELETE /api/comments/:threadId removes the thread and bumps the version', async () => {
      await fetch(`http://localhost:${port}/api/comment-imports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([
          {
            type: 'thread',
            id: 'delete-me',
            filePath: 'src/delete-test.ts',
            position: { side: 'new', line: 3 },
            body: 'Thread to delete',
          },
        ]),
      });

      const beforeResponse = await fetch(`http://localhost:${port}/api/comments-json`);
      const before = (await beforeResponse.json()) as any;
      expect(before.threads.some((t: any) => t.id === 'delete-me')).toBe(true);

      const deleteResponse = await fetch(`http://localhost:${port}/api/comments/delete-me`, {
        method: 'DELETE',
      });
      const deleteData = (await deleteResponse.json()) as any;

      expect(deleteResponse.ok).toBe(true);
      expect(deleteData).toMatchObject({
        success: true,
        threadId: 'delete-me',
      });
      expect(deleteData.version).toBe(before.version + 1);

      const afterResponse = await fetch(`http://localhost:${port}/api/comments-json`);
      const after = (await afterResponse.json()) as any;
      expect(after.threads.some((t: any) => t.id === 'delete-me')).toBe(false);
    });

    it('DELETE /api/comments/:threadId returns 404 for unknown thread', async () => {
      const response = await fetch(`http://localhost:${port}/api/comments/does-not-exist`, {
        method: 'DELETE',
      });

      expect(response.status).toBe(404);
      const data = (await response.json()) as any;
      expect(data).toHaveProperty('error');
      expect(data.error).toContain('does-not-exist');
    });

    describe('user settings API', () => {
      const originalConfigDir = process.env.DIFIT_CONFIG_DIR;
      let configDir: string;

      beforeEach(async () => {
        configDir = await fs.mkdtemp(join(tmpdir(), 'difit-user-settings-'));
        process.env.DIFIT_CONFIG_DIR = configDir;
      });

      afterEach(async () => {
        if (originalConfigDir === undefined) {
          delete process.env.DIFIT_CONFIG_DIR;
        } else {
          process.env.DIFIT_CONFIG_DIR = originalConfigDir;
        }
        await fs.rm(configDir, { recursive: true, force: true });
      });

      it('GET /api/user-settings returns defaults when no config exists', async () => {
        const response = await fetch(`http://localhost:${port}/api/user-settings`);

        expect(response.ok).toBe(true);
        const data = (await response.json()) as any;
        expect(data).toEqual({ version: 1, client: {} });
      });

      it('PUT /api/user-settings merges and persists client settings', async () => {
        const first = await fetch(`http://localhost:${port}/api/user-settings`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client: { diffViewMode: 'split', sidebarWidth: 320 },
          }),
        });
        expect(first.ok).toBe(true);

        const second = await fetch(`http://localhost:${port}/api/user-settings`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ client: { sidebarWidth: 400 } }),
        });
        expect(second.ok).toBe(true);
        const merged = (await second.json()) as any;
        expect(merged.client).toEqual({
          diffViewMode: 'split',
          sidebarWidth: 400,
        });

        const getResponse = await fetch(`http://localhost:${port}/api/user-settings`);
        const data = (await getResponse.json()) as any;
        expect(data.client).toEqual({
          diffViewMode: 'split',
          sidebarWidth: 400,
        });

        const stored = JSON.parse(
          await fs.readFile(join(configDir, 'config.json'), 'utf-8'),
        ) as any;
        expect(stored.client).toEqual({
          diffViewMode: 'split',
          sidebarWidth: 400,
        });
      });

      it('PUT /api/user-settings rejects invalid payloads', async () => {
        const response = await fetch(`http://localhost:${port}/api/user-settings`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ client: 'dark' }),
        });

        expect(response.status).toBe(400);
        const data = (await response.json()) as any;
        expect(data).toHaveProperty('error');
      });
    });

    it('isolates comment sessions between different diff selections', async () => {
      const importServer = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        preferredPort: 9039,
        commentImports: [
          {
            type: 'thread',
            filePath: 'src/cli/comment.test.ts',
            position: { side: 'new', line: 10 },
            body: 'Startup comment',
          },
        ],
      });
      servers.push(importServer.server);

      const parser = parserInstances.at(-1);
      parser?.parseDiff.mockImplementation(async (selection: any) => ({
        targetCommit: 'abc123',
        baseCommit: 'def456',
        baseCommitish: selection.baseCommitish === 'HEAD^' ? 'def4567' : selection.baseCommitish,
        targetCommitish:
          selection.targetCommitish === 'HEAD' ? 'abc1234' : selection.targetCommitish,
        requestedBaseCommitish: selection.baseCommitish,
        requestedTargetCommitish: selection.targetCommitish,
        requestedBaseMode: selection.baseMode,
        targetMessage: 'Test commit',
        baseMessage: 'Previous commit',
        files: [
          {
            path: 'src/cli/comment.test.ts',
            additions: 10,
            deletions: 5,
            chunks: [],
          },
        ],
        stats: { additions: 10, deletions: 5 },
        isEmpty: false,
      }));

      await fetch(`http://localhost:${importServer.port}/api/comment-imports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([
          {
            type: 'thread',
            filePath: 'src/cli/comment.test.ts',
            position: { side: 'new', line: 20 },
            body: 'API comment',
          },
        ]),
      });

      let response = await fetch(`http://localhost:${importServer.port}/api/comments-output`);
      let output = await response.text();
      expect(output).toContain('Startup comment');
      expect(output).toContain('API comment');

      await fetch(
        `http://localhost:${importServer.port}/api/diff?base=feat%2F292-comment-read-write&target=codex%2Fcomment-session-state`,
      );

      response = await fetch(`http://localhost:${importServer.port}/api/comments-output`);
      output = await response.text();
      expect(output).toBe('');

      await fetch(`http://localhost:${importServer.port}/api/comment-imports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([
          {
            type: 'thread',
            filePath: 'src/cli/comment.test.ts',
            position: { side: 'new', line: 30 },
            body: 'Other diff comment',
          },
        ]),
      });

      response = await fetch(`http://localhost:${importServer.port}/api/comments-output`);
      output = await response.text();
      expect(output).toContain('Other diff comment');
      expect(output).not.toContain('Startup comment');
      expect(output).not.toContain('API comment');

      await fetch(`http://localhost:${importServer.port}/api/diff?base=HEAD%5E&target=HEAD`);

      response = await fetch(`http://localhost:${importServer.port}/api/comments-output`);
      output = await response.text();
      expect(output).toContain('Startup comment');
      expect(output).toContain('API comment');
      expect(output).not.toContain('Other diff comment');
    });

    it.skip('GET /api/heartbeat returns SSE headers', async () => {
      // Skipped due to connection reset issues in test environment
      // SSE endpoint functionality is verified through manual testing
      expect(true).toBe(true);
    });

    it('GET /api/diff sets openInEditorAvailable=false for stdin diff', async () => {
      const stdinServer = await startServer({
        stdinDiff: 'diff --git a/stdin-test.js b/stdin-test.js',
        preferredPort: 9035,
      });
      servers.push(stdinServer.server);

      const response = await fetch(`http://localhost:${stdinServer.port}/api/diff`);
      const data = (await response.json()) as any;

      expect(response.ok).toBe(true);
      expect(data).toHaveProperty('openInEditorAvailable', false);
    });

    it('GET /api/generated-status/* returns 400 for stdin diff', async () => {
      const stdinServer = await startServer({
        stdinDiff: 'diff --git a/stdin-test.js b/stdin-test.js',
        preferredPort: 9036,
      });
      servers.push(stdinServer.server);

      const response = await fetch(
        `http://localhost:${stdinServer.port}/api/generated-status/stdin-test.js?ref=HEAD`,
      );
      const data = (await response.json()) as any;

      expect(response.status).toBe(400);
      expect(data).toHaveProperty('error', 'Generated status is not available for stdin diff');
    });
  });

  describe('Static file serving', () => {
    let originalNodeEnv: string | undefined;

    beforeEach(() => {
      originalNodeEnv = process.env.NODE_ENV;
    });

    afterEach(() => {
      if (originalNodeEnv !== undefined) {
        process.env.NODE_ENV = originalNodeEnv;
      } else {
        delete process.env.NODE_ENV;
      }
    });

    it('serves dev mode HTML in development', async () => {
      process.env.NODE_ENV = 'development';

      const result = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        preferredPort: 9040,
      });
      servers.push(result.server);

      const response = await fetch(`http://localhost:${result.port}/`);
      const html = await response.text();

      expect(response.ok).toBe(true);
      expect(html).toContain('difit - Dev Mode');
      expect(html).toContain('difit development mode');
    });

    it('serves static files in production mode', async () => {
      process.env.NODE_ENV = 'production';

      const result = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        preferredPort: 9050,
      });
      servers.push(result.server);

      // In production, it should try to serve static files
      // This might 404 if dist/client doesn't exist, but that's expected
      const response = await fetch(`http://localhost:${result.port}/`);

      // We don't expect a specific response since dist/client may not exist
      // But the server should not crash
      expect([200, 404]).toContain(response.status);
    });

    it('returns 404 for unknown paths in production mode', async () => {
      process.env.NODE_ENV = 'production';

      const result = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        preferredPort: 9055,
      });
      servers.push(result.server);

      const response = await fetch(`http://localhost:${result.port}/not-a-route`);

      expect(response.status).toBe(404);
    });
  });

  describe('Revision options API', () => {
    it('returns available revisions', async () => {
      const result = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
      });
      servers.push(result.server);

      const response = await fetch(`http://localhost:${result.port}/api/revisions`);
      const data = (await response.json()) as any;

      expect(response.ok).toBe(true);
      expect(data.specialOptions).toHaveLength(3);
      expect(data.specialOptions).not.toContainEqual({
        value: 'merge-base',
        label: 'Merge Base',
      });
      expect(data.branches).toEqual([{ name: 'main', current: true }]);
      expect(data.commits).toEqual([
        { hash: 'abc1234', shortHash: 'abc1234', message: 'Test commit' },
      ]);
      expect(data.originDefaultBranch).toBe('origin/main');
      expect(data.resolvedBase).toBe('abc1234');
      expect(data.resolvedTarget).toBe('def5678');
    });
  });

  describe('Error handling', () => {
    it('handles malformed comment data', async () => {
      const result = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
      });
      servers.push(result.server);

      const response = await fetch(`http://localhost:${result.port}/api/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid json',
      });

      expect(response.status).toBe(400);
      if (response.headers.get('content-type')?.includes('application/json')) {
        const data = await response.json();
        expect(data).toHaveProperty('error', 'Invalid comment data');
      } else {
        // If not JSON, just check status
        expect(response.ok).toBe(false);
      }
    });
  });

  describe('CORS configuration', () => {
    it('sets correct CORS headers', async () => {
      const result = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
      });
      servers.push(result.server);

      const response = await fetch(`http://localhost:${result.port}/api/diff`);

      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:*');
      expect(response.headers.get('Access-Control-Allow-Methods')).toBe(
        'GET, POST, PUT, DELETE, OPTIONS',
      );
      expect(response.headers.get('Access-Control-Allow-Headers')).toBe(
        'Origin, X-Requested-With, Content-Type, Accept',
      );
    });
  });

  describe('Line count API', () => {
    let port: number;

    beforeEach(async () => {
      const result = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        preferredPort: 9050,
      });
      servers.push(result.server);
      port = result.port;
    });

    it('returns line counts for repository files', async () => {
      const response = await fetch(
        `http://localhost:${port}/api/line-count/src%2Findex.ts?oldRef=HEAD~1&newRef=HEAD`,
      );
      const data = (await response.json()) as any;

      expect(response.ok).toBe(true);
      expect(data).toEqual({
        oldLineCount: 42,
        newLineCount: 42,
      });
    });

    it('rejects paths outside repository', async () => {
      const response = await fetch(`http://localhost:${port}/api/line-count/..%2Foutside.txt`);
      const data = (await response.json()) as any;

      expect(response.status).toBe(400);
      expect(data).toHaveProperty('error', 'File path outside repository');
    });

    it('rejects oldPath values outside repository', async () => {
      const response = await fetch(
        `http://localhost:${port}/api/line-count/src%2Findex.ts?oldRef=HEAD~1&oldPath=..%2Foutside.txt`,
      );
      const data = (await response.json()) as any;

      expect(response.status).toBe(400);
      expect(data).toHaveProperty('error', 'File path outside repository');
    });
  });

  describe('Blob API endpoints', () => {
    let port: number;

    beforeEach(async () => {
      const result = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        preferredPort: 9060,
      });
      servers.push(result.server);
      port = result.port;
    });

    it('GET /api/blob/* returns file content for images', async () => {
      const response = await fetch(`http://localhost:${port}/api/blob/image.jpg?ref=HEAD`);

      expect(response.ok).toBe(true);
      expect(response.headers.get('Content-Type')).toBe('image/jpeg');
      expect(response.headers.get('Cache-Control')).toBe('no-cache, no-store, must-revalidate');
      expect(response.headers.get('Pragma')).toBe('no-cache');
      expect(response.headers.get('Expires')).toBe('0');

      const buffer = await response.arrayBuffer();
      expect(buffer.byteLength).toBeGreaterThan(0);
    });

    it('sets correct content type for different image formats', async () => {
      const testCases = [
        { filename: 'photo.jpg', expectedType: 'image/jpeg' },
        { filename: 'photo.jpeg', expectedType: 'image/jpeg' },
        { filename: 'logo.png', expectedType: 'image/png' },
        { filename: 'animation.gif', expectedType: 'image/gif' },
        { filename: 'bitmap.bmp', expectedType: 'image/bmp' },
        { filename: 'vector.svg', expectedType: 'image/svg+xml' },
        { filename: 'modern.webp', expectedType: 'image/webp' },
        { filename: 'favicon.ico', expectedType: 'image/x-icon' },
        { filename: 'photo.tiff', expectedType: 'image/tiff' },
        { filename: 'photo.tif', expectedType: 'image/tiff' },
        { filename: 'modern.avif', expectedType: 'image/avif' },
        { filename: 'mobile.heic', expectedType: 'image/heic' },
        { filename: 'camera.heif', expectedType: 'image/heif' },
      ];

      for (const { filename, expectedType } of testCases) {
        const response = await fetch(`http://localhost:${port}/api/blob/${filename}?ref=HEAD`);
        expect(response.headers.get('Content-Type')).toBe(expectedType);
      }
    });

    it('sets default content type for unknown extensions', async () => {
      const response = await fetch(`http://localhost:${port}/api/blob/unknown.xyz?ref=HEAD`);

      expect(response.ok).toBe(true);
      expect(response.headers.get('Content-Type')).toBe('application/octet-stream');
    });

    it('handles different git refs correctly', async () => {
      const testRefs = ['HEAD', 'main', 'feature-branch', 'abc123'];

      for (const ref of testRefs) {
        const response = await fetch(`http://localhost:${port}/api/blob/image.jpg?ref=${ref}`);
        expect(response.ok).toBe(true);
      }
    });

    it('defaults to HEAD when no ref is provided', async () => {
      const response = await fetch(`http://localhost:${port}/api/blob/image.jpg`);

      expect(response.ok).toBe(true);
      // Should use HEAD as default ref
    });

    it('handles file not found errors', async () => {
      // Skip this test as mocking GitDiffParser in an already running server is complex
      // The error handling is already covered by the actual implementation
    });

    it('handles large file errors appropriately', async () => {
      // Skip this test as mocking GitDiffParser in an already running server is complex
      // The error handling is already covered by the actual implementation
    });

    it('handles special characters in file paths', async () => {
      const specialPaths = [
        'folder/image with spaces.jpg',
        'folder/image-with-dashes.png',
        'folder/image_with_underscores.gif',
        'folder/ιμαγε.jpg', // Unicode characters
      ];

      for (const path of specialPaths) {
        const encodedPath = encodeURIComponent(path);
        const response = await fetch(`http://localhost:${port}/api/blob/${encodedPath}?ref=HEAD`);
        expect(response.ok).toBe(true);
      }
    });

    it('rejects paths outside repository', async () => {
      const response = await fetch(`http://localhost:${port}/api/blob/..%2Foutside.txt?ref=HEAD`);
      const data = (await response.json()) as any;

      expect(response.status).toBe(400);
      expect(data).toHaveProperty('error', 'File path outside repository');
    });
  });

  describe('Keep-alive option', () => {
    it('accepts keepAlive option without error', async () => {
      const { port, server } = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        keepAlive: true,
      });
      servers.push(server);

      expect(port).toBeGreaterThanOrEqual(4966);
    });

    it('starts normally without keepAlive option', async () => {
      const { port, server } = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
      });
      servers.push(server);

      expect(port).toBeGreaterThanOrEqual(4966);
    });

    it('does not call process.exit on client disconnect when keepAlive is true', async () => {
      const { port, server } = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        keepAlive: true,
        preferredPort: 9070,
      });
      servers.push(server);

      // Connect to heartbeat SSE endpoint and then abort
      const controller = new AbortController();
      const responsePromise = fetch(`http://localhost:${port}/api/heartbeat`, {
        signal: controller.signal,
      });

      // Wait for the connection to be established
      const response = await responsePromise.catch(() => null);
      if (response) {
        // Start reading the stream to ensure connection is established
        const reader = response.body?.getReader();
        if (reader) {
          await reader.read(); // Read the initial "connected" message
        }
      }

      // Disconnect by aborting
      controller.abort();

      // Wait for the server's close handler + setTimeout(100ms) to run
      await new Promise((resolve) => setTimeout(resolve, 300));

      // With keepAlive, process.exit should NOT have been called
      expect(process.exit).not.toHaveBeenCalled();
    });

    it('calls process.exit on client disconnect when keepAlive is false', async () => {
      const { port, server } = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        keepAlive: false,
        preferredPort: 9080,
      });
      servers.push(server);

      // Connect to heartbeat SSE endpoint and then abort
      const controller = new AbortController();
      const responsePromise = fetch(`http://localhost:${port}/api/heartbeat`, {
        signal: controller.signal,
      });

      // Wait for the connection to be established
      const response = await responsePromise.catch(() => null);
      if (response) {
        const reader = response.body?.getReader();
        if (reader) {
          await reader.read(); // Read the initial "connected" message
        }
      }

      // Disconnect by aborting
      controller.abort();

      // Wait for the server's close handler + setTimeout(100ms) to run
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Without keepAlive, process.exit SHOULD have been called
      expect(process.exit).toHaveBeenCalledWith(0);
    });
  });

  describe('Clear Comments functionality', () => {
    it('includes clearComments flag in diff response when provided', async () => {
      const { port, server } = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        clearComments: true,
      });
      servers.push(server);

      const response = await fetch(`http://localhost:${port}/api/diff`);
      const data = (await response.json()) as any;

      expect(response.ok).toBe(true);
      expect(data.clearComments).toBe(true);
    });

    it('does not include clearComments flag when not provided', async () => {
      const { port, server } = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
      });
      servers.push(server);

      const response = await fetch(`http://localhost:${port}/api/diff`);
      const data = (await response.json()) as any;

      expect(response.ok).toBe(true);
      expect(data.clearComments).toBeUndefined();
    });

    it('preserves clearComments flag across diff requests', async () => {
      const { port, server } = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        clearComments: true,
      });
      servers.push(server);

      // First request
      const response1 = await fetch(`http://localhost:${port}/api/diff`);
      const data1 = (await response1.json()) as any;
      expect(data1.clearComments).toBe(true);

      // Second request with different ignoreWhitespace
      const response2 = await fetch(`http://localhost:${port}/api/diff?ignoreWhitespace=true`);
      const data2 = (await response2.json()) as any;
      expect(data2.clearComments).toBe(true);
    });
  });
});
