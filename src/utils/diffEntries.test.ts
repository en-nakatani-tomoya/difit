import { describe, expect, it } from 'vitest';

import {
  createDiffEntryId,
  deriveDiffTitle,
  formatElapsedHours,
  isValidDiffEntryId,
  MAX_DIFF_TITLE_LENGTH,
  normalizeDiffTitle,
} from './diffEntries.js';
import { createDiffSelection } from './diffSelection.js';

const HOUR = 3_600_000;

describe('formatElapsedHours', () => {
  const now = Date.parse('2026-09-01T12:00:00.000Z');
  const at = (hoursAgo: number) => new Date(now - hoursAgo * HOUR).toISOString();

  it('reports whole hours below the cap', () => {
    expect(formatElapsedHours(at(0), now)).toBe('0h');
    expect(formatElapsedHours(at(1), now)).toBe('1h');
    expect(formatElapsedHours(at(98), now)).toBe('98h');
    expect(formatElapsedHours(at(99), now)).toBe('99h');
  });

  it('floors partial hours', () => {
    expect(formatElapsedHours(new Date(now - HOUR - 59 * 60_000).toISOString(), now)).toBe('1h');
    expect(formatElapsedHours(new Date(now - 59 * 60_000).toISOString(), now)).toBe('0h');
  });

  it('caps anything past 99 hours at 99+', () => {
    expect(formatElapsedHours(at(100), now)).toBe('99+');
    expect(formatElapsedHours(at(10_000), now)).toBe('99+');
  });

  it('never reports negative time', () => {
    expect(formatElapsedHours(at(-5), now)).toBe('0h');
  });

  it('falls back to 0h for unparsable timestamps', () => {
    expect(formatElapsedHours('not-a-date', now)).toBe('0h');
  });

  it('accepts epoch millis and Date values', () => {
    expect(formatElapsedHours(now - 3 * HOUR, now)).toBe('3h');
    expect(formatElapsedHours(new Date(now - 3 * HOUR), now)).toBe('3h');
  });
});

describe('normalizeDiffTitle', () => {
  it('collapses whitespace and trims', () => {
    expect(normalizeDiffTitle('  fix   the   parser ')).toBe('fix the parser');
  });

  it('rejects blank and non-string values', () => {
    expect(normalizeDiffTitle('   ')).toBeUndefined();
    expect(normalizeDiffTitle(undefined)).toBeUndefined();
    expect(normalizeDiffTitle(42)).toBeUndefined();
  });

  it('truncates overly long titles', () => {
    expect(normalizeDiffTitle('a'.repeat(200))).toHaveLength(MAX_DIFF_TITLE_LENGTH);
  });
});

describe('deriveDiffTitle', () => {
  it('names the special working-tree targets', () => {
    expect(deriveDiffTitle(createDiffSelection('HEAD', '.'))).toBe('All Uncommitted Changes');
    expect(deriveDiffTitle(createDiffSelection('HEAD', 'staged'))).toBe('Staging Area');
    expect(deriveDiffTitle(createDiffSelection('staged', 'working'))).toBe('Working Directory');
  });

  it('renders a revision range', () => {
    expect(deriveDiffTitle(createDiffSelection('HEAD^', 'HEAD'))).toBe('HEAD^ → HEAD');
    expect(deriveDiffTitle(createDiffSelection('main', 'feature', 'merge-base'))).toBe(
      'main ... feature',
    );
  });

  it('labels stdin diffs', () => {
    expect(deriveDiffTitle(undefined, { stdin: true })).toBe('Diff from stdin');
    expect(deriveDiffTitle(undefined, { stdin: true, stdinLabel: 'PR #1' })).toBe('PR #1');
  });
});

describe('diff entry ids', () => {
  it('generates ids accepted by the validator', () => {
    for (let i = 0; i < 50; i++) {
      expect(isValidDiffEntryId(createDiffEntryId())).toBe(true);
    }
  });

  it('rejects ids that could escape the route namespace', () => {
    expect(isValidDiffEntryId('../etc')).toBe(false);
    expect(isValidDiffEntryId('')).toBe(false);
    expect(isValidDiffEntryId('UPPER')).toBe(false);
    expect(isValidDiffEntryId(undefined)).toBe(false);
  });
});
