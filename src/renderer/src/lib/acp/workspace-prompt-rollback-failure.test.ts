import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SessionPromptPreparationOwner } from '../../../../main/session-persistence/prompt-preparation-owner'
import type { AcpStateSnapshot } from '../../../../shared/acp'
import {
  materializeSessionConversationGraph,
  type PersistedChatSession
} from '../../../../shared/session-persistence'
import { resetSessionConversationIntentsForTests } from '../../stores/session-conversation-intents'
import {
  createInitialSessionState,
  toPersistedSession,
  useSessionStore
} from '../../stores/session-store'
import {
  resetSessionPersistenceWriteFailuresForTests,
  saveSessionInOrder,
  type SessionPersistenceApi
} from '../session-persistence/session-persistence'
import { initI18n, prepareI18nLocale } from '../../i18n'
import { useWorkspaceOperationErrors } from './workspace-operation-error'
import { sendWorkspaceMessage } from './workspace-runtime-command-owner'
import { cancelWorkspaceRun } from './workspace-runtime-session-lifecycle-owner'
import {
  hasPendingWorkspacePromptRollback,
  resetWorkspacePromptRollbacksForTests
} from './workspace-prompt-preparation'

const SESSION_ID = 'rollback-failure-session'

const fixture = (): PersistedChatSession =>
  materializeSessionConversationGraph({
    id: SESSION_ID,
    projectId: 'project',
    title: 'Existing history',
    cwd: '/workspace',
    status: 'idle',
    agentFrameworkId: 'codex',
    createdAt: 1,
    updatedAt: 1,
    revision: 1,
    runtimeTranscriptOwner: 'main',
    messages: [
      {
        id: 'old',
        role: 'user',
        content: 'Existing question',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1,
        turnOutcome: { kind: 'completed', settledAt: 2 }
      },
      {
        id: 'old-reply',
        role: 'agent',
        content: 'Existing answer',
        status: 'complete',
        eventIds: [],
        createdAt: 2,
        updatedAt: 2,
        responseToMessageId: 'old'
      }
    ]
  })

const current = (): PersistedChatSession =>
  toPersistedSession(useSessionStore.getState().sessions[0])

// Only the native save boundary is replaced; Main's real preparation owner decides every receipt.
const mainWithFailingRollback = (): {
  api: Pick<SessionPersistenceApi, 'saveSession' | 'saveManifest'>
  read: () => PersistedChatSession
  failRollbacks: (failing: boolean) => void
} => {
  const owner = new SessionPromptPreparationOwner()
  let durable = structuredClone(fixture())
  let failing = false
  const api = {
    saveSession: vi.fn<SessionPersistenceApi['saveSession']>(async (_candidate, options) => {
      const commands = options?.conversationCommands ?? []
      if (failing && commands.some(({ kind }) => kind === 'rollback-prompt')) {
        throw new Error('No space left on device')
      }
      const result = owner.apply(durable, commands)
      durable = { ...result, runtimeTranscriptOwner: 'main', revision: (durable.revision ?? 0) + 1 }
      owner.observe(durable)
      return structuredClone(durable)
    }),
    saveManifest: vi.fn<SessionPersistenceApi['saveManifest']>(async () => undefined)
  }
  vi.stubGlobal('window', {
    api: { sessions: { ...api, loadOne: async () => structuredClone(durable) } }
  })
  useSessionStore.getState().hydrateSessions([structuredClone(durable)])
  return {
    api,
    read: () => structuredClone(durable),
    failRollbacks: (value) => {
      failing = value
    }
  }
}

const runtime = (): {
  state: AcpStateSnapshot
  createSession: ReturnType<typeof vi.fn>
  resumeSession: ReturnType<typeof vi.fn>
  resetSessionContext: ReturnType<typeof vi.fn>
  sendPrompt: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
} => {
  const state = {
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
  } as unknown as AcpStateSnapshot
  return {
    state,
    createSession: vi.fn(),
    resumeSession: vi.fn(),
    resetSessionContext: vi.fn(),
    sendPrompt: vi.fn(async () => state),
    cancel: vi.fn(async () => state)
  }
}

const send = (
  agent: ReturnType<typeof runtime>,
  text: string,
  onPreparationRejected?: (error: string) => void
): ReturnType<typeof sendWorkspaceMessage> =>
  sendWorkspaceMessage(
    agent as never,
    { sessionId: SESSION_ID, projectId: 'project', cwd: '/workspace', text, onPreparationRejected },
    {
      awaitPromptAdmission: true,
      flushPersistence: async () => {
        await saveSessionInOrder(current())
      }
    }
  )

