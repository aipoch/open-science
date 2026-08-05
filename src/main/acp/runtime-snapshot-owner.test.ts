import { describe, expect, it } from 'vitest'

import type { ActivePlanProjection } from '../../shared/session-plan/contract'
import { AcpRuntimeSnapshotOwner } from './runtime-snapshot-owner'

const planProjection: ActivePlanProjection = {
  artifactId: 'artifact-1',
  artifactVersionId: 'version-1',
  artifactChecksum: 'a'.repeat(64),
  revision: 1,
  approval: 'pending',
  lifecycle: 'awaiting_approval',
  requiresExplicitContinuation: false,
  document: {
    schema_version: 1,
    task_summary: 'Review the proposed changes',
    phases: [],
    desired_outputs: [],
    feasibility: { confidence: 'high', rationale: 'The task is ready.' }
  },
  stepStatuses: {},
  stepStates: {},
  counts: { phases: 0, delegations: 0, steps: 0, completed: 0, inProgress: 0 }
}

describe('AcpRuntimeSnapshotOwner', () => {
  it('retains a Plan projection in the renderer-visible event snapshot', () => {
    const owner = new AcpRuntimeSnapshotOwner('/workspace')

    owner.appendEvent({
      kind: 'plan',
      level: 'info',
      sessionId: 'session-1',
      title: 'Session Plan updated',
      planProjection
    })

    const snapshot = owner.snapshot({
      sessionIds: ['session-1'],
      pendingPermissions: [],
      permissionProfiles: {},
      permissionGrants: {},
      contextUsageBySession: {},
      promptInFlight: true,
      promptInFlightSessionIds: ['session-1']
    })

    expect(snapshot.events).toEqual([
      expect.objectContaining({
        kind: 'plan',
        sessionId: 'session-1',
        planProjection
      })
    ])
  })
})
