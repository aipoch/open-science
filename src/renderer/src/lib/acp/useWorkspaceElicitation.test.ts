import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createWorkspaceElicitationRuntime } from './useWorkspaceElicitation'

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
})
