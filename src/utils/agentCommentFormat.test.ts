import { describe, it, expect } from 'vitest';

import type { DiffCommentThread } from '../types/diff';

import { formatAgentComments, toAgentCommentLine } from './agentCommentFormat';

function makeThread(overrides: Partial<DiffCommentThread> = {}): DiffCommentThread {
  return {
    id: 't_abc123',
    filePath: 'src/main.ts',
    createdAt: '2026-09-04T00:00:00.000Z',
    updatedAt: '2026-09-04T00:00:00.000Z',
    position: { side: 'new', line: 42 },
    messages: [
      {
        id: 'm_1',
        body: 'Not idempotent on rerun.',
        author: 'user',
        createdAt: '2026-09-04T00:00:00.000Z',
        updatedAt: '2026-09-04T00:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

describe('toAgentCommentLine', () => {
  it('condenses a single-line thread', () => {
    expect(toAgentCommentLine(makeThread())).toEqual({
      id: 't_abc123',
      file: 'src/main.ts',
      side: 'new',
      line: 42,
      body: 'Not idempotent on rerun.',
      replies: 0,
    });
  });

  it('renders a range position as [start, end]', () => {
    const line = toAgentCommentLine(
      makeThread({ position: { side: 'old', line: { start: 36, end: 39 } } }),
    );

    expect(line.line).toEqual([36, 39]);
    expect(line.side).toBe('old');
  });

  it('collapses a degenerate range to a number', () => {
    const line = toAgentCommentLine(
      makeThread({ position: { side: 'new', line: { start: 7, end: 7 } } }),
    );

    expect(line.line).toBe(7);
  });

  it('counts every message after the first as a reply', () => {
    const thread = makeThread();
    thread.messages.push(
      { ...thread.messages[0], id: 'm_2', body: 'Reply one' },
      { ...thread.messages[0], id: 'm_3', body: 'Reply two', author: 'agent' },
    );

    const line = toAgentCommentLine(thread);
    expect(line.body).toBe('Not idempotent on rerun.');
    expect(line.replies).toBe(2);
    expect(line.messages).toBeUndefined();
  });

  it('handles a thread with no messages', () => {
    const line = toAgentCommentLine(makeThread({ messages: [] }));

    expect(line.body).toBe('');
    expect(line.replies).toBe(0);
  });

  it('includes replies (not the first message) with --with-replies', () => {
    const thread = makeThread();
    thread.messages.push({ ...thread.messages[0], id: 'm_2', body: 'Reply', author: 'agent' });

    expect(toAgentCommentLine(thread, { withReplies: true }).messages).toEqual([
      { author: 'agent', body: 'Reply' },
    ]);
  });

  it('omits codeSnapshot unless --with-snapshot is given', () => {
    const thread = makeThread({ codeSnapshot: { content: 'const a = 1;', language: 'ts' } });

    expect(toAgentCommentLine(thread).snippet).toBeUndefined();
    expect(toAgentCommentLine(thread, { withSnapshot: true }).snippet).toBe('const a = 1;');
  });

  it('tags the line with diffId when provided', () => {
    expect(toAgentCommentLine(makeThread(), { diffId: 'yoqzhlmk' }).diffId).toBe('yoqzhlmk');
  });
});

describe('formatAgentComments', () => {
  it('returns an empty string for no threads', () => {
    expect(formatAgentComments([])).toBe('');
  });

  it('emits one JSON object per line', () => {
    const output = formatAgentComments([
      makeThread(),
      makeThread({ id: 't_def456', position: { side: 'new', line: { start: 36, end: 39 } } }),
    ]);

    const lines = output.split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).id).toBe('t_abc123');
    expect(JSON.parse(lines[1]).line).toEqual([36, 39]);
  });

  it('keeps multi-line bodies parseable on a single line', () => {
    const thread = makeThread();
    thread.messages[0].body = 'line one\nline two\n\n```suggestion\nfoo\n```';

    const output = formatAgentComments([thread]);
    expect(output.split('\n')).toHaveLength(1);
    expect(JSON.parse(output).body).toBe('line one\nline two\n\n```suggestion\nfoo\n```');
  });
});
