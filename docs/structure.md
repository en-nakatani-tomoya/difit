# difit Codebase Structure

## Overview

difit is a CLI tool that displays Git diffs in a GitHub-like web interface. The architecture consists of three main components:

1. CLI entry point that handles command-line arguments
2. Server component that provides APIs and serves the web interface
3. Client web application

## Directory Structure

```
src/
├── cli/              # Command-line interface
│   ├── index.ts      # Main CLI entry point
│   ├── utils.ts      # CLI utility functions
│   └── utils.test.ts # Unit tests for utilities
├── server/           # Express server
│   ├── server.ts     # Server setup and API endpoints
│   └── git-diff.ts   # Git operations and diff parsing
├── client/           # React web application
│   └── ...          # UI components
└── types/            # Shared TypeScript types
    └── diff.ts      # Diff-related type definitions
```

## CLI Arguments and Options

### Basic Usage

```bash
difit [commit-ish] [compare-with]
```

### Positional Arguments

- `[commit-ish]`: Target commit/branch/tag to review (default: HEAD)
  - Git references: SHA, branch names, tags
  - HEAD references: HEAD, HEAD~n, HEAD^
  - Special values: "working", "staged", "."
- `[compare-with]`: Optional base for comparison
  - If omitted: uses `commit-ish^` (parent commit)
  - Special handling for "working": compares with "staged"

### Options

| Option            | Description                                | Default   |
| ----------------- | ------------------------------------------ | --------- |
| `--port <port>`   | Preferred port (auto-assigned if occupied) | 4966      |
| `--host <host>`   | Host address to bind                       | 127.0.0.1 |
| `--no-open`       | Do not automatically open browser          | false     |
| `--pr <url>`      | Review GitHub PR by URL                    | -         |
| `--title <title>` | Title shown in the diff switcher           | derived   |

### Subcommands

| Command                                  | Description                                 |
| ---------------------------------------- | ------------------------------------------- |
| `difit diff add <target> [compare-with]` | Register another diff on a running server   |
| `difit diff list`                        | List the diffs a running server hosts       |
| `difit comment add\|get\|resolve`        | Read and write comments on a running server |

All subcommands require `--port <port>`; the `comment` subcommands accept `--diff <id>`
to target a specific diff.

### Special Arguments Behavior

#### "working"

- Shows unstaged changes (working directory vs staging area)
- Cannot be used with `compare-with` (except "staged")
- Prompts for untracked files inclusion

#### "staged"

- Shows staged changes vs specified commit
- Only allowed as target, not as base
- Exception: allowed as base when target is "working"

#### "."

- Shows all uncommitted changes (working + staged)
- Can be compared with any commit
- Prompts for untracked files inclusion

## Git Operations (simple-git)

### CLI Operations

1. **Untracked Files Detection** (`src/cli/index.ts:97-98`)
   - Uses `git.status()` to find untracked files
   - Prompts user for intent-to-add inclusion
   - Executes `git.add(['--intent-to-add', ...files])`

### Server Operations (`src/server/git-diff.ts`)

1. **Commit Validation**
   - `git.show([commitish, '--name-only'])` - Verify commit exists
2. **Diff Generation**
   - `git.diffSummary(diffArgs)` - Get changed files summary
   - `git.diff(['--color=never', ...diffArgs])` - Get full diff content
3. **Revision Resolution**
   - `git.revparse([commitish])` - Resolve refs to SHA
4. **Status Checks**
   - `git.status()` - Check repository state

### GitHub PR Integration

- Uses `@octokit/rest` for GitHub API
- Authentication: `GITHUB_TOKEN` env or `gh auth token`
- Resolves PR commits locally after fetching metadata

## Server Architecture

### Express Server Setup

- **Port Assignment**: Automatic fallback on EADDRINUSE
- **CORS**: Restricted to localhost origins
- **Static Files**: Serves client dist in production

### API Endpoints

| Endpoint               | Method | Description                                        |
| ---------------------- | ------ | -------------------------------------------------- |
| `/api/diffs`           | GET    | List the diffs hosted by the server                |
| `/api/diffs`           | POST   | Register an additional diff                        |
| `/api/diff`            | GET    | Retrieve diff data with optional whitespace ignore |
| `/api/comments-json`   | GET    | Current comment session (`{ version, threads }`)   |
| `/api/comments/:id`    | PUT    | Create or replace one comment thread               |
| `/api/comments/:id`    | DELETE | Remove one comment thread                          |
| `/api/comments`        | POST   | Replace the whole session (`baseVersion` required) |
| `/api/comment-imports` | POST   | Merge externally produced comments (agents, CLI)   |
| `/api/comments-output` | GET    | Get formatted comments output                      |
| `/api/watch`           | GET    | SSE stream; `commentsChanged` events live here     |
| `/api/heartbeat`       | GET    | SSE endpoint for tab close detection               |

### Diff Namespacing

A server can host several independent diffs of the same repository:

- Each diff has a short id, a title, and a `createdAt` timestamp (`DiffEntrySummary`).
- `/api/d/:diffId/<rest>` is rewritten onto the flat `/api/<rest>` handlers with that diff
  attached to the request; `/api/<rest>?diffId=<id>` is equivalent. An unknown id yields 404.
