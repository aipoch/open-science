import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createDelegationSettlementContinuationDispatch,
  type SettlementContinuationDispatchOptions
} from './settlement-continuation-dispatch'
import type { DelegationSettlementDispatch } from './delegation-settlement-wake-owner'
import { DelegateMessagePreAcceptanceError } from './execution-port'
import { SettlementAdmissionError } from '../../shared/runtime-session-admission'

const diagnostics = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }))
vi.mock('../logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../logger')>()),
  createLogger: () => diagnostics
}))

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
  beforeEach(() => vi.clearAllMocks())

  it.each(['settlement', 'preparation'])(
    'keeps retry diagnostics actionable without retaining private error details: %s',
    async (boundary) => {
      const cause = Object.assign(new Error('private provider payload'), {
        code: 'EACCES',
        path: '/private/research'
      })
      const failure =
        boundary === 'settlement'
          ? new SettlementAdmissionError('pre-provider-failure', 'retry', cause)
          : new DelegateMessagePreAcceptanceError('Continuation preparation failed', cause)
      const onPromptEnded = vi.fn()
      const dispatch = createDelegationSettlementContinuationDispatch({
        sendAppContinuationObserved: async () => {
          throw failure
        },
        onPromptEnded
      })
      await expect(dispatch(request)).rejects.toBe(failure)
      expect(onPromptEnded).not.toHaveBeenCalled()
      expect(diagnostics.warn).toHaveBeenCalledWith(
        'Settlement admission rejected',
        expect.objectContaining({ errorCategory: 'permission', batchId: request.batchId })
      )
      expect(JSON.stringify(diagnostics.warn.mock.calls)).not.toMatch(/private|research/)
    }
  )

  it.each(['deferred', 'invalidated'] as const)(
    'keeps expected %s outcomes informational',
    async (disposition) => {
      const failure = new SettlementAdmissionError('origin-path-changed', disposition)
      const onPromptEnded = vi.fn()
      const dispatch = createDelegationSettlementContinuationDispatch({
        sendAppContinuationObserved: async () => {
          throw failure
        },
        onPromptEnded
      })
      if (disposition === 'deferred') {
        await expect(dispatch(request)).rejects.toBe(failure)
        expect(onPromptEnded).not.toHaveBeenCalled()
      } else {
        await expect(dispatch(request)).resolves.toBeUndefined()
        expect(onPromptEnded).toHaveBeenCalledOnce()
      }
      expect(diagnostics.warn).not.toHaveBeenCalled()
      expect(diagnostics.info).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ disposition })
      )
    }
  )

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
    expect(diagnostics.warn).toHaveBeenCalledWith(
      'Settlement provider execution failed',
      expect.objectContaining({ providerAccepted: false })
    )
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
    expect(diagnostics.warn).toHaveBeenCalledWith(
      'Settlement provider execution failed',
      expect.objectContaining({ providerAccepted: false })
    )
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
    expect(diagnostics.warn).toHaveBeenCalledWith(
      'Settlement provider execution failed',
      expect.objectContaining({ providerAccepted: true })
    )
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
    expect(diagnostics.warn).toHaveBeenCalledWith(
      'Settlement terminal cleanup failed',
      expect.objectContaining({ batchId: request.batchId })
    )
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
