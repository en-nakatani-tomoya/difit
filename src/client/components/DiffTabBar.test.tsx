import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { DiffEntrySummary } from '../../types/diff';

import { DiffTabBar } from './DiffTabBar';

const NOW = Date.parse('2026-09-01T12:00:00.000Z');
const HOUR = 3_600_000;

function makeDiff(overrides: Partial<DiffEntrySummary> & { id: string }): DiffEntrySummary {
  return {
    title: `diff ${overrides.id}`,
    createdAt: new Date(NOW).toISOString(),
    selection: { baseCommitish: 'HEAD^', targetCommitish: 'HEAD' },
    isStdin: false,
    url: `/d/${overrides.id}`,
    ...overrides,
  };
}

describe('DiffTabBar', () => {
  it('stays hidden until there is more than one diff', () => {
    const { container } = render(
      <DiffTabBar diffs={[makeDiff({ id: 'aaa' })]} currentDiffId="aaa" now={NOW} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('lists every diff with its title and elapsed hours', () => {
    render(
      <DiffTabBar
        diffs={[
          makeDiff({
            id: 'aaa',
            title: 'Fix parser',
            createdAt: new Date(NOW - HOUR).toISOString(),
          }),
          makeDiff({
            id: 'bbb',
            title: 'Review PR',
            createdAt: new Date(NOW - 42 * HOUR).toISOString(),
          }),
          makeDiff({
            id: 'ccc',
            title: 'Old work',
            createdAt: new Date(NOW - 500 * HOUR).toISOString(),
          }),
        ]}
        currentDiffId="bbb"
        now={NOW}
      />,
    );

    expect(screen.getByText('Fix parser')).toBeInTheDocument();
    expect(screen.getByText('1h')).toBeInTheDocument();
    expect(screen.getByText('42h')).toBeInTheDocument();
    expect(screen.getByText('99+')).toBeInTheDocument();
  });

  it('marks the current diff and switches on click', () => {
    const onSelect = vi.fn();
    render(
      <DiffTabBar
        diffs={[
          makeDiff({ id: 'aaa', title: 'Fix parser' }),
          makeDiff({ id: 'bbb', title: 'Review PR' }),
        ]}
        currentDiffId="aaa"
        now={NOW}
        onSelect={onSelect}
      />,
    );

    const current = screen.getByRole('button', { name: /Fix parser/ });
    expect(current).toHaveAttribute('aria-current', 'page');

    fireEvent.click(screen.getByRole('button', { name: /Review PR/ }));
    expect(onSelect).toHaveBeenCalledWith('bbb');

    fireEvent.click(current);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
