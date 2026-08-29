const HMAC_SIGNATURE_PATTERN = /^hmac-sha256:[a-f0-9]{64}$/;
const WORK_REF_KEYS = [
  'workspaceId',
  'customerId',
  'goalId',
  'objectiveId',
  'initiativeId',
  'workstreamId',
  'milestoneId',
  'taskId',
];
const CLOCK_SKEW_MS = 60_000;
const MAX_CAPABILITY_LEASE_TTL_MS = 60 * 60 * 1_000;

export class AutonomousDispatchContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AutonomousDispatchContractError';
    this.code = code;
  }
}

export function validateLineage(input) {
  const {
    task,
    workspaceId,
    runId,
    idempotencyKey,
    contextDigest,
    specialist,
    assignment,
    mission,
    node,
    manifest,
    lease,
    profile,
    qualityBar,
    envelope,
  } = input;
  assert(mission.workspaceId === workspaceId, 'mission_workspace_mismatch');
  assert(manifest.workspaceId === workspaceId, 'manifest_workspace_mismatch');
  assert(qualityBar.workspaceId === workspaceId, 'quality_workspace_mismatch');
  assert(lease.workspaceId === workspaceId, 'lease_workspace_mismatch');
  assert(envelope.workRef.workspaceId === workspaceId, 'envelope_workspace_mismatch');
  assert(envelope.runId === runId, 'envelope_run_mismatch');
  assert(envelope.idempotencyKey === idempotencyKey, 'envelope_idempotency_mismatch');
  assert(envelope.missionId === mission.id, 'envelope_mission_mismatch');
  assert(
    envelope.missionContractDigest === mission.digest,
    'mission_digest_binding_mismatch'
  );
  assert(envelope.nodeId === node.id, 'envelope_node_mismatch');
  assert(manifest.missionId === mission.id, 'manifest_mission_mismatch');
  assert(manifest.nodeId === node.id, 'manifest_node_mismatch');
  assert(
    envelope.contextManifestDigest === manifest.digest,
    'manifest_digest_binding_mismatch'
  );
  assert(envelope.capabilityLeaseId === lease.id, 'lease_id_binding_mismatch');
  assert(
    envelope.capabilityLeaseDigest === lease.digest,
    'lease_digest_binding_mismatch'
  );
  assert(
    envelope.runtimeProfileDigest === profile.digest,
    'runtime_profile_digest_binding_mismatch'
  );
  assert(
    envelope.qualityBarVersionId === qualityBar.id &&
      mission.qualityBarVersionId === qualityBar.id,
    'quality_bar_binding_mismatch'
  );
  assertSameWorkRef(envelope.workRef, mission.workRef, 'mission_work_ref_mismatch');
  assertSameWorkRef(envelope.workRef, node.workRef, 'node_work_ref_mismatch');
  assert(task.initiative_id === envelope.workRef.initiativeId, 'task_initiative_mismatch');
  assert(task.workstream_id === envelope.workRef.workstreamId, 'task_workstream_mismatch');
  if (assignment.taskId !== null) {
    assert(assignment.taskId === envelope.workRef.taskId, 'task_lineage_mismatch');
  }
  assert(mission.objective === assignment.description, 'mission_assignment_mismatch');
  assert(node.type === 'ACT', 'work_node_type_invalid');
  assert(node.title === assignment.title, 'work_node_title_mismatch');
  assert(node.handler === 'agent.gateway_peer', 'work_node_handler_invalid');
  const nodeInput = record(node.input, 'work_node.input');
  assert(nodeInput.launchMode === 'autonomous', 'work_node_launch_mode_mismatch');
  assert(nodeInput.task === assignment.description, 'work_node_task_mismatch');
  assert(nodeInput.agentId === specialist.agentId, 'work_node_agent_mismatch');
  assert(nodeInput.contextDigest === contextDigest, 'work_node_context_mismatch');
  assert(
    array(node.requiredCapabilities, 'work_node.requiredCapabilities').includes(
      'autonomous.execute'
    ),
    'work_node_capability_missing'
  );
  assert(profile.actor?.type === 'agent', 'runtime_profile_actor_type_invalid');
  assert(profile.actor?.id === specialist.agentId, 'runtime_profile_agent_mismatch');
  assert(profile.driver?.id === 'codex', 'runtime_profile_driver_mismatch');
  assert(qualityBar.domain === specialist.domain, 'quality_bar_domain_mismatch');
  const contextReference = array(manifest.included, 'context_manifest.included').find(
    (entry) => isRecord(entry) && entry.id === 'autonomous-dispatch-context'
  );
  assert(
    isRecord(contextReference) &&
      contextReference.digest === contextDigest &&
      contextReference.source?.digest === contextDigest,
    'context_manifest_binding_mismatch'
  );
  const blockingGap = array(
    manifest.unresolvedGaps,
    'context_manifest.unresolvedGaps'
  ).some((entry) => isRecord(entry) && entry.blocking === true);
  assert(!blockingGap, 'context_manifest_blocking_gap');
}

