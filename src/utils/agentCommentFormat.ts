import type { DiffCommentThread, DiffSide, LineNumber } from '../types/diff';

/** Options controlling the optional fields of the agent output. */
export interface AgentCommentFormatOptions {
  /** Attach every message after the first one as `messages`. */
  withReplies?: boolean;
  /** Attach `codeSnapshot.content` as `snippet`. */
  withSnapshot?: boolean;
  /** Tag the line with the diff it belongs to (multi-diff servers without a scope). */
  diffId?: string;
}

interface AgentCommentReply {
  author?: string;
  body: string;
}

/**
 * One thread condensed to what an agent needs: the id it can feed back to
 * `difit comment resolve`, the location, and the opening message.
 */
export interface AgentCommentLine {
  id: string;
  diffId?: string;
  file: string;
  side: DiffSide;
  line: LineNumber;
  body: string;
  replies: number;
  messages?: AgentCommentReply[];
  snippet?: string;
}

function toLineNumber(line: DiffCommentThread['position']['line']): LineNumber {
  if (typeof line === 'number') {
    return line;
  }
  return line.start === line.end ? line.start : [line.start, line.end];
}

/** Condense a single thread. Key order matches the documented output. */
export function toAgentCommentLine(
  thread: DiffCommentThread,
  options: AgentCommentFormatOptions = {},
): AgentCommentLine {
  const messages = thread.messages ?? [];
  const [first, ...rest] = messages;

  const result: AgentCommentLine = {
    id: thread.id,
    ...(options.diffId ? { diffId: options.diffId } : {}),
    file: thread.filePath,
    side: thread.position.side,
    line: toLineNumber(thread.position.line),
    body: first?.body ?? '',
    replies: rest.length,
  };

  // A thread with no replies gets no `messages` key at all, so agents can test the
  // key's presence instead of an empty array.
  if (options.withReplies && rest.length > 0) {
    result.messages = rest.map((message) => ({
      ...(message.author ? { author: message.author } : {}),
      body: message.body,
    }));
  }

  if (options.withSnapshot && thread.codeSnapshot) {
    result.snippet = thread.codeSnapshot.content;
  }

  return result;
}

/**
 * Render threads as JSON Lines, one thread per line. Returns an empty string
 * for no threads so callers can stay silent instead of printing a blank line.
 */
export function formatAgentComments(
  threads: DiffCommentThread[],
  options: AgentCommentFormatOptions = {},
): string {
  return threads.map((thread) => JSON.stringify(toAgentCommentLine(thread, options))).join('\n');
}
