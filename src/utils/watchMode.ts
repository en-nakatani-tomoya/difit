import type { DiffSelection } from '../types/diff.js';
import { DiffMode } from '../types/watch.js';

/**
 * Picks the file-watching mode a selection needs. Comparing two fixed revisions
 * needs no watching; anything anchored on HEAD or the working tree does.
 */
export function determineDiffMode(selection: DiffSelection, hasExplicitBase: boolean): DiffMode {
  const { targetCommitish } = selection;

  // If comparing specific commits/branches (not involving HEAD), no watching needed
  // Exception: allow watching when targetCommitish is '.' even with an explicit base
  if (hasExplicitBase && targetCommitish !== 'HEAD' && targetCommitish !== '.') {
    return DiffMode.SPECIFIC;
  }

  if (targetCommitish === 'working') {
    return DiffMode.WORKING;
  }

  if (targetCommitish === 'staged') {
    return DiffMode.STAGED;
  }

  if (targetCommitish === '.') {
    return DiffMode.DOT;
  }

  // Default mode: HEAD^ vs HEAD or HEAD vs other commits (watch for HEAD changes)
  return DiffMode.DEFAULT;
}
