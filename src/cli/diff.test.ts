import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { createDiffCommand } from './diff.js';

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe('difit diff', () => {
  const mockFetch = vi.fn();
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockFetch.mockReset();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('requires --port on both subcommands', () => {
    const command = createDiffCommand();
    for (const name of ['add', 'list']) {
      const sub = command.commands.find((c) => c.name() === name);
      expect(sub?.options.find((o) => o.long === '--port')?.mandatory).toBe(true);
    }
  });

  it('posts the target, base and title to the running server', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(
        {
          id: 'abc12345',
          title: 'Review PR',
          createdAt: '2026-09-01T00:00:00.000Z',
          url: '/d/abc12345',
          isEmpty: false,
        },
        201,
      ),
    );

    await createDiffCommand().parseAsync([
      'node',
      'difit',
      'add',
      'feature',
      'main',
      '--port',
      '4966',
      '--title',
      'Review PR',
    ]);

    expect(mockFetch).toHaveBeenCalledWith('http://localhost:4966/api/diffs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'feature', base: 'main', title: 'Review PR' }),
    });
    expect(logSpy.mock.calls[0]?.[0]).toContain('"url":"http://localhost:4966/d/abc12345"');
  });

  it('reports server-side rejections and exits non-zero', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ error: 'Invalid or non-existent commit: nope' }, 400),
    );

    await createDiffCommand().parseAsync(['node', 'difit', 'add', 'nope', '--port', '4966']);

    expect(errorSpy).toHaveBeenCalledWith('Error: Invalid or non-existent commit: nope');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('lists diffs with elapsed hours, marking the active one', async () => {
    const now = Date.now();
    mockFetch.mockResolvedValue(
      jsonResponse({
        activeDiffId: 'bbb22222',
        diffs: [
          {
            id: 'aaa11111',
            title: 'first',
            createdAt: new Date(now - 3 * 3_600_000).toISOString(),
            selection: { baseCommitish: 'HEAD^', targetCommitish: 'HEAD' },
            isStdin: false,
            url: '/d/aaa11111',
          },
          {
            id: 'bbb22222',
            title: 'second',
            createdAt: new Date(now - 500 * 3_600_000).toISOString(),
            selection: { baseCommitish: 'main', targetCommitish: 'feature' },
            isStdin: false,
            url: '/d/bbb22222',
          },
        ],
      }),
    );

    await createDiffCommand().parseAsync(['node', 'difit', 'list', '--port', '4966']);

    expect(mockFetch).toHaveBeenCalledWith('http://localhost:4966/api/diffs');
    const output = logSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(output[0]).toContain('  aaa11111    3h  first  (HEAD^ → HEAD)');
    expect(output[1]).toContain('* bbb22222   99+  second  (main → feature)');
  });

  it('emits raw JSON with --format json', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ activeDiffId: 'aaa11111', diffs: [] }));

    await createDiffCommand().parseAsync([
      'node',
      'difit',
      'list',
      '--port',
      '4966',
      '--format',
      'json',
    ]);

    expect(logSpy).toHaveBeenCalledWith('{"activeDiffId":"aaa11111","diffs":[]}');
  });
});
