import {
  array,
  assert,
  isRecord,
  nonEmpty,
  record,
} from './autonomousDispatchContractChecks.mjs';

const EVIDENCE_TYPES = new Set([
  'artifact',
  'action_receipt',
  'measured_verdict',
  'judged_verdict',
  'observation',
  'outcome_event',
  'human_intervention',
]);
const INDEPENDENCE_RANK = {
  separate_run: 1,
  separate_model: 2,
  separate_authority: 3,
};
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SIGNATURE_PATTERN = /^hmac-sha256:[a-f0-9]{64}$/;

/**
 * Compile the terminal gate from the already content-verified mission, work
 * node, and quality bar. A driver cannot replace these requirements with a
 * prose assertion at the end of a turn.
 */
export function compileAutonomousTerminalPolicy({ mission, node, qualityBar }) {
  const completion = record(
    mission.completionPolicy,
    'mission_contract.completionPolicy'
  );
  const missionEvidence = evidenceTypes(
    completion.requiredEvidenceTypes,
    'mission_contract.completionPolicy.requiredEvidenceTypes'
  );
  const nodeEvidence = evidenceTypes(
    node.requiredEvidenceTypes,
    'work_node.requiredEvidenceTypes'
  );
  assert(nodeEvidence.length > 0, 'work_node_required_evidence_empty');
  assert(
    nodeEvidence.every((type) => missionEvidence.includes(type)),
    'work_node_evidence_not_bound_to_mission'
  );

  const minimumOutcomeConfidence = boundedNumber(
    completion.minimumOutcomeConfidence,
    'mission_contract.completionPolicy.minimumOutcomeConfidence'
  );
  const verifierIndependence = nonEmpty(
    completion.verifierIndependence,
    'mission_contract.completionPolicy.verifierIndependence'
  );
  assert(
    Object.hasOwn(INDEPENDENCE_RANK, verifierIndependence),
    'mission_verifier_independence_invalid'
  );
  assert(
    typeof completion.allowOutcomePending === 'boolean',
    'mission_outcome_pending_policy_invalid'
  );

  const measuredCriteria = array(
    qualityBar.measuredCriteria,
    'quality_bar.measuredCriteria'
  );
  const judgedCriteria = array(
    qualityBar.judgedCriteria,
    'quality_bar.judgedCriteria'
  );
  assert(measuredCriteria.length > 0, 'quality_bar_measured_criteria_empty');
  assert(judgedCriteria.length > 0, 'quality_bar_judged_criteria_empty');
  assert(
    measuredCriteria.every(validCriterion) && judgedCriteria.every(validCriterion),
    'quality_bar_criterion_invalid'
  );
  assert(
    measuredCriteria.some((criterion) => criterion.blocking === true),
    'quality_bar_blocking_measured_criterion_missing'
  );
  assert(
    judgedCriteria.some((criterion) => criterion.blocking === true),
    'quality_bar_blocking_judged_criterion_missing'
  );

  const shipThreshold = record(
    qualityBar.shipThreshold,
    'quality_bar.shipThreshold'
  );
  const minimumJudgedScore = boundedNumber(
    shipThreshold.minimumJudgedScore,
    'quality_bar.shipThreshold.minimumJudgedScore'
  );
  const minimumVerdictConfidence = boundedNumber(
    shipThreshold.minimumVerdictConfidence,
    'quality_bar.shipThreshold.minimumVerdictConfidence'
  );
  assert(
    Number.isInteger(shipThreshold.criticalObservationsAllowed) &&
      shipThreshold.criticalObservationsAllowed >= 0,
    'quality_bar_critical_observation_threshold_invalid'
  );

  return {
    requiredEvidenceTypes: uniqueSorted([
      ...missionEvidence,
      ...nodeEvidence,
      'measured_verdict',
      'judged_verdict',
    ]),
    minimumOutcomeConfidence,
    verifierIndependence,
    allowOutcomePending: completion.allowOutcomePending,
    shipThreshold: {
      minimumJudgedScore,
      minimumVerdictConfidence,
      criticalObservationsAllowed: shipThreshold.criticalObservationsAllowed,
    },
  };
}

