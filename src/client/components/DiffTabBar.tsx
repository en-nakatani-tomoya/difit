import { Clock } from 'lucide-react';

import type { DiffEntrySummary } from '../../types/diff';
import { formatElapsedHours } from '../../utils/diffEntries';
import { diffPagePath } from '../utils/diffScope';

interface DiffTabBarProps {
  diffs: DiffEntrySummary[];
  currentDiffId: string | null;
  now: number;
  onSelect?: (diffId: string) => void;
}

function describeSelection(diff: DiffEntrySummary): string {
  if (diff.isStdin) {
    return 'stdin';
  }

  const { baseCommitish, targetCommitish, baseMode } = diff.selection;
  const separator = baseMode === 'merge-base' ? '...' : '→';
  return `${baseCommitish} ${separator} ${targetCommitish}`;
}

/**
 * Bottom bar listing every diff hosted by the server, with how long ago each one
 * was registered. Clicking a tab switches the page to that diff.
 */
export function DiffTabBar({ diffs, currentDiffId, now, onSelect }: DiffTabBarProps) {
  if (diffs.length < 2) {
    return null;
  }

  const handleSelect = (diffId: string) => {
    if (diffId === currentDiffId) {
      return;
    }

    if (onSelect) {
      onSelect(diffId);
      return;
    }

    window.location.assign(diffPagePath(diffId));
  };

  return (
    <nav
      className="shrink-0 z-30 bg-github-bg-secondary border-t border-github-border overflow-x-auto"
      aria-label="Diffs on this server"
    >
      <ul className="flex items-stretch gap-1 px-2 py-1 min-w-max">
        {diffs.map((diff) => {
          const isCurrent = diff.id === currentDiffId;
          const elapsed = formatElapsedHours(diff.createdAt, now);
          const range = describeSelection(diff);

          return (
            <li key={diff.id}>
              <button
                type="button"
                onClick={() => handleSelect(diff.id)}
                aria-current={isCurrent ? 'page' : undefined}
                title={`${diff.title} (${range}) · added ${elapsed} ago`}
                className={`flex items-center gap-2 max-w-xs px-3 py-1.5 text-xs rounded border transition-colors ${
                  isCurrent
                    ? 'bg-github-bg-tertiary border-github-border text-github-text-primary'
                    : 'bg-transparent border-transparent text-github-text-secondary hover:text-github-text-primary hover:bg-github-bg-tertiary'
                }`}
              >
                <span className="truncate">{diff.title}</span>
                <span className="flex items-center gap-1 font-mono text-github-text-muted shrink-0">
                  <Clock size={11} aria-hidden="true" />
                  <span aria-label={`Added ${elapsed} ago`}>{elapsed}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
