import { useState, useEffect, useCallback, useRef } from 'react';

import { type CommentThread, type DiffCommentThread, type DiffSide } from '../../types/diff';
import {
  type CommentPromptDiffContext,
  formatCommentThreadPrompt,
  formatAllCommentThreadsPrompt,
} from '../../utils/commentFormatting';
import { createId } from '../../utils/createId';
import { getLanguageFromPath } from '../utils/diffUtils';

interface AddThreadParams {
  filePath: string;
  body: string;
  side: DiffSide;
  line: number | { start: number; end: number };
  codeSnapshot?: DiffCommentThread['codeSnapshot'];
}

interface ReplyToThreadParams {
  threadId: string;
  body: string;
}

/** Builds the URL of a comment API path for the current diff selection. */
export type CommentApiUrlBuilder = (path: string) => string;

interface UseDiffCommentsReturn {
  threads: DiffCommentThread[];
  /** Re-reads the session from the server (used when another writer changed it). */
  refreshThreads: () => Promise<void>;
  addThread: (params: AddThreadParams) => DiffCommentThread;
  replyToThread: (params: ReplyToThreadParams) => void;
  removeThread: (threadId: string) => void;
  removeMessage: (threadId: string, messageId: string) => void;
  updateMessage: (threadId: string, messageId: string, newBody: string) => void;
  clearAllComments: () => void;
  generateThreadPrompt: (threadId: string) => string;
  generateAllCommentsPrompt: (context?: CommentPromptDiffContext) => string;
}

