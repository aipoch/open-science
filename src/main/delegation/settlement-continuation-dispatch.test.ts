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
