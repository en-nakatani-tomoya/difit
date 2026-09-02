const DIFF_PATH_PATTERN = /^\/d\/([0-9a-z]{1,32})\/?$/;

function readInitialDiffId(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  return DIFF_PATH_PATTERN.exec(window.location.pathname)?.[1] ?? null;
}

let scopedDiffId: string | null = readInitialDiffId();

export function getScopedDiffId(): string | null {
  return scopedDiffId;
}

export function diffPagePath(diffId: string): string {
  return `/d/${diffId}`;
}

/**
 * Pins every subsequent API call to `diffId` and reflects it in the address bar,
 * so a reload keeps showing the same diff even when the server's active diff changed.
 */
export function setScopedDiffId(diffId: string | null): void {
  if (!diffId || diffId === scopedDiffId) {
    return;
  }

  scopedDiffId = diffId;

  if (typeof window === 'undefined') {
    return;
  }

  const nextPath = diffPagePath(diffId);
  if (window.location.pathname === nextPath) {
    return;
  }

  try {
    window.history.replaceState(
      null,
      '',
      `${nextPath}${window.location.search}${window.location.hash}`,
    );
  } catch {
    // Address bar rewriting is cosmetic; ignore hosts that disallow it.
  }
}

/** Scopes an `/api/...` path to the diff this page is showing. */
export function apiUrl(path: string): string {
  if (!scopedDiffId) {
    return path;
  }

  return `${path}${path.includes('?') ? '&' : '?'}diffId=${encodeURIComponent(scopedDiffId)}`;
}
