/**
 * Gateway credentials authenticate the peer transport only. They must never
 * become ambient authority for Codex, git hooks, MCP servers, or shell tools
 * spawned by the peer.
 */
export const GATEWAY_SECRET_ENV_KEYS = [
  'ORGX_API_KEY',
  'ORGX_GATEWAY_KEY',
];

export function captureGatewayCredential(env = process.env) {
  const apiKey = env.ORGX_API_KEY ?? env.ORGX_GATEWAY_KEY;
  for (const key of GATEWAY_SECRET_ENV_KEYS) delete env[key];
  return apiKey;
}

export function sanitizedChildProcessEnv(
  baseEnv = process.env,
  overrides = {},
) {
  const env = { ...baseEnv, ...overrides };
  for (const key of GATEWAY_SECRET_ENV_KEYS) delete env[key];
  return env;
}
