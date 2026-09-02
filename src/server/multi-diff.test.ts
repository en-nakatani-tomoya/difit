import { type Server } from 'http';

import { afterEach, describe, expect, it, vi } from 'vitest';

// Set environment variable to skip fetch mocking
process.env.VITEST_SERVER_TEST = 'true';

import { startServer } from './server.js';
import { createDiffSelection } from '../utils/diffSelection.js';
import type { DiffEntrySummary, DiffResponse, DiffsResponse } from '../types/diff.js';

const { fetch } = await import('undici');
globalThis.fetch = fetch as any;

vi.mock('./git-diff.js', () => {
  class GitDiffParserMock {
    validateCommit = vi.fn(async (commitish: string) => commitish !== 'nope');
    parseDiff = vi.fn(async (selection: { baseCommitish: string; targetCommitish: string }) => ({
      commit: `${selection.baseCommitish}..${selection.targetCommitish}`,
      baseCommitish: selection.baseCommitish,
      targetCommitish: selection.targetCommitish,
      requestedBaseCommitish: selection.baseCommitish,
      requestedTargetCommitish: selection.targetCommitish,
      files: [],
      isEmpty: false,
    }));
    parseStdinDiff = vi.fn(() => ({ commit: 'stdin diff', files: [], isEmpty: false }));
    getBlobContent = vi.fn().mockResolvedValue(Buffer.from(''));
    getLineCount = vi.fn().mockResolvedValue(0);
    getGeneratedStatus = vi.fn().mockResolvedValue({ isGenerated: false, source: 'path' });
    clearResolvedCommitCache = vi.fn();
    getRevisionOptions = vi.fn().mockResolvedValue({
      branches: [],
      commits: [],
      originDefaultBranch: 'origin/main',
      resolvedBase: 'base',
      resolvedTarget: 'target',
    });
  }

  return { GitDiffParser: GitDiffParserMock };
});

let runningServer: Server | undefined;
let baseUrl = '';

async function launch(options: Parameters<typeof startServer>[0] = {}) {
  const result = await startServer({
    selection: createDiffSelection('HEAD^', 'HEAD'),
    preferredPort: 5300,
    openBrowser: false,
    ...options,
  });
  runningServer = result.server;
  baseUrl = `http://localhost:${result.port}`;
  return result;
}

async function addDiff(body: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}/api/diffs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { response, json: (await response.json()) as DiffEntrySummary & { error?: string } };
}

