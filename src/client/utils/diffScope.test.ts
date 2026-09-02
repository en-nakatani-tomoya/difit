import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

async function loadDiffScope(pathname: string) {
  window.history.replaceState(null, '', pathname);
  vi.resetModules();
  return await import('./diffScope');
}

describe('diffScope', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('leaves API paths untouched when the page is not scoped to a diff', async () => {
    const { apiUrl, getScopedDiffId } = await loadDiffScope('/');

    expect(getScopedDiffId()).toBeNull();
    expect(apiUrl('/api/diff')).toBe('/api/diff');
    expect(apiUrl('/api/diff?ignoreWhitespace=true')).toBe('/api/diff?ignoreWhitespace=true');
  });

  it('reads the diff id from a /d/:diffId page URL', async () => {
    const { apiUrl, getScopedDiffId } = await loadDiffScope('/d/ab12cd34');

    expect(getScopedDiffId()).toBe('ab12cd34');
    expect(apiUrl('/api/diff')).toBe('/api/diff?diffId=ab12cd34');
    expect(apiUrl('/api/diff?ignoreWhitespace=true')).toBe(
      '/api/diff?ignoreWhitespace=true&diffId=ab12cd34',
    );
  });

  it('ignores malformed diff paths', async () => {
    const { getScopedDiffId } = await loadDiffScope('/d/NOT-VALID/extra');
    expect(getScopedDiffId()).toBeNull();
  });

  it('pins later requests and rewrites the address bar', async () => {
    const { apiUrl, getScopedDiffId, setScopedDiffId } = await loadDiffScope('/');

    setScopedDiffId('ff00ff00');

    expect(getScopedDiffId()).toBe('ff00ff00');
    expect(window.location.pathname).toBe('/d/ff00ff00');
    expect(apiUrl('/api/comments')).toBe('/api/comments?diffId=ff00ff00');
  });

  it('ignores null ids so unscoped hosts keep working', async () => {
    const { getScopedDiffId, setScopedDiffId } = await loadDiffScope('/');

    setScopedDiffId(null);

    expect(getScopedDiffId()).toBeNull();
    expect(window.location.pathname).toBe('/');
  });
});
