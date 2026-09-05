// @vitest-environment jsdom

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SESSION_SIZE_LIMIT_ERROR_CODE } from '../../../../shared/session-persistence'

const respondToWorkspaceElicitation = vi.hoisted(() => vi.fn())

vi.mock('./workspace-elicitation-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./workspace-elicitation-runtime')>()),
  respondToWorkspaceElicitation
}))

import {
  createWorkspaceElicitationRuntime,
  useWorkspaceElicitation
} from './useWorkspaceElicitation'

describe('createWorkspaceElicitationRuntime', () => {
  const getState = vi.fn(async () => ({ sessionIds: [] }))
  const resumeSession = vi.fn(async () => ({ sessionId: 'session-1' }))
  const resetSessionContext = vi.fn(async () => ({ sessionId: 'session-1' }))

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('window', {
      api: {
        acp: {
          getState,
          resumeSession,
          resetSessionContext,
          respondToElicitation: vi.fn()
        }
      }
    })
  })

  afterEach(cleanup)

  it('forwards a disabled conversation Memory preference through resume and reset', async () => {
    const runtime = await createWorkspaceElicitationRuntime()

    await runtime.resumeSession(
      'session-1',
      '/workspace',
      'project-1',
      'ask',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false
    )
    await runtime.resetSessionContext?.('session-1', '/workspace', 'project-1', 'ask', false)

    expect(resumeSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1', memoryEnabled: false })
    )
    expect(resetSessionContext).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1', memoryEnabled: false })
    )
  })

  it('reports an elicitation response size limit for the affected Session', async () => {
    const error = Object.assign(new Error('Session exceeds the persistence limit.'), {
      code: SESSION_SIZE_LIMIT_ERROR_CODE
    })
    respondToWorkspaceElicitation.mockRejectedValue(error)
    const onSessionSizeLimit = vi.fn()
    const { result } = renderHook(() => useWorkspaceElicitation(vi.fn(), onSessionSizeLimit))

    await expect(
      result.current.respondToElicitation({
        requestId: 'question-1',
        action: 'decline',
        request: {
          requestId: 'question-1',
          sessionId: 'session-1',
          toolCallId: 'tool-1',
          message: 'Choose an approach',
          fields: []
        }
      })
    ).rejects.toBe(error)

    expect(onSessionSizeLimit).toHaveBeenCalledWith('session-1')
  })
})
