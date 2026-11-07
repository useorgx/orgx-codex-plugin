import { spawn } from 'node:child_process';
import { CodexAppServerClient } from './CodexAppServerClient.mjs';
import { sanitizedChildProcessEnv } from './childProcessEnv.mjs';

/** The peer cannot silently replace an explicitly selected provider contract. */
export function assertNativeCodexProvider(task, authority) {
  const profile = authority?.context?.contracts?.runtime_profile;
  const contract = profile?.runtime?.contract;
  const providers = [task?.provider, task?.modelProvider, task?.model_provider, profile?.provider,
    profile?.driver?.provider, contract?.provider, contract?.modelProvider, contract?.model_provider];
  if (providers.some(value => value != null && value !== 'auto' && value !== 'openai')) {
    throw new Error('codex_provider_unsupported: this driver requires managed OpenAI subscription execution');
  }
}

export async function detectCodexAuth(opts = {}) {
  let version;
  try {
    const out = await runOnce('codex', ['--version'], { timeoutMs: 5_000 });
    version = out.stdout.trim() || undefined;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/ENOENT|not found/i.test(msg)) {
      return {
        installed: false,
        authenticated: false,
        subscription_active: false,
        auth_status: 'not_installed',
        error: 'Codex executable not found',
      };
    }
    return {
      installed: true,
      authenticated: false,
      subscription_active: false,
      auth_status: 'probe_failed',
      error: 'Codex version probe unavailable',
    };
  }

  try {
    const auth = await runOnce('codex', ['login', 'status'], {
      timeoutMs: 5_000,
    });
    const output = `${auth.stdout}\n${auth.stderr}`.trim();
    const cachedChatgptLogin =
      /logged in using chatgpt/i.test(output) &&
      !/not logged in|not authenticated|sign in required|no session/i.test(
        output
      );
    let proof = { verified: false, quota_status: 'unknown', auth_status: cachedChatgptLogin
      ? 'provider_auth_unverified' : /logged in|authenticated/i.test(output)
        ? 'chatgpt_subscription_required' : 'sign_in_required' };
    if (cachedChatgptLogin) {
      try {
        const factory = opts.appServerFactory ?? ((opts) => new CodexAppServerClient(opts));
        const client = factory({ version: opts.pluginVersion });
        try {
          proof = await client.probeAuthReadiness({ cwd: opts.autonomousRepoPath,
            timeoutMs: opts.authProbeTimeoutMs });
        } finally { client.close?.(); }
      } catch { /* Unsupported app-server auth remains unverified, never a cached fallback. */ }
    }
    const authenticated = proof?.verified === true;
    return {
      installed: true,
      authenticated,
      cached_chatgpt_login: cachedChatgptLogin,
      provider_auth_verified: authenticated,
      quota_status: proof?.quota_status ?? 'unknown',
      version,
      subscription_active: authenticated,
      subscription_type: cachedChatgptLogin ? 'chatgpt' : null,
      auth_method: cachedChatgptLogin ? 'chatgpt' : null,
      auth_status: proof?.auth_status ?? 'provider_auth_unverified',
    };
  } catch (err) {
    return {
      installed: true,
      authenticated: false,
      version,
      subscription_active: false,
      subscription_type: null,
      auth_method: null,
      auth_status: /not logged in|sign in required|no session/i.test(err instanceof Error ? err.message : '')
        ? 'sign_in_required' : 'provider_auth_unverified',
      error: 'Codex login inventory unavailable',
    };
  }
}

function runOnce(cmd, args, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return new Promise((resolveFn, rejectFn) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: sanitizedChildProcessEnv(),
    });
    let stdout = '';
    let stderr = '';
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      rejectFn(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(t);
      rejectFn(err);
    });
    child.on('close', (code) => {
      clearTimeout(t);
      if (code === 0) resolveFn({ stdout, stderr });
      else rejectFn(new Error(`${cmd} exited ${code}: ${stderr.slice(0, 300)}`));
    });
  });
}

