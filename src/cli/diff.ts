import { Command, Option } from 'commander';

import type { DiffEntrySummary, DiffsResponse } from '../types/diff.js';
import { formatElapsedHours } from '../utils/diffEntries.js';

import { apiBaseUrl, handleCommandError } from './serverRequest.js';

interface AddedDiffResponse extends DiffEntrySummary {
  isEmpty?: boolean;
}

async function readError(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return body.error ?? fallback;
}

function formatDiffLine(diff: DiffEntrySummary, activeDiffId: string, now: number): string {
  const marker = diff.id === activeDiffId ? '*' : ' ';
  const elapsed = formatElapsedHours(diff.createdAt, now).padStart(4, ' ');
  const range = diff.isStdin
    ? 'stdin'
    : `${diff.selection.baseCommitish} → ${diff.selection.targetCommitish}`;
  return `${marker} ${diff.id}  ${elapsed}  ${diff.title}  (${range})`;
}

export function createDiffCommand(): Command {
  const diff = new Command('diff').description('Manage the diffs hosted by a running difit server');

  diff
    .command('add')
    .description('Add another diff to a running difit server')
    .argument(
      '<commit-ish>',
      'Git commit, tag, branch, HEAD~n reference, or "working"/"staged"/"."',
    )
    .argument('[compare-with]', 'Optional: base to compare with')
    .requiredOption('--port <port>', 'port of the running difit server', parseInt)
    .option('--title <title>', 'title shown in the diff switcher')
    .option('--merge-base', 'resolve the base revision with git merge-base before diffing')
    .action(
      async (
        commitish: string,
        compareWith: string | undefined,
        opts: { port: number; title?: string; mergeBase?: boolean },
      ) => {
        try {
          const response = await fetch(`${apiBaseUrl(opts.port)}/diffs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              target: commitish,
              base: compareWith,
              baseMode: opts.mergeBase ? 'merge-base' : undefined,
              title: opts.title,
            }),
          });

          if (!response.ok) {
            console.error(`Error: ${await readError(response, 'Failed to add diff')}`);
            process.exit(1);
          }

          const result = (await response.json()) as AddedDiffResponse;
          console.log(
            JSON.stringify({
              success: true,
              id: result.id,
              title: result.title,
              url: `http://localhost:${opts.port}${result.url}`,
              createdAt: result.createdAt,
              isEmpty: result.isEmpty ?? false,
            }),
          );
        } catch (error) {
          handleCommandError(error, opts.port);
        }
      },
    );

  diff
    .command('list')
    .description('List the diffs hosted by a running difit server')
    .requiredOption('--port <port>', 'port of the running difit server', parseInt)
    .addOption(
      new Option('--format <format>', 'output format').choices(['text', 'json']).default('text'),
    )
    .action(async (opts: { port: number; format: string }) => {
      try {
        const response = await fetch(`${apiBaseUrl(opts.port)}/diffs`);
        if (!response.ok) {
          console.error(`Error: ${await readError(response, 'Failed to list diffs')}`);
          process.exit(1);
        }

        const data = (await response.json()) as DiffsResponse;
        if (opts.format === 'json') {
          console.log(JSON.stringify(data));
          return;
        }

        const now = Date.now();
        for (const entry of data.diffs) {
          console.log(formatDiffLine(entry, data.activeDiffId, now));
        }
      } catch (error) {
        handleCommandError(error, opts.port);
      }
    });

  return diff;
}
