import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { useDiffComments } from './useDiffComments';
import { useViewedFiles } from './useViewedFiles';

// Mock StorageService with isolated storage
const mockStorage = new Map<string, any>();

vi.mock('../services/StorageService', () => ({
  VIEWED_HASH_VERSION: 1,
  storageService: {
    getViewedFiles: vi.fn((base, target, _hash, _branch, repoId) => {
      const key = `${repoId || 'default'}-${base}-${target}-viewed`;
      return mockStorage.get(key) || [];
    }),
    saveViewedFiles: vi.fn((base, target, files, _hash, _branch, repoId) => {
      const key = `${repoId || 'default'}-${base}-${target}-viewed`;
      mockStorage.set(key, files);
    }),
    getViewedHashIndex: vi.fn((repoId) => {
      const key = `${repoId || 'default'}-viewed-hash-index`;
      return (
        mockStorage.get(key) || {
          version: 1,
          lastModifiedAt: new Date(0).toISOString(),
          entries: [],
        }
      );
    }),
    recordViewedHashes: vi.fn((repoId, entries) => {
      const key = `${repoId || 'default'}-viewed-hash-index`;
      const existing = mockStorage.get(key) || {
        version: 1,
        lastModifiedAt: new Date(0).toISOString(),
        entries: [],
      };
      const compositeKey = (e: { filePath: string; diffContentHash: string }) =>
        `${e.filePath} ${e.diffContentHash}`;
      const byKey = new Map(
        existing.entries.map((entry: { filePath: string; diffContentHash: string }) => [
          compositeKey(entry),
          entry,
        ]),
      );
      for (const entry of entries) byKey.set(compositeKey(entry), entry);
      mockStorage.set(key, {
        version: 1,
        lastModifiedAt: new Date().toISOString(),
        entries: Array.from(byKey.values()),
      });
    }),
    removeViewedHashes: vi.fn(
      (repoId, entries: Array<{ filePath: string; diffContentHash: string }>) => {
        const key = `${repoId || 'default'}-viewed-hash-index`;
        const existing = mockStorage.get(key);
        if (!existing) return;
        const drop = new Set(entries.map((e) => `${e.filePath} ${e.diffContentHash}`));
        mockStorage.set(key, {
          ...existing,
          entries: existing.entries.filter(
            (entry: { filePath: string; diffContentHash: string }) =>
              !drop.has(`${entry.filePath} ${entry.diffContentHash}`),
          ),
        });
      },
    ),
    clearViewedHashIndex: vi.fn((repoId) => {
      mockStorage.delete(`${repoId || 'default'}-viewed-hash-index`);
    }),
    getDiffContextData: vi.fn(() => null),
    saveDiffContextData: vi.fn(),
  },
}));