function normalizeThread(thread: DiffCommentThread): CommentThread {
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

interface CommentsJsonPayload {
  version?: number;
  threads?: DiffCommentThread[];
}

function readVersion(payload: unknown): number | undefined {
  const version = (payload as { version?: unknown } | null)?.version;
  return typeof version === 'number' ? version : undefined;
}

/**
 * Review comments for one diff selection. The server session is the source of truth:
 * this hook reads it, applies user edits optimistically, and sends each edit as a
 * per-thread PUT/DELETE so concurrent writers (other tabs, agents) never clobber each other.
 *
 * `getCommentApiUrl` is `null` until the diff selection is known. The URL it produces for
 * `/api/comments-json` is the session key: when it changes, the hook reloads.
 */
export function useDiffComments(
  getCommentApiUrl: CommentApiUrlBuilder | null,
): UseDiffCommentsReturn {
  const [threads, setThreads] = useState<DiffCommentThread[]>([]);
  // Latest server version; echoed as baseVersion for whole-list replacements.
  const versionRef = useRef<number | null>(null);
  // Guards against a slow response for a previous selection overwriting the current one.
  const loadSequenceRef = useRef(0);
  // Keyed by the resulting URL rather than the builder's identity so an un-memoized builder
  // cannot trigger a reload on every render.
  const sessionUrl = getCommentApiUrl ? getCommentApiUrl('/api/comments-json') : null;
  const builderRef = useRef(getCommentApiUrl);
  builderRef.current = getCommentApiUrl;

  const refreshThreads = useCallback(async () => {
    if (!sessionUrl) {
      return;
    }

    const sequence = ++loadSequenceRef.current;
    const response = await fetch(sessionUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch comments: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as CommentsJsonPayload;
    if (sequence !== loadSequenceRef.current) {
      return;
    }
    const version = readVersion(payload);
    if (version !== undefined) {
      versionRef.current = version;
    }
    setThreads(Array.isArray(payload.threads) ? payload.threads : []);
  }, [sessionUrl]);

  useEffect(() => {
    loadSequenceRef.current += 1;
    versionRef.current = null;
    setThreads([]);

    if (!sessionUrl) {
      return;
    }

    refreshThreads().catch((error: unknown) => {
      console.error('Failed to load comments from server:', error);
    });
  }, [sessionUrl, refreshThreads]);

  const recoverFromFailedWrite = useCallback(
    (error: unknown) => {
      console.error('Failed to save comment to server:', error);
      refreshThreads().catch((refreshError: unknown) => {
        console.error('Failed to reload comments after a failed save:', refreshError);
      });
    },
    [refreshThreads],
  );

  const adoptVersion = useCallback((payload: unknown) => {
    const version = readVersion(payload);
    if (version !== undefined) {
      versionRef.current = version;
    }
  }, []);

  /** Optimistically upserts a thread locally, then persists it with PUT. */
  const commitThread = useCallback(
    (thread: DiffCommentThread) => {
      setThreads((current) => {
        const index = current.findIndex((item) => item.id === thread.id);
        return index < 0
          ? [...current, thread]
          : current.map((item, itemIndex) => (itemIndex === index ? thread : item));
      });

      const getUrl = builderRef.current;
      if (!getUrl) {
        return;
      }

      fetch(getUrl(`/api/comments/${encodeURIComponent(thread.id)}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ thread }),
      })
        .then(async (response) => {
          if (!response.ok) {
            throw new Error(`${response.status} ${response.statusText}`);
          }
          adoptVersion(await response.json());
        })
        .catch(recoverFromFailedWrite);
    },
    [adoptVersion, recoverFromFailedWrite],
  );

  const removeThread = useCallback(
    (threadId: string) => {
      setThreads((current) => current.filter((thread) => thread.id !== threadId));

      const getUrl = builderRef.current;
      if (!getUrl) {
        return;
      }

      fetch(getUrl(`/api/comments/${encodeURIComponent(threadId)}`), {
        method: 'DELETE',
      })
        .then(async (response) => {
          // 404 means another writer already removed it, which is the state we wanted.
          if (response.status === 404) {
            return;
          }
          if (!response.ok) {
            throw new Error(`${response.status} ${response.statusText}`);
          }
          adoptVersion(await response.json());
        })
        .catch(recoverFromFailedWrite);
    },
    [adoptVersion, recoverFromFailedWrite],
  );

  const addThread = useCallback(
    (params: AddThreadParams): DiffCommentThread => {
      const now = new Date().toISOString();
      const threadId = createId();
      const newThread: DiffCommentThread = {
        id: threadId,
        filePath: params.filePath,
        createdAt: now,
        updatedAt: now,
        position: {
          side: params.side,
          line: params.line,
        },
        codeSnapshot: params.codeSnapshot || {
          content: '',
          language: getLanguageFromPath(params.filePath),
        },
        messages: [
          {
            id: threadId,
            body: params.body,
            author: 'User',
            createdAt: now,
            updatedAt: now,
          },
        ],
      };

      commitThread(newThread);
      return newThread;
    },
    [commitThread],
  );

  const replyToThread = useCallback(
    ({ threadId, body }: ReplyToThreadParams) => {
      const thread = threads.find((item) => item.id === threadId);
      if (!thread) return;

      const now = new Date().toISOString();
      commitThread({
        ...thread,
        updatedAt: now,
        messages: [
          ...thread.messages,
          {
            id: createId(),
            body,
            author: 'User',
            createdAt: now,
            updatedAt: now,
          },
        ],
      });
    },
    [commitThread, threads],
  );

  const removeMessage = useCallback(
    (threadId: string, messageId: string) => {
      const thread = threads.find((item) => item.id === threadId);
      if (!thread) return;

      const targetIndex = thread.messages.findIndex((message) => message.id === messageId);
      if (targetIndex < 0) {
        return;
      }

      if (targetIndex === 0) {
        removeThread(threadId);
        return;
      }

      commitThread({
        ...thread,
        updatedAt: new Date().toISOString(),
        messages: thread.messages.filter((message) => message.id !== messageId),
      });
    },
    [commitThread, removeThread, threads],
  );

  const updateMessage = useCallback(
    (threadId: string, messageId: string, newBody: string) => {
      const thread = threads.find((item) => item.id === threadId);
      if (!thread) return;

      const now = new Date().toISOString();
      commitThread({
        ...thread,
        updatedAt: now,
        messages: thread.messages.map((message) =>
          message.id === messageId ? { ...message, body: newBody, updatedAt: now } : message,
        ),
      });
    },
    [commitThread, threads],
  );

  const clearAllComments = useCallback(() => {
    setThreads([]);

    const getUrl = builderRef.current;
    if (!getUrl) {
      return;
    }

    // Whole-list replacement is compare-and-set on the version we last saw; a 409 means
    // another writer got in between, and the recovery path reloads their state.
    fetch(getUrl('/api/comments'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threads: [], baseVersion: versionRef.current ?? 0 }),
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`${response.status} ${response.statusText}`);
        }
        adoptVersion(await response.json());
      })
      .catch(recoverFromFailedWrite);
  }, [adoptVersion, recoverFromFailedWrite]);

  const generateThreadPrompt = useCallback(
    (threadId: string): string => {
      const thread = threads.find((item) => item.id === threadId);
      if (!thread) return '';

      return formatCommentThreadPrompt(normalizeThread(thread));
    },
    [threads],
  );

  const generateAllCommentsPrompt = useCallback(
    (context?: CommentPromptDiffContext): string => {
      return formatAllCommentThreadsPrompt(threads.map(normalizeThread), context);
    },
    [threads],
  );

  return {
    threads,
    refreshThreads,
    addThread,
    replyToThread,
    removeThread,
    removeMessage,
    updateMessage,
    clearAllComments,
    generateThreadPrompt,
    generateAllCommentsPrompt,
  };
}