- Unscoped requests fall back to the most recently added diff. `/api/comments-output` is the
  exception: unscoped, it reports every diff.
- Comment sessions are keyed by diff id **and** revision selection, so diffs never share comments.
- The browser page for a diff is `/d/:diffId`; the client pins itself to the diff id returned
  by `/api/diff` and rewrites its address bar to match.

### Comment Source of Truth

The server owns review comments; the browser is a viewer/editor of the server's session.

- A **comment session** is `{ threads, version }` keyed by diff id and the _resolved_
  revision selection `(base, target, baseMode)`. `version` is an in-process counter bumped on
  every change and echoed to clients so conflicting writes are detectable.
- At startup the server restores the persisted session (below), applies `--clean` by deleting
  it, and merges `--comment` / `--pr` imports with `mergeCommentImports` **before** the first
  request. `GET /api/diff` no longer carries `commentImports`; clients never import anything.
- The client (`useDiffComments`) loads `GET /api/comments-json`, applies edits optimistically,
  and sends each edit as `PUT /api/comments/:threadId` (add / reply / edit) or
  `DELETE /api/comments/:threadId`. Other tabs learn about the change through the
  `commentsChanged` SSE event and re-read the session. Nothing about comments is kept in
  `localStorage` any more; only `viewedFiles` stays there.
- `POST /api/comments` is a compare-and-set whole-list replacement: `baseVersion` is
  mandatory (400 without it) and must equal the current version (409 otherwise, with the
  server's current `version` and `threads` in the body). A stale tab therefore cannot wipe a
  comment that arrived after its last read. The client uses it for "Cleanup All Prompt".
- `POST /api/comment-imports` merges (idempotently) and is the entry point for agents and
  the `difit comment add` CLI.

### Comment Storage

Sessions survive the server process. Each session is one JSON file:

```
<store root>/<repository key>/<base>_<target>[_merge-base].json
```

- `<store root>` is, in order of precedence: `$DIFIT_COMMENT_STORE_DIR`;
  `<git common dir>/difit/comments` (i.e. inside `.git/`, so never committed);
  `<$DIFIT_CONFIG_DIR or ~/.difit>/comments` when the working directory is not a Git
  repository.
- `<repository key>` is `sha256(realpath of git rev-parse --git-common-dir)`, so the main
  checkout, every linked worktree, and a launch from any subdirectory all restore the same
  sessions. Outside a repository it is `sha256(absolute path)`. This is deliberately not the
  `repositoryId` that `GET /api/diff` exposes (a hash of the launch path), which the client
  keeps using to isolate `viewedFiles` in `localStorage`.
- `base` / `target` are the resolved commitish values of the session. Every path component
  is escaped (`[^A-Za-z0-9.-]` → `_<hex>_`) so refs such as `feat/x` cannot traverse
  directories or collide. A file name longer than 200 characters is cut to
  `<prefix>_<sha256 prefix>` so it always fits `NAME_MAX`.
- stdin diffs use `stdin_<sha256(patch) prefix>`; `--pr <url>` uses the escaped PR URL so
  comments follow the pull request across new pushes.
- File format: `{ version: 1, selection, updatedAt, threads }`. Writes are atomic
  (temp file + rename); a session that becomes empty deletes its file. Unreadable files are
  ignored with a warning rather than failing startup.
- `--clean` deletes the file of the diff the server starts with.

### Request Flow

1. CLI validates arguments and starts server
2. Server fetches Git diff data, restores the persisted comment session, and merges
   `--comment` imports into it
3. Client connects, requests the diff via API, and reads the comment session
4. Comment edits are written to the server, persisted to the store, and broadcast over SSE
5. On disconnect, comments are output to console

## Dependencies

### Core Dependencies

- **commander**: CLI framework for argument parsing
- **simple-git**: Git command wrapper
- **express**: Web server framework
- **@octokit/rest**: GitHub API client
- **react**: UI framework

### Development Tools

- **vitest**: Testing framework
- **typescript**: Type safety
- **oxlint/oxfmt**: Code quality
- **lefthook**: Git hooks
- **vite**: Build tool for client

## Build and Distribution

### Build Process

1. TypeScript compilation for CLI/server
2. Vite build for React client
3. Bundle into dist/ directory

### Package Structure

```
dist/
├── cli/        # Compiled CLI code
├── server/     # Compiled server code
└── client/     # Built React application
```

### Entry Point

- Binary: `dist/cli/index.js` (via package.json bin field)
- Shebang: `#!/usr/bin/env node`

## Error Handling

### CLI Errors

- Invalid arguments: Validation with descriptive messages
- Git errors: Caught and displayed to user
- Server startup: Port conflicts handled automatically

### Server Errors

- Invalid commits: Pre-validated before server start
- API errors: JSON error responses
- Shutdown: Graceful with comment preservation

## Security Considerations

1. **Network Binding**
   - Default: 127.0.0.1 (localhost only)
   - Warning displayed for external binding
2. **CORS Policy**
   - Restricted to localhost origins
3. **File Access**
   - Limited to current Git repository
   - No arbitrary file system access

## Testing Strategy

### Current Test Coverage

- **Unit Tests**: CLI utilities (validation functions)
- **Missing**: Integration tests for Git operations
- **Missing**: Server API endpoint tests
- **Missing**: Error scenario testing
