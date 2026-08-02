import { describe, expect, it } from 'vitest'

import type { HandoffLifecycleEvent } from '../../../../shared/handoff-lifecycle'

import { projectHandoffLifecycle } from './handoff-lifecycle-projection'

const event = (overrides: Partial<HandoffLifecycleEvent> = {}): HandoffLifecycleEvent => ({
  id: 'handoff-1-awaiting',
  sessionId: 'session-1',
  sequence: 1,
  observedAt: 1_710_000_000_000,
  phase: 'awaiting-approval',
  target: { kind: 'specialist', name: 'Data analyst' },
  provenance: {
    originatingTurnId: 'turn-1',
    originatingUserMessageId: 'user-1',
    attachmentIds: ['upload-1'],
    artifactIds: ['artifact-1']
  },
  ...overrides
})

describe('handoff lifecycle transcript projection', () => {
  it('keeps the latest lifecycle state under the original user turn with sanitized continuation context', () => {
    const projection = projectHandoffLifecycle([
      event(),
      event({
        id: 'handoff-1-switching',
        sequence: 2,
        phase: 'switching',
        observedAt: 1_710_000_000_100
      }),
      event({
        id: 'handoff-1-continued',
        sequence: 3,
        phase: 'continued',
        observedAt: 1_710_000_000_200,
        continuation: {
          outcome: 'returned',
          switchReadback: { target: { kind: 'specialist', name: 'Data analyst' } }
        }
      })
    ])

    expect(projection).toEqual([
      {
        id: 'handoff:session-1:turn-1',
        sessionId: 'session-1',
        originatingTurnId: 'turn-1',
        originatingUserMessageId: 'user-1',
        timelineAt: 1_710_000_000_000,
        phase: 'continued',
        target: { kind: 'specialist', name: 'Data analyst' },
        provenance: {
          attachmentIds: ['upload-1'],
          artifactIds: ['artifact-1']
        },
        continuation: {
          outcome: 'returned',
          switchReadback: { target: { kind: 'specialist', name: 'Data analyst' } }
        }
      }
    ])
  })

  it('uses coordinator sequence to ignore a delayed lifecycle broadcast', () => {
    const projection = projectHandoffLifecycle([
      event({ id: 'continued', sequence: 4, phase: 'continued' }),
      event({ id: 'reconfiguring', sequence: 3, phase: 'reconfiguring' })
    ])

    expect(projection).toHaveLength(1)
    expect(projection[0]).toMatchObject({ phase: 'continued', id: 'handoff:session-1:turn-1' })
  })
})