export function validateLease(lease, input) {
  assert(
    HMAC_SIGNATURE_PATTERN.test(String(lease.signature ?? '')),
    'capability_lease_signature_invalid'
  );
  assert(
    lease.subject?.type === 'agent' && lease.subject?.id === input.agentId,
    'capability_lease_subject_mismatch'
  );
  assert(
    array(lease.actions, 'capability_lease.actions').includes('autonomous.execute'),
    'capability_lease_action_missing'
  );
  const nowMs = input.now instanceof Date ? input.now.getTime() : Date.parse(input.now);
  const issuedAt = Date.parse(lease.issuedAt);
  const expiresAt = Date.parse(lease.expiresAt);
  assert(Number.isFinite(nowMs), 'validation_time_invalid');
  assert(
    Number.isFinite(issuedAt) && Number.isFinite(expiresAt),
    'capability_lease_time_invalid'
  );
  assert(issuedAt <= nowMs + CLOCK_SKEW_MS, 'capability_lease_not_yet_valid');
  assert(expiresAt > nowMs, 'capability_lease_expired');
  assert(expiresAt > issuedAt, 'capability_lease_window_invalid');
  assert(
    expiresAt - issuedAt <= MAX_CAPABILITY_LEASE_TTL_MS,
    'capability_lease_ttl_exceeded'
  );
  assert(
    !input.envelope.deadline || Date.parse(input.envelope.deadline) <= expiresAt,
    'execution_deadline_exceeds_lease'
  );
  assert(
    !input.envelope.deadline || Date.parse(input.envelope.deadline) > nowMs,
    'execution_envelope_expired'
  );
  assert(
    Date.parse(input.envelope.requestedAt) === issuedAt,
    'execution_request_lease_time_mismatch'
  );
  assert(
    Number(input.node.riskTier) <= Number(lease.riskCeiling),
    'capability_lease_risk_exceeded'
  );
  const resources = array(lease.resourceSelectors, 'capability_lease.resourceSelectors');
  assert(
    resources.some(
      (entry) =>
        isRecord(entry) &&
        entry.resourceType === 'workspace' &&
        entry.pattern === input.workspaceId
    ),
    'capability_lease_workspace_scope_missing'
  );
  assert(
    resources.some(
      (entry) =>
        isRecord(entry) && entry.resourceType === 'run' && entry.pattern === input.runId
    ),
    'capability_lease_run_scope_missing'
  );
  const caveats = array(lease.caveats, 'capability_lease.caveats');
  assert(
    caveats.some(
      (entry) =>
        isRecord(entry) && entry.kind === 'launch_mode' && entry.value === 'autonomous'
    ),
    'capability_lease_launch_caveat_missing'
  );
  assert(
    caveats.some(
      (entry) =>
        isRecord(entry) && entry.kind === 'run_id' && entry.value === input.runId
    ),
    'capability_lease_run_caveat_missing'
  );
}

export function toolsByServer(tools) {
  const result = {};
  for (const tool of tools) {
    const current = result[tool.mcp_server] ?? [];
    current.push(tool.mcp_tool);
    result[tool.mcp_server] = current;
  }
  return Object.fromEntries(
    Object.entries(result)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([server, names]) => [server, [...new Set(names)].sort()])
  );
}

export function assertSameSet(left, right, code) {
  assert(Array.isArray(left) && Array.isArray(right), code);
  assertUnique(left, code);
  assertUnique(right, code);
  assert(
    left.length === right.length && left.every((value) => right.includes(value)),
    code
  );
}

export function assertUnique(values, code) {
  assert(new Set(values).size === values.length, code);
}

export function assertSorted(values, code) {
  assert(values.join('\n') === [...values].sort().join('\n'), code);
}

export function array(value, label) {
  if (
    value === undefined &&
    (label === 'task.skill_ids' || label === 'context_manifest.unresolvedGaps')
  ) {
    return [];
  }
  if (!Array.isArray(value)) {
    failContract('autonomous_contract_invalid', `${label} must be an array`);
  }
  return value;
}

export function record(value, label) {
  if (!isRecord(value)) {
    failContract('autonomous_contract_invalid', `${label} must be an object`);
  }
  return value;
}

export function nonEmpty(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    failContract('autonomous_contract_invalid', `${label} must be a non-empty string`);
  }
  return value.trim();
}

export function assert(condition, code) {
  if (!condition) failContract(code, code.replaceAll('_', ' '));
}

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertSameWorkRef(left, right, code) {
  assert(isRecord(left) && isRecord(right), code);
  for (const key of WORK_REF_KEYS) assert(left[key] === right[key], code);
}

function failContract(code, message) {
  throw new AutonomousDispatchContractError(code, message);
}
