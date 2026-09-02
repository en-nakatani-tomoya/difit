import type { DiffSelection } from '../types/diff.js';

export const MAX_DIFF_TITLE_LENGTH = 80;

/** Elapsed hours are capped so the badge stays a fixed width. */
const MAX_ELAPSED_HOURS = 99;

const DIFF_ID_PATTERN = /^[0-9a-z]{1,32}$/;

const SPECIAL_TARGET_TITLES: Record<string, string> = {
  '.': 'All Uncommitted Changes',
  staged: 'Staging Area',
  working: 'Working Directory',
};

export function createDiffEntryId(): string {
  // Short, URL-safe, and collision-resistant enough for the handful of diffs one server holds.
  return Math.random().toString(36).slice(2, 10).padEnd(8, '0');
}

export function isValidDiffEntryId(value: unknown): value is string {
  return typeof value === 'string' && DIFF_ID_PATTERN.test(value);
}

export function normalizeDiffTitle(title: unknown): string | undefined {
  if (typeof title !== 'string') {
    return undefined;
  }

  const collapsed = title.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) {
    return undefined;
  }

  return collapsed.slice(0, MAX_DIFF_TITLE_LENGTH);
}

export function deriveDiffTitle(
  selection: DiffSelection | undefined,
  options?: { stdin?: boolean; stdinLabel?: string },
): string {
  if (options?.stdin) {
    return normalizeDiffTitle(options.stdinLabel) ?? 'Diff from stdin';
  }

  if (!selection || !selection.targetCommitish) {
    return 'Diff';
  }

  const special = SPECIAL_TARGET_TITLES[selection.targetCommitish];
  if (special) {
    return special;
  }

  if (!selection.baseCommitish) {
    return selection.targetCommitish;
  }

  const separator = selection.baseMode === 'merge-base' ? '...' : '→';
  return `${selection.baseCommitish} ${separator} ${selection.targetCommitish}`;
}

/**
 * Hours elapsed since `createdAt`, rendered as `0h` .. `99h`, then `99+`.
 */
export function formatElapsedHours(
  createdAt: string | number | Date,
  now: number = Date.now(),
): string {
  const createdAtMs =
    createdAt instanceof Date
      ? createdAt.getTime()
      : typeof createdAt === 'number'
        ? createdAt
        : Date.parse(createdAt);

  if (!Number.isFinite(createdAtMs)) {
    return '0h';
  }

  const elapsedHours = Math.floor((now - createdAtMs) / 3_600_000);
  if (!Number.isFinite(elapsedHours) || elapsedHours <= 0) {
    return '0h';
  }

  if (elapsedHours > MAX_ELAPSED_HOURS) {
    return `${MAX_ELAPSED_HOURS}+`;
  }

  return `${elapsedHours}h`;
}
