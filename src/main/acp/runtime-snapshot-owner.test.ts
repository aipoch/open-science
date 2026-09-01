import { describe, expect, it } from 'vitest'

import type { ActivePlanProjection } from '../../shared/session-plan/contract'
import { AcpRuntimeSnapshotOwner, type RuntimeSnapshotProjection } from './runtime-snapshot-owner'

const createProjection = (): RuntimeSnapshotProjection => ({
  sessionIds: ['session-1'],
  pendingPermissions: [],
  permissionProfiles: {},
  permissionGrants: {},
  contextUsageBySession: {},
  promptInFlight: false,
  promptInFlightSessionIds: []
})

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
  it('preserves bounded tool terminal metadata in published runtime events', () => {
    const owner = new AcpRuntimeSnapshotOwner('/workspace')

    const event = owner.appendEvent({
      kind: 'tool',
      level: 'info',
      sessionId: 'session-1',
      toolCallId: 'tool-1',
      status: 'completed',
      terminalOutput: 'completed output',
      terminalExitCode: 0
    })

    expect(event).toMatchObject({
      kind: 'tool',
      toolCallId: 'tool-1',
      status: 'completed',
      terminalOutput: 'completed output',
      terminalExitCode: 0
    })
  })

  it('retains the terminal context window in the renderer-visible event', () => {
    const owner = new AcpRuntimeSnapshotOwner('/workspace')
    const terminalContextWindow = {
      termination: { kind: 'stop' as const, stopReason: 'end_turn' as const },
      contextWindow: { used: 31_732, size: 1_000_000 },
      modelStepUsage: { inputTokens: 116, cacheTokens: 31_616, outputTokens: 154 },
      source: 'provider-response' as const
    }

    expect(
      owner.appendEvent({
        kind: 'stop',
        level: 'info',
        sessionId: 'session-1',
        title: 'Prompt stopped',
        text: 'end_turn',
        terminalContextWindow
      })
    ).toMatchObject({ terminalContextWindow })
  })

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

  it('evicts the oldest events beyond the cap while preserving append order', () => {
    const owner = new AcpRuntimeSnapshotOwner('/workspace')
    // Cross the amortized trim threshold (2 × the 500-event cap) at least once.
    const total = 1_200
    for (let index = 0; index < total; index += 1) {
      owner.appendEvent({
        kind: 'message',
        level: 'info',
        role: 'assistant',
        text: `chunk-${index}`
      })
    }

    const events = owner.snapshot(createProjection()).events

    expect(events).toHaveLength(500)
    expect(events.map((event) => event.text)).toEqual(
      Array.from({ length: 500 }, (_, offset) => `chunk-${total - 500 + offset}`)
    )
  })

  it('isolates retained history from later mutation of mutable inputs', () => {
    const owner = new AcpRuntimeSnapshotOwner('/workspace')
    const raw = { nested: { value: 'before' } }

    owner.appendEvent({ kind: 'message', level: 'info', role: 'assistant', text: 'chunk', raw })
    raw.nested.value = 'after'

    expect(owner.snapshot(createProjection()).events[0]?.raw).toEqual({
      nested: { value: 'before' }
    })
  })

  it('retains deeply frozen inputs by reference without weakening snapshot immutability', () => {
    const owner = new AcpRuntimeSnapshotOwner('/workspace')
    const raw = Object.freeze({ nested: Object.freeze({ value: 'frozen' }) })
    const input = Object.freeze({
      kind: 'message' as const,
      level: 'info' as const,
      role: 'assistant' as const,
      text: 'chunk',
      raw
    })

    owner.appendEvent(input)

    const first = owner.snapshot(createProjection())
    expect(first.events[0]).toMatchObject({ text: 'chunk', raw: { nested: { value: 'frozen' } } })
    // Snapshots are private clones: mutating one must not rewrite retained history.
    first.events[0]!.text = 'mutated'
    expect(owner.snapshot(createProjection()).events[0]?.text).toBe('chunk')
  })
})