beforeEach(() => {
  resetWorkspacePromptRollbacksForTests()
  resetSessionConversationIntentsForTests()
  resetSessionPersistenceWriteFailuresForTests()
  useSessionStore.setState(createInitialSessionState())
  useWorkspaceOperationErrors.setState({ errors: {} })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('failed prompt rollback after a rejected dispatch', () => {
  const failDispatchAndRollback = async (
    main: ReturnType<typeof mainWithFailingRollback>,
    agent: ReturnType<typeof runtime>,
    rejected = vi.fn()
  ): Promise<ReturnType<typeof vi.fn>> => {
    agent.sendPrompt.mockRejectedValueOnce(new Error('Provider rejected the prompt'))
    main.failRollbacks(true)
    await send(agent, 'Rejected question', rejected)
    return rejected
  }

  it('reports the original failure together with the rollback failure and keeps the draft', async () => {
    const main = mainWithFailingRollback()
    const agent = runtime()
    const rejected = await failDispatchAndRollback(main, agent)
    const reported = useWorkspaceOperationErrors.getState().errors[SESSION_ID]
    expect(reported).toContain('Provider rejected the prompt')
    expect(reported).toContain('No space left on device')
    expect(reported).toMatch(/rolled back/i)
    expect(rejected).toHaveBeenCalledOnce()
    expect(rejected.mock.calls[0][0]).toBe(reported)
    expect(hasPendingWorkspacePromptRollback(SESSION_ID)).toBe(true)
    // Nothing was deleted: Main still holds history plus the unadmitted preparation.
    expect(main.read().messages.map(({ id }) => id)).toEqual(
      expect.arrayContaining(['old', 'old-reply'])
    )
  })

  it('localizes the rollback failure sentence while keeping both underlying failures verbatim', async () => {
    await prepareI18nLocale('zh-Hans')
    initI18n('zh-Hans')
    try {
      const main = mainWithFailingRollback()
      await failDispatchAndRollback(main, runtime())
      const reported = useWorkspaceOperationErrors.getState().errors[SESSION_ID]
      expect(reported).toContain('Provider rejected the prompt')
      expect(reported).toContain('未发送的消息无法回滚（No space left on device）')
      expect(reported).not.toMatch(/rolled back/i)
    } finally {
      initI18n('en')
    }
  })

  it('retries the exact failed preparation when the user stops the stuck run', async () => {
    const main = mainWithFailingRollback()
    const agent = runtime()
    await failDispatchAndRollback(main, agent)
    expect(useSessionStore.getState().sessions[0].activeRun).toBeDefined()
    main.failRollbacks(false)
    await cancelWorkspaceRun(agent as never, SESSION_ID)
    const session = useSessionStore.getState().sessions[0]
    expect(session.activeRun).toBeUndefined()
    expect(session.status).toBe('idle')
    expect(session.promptPreparation).toBeUndefined()
    expect(session.messages.map(({ id }) => id)).toEqual(['old', 'old-reply'])
    expect(main.read().promptPreparation).toBeUndefined()
    expect(main.read().messages.map(({ id }) => id)).toEqual(['old', 'old-reply'])
    expect(hasPendingWorkspacePromptRollback(SESSION_ID)).toBe(false)
    expect(agent.cancel).not.toHaveBeenCalled()
  })

  it('retries the failed rollback before preparing the next send, which then succeeds', async () => {
    const main = mainWithFailingRollback()
    const agent = runtime()
    await failDispatchAndRollback(main, agent)
    main.failRollbacks(false)
    const result = await send(agent, 'Second attempt')
    expect(result?.messageId).toBeDefined()
    expect(agent.sendPrompt).toHaveBeenCalledTimes(2)
    expect(hasPendingWorkspacePromptRollback(SESSION_ID)).toBe(false)
    const contents = main.read().messages.map(({ content }) => content)
    expect(contents).toEqual(['Existing question', 'Existing answer', 'Second attempt'])
  })

  it('keeps the record and reports again when the retry also fails, without preparing anew', async () => {
    const main = mainWithFailingRollback()
    const agent = runtime()
    await failDispatchAndRollback(main, agent)
    const prepares = vi
      .mocked(main.api.saveSession)
      .mock.calls.filter(([, options]) =>
        options?.conversationCommands?.some(({ kind }) => kind === 'prepare-prompt')
      ).length
    expect(await send(agent, 'Second attempt')).toBeUndefined()
    expect(hasPendingWorkspacePromptRollback(SESSION_ID)).toBe(true)
    expect(useWorkspaceOperationErrors.getState().errors[SESSION_ID]).toContain(
      'No space left on device'
    )
    expect(
      vi
        .mocked(main.api.saveSession)
        .mock.calls.filter(([, options]) =>
          options?.conversationCommands?.some(({ kind }) => kind === 'prepare-prompt')
        )
    ).toHaveLength(prepares)
    expect(agent.sendPrompt).toHaveBeenCalledOnce()
  })
})
