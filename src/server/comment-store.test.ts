import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CommentStore,
  MAX_COMMENT_STORE_KEY_LENGTH,
  capCommentStoreKey,
  createCommentStoreKeyForSelection,
  encodeCommentStoreComponent,
  resolveCommentStoreLocation,
} from './comment-store.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();

describe('comment store keys', () => {
  it('escapes path separators, traversal tokens, and the separator itself', () => {
    expect(encodeCommentStoreComponent('feat/x_y')).toBe('feat_2f_x_5f_y');
    expect(encodeCommentStoreComponent('..')).toBe('_2e__2e_');
    expect(encodeCommentStoreComponent('')).toBe('_empty_');
    expect(encodeCommentStoreComponent('abc1234.v2-rc')).toBe('abc1234.v2-rc');
  });

  it('builds <base>_<target>[_merge-base] for a selection', () => {
    expect(
      createCommentStoreKeyForSelection({ baseCommitish: 'main', targetCommitish: 'feat/x' }),
    ).toBe('main_feat_2f_x');
    expect(
      createCommentStoreKeyForSelection({
        baseCommitish: 'main',
        targetCommitish: 'HEAD',
        baseMode: 'merge-base',
      }),
    ).toBe('main_HEAD_merge-base');
  });

  it('caps over-long keys with a hash suffix so writes stay under NAME_MAX', () => {
    const long = `${'a'.repeat(150)}_${'b'.repeat(150)}`;
    const capped = capCommentStoreKey(long);
    expect(capped.length).toBeLessThanOrEqual(MAX_COMMENT_STORE_KEY_LENGTH);
    expect(capped).toMatch(/^a{150}_b+_[0-9a-f]{16}$/);
    // Distinct long keys stay distinct; short keys are untouched.
    expect(capped).not.toBe(capCommentStoreKey(`${long}c`));
    expect(capCommentStoreKey('main_HEAD')).toBe('main_HEAD');
  });

  it('does not cut an escape sequence in half when truncating', () => {
    const key = `${'x'.repeat(MAX_COMMENT_STORE_KEY_LENGTH - 19)}_2f_${'y'.repeat(40)}`;
    expect(capCommentStoreKey(key)).toMatch(/^x+_[0-9a-f]{16}$/);
  });
});

describe('comment store location', () => {
  const dirs: string[] = [];
  const temp = (prefix: string) => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  };

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    delete process.env.DIFIT_COMMENT_STORE_DIR;
  });

  it('shares one key between a repository, its worktrees, and its subdirectories', () => {
    const repo = temp('difit-store-repo-');
    git(repo, 'init', '-q', '-b', 'main');
    git(
      repo,
      '-c',
      'user.email=t@e.st',
      '-c',
      'user.name=t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'init',
    );
    mkdirSync(join(repo, 'sub', 'dir'), { recursive: true });
    const worktree = join(temp('difit-store-wt-'), 'wt');
    git(repo, 'worktree', 'add', '-q', worktree, '-b', 'wt');

    const main = resolveCommentStoreLocation(repo);
    const fromWorktree = resolveCommentStoreLocation(worktree);
    const fromSubdir = resolveCommentStoreLocation(join(repo, 'sub', 'dir'));

    expect(fromWorktree.repositoryKey).toBe(main.repositoryKey);
    expect(fromSubdir.repositoryKey).toBe(main.repositoryKey);
    // All three write into the main repository's .git, never the worktree's private gitdir.
    expect(fromWorktree.root).toBe(main.root);
    expect(fromSubdir.root).toBe(main.root);
    expect(main.root.endsWith(join('.git', 'difit', 'comments'))).toBe(true);
  });

  it('falls back to a path hash and the config dir outside a repository', () => {
    const plain = temp('difit-store-plain-');
    const other = temp('difit-store-other-');
    process.env.DIFIT_COMMENT_STORE_DIR = other;

    const location = resolveCommentStoreLocation(plain);
    expect(location.root).toBe(other);
    expect(location.repositoryKey).not.toBe(resolveCommentStoreLocation(other).repositoryKey);
  });

  it('round-trips a session through the capped file name', () => {
    const root = temp('difit-store-root-');
    const store = new CommentStore({ root, repositoryKey: 'repo' });
    const key = `${'r'.repeat(300)}_HEAD`;
    const selection = { baseCommitish: 'r'.repeat(300), targetCommitish: 'HEAD' };
    const thread = {
      id: 't1',
      filePath: 'a.ts',
      createdAt: 'now',
      updatedAt: 'now',
      position: { side: 'new' as const, line: 1 },
      messages: [{ id: 't1', body: 'hi', createdAt: 'now', updatedAt: 'now' }],
    };

    store.write(key, selection, [thread]);
    const [file] = readdirSync(join(root, 'repo'));
    expect(file!.length).toBeLessThanOrEqual(MAX_COMMENT_STORE_KEY_LENGTH + '.json'.length);
    expect(store.read(key)?.threads).toEqual([thread]);

    writeFileSync(store.filePath(key), 'not json');
    expect(store.read(key)).toBeUndefined();

    store.remove(key);
    expect(readdirSync(join(root, 'repo'))).toEqual([]);
  });
});
