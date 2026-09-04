import { execFileSync } from 'child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, isAbsolute, join, resolve } from 'path';

import type { DiffCommentThread, DiffSelection } from '../types/diff.js';
import { normalizeBaseMode } from '../utils/diffSelection.js';

/** On-disk shape of one comment session. */
export interface PersistedCommentSession {
  version: 1;
  selection: DiffSelection;
  updatedAt: string;
  threads: DiffCommentThread[];
}

/**
 * Escapes a value so it can be used as (part of) a file name without collisions:
 * anything outside `[A-Za-z0-9.-]` becomes `_<hex>_`, so `_` itself is reserved as the
 * separator between components. `..` cannot survive because `.` is only kept when the
 * whole component is not a traversal token.
 */
export function encodeCommentStoreComponent(value: string): string {
  if (value.length === 0) {
    return '_empty_';
  }
  if (value === '.' || value === '..') {
    return value.replace(/\./g, '_2e_');
  }
  return value.replace(/[^A-Za-z0-9.-]/g, (char) => `_${char.charCodeAt(0).toString(16)}_`);
}

/** `<base>_<target>[_merge-base]`, matching the localStorage convention the client used to have. */
export function createCommentStoreKeyForSelection(selection: DiffSelection): string {
  const key = `${encodeCommentStoreComponent(selection.baseCommitish)}_${encodeCommentStoreComponent(
    selection.targetCommitish,
  )}`;
  return normalizeBaseMode(selection.baseMode) === 'merge-base' ? `${key}_merge-base` : key;
}

function resolveGitCommonDir(repositoryPath: string): string | undefined {
  try {
    const output = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: repositoryPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!output) {
      return undefined;
    }
    return isAbsolute(output) ? output : resolve(repositoryPath, output);
  } catch {
    return undefined;
  }
}

/**
 * Root directory that holds every repository's comment files.
 *
 * Precedence: `DIFIT_COMMENT_STORE_DIR` (tests, power users) → `<git common dir>/difit/comments`
 * (inside `.git`, so never committed; the common dir keeps worktrees of one repo together) →
 * `<DIFIT_CONFIG_DIR or ~/.difit>/comments` when the path is not a git repository (e.g. `--pr`
 * run from an arbitrary directory).
 */
export function resolveCommentStoreRoot(repositoryPath: string): string {
  const override = process.env.DIFIT_COMMENT_STORE_DIR?.trim();
  if (override) {
    return resolve(override);
  }

  const gitCommonDir = resolveGitCommonDir(repositoryPath);
  if (gitCommonDir) {
    return join(gitCommonDir, 'difit', 'comments');
  }

  const configDir = process.env.DIFIT_CONFIG_DIR?.trim();
  return join(configDir || join(homedir(), '.difit'), 'comments');
}

/**
 * File-backed persistence for comment sessions of one repository.
 * Every session lives in its own JSON file so concurrent difit processes on different
 * diffs never contend, and a corrupt file only affects that one diff.
 */
export class CommentStore {
  private readonly directory: string;

  constructor(root: string, repositoryId: string) {
    this.directory = join(root, encodeCommentStoreComponent(repositoryId));
  }

  filePath(key: string): string {
    return join(this.directory, `${key}.json`);
  }

  read(key: string): PersistedCommentSession | undefined {
    let raw: string;
    try {
      raw = readFileSync(this.filePath(key), 'utf8');
    } catch {
      return undefined;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<PersistedCommentSession> | null;
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.threads)) {
        console.warn(`Ignoring unrecognized comment store file: ${this.filePath(key)}`);
        return undefined;
      }
      return parsed as PersistedCommentSession;
    } catch (error) {
      console.warn(`Ignoring unreadable comment store file: ${this.filePath(key)}`, error);
      return undefined;
    }
  }

  write(key: string, selection: DiffSelection, threads: DiffCommentThread[]): void {
    const path = this.filePath(key);
    const payload: PersistedCommentSession = {
      version: 1,
      selection,
      updatedAt: new Date().toISOString(),
      threads,
    };

    try {
      if (threads.length === 0) {
        // Nothing left to keep; drop the file rather than leaving an empty husk behind.
        rmSync(path, { force: true });
        return;
      }
      mkdirSync(dirname(path), { recursive: true });
      // Temp file + rename so a crash mid-write cannot leave a truncated store.
      const tmpPath = `${path}.${process.pid}.tmp`;
      writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      renameSync(tmpPath, path);
    } catch (error) {
      console.warn(`Failed to persist comments to ${path}:`, error);
    }
  }

  remove(key: string): void {
    try {
      rmSync(this.filePath(key), { force: true });
    } catch (error) {
      console.warn(`Failed to remove comment store file ${this.filePath(key)}:`, error);
    }
  }
}
