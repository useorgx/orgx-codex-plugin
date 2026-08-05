import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, parse } from 'node:path';
import { promisify } from 'node:util';

import { sanitizedChildProcessEnv } from './childProcessEnv.mjs';

const execFileAsync = promisify(execFile);

/**
 * Autonomous dispatch is a runner-owned permission. Keep this parser
 * deliberately narrow so a missing value, typo, or inherited truthy value
 * cannot silently authorize unattended work.
 */
export function parseAutonomousDispatchEnabled(value) {
  return value === 'true';
}

/**
 * Resolve the local coding checkout from runner-owned configuration. A remote
 * task path is never authoritative: autonomy is bound to one canonical git
 * worktree root chosen by the runner operator.
 */
export async function validateAutonomousRepoPath(value, opts = {}) {
  if (typeof value !== 'string' || !value.trim()) {
    return invalid('autonomous_repo_path_missing');
  }
  const requested = value.trim();
  if (!isAbsolute(requested) || requested.includes('\0')) {
    return invalid('autonomous_repo_path_not_absolute');
  }

  const realpathImpl = opts.realpathImpl ?? realpath;
  const statImpl = opts.statImpl ?? stat;
  let canonical;
  try {
    canonical = await realpathImpl(requested);
    if (!(await statImpl(canonical)).isDirectory()) {
      return invalid('autonomous_repo_path_not_directory');
    }
  } catch {
    return invalid('autonomous_repo_path_unavailable');
  }

  const home = await canonicalOrNull(opts.homeDir ?? homedir(), realpathImpl);
  if (canonical === parse(canonical).root || (home && canonical === home)) {
    return invalid('autonomous_repo_path_too_broad');
  }

  try {
    await statImpl(join(canonical, '.git'));
  } catch {
    return invalid('autonomous_repo_path_not_worktree_root');
  }

  try {
    const resolveGitRoot = opts.gitRootResolver ?? defaultGitRootResolver;
    const gitRoot = await realpathImpl(await resolveGitRoot(canonical));
    if (gitRoot !== canonical) {
      return invalid('autonomous_repo_path_not_worktree_root');
    }
  } catch {
    return invalid('autonomous_repo_path_not_git_worktree');
  }

  return { ready: true, path: canonical, reason: null };
}

async function defaultGitRootResolver(cwd) {
  const { stdout } = await execFileAsync(
    'git',
    ['-C', cwd, 'rev-parse', '--show-toplevel'],
    {
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      env: sanitizedChildProcessEnv(),
    }
  );
  return stdout.trim();
}

async function canonicalOrNull(value, realpathImpl) {
  try {
    return await realpathImpl(value);
  } catch {
    return null;
  }
}

function invalid(reason) {
  return { ready: false, path: null, reason };
}
