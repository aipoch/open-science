import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AcpRuntimeState } from '../../../../shared/acp'
import type { PersistedChatSession } from '../../../../shared/session-persistence'
import {
  createInitialSessionState,
  projectSessionActionability,
  useSessionStore,
  type ChatSession
} from '../../stores/session-store'
import {
  loadPersistedSession,
  resetSessionContentCacheForTests
} from '../session-persistence/session-persistence'
import { useDesktopRuntimeRecoveryStore } from '../../stores/desktop-runtime-recovery-store'
import { resetSessionConversationIntentsForTests } from '../../stores/session-conversation-intents'
import { cancelWorkspaceRun } from './workspace-runtime-session-lifecycle-owner'
import {
  acceptAcpRuntimeSnapshotRevision,
  resetAcpRuntimeSnapshotRevisionForTests
} from './runtime-snapshot-revision-owner'

const durable = (): PersistedChatSession => ({
  id: 'session-1',
  projectId: 'project-1',
  title: 'Recovery',
  cwd: '/workspace',
  status: 'idle',
  revision: 4,
  createdAt: 1,
  updatedAt: 2,
  messages: []
})
const snapshot = (): AcpRuntimeState => ({
  revision: 10,
  status: 'connected',
  cwd: '/workspace',
  sessionIds: ['session-1'],
  pendingPermissions: [],
  pendingElicitations: [],
  permissionProfiles: {},
  permissionGrants: {},
  contextUsageBySession: {},
  promptInFlight: false,
  promptInFlightSessionIds: [],
  agentPromptInFlightSessionIds: []
})
const current = (): ChatSession => useSessionStore.getState().sessions[0]
const seed = (status: 'waiting-permission' | 'waiting-for-user'): void => {
  useSessionStore.getState().hydrateSessions([{ ...durable(), status }])
}

