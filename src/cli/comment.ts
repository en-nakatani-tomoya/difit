import { Command, Option } from 'commander';

import type { DiffCommentThread, DiffsResponse } from '../types/diff.js';
import { formatAgentComments } from '../utils/agentCommentFormat.js';
import { parseCommentImportValue } from '../utils/commentImports.js';

import { apiBaseUrl, handleCommandError } from './serverRequest.js';
import { detectStdinSource, readStdin } from './utils.js';

interface CommentImportResponse {
  success?: boolean;
  importId?: string;
  count?: number;
  warnings?: string[];
}

interface AgentGetOptions {
  port: number;
  diff?: string;
  withReplies?: boolean;
  withSnapshot?: boolean;
}

async function fetchThreads(port: number, diffId?: string): Promise<DiffCommentThread[]> {
  const response = await fetch(`${apiBaseUrl(port, diffId)}/comments-json`);

  if (!response.ok) {
    console.error('Error: Failed to retrieve comments');
    process.exit(1);
  }

  const data = (await response.json()) as { threads?: DiffCommentThread[] };
  return data.threads ?? [];
}

/**
 * `/api/comments-json` only ever answers for one diff (the scoped one, or the active
 * one when unscoped). To cover every diff of a multi-diff server we list the diffs
 * first and fetch each one, tagging its lines with `diffId`.
 */
async function collectAgentOutput(opts: AgentGetOptions): Promise<string> {
  const formatOptions = { withReplies: opts.withReplies, withSnapshot: opts.withSnapshot };

  if (opts.diff) {
    return formatAgentComments(await fetchThreads(opts.port, opts.diff), formatOptions);
  }

  const diffsResponse = await fetch(`${apiBaseUrl(opts.port)}/diffs`);
  const diffs = diffsResponse.ok
    ? ((await diffsResponse.json()) as DiffsResponse).diffs
    : undefined;

  if (!diffs || diffs.length <= 1) {
    return formatAgentComments(await fetchThreads(opts.port), formatOptions);
  }

  const sections = await Promise.all(
    diffs.map(async (entry) =>
      formatAgentComments(await fetchThreads(opts.port, entry.id), {
        ...formatOptions,
        diffId: entry.id,
      }),
    ),
  );

  return sections.filter((section) => section.length > 0).join('\n');
}

async function parseCommentAddInput(json?: string): Promise<string> {
  if (typeof json === 'string') {
    return json;
  }

  if (detectStdinSource() === 'tty') {
    throw new Error('Provide comment JSON as an argument or via stdin');
  }

  const stdin = await readStdin();
  if (!stdin.trim()) {
    throw new Error('No comment JSON received from stdin');
  }

  return stdin;
}

export function createCommentCommand(): Command {
  const comment = new Command('comment').description(
    'Add, retrieve, or resolve comments on a running difit server',
  );

  comment
    .command('add')
    .description('Add comments to a running difit server')
    .argument('[json]', 'comment import JSON (object or array)')
    .requiredOption('--port <port>', 'port of the running difit server', parseInt)
    .option('--diff <id>', 'target a specific diff on the server (see `difit diff list`)')
    .action(async (json: string | undefined, opts: { port: number; diff?: string }) => {
      try {
        const input = await parseCommentAddInput(json);
        const imports = parseCommentImportValue(input);

        const response = await fetch(`${apiBaseUrl(opts.port, opts.diff)}/comment-imports`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(imports),
        });

        if (!response.ok) {
          const errorBody = (await response.json().catch(() => ({}))) as {
            error?: string;
          };
          console.error(`Error: ${errorBody.error ?? 'Failed to add comments'}`);
          process.exit(1);
        }

        const result = (await response.json()) as CommentImportResponse;
        console.log(
          JSON.stringify({
            success: result.success ?? true,
            importId: result.importId,
            count: result.count ?? imports.length,
            warnings: result.warnings ?? [],
          }),
        );
      } catch (error) {
        handleCommandError(error, opts.port);
      }
    });

  comment
    .command('get')
    .description('Retrieve comments from a running difit server')
    .requiredOption('--port <port>', 'port of the running difit server', parseInt)
    .option('--diff <id>', 'target a specific diff on the server (see `difit diff list`)')
    .addOption(
      new Option('--format <format>', 'output format')
        .choices(['text', 'json', 'agent'])
        .default('text'),
    )
    .option('--with-replies', 'agent format: include replies as `messages`')
    .option('--with-snapshot', 'agent format: include the code snapshot as `snippet`')
    .action(
      async (opts: {
        port: number;
        format: string;
        diff?: string;
        withReplies?: boolean;
        withSnapshot?: boolean;
      }) => {
        try {
          if (opts.format === 'agent') {
            const output = await collectAgentOutput(opts);
            if (output) {
              console.log(output);
            }
            return;
          }

          const endpoint = opts.format === 'json' ? '/comments-json' : '/comments-output';
          const response = await fetch(`${apiBaseUrl(opts.port, opts.diff)}${endpoint}`);

          if (!response.ok) {
            console.error('Error: Failed to retrieve comments');
            process.exit(1);
          }

          if (opts.format === 'json') {
            const data: unknown = await response.json();
            console.log(JSON.stringify(data));
          } else {
            const text = await response.text();
            if (text.trim()) {
              console.log(text);
            }
          }
        } catch (error) {
          handleCommandError(error, opts.port);
        }
      },
    );

  comment
    .command('resolve')
    .alias('remove')
    .description('Resolve (remove) comment threads on a running difit server')
    .argument('<threadIds...>', 'thread IDs to resolve')
    .requiredOption('--port <port>', 'port of the running difit server', parseInt)
    .option('--diff <id>', 'target a specific diff on the server (see `difit diff list`)')
    .action(async (threadIds: string[], opts: { port: number; diff?: string }) => {
      try {
        const results = await Promise.all(
          threadIds.map(
            async (
              threadId,
            ): Promise<{
              threadId: string;
              status: 'resolved' | 'notFound' | 'error';
              error?: string;
            }> => {
              const response = await fetch(
                `${apiBaseUrl(opts.port, opts.diff)}/comments/${encodeURIComponent(threadId)}`,
                { method: 'DELETE' },
              );

              if (response.ok) {
                return { threadId, status: 'resolved' };
              }

              if (response.status === 404) {
                return { threadId, status: 'notFound' };
              }

              const errorBody = (await response.json().catch(() => ({}))) as {
                error?: string;
              };
              return {
                threadId,
                status: 'error',
                error: errorBody.error ?? `Failed to resolve thread ${threadId}`,
              };
            },
          ),
        );

        const resolved = results.filter((r) => r.status === 'resolved').map((r) => r.threadId);
        const notFound = results.filter((r) => r.status === 'notFound').map((r) => r.threadId);
        const errors = results
          .filter((r) => r.status === 'error')
          .map((r) => ({
            threadId: r.threadId,
            error: r.error ?? `Failed to resolve thread ${r.threadId}`,
          }));

        console.log(
          JSON.stringify({
            success: notFound.length === 0 && errors.length === 0,
            resolved,
            notFound,
            errors,
          }),
        );
        if (notFound.length > 0 || errors.length > 0) {
          process.exit(1);
        }
      } catch (error) {
        handleCommandError(error, opts.port);
      }
    });

  return comment;
}
