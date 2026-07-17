import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  AutonomousTerminalEvidenceValidator,
  compileAutonomousTerminalPolicy,
} from './autonomousTerminalEvidence.mjs';

const RUN_ID = 'producer-run';

describe('autonomous terminal evidence gate', () => {
  it('compiles required evidence and verifier thresholds from signed contracts', () => {
    const policy = compileAutonomousTerminalPolicy(contracts());

    assert.deepEqual(policy, {
      requiredEvidenceTypes: [
        'action_receipt',
        'artifact',
        'judged_verdict',
        'measured_verdict',
      ],
      minimumOutcomeConfidence: 0.8,
      verifierIndependence: 'separate_model',
      allowOutcomePending: true,
      shipThreshold: {
        minimumJudgedScore: 0.8,
        minimumVerdictConfidence: 0.8,
        criticalObservationsAllowed: 0,
      },
    });
  });

  it('blocks an empty or prose-only run instead of forging shipped', () => {
    const validator = new AutonomousTerminalEvidenceValidator(authority(), {
      runId: RUN_ID,
    });

    const decision = validator.evaluate({ outcome_kind: 'shipped' });
    assert.equal(decision.outcomeKind, 'blocked');
    assert.equal(decision.code, 'required_execution_evidence_missing');
  });

  it('holds concrete work as awaiting review when independent proof is absent', () => {
    const validator = validatorWithConcreteWork();

    const decision = validator.evaluate({ outcome_kind: 'shipped' });
    assert.equal(decision.outcomeKind, 'awaiting_review');
    assert.equal(decision.code, 'independent_verification_pending');
  });

  it('does not count failed file or tool events as terminal evidence', () => {
    const validator = new AutonomousTerminalEvidenceValidator(authority(), {
      runId: RUN_ID,
    });
    for (const kind of ['file_edit', 'tool_call']) {
      validator.observe({
        kind: 'task.step',
        step: {
          kind,
          status: 'failed',
          evidence_ref: `failed:${kind}`,
        },
      });
    }

    const decision = validator.evaluate({ outcome_kind: 'shipped' });
    assert.equal(decision.outcomeKind, 'blocked');
    assert.equal(decision.code, 'required_execution_evidence_missing');
  });

  it('blocks a read-only run whose signed mission requires an artifact', () => {
    const validator = validatorWithConcreteWork('read_only');
    validator.observe(verifierStep());

    const decision = validator.evaluate({ outcome_kind: 'shipped' });
    assert.equal(decision.outcomeKind, 'blocked');
    assert.equal(decision.code, 'read_only_artifact_requirement_unsatisfied');
  });

  it('blocks verifier evidence below the signed quality threshold', () => {
    const validator = validatorWithConcreteWork('workspace_write', {
      verifyVerifier: () => true,
    });
    validator.observe(
      verifierStep({ judged_score: 0.79, confidence: 0.79 })
    );

    const decision = validator.evaluate({ outcome_kind: 'shipped' });
    assert.equal(decision.outcomeKind, 'blocked');
    assert.equal(decision.code, 'quality_bar_not_met');
  });

  it('rejects a forged signature-shaped verifier without runner trust', () => {
    const validator = validatorWithConcreteWork();
    validator.observe(verifierStep());

    const decision = validator.evaluate({ outcome_kind: 'shipped' });
    assert.equal(decision.outcomeKind, 'awaiting_review');
    assert.equal(decision.code, 'independent_verification_pending');
  });

  it('allows shipped only with every required type and a qualified verifier', () => {
    let verifiedRecord;
    const validator = validatorWithConcreteWork('workspace_write', {
      verifyVerifier: (record) => {
        verifiedRecord = record;
        return record.proof_ref === 'proof:verifier-1';
      },
    });
    validator.observe(verifierStep());

    const decision = validator.evaluate({ outcome_kind: 'shipped' });
    assert.equal(decision.outcomeKind, 'shipped');
    assert.equal(decision.code, 'terminal_evidence_accepted');
    assert.equal(verifiedRecord.source, 'orgx_control_plane');
  });
});

function validatorWithConcreteWork(mode = 'workspace_write', input = {}) {
  const validator = new AutonomousTerminalEvidenceValidator(authority(mode), {
    runId: RUN_ID,
    ...input,
  });
  validator.observe({
    kind: 'task.step',
    step: {
      kind: 'file_edit',
      status: 'completed',
      evidence_ref: 'artifact:src/runtime.ts',
    },
  });
  validator.observe({
    kind: 'task.step',
    step: {
      kind: 'tool_call',
      status: 'completed',
      evidence_ref: 'action:test-run-1',
    },
  });
  return validator;
}

function verifierStep(overrides = {}) {
  return {
    kind: 'task.step',
    step: {
      kind: 'skill_fire',
      status: 'completed',
      evidence_ref: 'proof:verifier-1',
      verifier: {
        source: 'orgx_control_plane',
        actor_id: 'independent-verifier',
        run_id: 'verifier-run',
        proof_ref: 'proof:verifier-1',
        proof_digest: `sha256:${'b'.repeat(64)}`,
        signature: `hmac-sha256:${'c'.repeat(64)}`,
        independence: 'separate_model',
        evidence_types: ['measured_verdict', 'judged_verdict'],
        passed: true,
        judged_score: 0.9,
        confidence: 0.9,
        outcome_confidence: 0.9,
        critical_observations: 0,
        ...overrides,
      },
    },
  };
}

function authority(mode = 'workspace_write') {
  return {
    terminalPolicy: compileAutonomousTerminalPolicy(contracts()),
    nativePolicy: { mode },
    context: { specialist: { agent_id: 'engineering-agent' } },
  };
}

function contracts() {
  return {
    mission: {
      completionPolicy: {
        requiredEvidenceTypes: ['artifact', 'action_receipt'],
        minimumOutcomeConfidence: 0.8,
        verifierIndependence: 'separate_model',
        allowOutcomePending: true,
      },
    },
    node: {
      requiredEvidenceTypes: ['artifact', 'action_receipt'],
    },
    qualityBar: {
      measuredCriteria: [{ id: 'contract-binding', blocking: true }],
      judgedCriteria: [{ id: 'task-outcome', blocking: true }],
      shipThreshold: {
        minimumJudgedScore: 0.8,
        minimumVerdictConfidence: 0.8,
        criticalObservationsAllowed: 0,
      },
    },
  };
}
