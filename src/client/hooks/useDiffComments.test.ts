import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { DiffCommentThread } from '../../types/diff';
import { useDiffComments } from './useDiffComments';

// Mock diffUtils
vi.mock('../utils/diffUtils', () => ({
  getLanguageFromPath: vi.fn((path: string) => {
    if (path.endsWith('.ts') || path.endsWith('.tsx')) return 'typescript';
    if (path.endsWith('.js') || path.endsWith('.jsx')) return 'javascript';
    return 'plaintext';
  }),
}));

interface RecordedRequest {
  url: string;
  method: string;
  body: unknown;
}

/** Minimal in-memory stand-in for the server's comment session endpoints. */
class FakeCommentServer {
  threads: DiffCommentThread[] = [];
  version = 0;
  requests: RecordedRequest[] = [];
  failNextWrite = false;

  install() {
    vi.mocked(global.fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
      this.requests.push({ url, method, body });
      const [path] = url.split('?');

      if (path === '/api/comments-json' && method === 'GET') {
        return this.respond(200, { version: this.version, threads: this.threads });
      }

      if (this.failNextWrite) {
        this.failNextWrite = false;
        return this.respond(500, { error: 'boom' });
      }

      if (path?.startsWith('/api/comments/') && method === 'PUT') {
        const { thread } = body as { thread: DiffCommentThread };
        const index = this.threads.findIndex((item) => item.id === thread.id);
        this.threads =
          index < 0
            ? [...this.threads, thread]
            : this.threads.map((item, itemIndex) => (itemIndex === index ? thread : item));
        this.version += 1;
        return this.respond(index < 0 ? 201 : 200, { version: this.version, thread });
      }

      if (path?.startsWith('/api/comments/') && method === 'DELETE') {
        const id = decodeURIComponent(path.slice('/api/comments/'.length));
        const next = this.threads.filter((thread) => thread.id !== id);
        if (next.length === this.threads.length) {
          return this.respond(404, { error: 'not found' });
        }
        this.threads = next;
        this.version += 1;
        return this.respond(200, { version: this.version });
      }

      if (path === '/api/comments' && method === 'POST') {
        const payload = body as { threads: DiffCommentThread[]; baseVersion?: number };
        if (payload.baseVersion === undefined) {
          return this.respond(400, { error: 'baseVersion is required' });
        }
        if (payload.baseVersion !== this.version) {
          return this.respond(409, { version: this.version, threads: this.threads });
        }
        this.threads = payload.threads;
        this.version += 1;
        return this.respond(200, { version: this.version, threads: this.threads });
      }

      return this.respond(404, { error: 'unknown route' });
    });
  }

  writes() {
    return this.requests.filter((request) => request.method !== 'GET');
  }

  private respond(status: number, data: unknown): Response {
    return {
      ok: status < 300,
      status,
      statusText: String(status),
      json: async () => data,
    } as Response;
  }
}

const isoNow = '2024-01-01T00:00:00.000Z';
const makeThread = (
  id: string,
  filePath: string,
  line: number | { start: number; end: number },
  body: string,
  extra: Partial<DiffCommentThread> = {},
): DiffCommentThread => ({
  id,
  filePath,
  createdAt: isoNow,
  updatedAt: isoNow,
  position: { side: 'new', line },
  messages: [{ id, body, author: 'User', createdAt: isoNow, updatedAt: isoNow }],
  ...extra,
});

const apiUrl = (path: string) => `${path}?base=abc1234&target=def5678`;