afterEach(async () => {
  if (runningServer) {
    const server = runningServer;
    runningServer = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe('diff registry', () => {
  it('exposes the diff the server booted with, using the given title', async () => {
    await launch({ title: 'Initial review' });

    const data = (await (await fetch(`${baseUrl}/api/diffs`)).json()) as DiffsResponse;

    expect(data.diffs).toHaveLength(1);
    expect(data.diffs[0]).toMatchObject({
      title: 'Initial review',
      isStdin: false,
      selection: { baseCommitish: 'HEAD^', targetCommitish: 'HEAD' },
    });
    expect(data.diffs[0]?.url).toBe(`/d/${data.diffs[0]?.id}`);
    expect(data.activeDiffId).toBe(data.diffs[0]?.id);
    expect(Date.parse(data.diffs[0]?.createdAt ?? '')).not.toBeNaN();
  });

  it('derives a title when none is given', async () => {
    await launch();

    const data = (await (await fetch(`${baseUrl}/api/diffs`)).json()) as DiffsResponse;
    expect(data.diffs[0]?.title).toBe('HEAD^ → HEAD');
  });

  it('registers additional diffs and makes the newest one active', async () => {
    await launch({ title: 'first' });

    const { response, json } = await addDiff({ target: 'feature', base: 'main', title: 'second' });
    expect(response.status).toBe(201);
    expect(json.title).toBe('second');

    const data = (await (await fetch(`${baseUrl}/api/diffs`)).json()) as DiffsResponse;
    expect(data.diffs.map((d) => d.title)).toEqual(['first', 'second']);
    expect(data.activeDiffId).toBe(json.id);
  });

  it('defaults the base to the target parent when omitted', async () => {
    await launch();

    const { json } = await addDiff({ target: 'abc1234' });
    expect(json.selection).toMatchObject({ baseCommitish: 'abc1234^', targetCommitish: 'abc1234' });

    const uncommitted = await addDiff({ target: '.' });
    expect(uncommitted.json.selection).toMatchObject({
      baseCommitish: 'HEAD',
      targetCommitish: '.',
    });
    expect(uncommitted.json.title).toBe('All Uncommitted Changes');
  });

  it('rejects invalid add requests', async () => {
    await launch();

    expect((await addDiff({})).response.status).toBe(400);
    expect((await addDiff({ target: 'nope' })).response.status).toBe(400);
  });
});

describe('namespaced routes', () => {
  it('serves each diff under /api/d/:diffId', async () => {
    await launch({ title: 'first' });
    const { json: second } = await addDiff({ target: 'feature', base: 'main', title: 'second' });
    const list = (await (await fetch(`${baseUrl}/api/diffs`)).json()) as DiffsResponse;
    const firstId = list.diffs[0]!.id;

    const firstDiff = (await (
      await fetch(`${baseUrl}/api/d/${firstId}/diff`)
    ).json()) as DiffResponse;
    const secondDiff = (await (
      await fetch(`${baseUrl}/api/d/${second.id}/diff`)
    ).json()) as DiffResponse;

    expect(firstDiff.diffId).toBe(firstId);
    expect(firstDiff.targetCommitish).toBe('HEAD');
    expect(secondDiff.diffId).toBe(second.id);
    expect(secondDiff.targetCommitish).toBe('feature');
    expect(secondDiff.baseCommitish).toBe('main');
  });

  it('accepts ?diffId= as an equivalent scope selector', async () => {
    await launch();
    const { json: second } = await addDiff({ target: 'feature', base: 'main' });

    const scoped = (await (
      await fetch(`${baseUrl}/api/diff?diffId=${second.id}`)
    ).json()) as DiffResponse;
    expect(scoped.diffId).toBe(second.id);
  });

  it('preserves query parameters through the namespace rewrite', async () => {
    await launch();
    const list = (await (await fetch(`${baseUrl}/api/diffs`)).json()) as DiffsResponse;

    const scoped = (await (
      await fetch(`${baseUrl}/api/d/${list.diffs[0]!.id}/diff?ignoreWhitespace=true`)
    ).json()) as DiffResponse;
    expect(scoped.ignoreWhitespace).toBe(true);
  });

  it('404s on unknown diff ids', async () => {
    await launch();

    expect((await fetch(`${baseUrl}/api/d/deadbeef/diff`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/diff?diffId=deadbeef`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/d/..%2Fsecret/diff`)).status).toBe(404);
  });

  it('falls back to the active diff when no scope is given', async () => {
    await launch();
    const { json: second } = await addDiff({ target: 'feature', base: 'main' });

    const flat = (await (await fetch(`${baseUrl}/api/diff`)).json()) as DiffResponse;
    expect(flat.diffId).toBe(second.id);
  });
});

describe('comment isolation', () => {
  it('keeps comments of independent diffs apart', async () => {
    await launch({ title: 'first' });
    const list = (await (await fetch(`${baseUrl}/api/diffs`)).json()) as DiffsResponse;
    const firstId = list.diffs[0]!.id;
    const { json: second } = await addDiff({ target: 'feature', base: 'main', title: 'second' });

    const post = async (diffId: string, body: string) =>
      fetch(`${baseUrl}/api/d/${diffId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          comments: [{ id: '1', file: 'a.ts', line: 1, body, timestamp: '2026-09-01T00:00:00Z' }],
        }),
      });

    expect((await post(firstId, 'comment on first')).status).toBe(200);
    expect((await post(second.id, 'comment on second')).status).toBe(200);

    const firstOutput = await (await fetch(`${baseUrl}/api/d/${firstId}/comments-output`)).text();
    const secondOutput = await (
      await fetch(`${baseUrl}/api/d/${second.id}/comments-output`)
    ).text();

    expect(firstOutput).toContain('comment on first');
    expect(firstOutput).not.toContain('comment on second');
    expect(secondOutput).toContain('comment on second');
    expect(secondOutput).not.toContain('comment on first');
  });

  it('reports every diff, labelled, when asked without a scope', async () => {
    await launch({ title: 'first' });
    const list = (await (await fetch(`${baseUrl}/api/diffs`)).json()) as DiffsResponse;
    const firstId = list.diffs[0]!.id;
    const { json: second } = await addDiff({ target: 'feature', base: 'main', title: 'second' });

    for (const [diffId, body] of [
      [firstId, 'comment on first'],
      [second.id, 'comment on second'],
    ]) {
      await fetch(`${baseUrl}/api/d/${diffId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          comments: [{ id: '1', file: 'a.ts', line: 1, body, timestamp: '2026-09-01T00:00:00Z' }],
        }),
      });
    }

    const combined = await (await fetch(`${baseUrl}/api/comments-output`)).text();

    expect(combined).toContain(`# first  (${firstId})`);
    expect(combined).toContain('comment on first');
    expect(combined).toContain(`# second  (${second.id})`);
    expect(combined).toContain('comment on second');
  });

  it('omits diff headings when the server hosts a single diff', async () => {
    await launch({ title: 'only' });

    await fetch(`${baseUrl}/api/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        comments: [
          { id: '1', file: 'a.ts', line: 1, body: 'lonely', timestamp: '2026-09-01T00:00:00Z' },
        ],
      }),
    });

    const output = await (await fetch(`${baseUrl}/api/comments-output`)).text();
    expect(output).toContain('lonely');
    expect(output).not.toContain('# only');
  });
});
