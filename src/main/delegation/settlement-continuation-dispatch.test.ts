import { describe, expect, it, vi } from 'vitest'

import {
  createDelegationSettlementContinuationDispatch,
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
  rootBranchRevision: 'root-branch:1',
  runtimeSegmentId: 'root-runtime',
  batchId: 'batch-1',
  items: [{ frameId: 'child-1', attemptId: 'attempt-1', name: 'Child', status: 'completed' }],
  promptId: 'wake-1',
  text: 'settlement update'
}

describe('delegation settlement continuation dispatch', () => {
  it('passes the exact frozen batch as a separate internal admission without creating a user message', async () => {
    const sendAppContinuationObserved = vi.fn(async () => undefined)
    const onPromptEnded = vi.fn(async () => undefined)
    await createDelegationSettlementContinuationDispatch({
      sendAppContinuationObserved,
      onPromptEnded
    })(request)
    expect(sendAppContinuationObserved).toHaveBeenCalledWith(
      expect.objectContaining({ suppressUserMessage: true, text: 'settlement update' }),
      expect.any(Function),
      {
        batchId: 'batch-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        rootFrameId: 'root-frame',
        originatingPromptId: 'root-prompt',
        rootBranchId: 'root-branch',
        rootBranchRevision: 'root-branch:1',
        promptRuntimeSegmentId: 'root-runtime',
        items: [{ frameId: 'child-1', attemptId: 'attempt-1', status: 'completed' }]
      },
      undefined
    )
  })

  it('releases only its flight on a synchronous unknown provider failure', async () => {
    const onPromptEnded = vi.fn(async () => undefined)
    const dispatch = createDelegationSettlementContinuationDispatch({
      sendAppContinuationObserved: () => {
        throw new Error('provider call outcome unknown')
      },
      onPromptEnded
    })
    await expect(dispatch(request)).resolves.toBeUndefined()
    expect(onPromptEnded).toHaveBeenCalledWith('session-1', 'wake-1')
  })

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

  it('does not replay when terminal flight cleanup throws synchronously', async () => {
    const onPromptEnded = vi.fn(() => {
      throw new Error('local cleanup failed synchronously')
    })
    const dispatch = createDelegationSettlementContinuationDispatch({
      sendAppContinuationObserved: async (_request, accepted) => {
        accepted()
      },
      onPromptEnded
    })
    await expect(dispatch(request)).resolves.toBeUndefined()
    expect(onPromptEnded).toHaveBeenCalledOnce()
  })
})