describe('useDiffComments', () => {
  let server: FakeCommentServer;

  const renderLoaded = async (builder: ((path: string) => string) | null = apiUrl) => {
    const rendered = renderHook(({ getUrl }) => useDiffComments(getUrl), {
      initialProps: { getUrl: builder },
    });
    if (builder) {
      await waitFor(() => expect(server.requests.length).toBeGreaterThan(0));
      // Let the resolved response land in state before callers assert on it.
      await act(async () => {});
    }
    return rendered;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    server = new FakeCommentServer();
    server.install();
  });

  describe('loading from the server', () => {
    it('reads the session with GET /api/comments-json for the given selection', async () => {
      server.threads = [makeThread('t1', 'src/a.ts', 10, 'from server')];
      server.version = 3;

      const { result } = await renderLoaded();

      expect(result.current.threads).toEqual(server.threads);
      expect(server.requests).toEqual([
        { url: '/api/comments-json?base=abc1234&target=def5678', method: 'GET', body: undefined },
      ]);
    });

    it('does nothing until the selection is known', () => {
      const { result } = renderHook(() => useDiffComments(null));

      expect(result.current.threads).toEqual([]);
      expect(server.requests).toHaveLength(0);
    });

    it('reloads when the selection (url builder) changes', async () => {
      server.threads = [makeThread('t1', 'src/a.ts', 10, 'first selection')];
      const { result, rerender } = await renderLoaded();
      expect(result.current.threads).toHaveLength(1);

      server.threads = [];
      const otherUrl = (path: string) => `${path}?base=111&target=222`;
      rerender({ getUrl: otherUrl });

      await waitFor(() => expect(server.requests).toHaveLength(2));
      await act(async () => {});
      expect(result.current.threads).toEqual([]);
      expect(server.requests.map((request) => request.url)).toEqual([
        '/api/comments-json?base=abc1234&target=def5678',
        '/api/comments-json?base=111&target=222',
      ]);
    });

    it('does not reload when the builder identity changes but the URL does not', async () => {
      const { rerender } = renderHook(({ getUrl }) => useDiffComments(getUrl), {
        initialProps: { getUrl: (path: string) => apiUrl(path) },
      });
      await waitFor(() => expect(server.requests).toHaveLength(1));

      // A new function each render (as an un-memoized caller would pass).
      rerender({ getUrl: (path: string) => apiUrl(path) });
      rerender({ getUrl: (path: string) => apiUrl(path) });
      await act(async () => {});

      expect(server.requests).toHaveLength(1);
    });

    it('refreshThreads picks up threads written by other clients', async () => {
      const { result } = await renderLoaded();

      server.threads = [makeThread('agent-1', 'src/b.ts', 20, 'agent finding')];
      server.version = 7;
      await act(async () => {
        await result.current.refreshThreads();
      });

      expect(result.current.threads).toEqual(server.threads);
    });
  });

  describe('writes go to the server per thread', () => {
    it('addThread PUTs the new thread and shows it immediately', async () => {
      const { result } = await renderLoaded();

      let created: DiffCommentThread | undefined;
      act(() => {
        created = result.current.addThread({
          filePath: 'src/a.ts',
          body: 'new comment',
          side: 'new',
          line: 42,
          codeSnapshot: { content: 'const a = 1;', language: 'typescript' },
        });
      });

      expect(result.current.threads).toHaveLength(1);
      expect(result.current.threads[0]?.messages[0]?.body).toBe('new comment');
      expect(result.current.threads[0]?.codeSnapshot).toEqual({
        content: 'const a = 1;',
        language: 'typescript',
      });

      await waitFor(() => expect(server.threads).toHaveLength(1));
      const [write] = server.writes();
      expect(write).toEqual({
        url: `/api/comments/${created!.id}?base=abc1234&target=def5678`,
        method: 'PUT',
        body: { thread: created },
      });
    });

    it('addThread infers the code snapshot language when none is provided', async () => {
      const { result } = await renderLoaded();

      act(() => {
        result.current.addThread({ filePath: 'src/a.ts', body: 'x', side: 'new', line: 1 });
      });

      expect(result.current.threads[0]?.codeSnapshot).toEqual({
        content: '',
        language: 'typescript',
      });
    });

    it('replyToThread PUTs the thread with the appended message', async () => {
      server.threads = [makeThread('t1', 'src/a.ts', 10, 'root')];
      const { result } = await renderLoaded();

      act(() => {
        result.current.replyToThread({ threadId: 't1', body: 'a reply' });
      });

      expect(result.current.threads[0]?.messages).toHaveLength(2);
      expect(result.current.threads[0]?.messages[1]?.body).toBe('a reply');

      await waitFor(() => expect(server.threads[0]?.messages).toHaveLength(2));
      expect(server.writes()[0]?.method).toBe('PUT');
      expect(server.writes()[0]?.url).toBe('/api/comments/t1?base=abc1234&target=def5678');
    });

    it('updateMessage PUTs the edited body', async () => {
      server.threads = [makeThread('t1', 'src/a.ts', 10, 'before')];
      const { result } = await renderLoaded();

      act(() => {
        result.current.updateMessage('t1', 't1', 'after');
      });

      expect(result.current.threads[0]?.messages[0]?.body).toBe('after');
      await waitFor(() => expect(server.threads[0]?.messages[0]?.body).toBe('after'));
    });

    it('removeThread DELETEs the thread', async () => {
      server.threads = [
        makeThread('t1', 'src/a.ts', 10, 'one'),
        makeThread('t2', 'src/a.ts', 20, 'two'),
      ];
      const { result } = await renderLoaded();

      act(() => {
        result.current.removeThread('t1');
      });

      expect(result.current.threads.map((thread) => thread.id)).toEqual(['t2']);
      await waitFor(() => expect(server.threads.map((thread) => thread.id)).toEqual(['t2']));
      expect(server.writes()).toEqual([
        { url: '/api/comments/t1?base=abc1234&target=def5678', method: 'DELETE', body: undefined },
      ]);
    });

    it('removeMessage on the root message deletes the whole thread', async () => {
      server.threads = [makeThread('t1', 'src/a.ts', 10, 'root')];
      const { result } = await renderLoaded();

      act(() => {
        result.current.removeMessage('t1', 't1');
      });

      expect(result.current.threads).toHaveLength(0);
      await waitFor(() => expect(server.writes()[0]?.method).toBe('DELETE'));
    });

    it('removeMessage on a reply PUTs the thread without it', async () => {
      server.threads = [
        makeThread('t1', 'src/a.ts', 10, 'root', {
          messages: [
            { id: 't1', body: 'root', author: 'User', createdAt: isoNow, updatedAt: isoNow },
            { id: 'r1', body: 'reply', author: 'User', createdAt: isoNow, updatedAt: isoNow },
          ],
        }),
      ];
      const { result } = await renderLoaded();

      act(() => {
        result.current.removeMessage('t1', 'r1');
      });

      expect(result.current.threads[0]?.messages.map((message) => message.id)).toEqual(['t1']);
      await waitFor(() => expect(server.threads[0]?.messages).toHaveLength(1));
      expect(server.writes()[0]?.method).toBe('PUT');
    });

    it('should not remove a thread when reply deletion targets a missing message id', async () => {
      server.threads = [makeThread('t1', 'src/a.ts', 10, 'root')];
      const { result } = await renderLoaded();

      act(() => {
        result.current.removeMessage('t1', 'missing');
      });

      expect(result.current.threads).toHaveLength(1);
      expect(server.writes()).toHaveLength(0);
    });

    it('treats a 404 on delete as already gone', async () => {
      server.threads = [makeThread('t1', 'src/a.ts', 10, 'root')];
      const { result } = await renderLoaded();
      server.threads = []; // an agent removed it first

      act(() => {
        result.current.removeThread('t1');
      });

      await waitFor(() => expect(server.writes()).toHaveLength(1));
      // No corrective reload was needed.
      expect(server.requests.filter((request) => request.method === 'GET')).toHaveLength(1);
      expect(result.current.threads).toEqual([]);
    });

    it('reloads the server state when a write fails', async () => {
      server.threads = [makeThread('t1', 'src/a.ts', 10, 'server truth')];
      const { result } = await renderLoaded();
      server.failNextWrite = true;

      act(() => {
        result.current.updateMessage('t1', 't1', 'optimistic');
      });
      expect(result.current.threads[0]?.messages[0]?.body).toBe('optimistic');

      await waitFor(() => {
        expect(result.current.threads[0]?.messages[0]?.body).toBe('server truth');
      });
      expect(server.requests.filter((request) => request.method === 'GET')).toHaveLength(2);
    });
  });

  describe('clearAllComments', () => {
    it('replaces the session with an empty list using the last seen version', async () => {
      server.threads = [makeThread('t1', 'src/a.ts', 10, 'one')];
      server.version = 5;
      const { result } = await renderLoaded();

      act(() => {
        result.current.clearAllComments();
      });

      expect(result.current.threads).toEqual([]);
      await waitFor(() => expect(server.threads).toEqual([]));
      expect(server.writes()).toEqual([
        {
          url: '/api/comments?base=abc1234&target=def5678',
          method: 'POST',
          body: { threads: [], baseVersion: 5 },
        },
      ]);
    });

    it('adopts the server state when the version is stale (409)', async () => {
      server.threads = [makeThread('t1', 'src/a.ts', 10, 'one')];
      server.version = 1;
      const { result } = await renderLoaded();

      // An agent writes in between.
      server.threads = [...server.threads, makeThread('agent', 'src/b.ts', 5, 'agent')];
      server.version = 2;

      act(() => {
        result.current.clearAllComments();
      });

      await waitFor(() => expect(result.current.threads).toHaveLength(2));
      expect(server.threads).toHaveLength(2);
    });
  });

  describe('generateThreadPrompt', () => {
    it('should format single line comment correctly', async () => {
      const { result } = await renderLoaded();

      let thread: DiffCommentThread | undefined;
      act(() => {
        thread = result.current.addThread({
          filePath: 'src/client/components/CommentForm.tsx',
          body: 'コメント内容',
          side: 'new',
          line: 42,
        });
      });

      expect(result.current.generateThreadPrompt(thread!.id)).toBe(
        'src/client/components/CommentForm.tsx:L42\nコメント内容',
      );
    });

    it('should format multi-line comment correctly', async () => {
      const { result } = await renderLoaded();

      let thread: DiffCommentThread | undefined;
      act(() => {
        thread = result.current.addThread({
          filePath: 'src/client/components/CommentForm.tsx',
          body: '複数行',
          side: 'new',
          line: { start: 36, end: 39 },
        });
      });

      expect(result.current.generateThreadPrompt(thread!.id)).toBe(
        'src/client/components/CommentForm.tsx:L36-L39\n複数行',
      );
    });

    it('should return empty string for non-existent comment', async () => {
      const { result } = await renderLoaded();

      expect(result.current.generateThreadPrompt('non-existent-id')).toBe('');
    });
  });

  describe('generateAllCommentsPrompt', () => {
    it('should return empty string when no comments', async () => {
      const { result } = await renderLoaded();

      expect(result.current.generateAllCommentsPrompt()).toBe('');
    });

    it('should format multiple comments with separator', async () => {
      const { result } = await renderLoaded();

      act(() => {
        result.current.addThread({
          filePath: 'src/client/components/CommentForm.tsx',
          body: '複数行',
          side: 'new',
          line: { start: 36, end: 39 },
        });
      });
      act(() => {
        result.current.addThread({
          filePath: 'src/client/components/CommentForm.tsx',
          body: 'コメント内容',
          side: 'new',
          line: 42,
        });
      });

      const prompt = result.current.generateAllCommentsPrompt({
        requestedBaseCommitish: 'main',
        requestedTargetCommitish: 'feature-branch',
        baseMode: 'merge-base',
        resolvedBaseCommitish: 'abc1234',
        resolvedTargetCommitish: 'def5678',
      });

      expect(result.current.threads).toHaveLength(2);
      expect(result.current.threads[0]?.position.line).toEqual({ start: 36, end: 39 });
      expect(result.current.threads[1]?.position.line).toBe(42);

      expect(prompt).toBe(`diff main...feature-branch (abc1234...def5678)
=====
src/client/components/CommentForm.tsx:L36-L39
複数行
=====
src/client/components/CommentForm.tsx:L42
コメント内容`);
    });

    it('should handle comments from different files', async () => {
      const { result } = await renderLoaded();

      act(() => {
        result.current.addThread({
          filePath: 'src/client/App.tsx',
          body: 'App comment',
          side: 'new',
          line: 10,
        });
      });
      act(() => {
        result.current.addThread({
          filePath: 'src/server/server.ts',
          body: 'Server comment',
          side: 'new',
          line: { start: 20, end: 25 },
        });
      });

      expect(result.current.generateAllCommentsPrompt()).toBe(`src/client/App.tsx:L10
App comment
=====
src/server/server.ts:L20-L25
Server comment`);
    });

    it('should include ORIGINAL section for suggestion comments with code snapshot', async () => {
      const { result } = await renderLoaded();

      act(() => {
        result.current.addThread({
          filePath: 'src/client/components/Button.tsx',
          body: `Please apply this:\n\`\`\`suggestion
const next = true;
\`\`\``,
          side: 'new',
          line: 12,
          codeSnapshot: {
            content: 'const prev = false;',
            language: 'typescript',
          },
        });
      });

      const prompt = result.current.generateAllCommentsPrompt();

      expect(prompt).toContain('src/client/components/Button.tsx:L12');
      expect(prompt).toContain('ORIGINAL:');
      expect(prompt).toContain('const prev = false;');
      expect(prompt).toContain('SUGGESTED:');
      expect(prompt).toContain('const next = true;');
    });
  });
});