/**
 * Fail-closed terminal evidence ledger for autonomous V1 execution.
 *
 * Built-in Codex events can establish that a concrete file/tool action
 * occurred. They cannot manufacture an independent verifier. A verifier step
 * is accepted only when trusted peer code marks an authenticated OrgX proof
 * source; the built-in Codex event adapters never derive this from assistant
 * prose or tool output.
 */
export class AutonomousTerminalEvidenceValidator {
  constructor(authority, input = {}) {
    this.policy = authority.terminalPolicy;
    this.nativePolicy = authority.nativePolicy;
    this.agentId = authority.context.specialist.agent_id;
    this.runId = input.runId;
    this.verifyVerifier = input.verifyVerifier;
    this.evidence = new Map();
    this.verifiers = [];
  }

  observe(message) {
    if (message?.kind !== 'task.step' || !isRecord(message.step)) return;
    const step = message.step;
    const completed = step.status === 'completed';
    const evidenceRef = cleanString(step.evidence_ref);
    if (completed && evidenceRef && step.kind === 'file_edit') {
      this.addEvidence('artifact', evidenceRef);
    }
    if (completed && evidenceRef && step.kind === 'tool_call') {
      this.addEvidence('action_receipt', evidenceRef);
    }
    if (
      completed &&
      evidenceRef &&
      typeof step.evidence_type === 'string' &&
      EVIDENCE_TYPES.has(step.evidence_type)
    ) {
      this.addEvidence(step.evidence_type, evidenceRef);
    }

    const verifier = completed
      ? trustedVerifier(step.verifier, {
          runId: this.runId,
          agentId: this.agentId,
          verifyVerifier: this.verifyVerifier,
        })
      : null;
    if (!verifier) return;
    this.verifiers.push(verifier);
    for (const type of verifier.evidence_types) {
      this.addEvidence(type, verifier.proof_ref);
    }
  }

  evaluate(candidate) {
    if (candidate?.outcome_kind !== 'shipped') {
      return {
        outcomeKind: candidate?.outcome_kind ?? 'blocked',
        code: 'terminal_candidate_not_shipped',
        detail: 'The driver did not claim a shipped outcome.',
      };
    }

    const required = this.policy.requiredEvidenceTypes;
    const missingEvidence = required.filter((type) => !this.evidence.has(type));
    const missingConcrete = missingEvidence.filter((type) =>
      type === 'artifact' || type === 'action_receipt'
    );
    if (
      this.nativePolicy.mode === 'read_only' &&
      required.includes('artifact')
    ) {
      return held(
        'blocked',
        'read_only_artifact_requirement_unsatisfied',
        'The signed mission requires an artifact, but this run was constrained to read-only execution.'
      );
    }
    if (missingConcrete.length > 0) {
      return held(
        'blocked',
        'required_execution_evidence_missing',
        `Missing signed required evidence: ${missingConcrete.join(', ')}.`
      );
    }

    if (missingEvidence.length > 0 || this.verifiers.length === 0) {
      return held(
        this.policy.allowOutcomePending ? 'awaiting_review' : 'blocked',
        'independent_verification_pending',
        `Completion requires ${required.join(', ')} plus an independent verifier meeting the signed quality thresholds.`
      );
    }
    const passingVerifier = this.verifiers.find((verifier) =>
      verifierPasses(verifier, this.policy)
    );
    if (!passingVerifier) {
      return held(
        'blocked',
        'quality_bar_not_met',
        'Verifier evidence was present but did not meet the signed independence, score, confidence, or critical-observation threshold.'
      );
    }

    return held(
      'shipped',
      'terminal_evidence_accepted',
      `Verified by ${passingVerifier.actor_id} with proof ${passingVerifier.proof_ref}.`
    );
  }

