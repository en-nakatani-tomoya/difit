export function handleCommandError(error: unknown, port: number): never {
  if (error instanceof TypeError && error.message.includes('fetch failed')) {
    console.error(`Error: Cannot connect to difit server on port ${port}. Is the server running?`);
  } else {
    console.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
  process.exit(1);
}

/** Base URL for a running server's API, scoped to a diff when `diffId` is given. */
export function apiBaseUrl(port: number, diffId?: string): string {
  const origin = `http://localhost:${port}`;
  return diffId ? `${origin}/api/d/${encodeURIComponent(diffId)}` : `${origin}/api`;
}
