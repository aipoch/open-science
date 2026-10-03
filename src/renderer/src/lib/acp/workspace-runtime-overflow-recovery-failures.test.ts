import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AcpStateSnapshot } from '../../../../shared/acp'
import { resetSessionConversationIntentsForTests } from '../../stores/session-conversation-intents'
import { createInitialSessionState, useSessionStore } from '../../stores/session-store'
import { recoverContextOverflowWorkspaceSession } from './workspace-runtime-session-lifecycle-owner'

const SESSION_ID = 'overflow-session'

const seed = (activeRun: boolean): void => {
  const store = useSessionStore.getState()
  store.appendUserMessage({
    sessionId: SESSION_ID,
    content: 'first question',
    cwd: '/workspace',
    projectId: 'project',
    permissionProfile: 'ask'
  })
  store.finishRun(SESSION_ID)
  store.appendUserMessage({
    sessionId: SESSION_ID,
    content: 'overflowing question',
    cwd: '/workspace',
    projectId: 'project',
    permissionProfile: 'ask'
  })
  if (!activeRun) store.failRun(SESSION_ID, 'Request too large (max 32MB)')
  resetSessionConversationIntentsForTests()
}

const runtime = (
  resetSessionContext: () => Promise<never>
): Parameters<typeof recoverContextOverflowWorkspaceSession>[0] =>
  ({
    state: {
      status: 'connected',
      cwd: '/workspace',
      sessionIds: [SESSION_ID],
      events: [],
      pendingPermissions: [],
      permissionProfiles: {},
      permissionGrants: {},
      contextUsageBySession: {},
      promptInFlight: false,
      promptInFlightSessionIds: []
    } as unknown as AcpStateSnapshot,
    createSession: vi.fn(),
    resumeSession: vi.fn(),
    resetSessionContext,
    sendPrompt: vi.fn()
  }) as never

describe('context overflow recovery failure handling', () => {
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason)
  }
  beforeEach(() => {
    unhandled.length = 0
    process.on('unhandledRejection', onUnhandled)
    resetSessionConversationIntentsForTests()
    useSessionStore.setState(createInitialSessionState())
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => {
    process.off('unhandledRejection', onUnhandled)
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('reports a failed Main authority read instead of swallowing it', async () => {
    seed(true)
    const reportRendererFailure = vi.fn()
    vi.stubGlobal('window', {
      api: {
        diagnostics: { reportRendererFailure },
        sessions: {
          loadOne: async () => {
            throw new Error('Session read unavailable')
          }
        }
      }
    })
    expect(
      await recoverContextOverflowWorkspaceSession(
        runtime(async () => {
          throw new Error('unused')
        }),
        SESSION_ID
      )
    ).toBe(false)
    expect(reportRendererFailure).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'handled-error', context: 'session-load' })
    )
    expect(useSessionStore.getState().sessions[0].compacting).not.toBe(true)
  })

  it('contains a reset failure followed by a failed authority refresh without an unhandled rejection', async () => {
    seed(false)
    const reportRendererFailure = vi.fn()
    vi.stubGlobal('window', {
      api: {
        diagnostics: { reportRendererFailure },
        sessions: {
          loadOne: async () => {
            throw new Error('Session read unavailable')
          }
        }
      }
    })
    const recovery = runtime(async () => {
      throw new Error('Provider reset failed')
    })
    await expect(recoverContextOverflowWorkspaceSession(recovery, SESSION_ID)).resolves.toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(unhandled).toEqual([])
    expect(reportRendererFailure).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'handled-error', context: 'session-load' })
    )
    expect(useSessionStore.getState().sessions[0].compacting).not.toBe(true)
  })
})
