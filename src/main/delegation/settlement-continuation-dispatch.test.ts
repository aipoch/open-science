import { describe, expect, it, vi } from 'vitest'
import { materializeSessionConversationGraph } from '../../shared/session-persistence'

import {
  createDelegationSettlementContinuationDispatch,
  admitDelegationSettlement,
  type SettlementContinuationDispatchOptions
} from './settlement-continuation-dispatch'
import type { DelegationSettlementDispatch } from './delegation-settlement-wake-owner'
import { DelegateMessagePreAcceptanceError } from './execution-port'

const request: DelegationSettlementDispatch = {
  projectId: 'project-1',
  sessionId: 'session-1',
  originatingPromptId: 'root-prompt',
  rootFrameId: 'root-frame',
  rootBranchId: 'root-branch',
  runtimeSegmentId: 'root-runtime',
  promptId: 'wake-1',
  text: 'settlement update'
}

describe('delegation settlement continuation dispatch', () => {
  it('reports a rejection before provider acceptance so the settlement batch can retry', async () => {
    const failure = new DelegateMessagePreAcceptanceError('runtime unavailable')
    const sendAppContinuationObserved = vi.fn(async () => {
      throw failure
    })
    const onPromptEnded = vi.fn(async () => undefined)
    const dispatch = createDelegationSettlementContinuationDispatch({
      sendAppContinuationObserved,
      onPromptEnded
    })

    await expect(dispatch(request)).rejects.toBe(failure)
    expect(onPromptEnded).not.toHaveBeenCalled()
  })

  it('ends the flight without retrying an unconfirmed provider rejection', async () => {
    const sendAppContinuationObserved = vi.fn(async () => {
      throw new Error('provider outcome is unknown')
    })
    const onPromptEnded = vi.fn(async () => undefined)
    const dispatch = createDelegationSettlementContinuationDispatch({
      sendAppContinuationObserved,
      onPromptEnded
    })

    await expect(dispatch(request)).resolves.toBeUndefined()
    expect(onPromptEnded).toHaveBeenCalledOnce()
  })

  it('ends the single flight without retrying when an accepted provider prompt later rejects', async () => {
    const failure = new Error('provider turn failed')
    const sendAppContinuationObserved: SettlementContinuationDispatchOptions['sendAppContinuationObserved'] =
      vi.fn(async (_request, onProviderPromptAccepted) => {
        onProviderPromptAccepted()
        throw failure
      })
    const onPromptEnded = vi.fn(async () => undefined)
    const dispatch = createDelegationSettlementContinuationDispatch({
      sendAppContinuationObserved,
      onPromptEnded
    })

    await expect(dispatch(request)).resolves.toBeUndefined()
    expect(onPromptEnded).toHaveBeenCalledOnce()
    expect(onPromptEnded).toHaveBeenCalledWith('session-1', 'wake-1')
  })

  it('does not turn terminal flight-cleanup failure into a continuation retry', async () => {
    const sendAppContinuationObserved = vi.fn(
      async (_request, onProviderPromptAccepted: () => void) => {
        onProviderPromptAccepted()
      }
    )
    const onPromptEnded = vi.fn(async () => {
      throw new Error('local cleanup failed')
    })
    const dispatch = createDelegationSettlementContinuationDispatch({
      sendAppContinuationObserved,
      onPromptEnded
    })

    await expect(dispatch(request)).resolves.toBeUndefined()
    expect(onPromptEnded).toHaveBeenCalledOnce()
  })
})

describe('settlement turn admission', () => {
  it('re-arms an idle root turn without adding a user message and rejects changed ownership', () => {
    const session = materializeSessionConversationGraph({
      id: request.sessionId,
      projectId: request.projectId,
      title: 'Delegate',
      cwd: '/workspace',
      status: 'idle',
      createdAt: 1,
      updatedAt: 2,
      messages: [
        {
          id: request.originatingPromptId,
          role: 'user',
          content: 'Research',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 2
        }
      ],
      runtimeTranscriptLastRun: { promptMessageId: request.originatingPromptId, startedAt: 10 }
    })
    const graph = session.conversationGraph!
    const selected = {
      ...request,
      rootFrameId: graph.rootFrameId,
      rootBranchId: graph.frames[0].activeBranchId,
      runtimeSegmentId: graph.messages[0].runtimeSegmentId!
    }
    const admitted = admitDelegationSettlement(session, selected, 5)
    expect(admitted.activeRun).toEqual({
      promptMessageId: request.originatingPromptId,
      startedAt: 11
    })
    expect(admitted.messages).toBe(session.messages)
    expect(admitted.conversationGraph).toBe(graph)
    expect(() =>
      admitDelegationSettlement(
        { ...session, activeRun: { promptMessageId: 'new-user-turn', startedAt: 20 } },
        selected
      )
    ).toThrow('idle active root turn')
    expect(() =>
      admitDelegationSettlement(
        {
          ...session,
          promptPreparation: {
            id: 'preparing',
            sessionId: session.id,
            projectId: session.projectId,
            promptMessageId: 'next-user-turn',
            mode: 'new',
            preparedAt: 20,
            previousState: { status: 'idle' },
            expectedState: { status: 'idle' }
          }
        },
        selected
      )
    ).toThrow('idle active root turn')
    expect(() =>
      admitDelegationSettlement(session, { ...selected, rootBranchId: 'another-branch' })
    ).toThrow('idle active root turn')
    expect(() =>
      admitDelegationSettlement(session, { ...selected, runtimeSegmentId: 'another-segment' })
    ).toThrow('idle active root turn')
  })
})
