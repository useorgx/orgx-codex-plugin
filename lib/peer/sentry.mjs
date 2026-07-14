import * as Sentry from '@sentry/node';

// The public, write-only orgx-clients DSN is injected before release. Operators
// can override it without falling back to a customer's generic SENTRY_DSN.
const DEFAULT_DSN = '';
const PACKAGE_NAME = '@useorgx/codex-plugin';
const SURFACE = 'codex-plugin';

const SENSITIVE_KEY =
  /(?:^|[_-])(authorization|cookie|password|secret|token|api[_-]?key|private[_-]?key|session|prompt|input|output|completion|model[_-]?(?:input|output))(?:$|[_-])/i;

function isTruthy(value) {
  return ['1', 'true', 'yes', 'y', 'on'].includes(
    String(value ?? '').trim().toLowerCase()
  );
}

function sampleRate(value, fallback = 0.02) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
    ? parsed
    : fallback;
}

function isDisabled() {
  return (
    isTruthy(process.env.ORGX_TELEMETRY_DISABLED) ||
    isTruthy(process.env.ORGX_SENTRY_DISABLED)
  );
}

function redactText(value) {
  return String(value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\boxk_[A-Za-z0-9_-]+\b/g, 'oxk_[redacted]')
    .replace(/\bsntrys_[A-Za-z0-9_-]+\b/g, 'sntrys_[redacted]')
    .replace(
      /\b(api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*[^\s,;]+/gi,
      '$1=[redacted]'
    )
    .replace(/\/Users\/[^/\s]+/g, '/Users/[user]')
    .replace(/\/home\/[^/\s]+/g, '/home/[user]')
    .replace(/[A-Z]:\\Users\\[^\\\s]+/gi, 'C:\\Users\\[user]');
}

function sanitize(value, depth = 0) {
  if (typeof value === 'string') return redactText(value);
  if (value == null || typeof value !== 'object') return value;
  if (depth >= 6) return '[truncated]';
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry, depth + 1));
  if (value instanceof Error) {
    return {
      name: redactText(value.name),
      message: redactText(value.message),
      stack: value.stack ? redactText(value.stack) : undefined,
    };
  }

  const sanitized = {};
  for (const [key, entry] of Object.entries(value)) {
    sanitized[key] = SENSITIVE_KEY.test(key)
      ? '[redacted]'
      : sanitize(entry, depth + 1);
  }
  return sanitized;
}

export function initializePeerSentry(version = '0.0.0-dev') {
  const dsn = process.env.ORGX_SENTRY_DSN?.trim() || DEFAULT_DSN;
  if (!dsn || isDisabled() || Sentry.isInitialized()) return false;

  Sentry.init({
    dsn,
    environment: process.env.ORGX_SENTRY_ENVIRONMENT || 'production',
    release: `${PACKAGE_NAME}@${version}`,
    tracesSampleRate: sampleRate(process.env.ORGX_SENTRY_TRACES_SAMPLE_RATE),
    enableLogs: true,
    sendDefaultPii: false,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: { request: false, response: false },
      httpBodies: [],
      queryParams: false,
      genAI: { inputs: false, outputs: false },
      stackFrameVariables: false,
      frameContextLines: 3,
    },
    initialScope: { tags: { service: 'orgx-clients', surface: SURFACE } },
    beforeBreadcrumb: (breadcrumb) =>
      breadcrumb.category === 'console' ? null : sanitize(breadcrumb),
    beforeSend(event) {
      const sanitized = sanitize(event);
      delete sanitized.user;
      delete sanitized.request;
      return sanitized;
    },
    beforeSendTransaction: (event) => sanitize(event),
    beforeSendLog: (log) => sanitize(log),
  });
  return true;
}

export function capturePeerException(error, tags = {}) {
  if (!Sentry.isInitialized()) return;
  Sentry.captureException(error, { tags });
}

export async function captureFatalPeerException(error) {
  capturePeerException(error, { stage: 'fatal' });
  if (Sentry.isInitialized()) await Sentry.flush(2_000);
}