// The store, cancellation owner, and authority projection are real; only native IPC is replaced.
describe('Stop recovery from a status-only wait', () => {
  beforeEach(() => {
    useSessionStore.setState(createInitialSessionState())
    resetSessionContentCacheForTests()
    resetSessionConversationIntentsForTests()
    resetAcpRuntimeSnapshotRevisionForTests()
    vi.stubGlobal('window', { api: { sessions: { loadOne: async () => durable() } } })
  })
  afterEach(() => vi.unstubAllGlobals())

  it.each(['waiting-permission', 'waiting-for-user'] as const)(
    'restores sending after cancelling an orphaned %s',
    async (status) => {
      seed(status)
      await cancelWorkspaceRun({ cancel: async () => snapshot() }, 'session-1')
      expect(current().status).toBe('idle')
      expect(projectSessionActionability(current()).actions.startTurn.allowed).toBe(true)
    }
  )

  it.each(['permission', 'elicitation', 'prompt'] as const)(
    'retains the wait while the runtime still owns a %s',
    async (kind) => {
      seed('waiting-permission')
      const state = snapshot()
      if (kind === 'permission')
        state.pendingPermissions = [
          {
            sessionId: 'session-1',
            requestId: 'permission-1',
            toolCallId: 'tool-1',
            title: 'Run command',
            options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }]
          }
        ]
      if (kind === 'elicitation')
        state.pendingElicitations = [
          {
            sessionId: 'session-1',
            requestId: 'question-1',
            toolCallId: 'tool-2',
            message: 'Choose a dataset',
            fields: [{ id: 'dataset', label: 'Dataset', kind: 'text', required: true }]
          }
        ]
      if (kind === 'prompt') state.promptInFlightSessionIds = ['session-1']
      await cancelWorkspaceRun({ cancel: async () => state }, 'session-1')
      expect(projectSessionActionability(current()).actions.startTurn.allowed).toBe(false)
    }
  )

  it.each(['waiting-permission', 'waiting-for-user', 'running'] as const)(
    'does not erase durable %s authority',
    async (status) => {
      seed('waiting-permission')
      window.api.sessions.loadOne = async () => ({ ...durable(), status })
      await cancelWorkspaceRun({ cancel: async () => snapshot() }, 'session-1')
      expect(projectSessionActionability(current()).actions.startTurn.allowed).toBe(false)
    }
  )

  it('does not erase a new live request delivered during the authority read', async () => {
    seed('waiting-for-user')
    window.api.sessions.loadOne = async () => {
      useSessionStore.getState().setPermissionPending('session-1', { liveProjection: 'writer' })
      return durable()
    }
    await cancelWorkspaceRun({ cancel: async () => snapshot() }, 'session-1')
    expect(projectSessionActionability(current()).blockingInteraction).toBe('permission')
  })

  it('keeps recovery blocked when a newer revision has no observed activity state', async () => {
    seed('waiting-for-user')
    window.api.sessions.loadOne = async () => {
      acceptAcpRuntimeSnapshotRevision({ revision: 11 })
      return durable()
    }
    await cancelWorkspaceRun({ cancel: async () => snapshot() }, 'session-1')
    expect(current().status).toBe('waiting-for-user')
  })

  describe.each(['waiting-permission', 'waiting-for-user'] as const)('%s', (status) => {
    it.each(['before cancellation returns', 'during the authority read'] as const)(
      'recovers despite unrelated activity %s',
      async (timing) => {
        seed(status)
        const source = current()
        const unrelated = { ...snapshot(), revision: 11, promptInFlightSessionIds: ['session-2'] }
        const observeUnrelated = (): void => {
          acceptAcpRuntimeSnapshotRevision(unrelated)
          // A second consumer may acknowledge the same watermark without providing state.
          acceptAcpRuntimeSnapshotRevision({ revision: 11 })
          expect(current()).toBe(source)
        }
        window.api.sessions.loadOne = async () => {
          if (timing === 'during the authority read') observeUnrelated()
          return durable()
        }
        await cancelWorkspaceRun(
          {
            cancel: async () => {
              if (timing === 'before cancellation returns') observeUnrelated()
              return snapshot()
            }
          },
          'session-1'
        )
        expect(current().status).toBe('idle')
        expect(projectSessionActionability(current()).actions.startTurn.allowed).toBe(true)
      }
    )
  })

  it.each(['permission', 'elicitation', 'prompt', 'agent-prompt'] as const)(
    'protects a newer %s before its React projection during recovery',
    async (kind) => {
      seed('waiting-for-user')
      const source = current()
      window.api.sessions.loadOne = async () => {
        const latest = { ...snapshot(), revision: 11 }
        if (kind === 'permission')
          latest.pendingPermissions = [
            {
              sessionId: 'session-1',
              requestId: 'new-permission',
              toolCallId: 'tool-1',
              title: 'Run command',
              options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]
            }
          ]
        if (kind === 'elicitation')
          latest.pendingElicitations = [
            {
              sessionId: 'session-1',
              requestId: 'new-question',
              toolCallId: 'tool-2',
              message: 'Choose a dataset',
              fields: []
            }
          ]
        if (kind === 'prompt') latest.promptInFlightSessionIds = ['session-1']
        if (kind === 'agent-prompt') latest.agentPromptInFlightSessionIds = ['session-1']
        acceptAcpRuntimeSnapshotRevision(latest)
        expect(acceptAcpRuntimeSnapshotRevision(snapshot())).toBe(false)
        expect(current()).toBe(source)
        return durable()
      }
      await cancelWorkspaceRun({ cancel: async () => snapshot() }, 'session-1')
      expect(current()).toBe(source)
      expect(projectSessionActionability(current()).actions.startTurn.allowed).toBe(false)
    }
  )

  it('does not use an older durable revision to unlock the composer', async () => {
    seed('waiting-for-user')
    window.api.sessions.loadOne = async () => ({ ...durable(), revision: 3 })
    await cancelWorkspaceRun({ cancel: async () => snapshot() }, 'session-1')
    expect(current().status).toBe('waiting-for-user')
  })

  it('keeps the wait when no durable authority exists', async () => {
    seed('waiting-for-user')
    window.api.sessions.loadOne = async () => undefined
    await cancelWorkspaceRun({ cancel: async () => snapshot() }, 'session-1')
    expect(current().status).toBe('waiting-for-user')
  })

  it('bypasses a cached waiting projection even at the same durable revision', async () => {
    seed('waiting-for-user')
    window.api.sessions.loadOne = async () => ({ ...durable(), status: 'waiting-for-user' })
    await loadPersistedSession({ projectId: 'project-1', sessionId: 'session-1' })
    window.api.sessions.loadOne = async () => durable()
    await cancelWorkspaceRun({ cancel: async () => snapshot() }, 'session-1')
    expect(projectSessionActionability(current()).actions.startTurn.allowed).toBe(true)
  })

  it('preserves a new prompt prepared while the authority read is pending', async () => {
    seed('waiting-for-user')
    window.api.sessions.loadOne = async () => {
      useSessionStore.getState().appendUserMessage({
        sessionId: 'session-1',
        content: 'New turn',
        cwd: '/workspace',
        projectId: 'project-1'
      })
      return durable()
    }
    await cancelWorkspaceRun({ cancel: async () => snapshot() }, 'session-1')
    expect(current().activeRun).toBeDefined()
    expect(current().messages.at(-1)?.content).toBe('New turn')
    expect(projectSessionActionability(current()).actions.startTurn.allowed).toBe(false)
  })

  it('rejects recovery from a replaced runtime service', async () => {
    seed('waiting-for-user')
    useDesktopRuntimeRecoveryStore.setState({ generation: 'before-cancel' })
    window.api.sessions.loadOne = async () => {
      useDesktopRuntimeRecoveryStore.setState({ generation: 'after-cancel' })
      return durable()
    }
    await cancelWorkspaceRun({ cancel: async () => snapshot() }, 'session-1')
    expect(current().status).toBe('waiting-for-user')
  })

  it('rejects a cancellation overtaken by service replacement and a new idle snapshot', async () => {
    seed('waiting-for-user')
    useDesktopRuntimeRecoveryStore.setState({ generation: 'before-cancel' })
    await cancelWorkspaceRun(
      {
        cancel: async () => {
          useDesktopRuntimeRecoveryStore.setState({ generation: 'after-cancel' })
          acceptAcpRuntimeSnapshotRevision({ ...snapshot(), revision: 1 })
          return snapshot()
        }
      },
      'session-1'
    )
    expect(current().status).toBe('waiting-for-user')
  })

  it('retains the wait on read failure and allows a later Stop to retry', async () => {
    seed('waiting-for-user')
    window.api.sessions.loadOne = async () => {
      throw new Error('Read failed')
    }
    await expect(
      cancelWorkspaceRun({ cancel: async () => snapshot() }, 'session-1')
    ).rejects.toThrow('Read failed')
    expect(current().status).toBe('waiting-for-user')
    window.api.sessions.loadOne = async () => durable()
    await cancelWorkspaceRun({ cancel: async () => snapshot() }, 'session-1')
    expect(projectSessionActionability(current()).actions.startTurn.allowed).toBe(true)
  })

  it('keeps the wait after cancellation fails', async () => {
    seed('waiting-for-user')
    await expect(
      cancelWorkspaceRun({ cancel: async () => undefined }, 'session-1')
    ).rejects.toThrow('Agent cancellation failed')
    expect(current().status).toBe('waiting-for-user')
  })
})