  addEvidence(type, ref) {
    const refs = this.evidence.get(type) ?? new Set();
    refs.add(ref);
    this.evidence.set(type, refs);
  }
}

export function terminalGateStep(runId, decision) {
  return {
    kind: 'task.step',
    run_id: runId,
    step: {
      kind: 'skill_fire',
      summary: `autonomous terminal gate: ${decision.code} - ${decision.detail}`,
      evidence_ref: `orgx-terminal-gate:${decision.code}`,
      confidence: decision.outcomeKind === 'shipped' ? 1 : 0,
    },
  };
}

function trustedVerifier(value, input) {
  if (!isRecord(value) || value.source !== 'orgx_control_plane') return null;
  const actorId = cleanString(value.actor_id);
  const verifierRunId = cleanString(value.run_id);
  const proofRef = cleanString(value.proof_ref);
  const independence = cleanString(value.independence);
  const evidence = Array.isArray(value.evidence_types)
    ? uniqueSorted(
        value.evidence_types.filter(
          (type) => typeof type === 'string' && EVIDENCE_TYPES.has(type)
        )
      )
    : [];
  if (
    !actorId ||
    !verifierRunId ||
    verifierRunId === input.runId ||
    !proofRef ||
    !DIGEST_PATTERN.test(String(value.proof_digest ?? '')) ||
    !SIGNATURE_PATTERN.test(String(value.signature ?? '')) ||
    !Object.hasOwn(INDEPENDENCE_RANK, independence) ||
    typeof value.passed !== 'boolean' ||
    !isBoundedNumber(value.judged_score) ||
    !isBoundedNumber(value.confidence) ||
    !isBoundedNumber(value.outcome_confidence) ||
    !Number.isInteger(value.critical_observations) ||
    value.critical_observations < 0
  ) {
    return null;
  }
  if (independence === 'separate_authority' && actorId === input.agentId) {
    return null;
  }
  const verifier = {
    source: value.source,
    actor_id: actorId,
    run_id: verifierRunId,
    proof_ref: proofRef,
    proof_digest: value.proof_digest,
    signature: value.signature,
    independence,
    evidence_types: evidence,
    passed: value.passed,
    judged_score: value.judged_score,
    confidence: value.confidence,
    outcome_confidence: value.outcome_confidence,
    critical_observations: value.critical_observations,
  };
  // A source label and signature-shaped string are not authentication. Only
  // runner-owned code may validate this record (for example against an OrgX
  // control-plane signing key). Production has no permissive default.
  if (typeof input.verifyVerifier !== 'function') return null;
  try {
    if (input.verifyVerifier(verifier, input) !== true) return null;
  } catch {
    return null;
  }
  return verifier;
}

function verifierPasses(verifier, policy) {
  return (
    verifier.passed === true &&
    INDEPENDENCE_RANK[verifier.independence] >=
      INDEPENDENCE_RANK[policy.verifierIndependence] &&
    verifier.judged_score >= policy.shipThreshold.minimumJudgedScore &&
    verifier.confidence >= policy.shipThreshold.minimumVerdictConfidence &&
    verifier.outcome_confidence >= policy.minimumOutcomeConfidence &&
    verifier.critical_observations <=
      policy.shipThreshold.criticalObservationsAllowed
  );
}

function evidenceTypes(value, label) {
  const types = array(value, label);
  assert(types.length > 0, 'required_evidence_types_empty');
  assert(
    types.every((type) => typeof type === 'string' && EVIDENCE_TYPES.has(type)),
    'required_evidence_type_invalid'
  );
  assert(new Set(types).size === types.length, 'required_evidence_types_duplicate');
  return [...types].sort();
}

function validCriterion(value) {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.trim().length > 0 &&
    typeof value.blocking === 'boolean'
  );
}

function boundedNumber(value, label) {
  assert(isBoundedNumber(value), `${label}_invalid`);
  return value;
}

function isBoundedNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function held(outcomeKind, code, detail) {
  return { outcomeKind, code, detail };
}