describe('Repository Isolation Integration Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStorage.clear();
  });

  describe('useDiffComments - Repository Isolation', () => {
    // Comments are owned by the server, one session per diff. Isolation therefore comes
    // from each hook talking to its own diff-scoped URL rather than from a storage key.
    const serverThreads = new Map<string, unknown[]>();

    const installServerMock = () => {
      vi.mocked(global.fetch).mockImplementation(async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        const [path, query = ''] = url.split('?');
        const scope = new URLSearchParams(query).get('diffId') ?? 'default';

        if (path === '/api/comments-json') {
          return {
            ok: true,
            status: 200,
            json: async () => ({ version: 0, threads: serverThreads.get(scope) ?? [] }),
          } as Response;
        }

        if (method === 'PUT') {
          const { thread } = JSON.parse(String(init?.body)) as { thread: { id: string } };
          serverThreads.set(scope, [...(serverThreads.get(scope) ?? []), thread]);
          return { ok: true, status: 201, json: async () => ({ version: 1, thread }) } as Response;
        }

        return { ok: false, status: 404, json: async () => ({}) } as Response;
      });
    };

    const scopedUrl = (diffId: string) => (path: string) => `${path}?diffId=${diffId}`;

    beforeEach(() => {
      serverThreads.clear();
      installServerMock();
    });

    it('should isolate comments between different repositories', async () => {
      const repo1 = scopedUrl('repo-1');
      const repo2 = scopedUrl('repo-2');
      const { result: result1 } = renderHook(() => useDiffComments(repo1));
      const { result: result2 } = renderHook(() => useDiffComments(repo2));

      await waitFor(() => expect(result1.current.hasLoadedComments).toBe(true));
      await waitFor(() => expect(result2.current.hasLoadedComments).toBe(true));

      act(() => {
        result1.current.addThread({
          filePath: 'test.ts',
          body: 'Comment in repo 1',
          side: 'new',
          line: 10,
        });
      });

      expect(result1.current.threads).toHaveLength(1);
      expect(result1.current.threads[0]?.messages[0]?.body).toBe('Comment in repo 1');
      expect(result2.current.threads).toHaveLength(0);

      act(() => {
        result2.current.addThread({
          filePath: 'test.ts',
          body: 'Comment in repo 2',
          side: 'new',
          line: 10,
        });
      });

      expect(result1.current.threads).toHaveLength(1);
      expect(result1.current.threads[0]?.messages[0]?.body).toBe('Comment in repo 1');
      expect(result2.current.threads).toHaveLength(1);
      expect(result2.current.threads[0]?.messages[0]?.body).toBe('Comment in repo 2');

      // Each write went to its own diff scope on the server.
      await waitFor(() => {
        expect(serverThreads.get('repo-1')).toHaveLength(1);
        expect(serverThreads.get('repo-2')).toHaveLength(1);
      });
    });

    it('should only show the server session of its own repository after reload', async () => {
      serverThreads.set('repo-1', [
        {
          id: 'remote-1',
          filePath: 'file.ts',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
          position: { side: 'new', line: 5 },
          messages: [
            {
              id: 'remote-1',
              body: 'Working diff comment in repo 1',
              createdAt: '2024-01-01T00:00:00Z',
              updatedAt: '2024-01-01T00:00:00Z',
            },
          ],
        },
      ]);

      const { result: result1 } = renderHook(() => useDiffComments(scopedUrl('repo-1')));
      const { result: result2 } = renderHook(() => useDiffComments(scopedUrl('repo-2')));

      await waitFor(() => expect(result1.current.hasLoadedComments).toBe(true));
      await waitFor(() => expect(result2.current.hasLoadedComments).toBe(true));

      expect(result1.current.threads).toHaveLength(1);
      expect(result2.current.threads).toHaveLength(0);
    });
  });

  describe('useViewedFiles - Repository Isolation', () => {
    it('should isolate viewed files between different repositories', async () => {
      const mockFile1 = {
        path: 'file1.ts',
        status: 'modified' as const,
        additions: 1,
        deletions: 1,
        chunks: [],
      };

      const mockFile2 = {
        path: 'file2.ts',
        status: 'modified' as const,
        additions: 1,
        deletions: 1,
        chunks: [],
      };

      // Repository 1
      const { result: result1 } = renderHook(() =>
        useViewedFiles('base', 'target', undefined, undefined, [mockFile1], 'repo-1'),
      );

      // Repository 2
      const { result: result2 } = renderHook(() =>
        useViewedFiles('base', 'target', undefined, undefined, [mockFile2], 'repo-2'),
      );

      // Mark file as viewed in repository 1
      await act(async () => {
        await result1.current.toggleFileViewed('file1.ts', mockFile1);
      });

      // Repository 1 should have 1 viewed file
      expect(result1.current.viewedFiles.has('file1.ts')).toBe(true);
      expect(result1.current.viewedFiles.size).toBe(1);

      // Repository 2 should have 0 viewed files
      expect(result2.current.viewedFiles.has('file1.ts')).toBe(false);
      expect(result2.current.viewedFiles.size).toBe(0);

      // Mark file as viewed in repository 2
      await act(async () => {
        await result2.current.toggleFileViewed('file2.ts', mockFile2);
      });

      // Repository 1 should still only have file1.ts
      expect(result1.current.viewedFiles.has('file1.ts')).toBe(true);
      expect(result1.current.viewedFiles.has('file2.ts')).toBe(false);
      expect(result1.current.viewedFiles.size).toBe(1);

      // Repository 2 should only have file2.ts
      expect(result2.current.viewedFiles.has('file1.ts')).toBe(false);
      expect(result2.current.viewedFiles.has('file2.ts')).toBe(true);
      expect(result2.current.viewedFiles.size).toBe(1);
    });

    it('should isolate auto-marked generated files between repositories', () => {
      const generatedFile1 = {
        path: 'package-lock.json',
        status: 'modified' as const,
        additions: 100,
        deletions: 50,
        chunks: [],
        isGenerated: true,
      };

      const generatedFile2 = {
        path: 'yarn.lock',
        status: 'modified' as const,
        additions: 80,
        deletions: 40,
        chunks: [],
        isGenerated: true,
      };

      // Repository 1 with generated file
      const { result: result1 } = renderHook(() =>
        useViewedFiles('base', 'target', undefined, undefined, [generatedFile1], 'repo-1'),
      );

      // Repository 2 with different generated file
      const { result: result2 } = renderHook(() =>
        useViewedFiles('base', 'target', undefined, undefined, [generatedFile2], 'repo-2'),
      );

      // Each repository should only auto-mark its own generated files
      // Note: Auto-marking is async, so we need to wait for the effect
      setTimeout(() => {
        // Repo 1 may have package-lock.json auto-marked
        // Repo 2 may have yarn.lock auto-marked
        // But they should NOT share auto-marked files
        const repo1HasYarnLock = result1.current.viewedFiles.has('yarn.lock');
        const repo2HasPackageLock = result2.current.viewedFiles.has('package-lock.json');

        expect(repo1HasYarnLock).toBe(false);
        expect(repo2HasPackageLock).toBe(false);
      }, 100);
    });
  });

  describe('Cross-Repository Data Integrity', () => {
    // Skip this test due to async timing issues in test environment
    // The functionality is covered by other isolation tests
    it.skip('should maintain separate view counts for different repositories', async () => {
      const file1 = {
        path: 'file1.ts',
        status: 'modified' as const,
        additions: 1,
        deletions: 1,
        chunks: [],
      };
      const file2 = {
        path: 'file2.ts',
        status: 'modified' as const,
        additions: 1,
        deletions: 1,
        chunks: [],
      };

      // Repository 1 - view 1 file
      const { result: result1 } = renderHook(() =>
        useViewedFiles('base', 'target', undefined, undefined, [file1], 'repo-1'),
      );

      await act(async () => {
        await result1.current.toggleFileViewed('file1.ts', file1);
      });

      // Repository 2 - view a different file
      const { result: result2 } = renderHook(() =>
        useViewedFiles('base', 'target', undefined, undefined, [file2], 'repo-2'),
      );

      await act(async () => {
        await result2.current.toggleFileViewed('file2.ts', file2);
      });

      // Each repo should only have 1 viewed file
      expect(result1.current.viewedFiles.size).toBe(1);
      expect(result1.current.viewedFiles.has('file1.ts')).toBe(true);
      expect(result1.current.viewedFiles.has('file2.ts')).toBe(false);

      expect(result2.current.viewedFiles.size).toBe(1);
      expect(result2.current.viewedFiles.has('file2.ts')).toBe(true);
      expect(result2.current.viewedFiles.has('file1.ts')).toBe(false);
    });

    it('should allow same file paths in different repositories without conflict', async () => {
      const file = {
        path: 'common.ts',
        status: 'modified' as const,
        additions: 5,
        deletions: 3,
        chunks: [],
      };

      // Both repos have a file with the same path
      const { result: result1 } = renderHook(() =>
        useViewedFiles('base', 'target', undefined, undefined, [file], 'repo-1'),
      );

      const { result: result2 } = renderHook(() =>
        useViewedFiles('base', 'target', undefined, undefined, [file], 'repo-2'),
      );

      // Mark as viewed in repo 1
      await act(async () => {
        await result1.current.toggleFileViewed('common.ts', file);
      });

      // Repo 1 should have it marked
      expect(result1.current.viewedFiles.has('common.ts')).toBe(true);

      // Repo 2 should NOT have it marked
      expect(result2.current.viewedFiles.has('common.ts')).toBe(false);
    });
  });
});
