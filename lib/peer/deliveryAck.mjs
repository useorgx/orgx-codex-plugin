import { createHash } from 'node:crypto';

/**
 * Digest-bound delivery ACK (plan v3 §5.6). Server half:
 * orgx/lib/server/deliveryAck.ts.
 *
 * A durable outbox record may be removed only through `settleOnAck`. The
 * response must echo the operation id and the sha256 of the exact bytes sent;
 * a bare 2xx (`200 {}`, a proxy page, an older route) keeps the record.
 */
export const PAYLOAD_DIGEST_HEADER = 'X-OrgX-Payload-Digest';

export function payloadDigest(bodyText) {
  return `sha256:${createHash('sha256').update(bodyText, 'utf8').digest('hex')}`;
}

export function deliveryAckHeaders(operationId, bodyText) {
  return {
    'Idempotency-Key': operationId,
    [PAYLOAD_DIGEST_HEADER]: payloadDigest(bodyText),
  };
}

/**
 * @returns {{ settled: true, disposition: string } | { settled: false, reason: string }}
 */
export function settleOnAck(operationId, digest, response) {
  const status = response?.status ?? 0;
  const body = response?.body;
  if (
    status === 409 &&
    body &&
    typeof body === 'object' &&
    body.reason === 'run_already_terminal'
  ) {
    // Definitive: a different terminal already won; retrying cannot help.
    return { settled: true, disposition: 'superseded' };
  }
  if (!response?.ok) return { settled: false, reason: `HTTP ${status}` };
  const ack = body && typeof body === 'object' ? body.ack : null;
  if (!ack || typeof ack !== 'object') {
    return { settled: false, reason: `HTTP ${status} without a delivery ACK` };
  }
  if (ack.operation_id !== operationId) {
    return { settled: false, reason: 'delivery ACK names a different operation' };
  }
  if (ack.payload_digest !== digest) {
    return { settled: false, reason: 'delivery ACK digest does not match the bytes sent' };
  }
  if (ack.disposition !== 'persisted' && ack.disposition !== 'duplicate') {
    return { settled: false, reason: 'delivery ACK has no durable disposition' };
  }
  return { settled: true, disposition: ack.disposition };
}
