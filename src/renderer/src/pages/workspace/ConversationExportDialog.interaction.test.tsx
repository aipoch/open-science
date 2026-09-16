// @vitest-environment jsdom
import { act } from 'react'
import { webcrypto } from 'node:crypto'
import { waitFor } from '@testing-library/react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useSessionStore, type ChatSession } from '@/stores/session-store'
import { ConversationExportDialog } from './ConversationExportDialog'
import {
  materializeSessionConversationGraph,
  SessionRevisionConflictError,
  type PersistedChatSession
} from '../../../../shared/session-persistence'
import {
  createConversationExportDocument,
  hashConversationExportContent
} from '../../../../shared/conversation-export'
import {
  createOrderedSessionPersistence,
  createStoreSaver,
  saveSessionInOrder,
  resetSessionPersistenceWriteFailuresForTests
} from '@/lib/session-persistence/session-persistence'
import { createConversationExportService } from '../../../../main/session-persistence/conversation-export'

vi.mock('electron', () => ({
  app: {},
  BrowserWindow: vi.fn(),
  dialog: {},
  ipcMain: { handle: vi.fn() }
}))

vi.mock('@/lib/acp/useWorkspaceAgentRuntime', () => ({
  drainWorkspaceRuntimeEventsForPersistence: vi.fn(async () => undefined)
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const createSession = (overrides: Partial<ChatSession> = {}): ChatSession => ({
  id: 'session-1',
  projectId: 'project-1',
  title: 'Analysis session',
  cwd: '/workspace',
  status: 'idle',
  messages: [
    {
      id: 'prompt-1',
      role: 'user',
      content: 'Compare the papers',
      status: 'complete',
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    },
    {
      id: 'answer-1',
      role: 'agent',
      content: 'The first comparison',
      status: 'complete',
      eventIds: [],
      createdAt: 2,
      updatedAt: 2
    },
    {
      id: 'prompt-2',
      role: 'user',
      content: 'Summarize the limitations',
      status: 'complete',
      eventIds: [],
      createdAt: 3,
      updatedAt: 3
    },
    {
      id: 'answer-2',
      role: 'agent',
      content: 'The selected limitations',
      status: 'complete',
      eventIds: [],
      createdAt: 4,
      updatedAt: 4
    }
  ],
  createdAt: 1,
  updatedAt: 4,
  ...overrides
})

const findControl = (role: string, text: string): HTMLButtonElement | undefined =>
  [...document.body.querySelectorAll<HTMLButtonElement>(`[role="${role}"]`)].find((element) =>
    element.textContent?.includes(text)
  )

describe('ConversationExportDialog', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.stubGlobal('crypto', webcrypto)
  })

  afterEach(() => {
    act(() => root.unmount())
    document.body.innerHTML = ''
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    resetSessionPersistenceWriteFailuresForTests()
  })

  it.each([false, true])(
    'reconciles a queued CLI save without ending a local follow-up (%s)',
    async (followUp) => {
      const initialState = useSessionStore.getState()
      const running = materializeSessionConversationGraph(
        createSession({
          revision: 1,
          status: 'running',
          activeRun: { promptMessageId: 'prompt-2', startedAt: 3 }
        })
      )
      let durable: PersistedChatSession = running
      let release!: () => void
      const barrier = new Promise<void>((resolve) => {
        release = resolve
      })
      const api = {
        loadAll: vi.fn(),
        loadOne: async () => durable,
        saveSession: async (session: PersistedChatSession) => {
          if (session.revision !== durable.revision) {
            throw new SessionRevisionConflictError(session.revision ?? 0, durable.revision ?? 0)
          }
          durable = { ...session, revision: (durable.revision ?? 0) + 1 }
          return durable
        },
        deleteSession: vi.fn(),
        saveManifest: async () => barrier
      }
      const persistence = createOrderedSessionPersistence(api)
      try {
        useSessionStore.getState().hydrateSessions([running])
        const save = createStoreSaver(api, useSessionStore.getState(), {}, persistence)
        const blocked = persistence.saveManifest({ lastSessionId: running.id })
        useSessionStore.getState().setMemoryEnabled(running.id, false)
        if (followUp) {
          useSessionStore.getState().finishRun(running.id)
          useSessionStore.getState().appendUserMessage({
            sessionId: running.id,
            content: 'A newer local prompt'
          })
        }
        const queued = save(useSessionStore.getState())
        durable = materializeSessionConversationGraph(createSession({ revision: 2, updatedAt: 5 }))
        useSessionStore.getState().upsertPersistedSession(durable)
        const observed = save(useSessionStore.getState())
        release()
        await Promise.all([blocked, queued, observed])
        expect(useSessionStore.getState().sessions[0].status).toBe(followUp ? 'running' : 'idle')
        const service = createConversationExportService({
          loadSession: async () => durable,
          isSessionActive: () => false,
          getDownloadsPath: () => '/in-memory',
          showSaveDialog: async () => ({ canceled: true, filePath: '' })
        })
        const exported = service.exportConversation({
          projectId: durable.projectId,
          sessionId: durable.id,
          format: 'markdown',
          expectedContentHash: await hashConversationExportContent(
            useSessionStore.getState().sessions[0]!
          )
        })
        if (followUp) {
          await expect(exported).rejects.toThrow(
            'Wait for the conversation to finish before exporting it.'
          )
          expect(durable.status).toBe('running')
          expect(durable.messages.at(-1)?.content).toBe('A newer local prompt')
          expect(durable.activeRun?.promptMessageId).toBe(durable.messages.at(-1)?.id)
        } else {
          await expect(exported).resolves.toEqual({ saved: false })
          expect(durable.status).toBe('idle')
          expect(durable.activeRun).toBeUndefined()
        }
        expect(durable.memoryEnabled).toBe(false)
      } finally {
        release()
        useSessionStore.setState(initialState, true)
      }
    }
  )

  it.each(['remote-update', 'save-receipt', 'save-receipt-after-echo'] as const)(
    'exports after a newer durable %s replaces the CLI completion at the same timestamp',
    async (delivery) => {
      const initialState = useSessionStore.getState()
      const prompt = createSession().messages[0]
      const completion = {
        ...createSession().messages[1],
        responseToMessageId: prompt.id,
        eventIds: ['provider-output'],
        createdAt: 3,
        updatedAt: 3
      }
      const taskSnapshot = materializeSessionConversationGraph(
        createSession({ revision: 4, updatedAt: 5, messages: [prompt, completion] })
      )
      const durable = materializeSessionConversationGraph(
        createSession({
          revision: 5,
          updatedAt: 5,
          messages: [
            prompt,
            {
              ...completion,
              id: 'message-stream',
              streamId: 'provider-message',
              createdAt: 2,
              updatedAt: 2
            }
          ]
        })
      )
      const showSaveDialog = vi.fn(async () => ({ canceled: true, filePath: '' }))
      const service = createConversationExportService({
        loadSession: async () => durable,
        isSessionActive: () => false,
        getDownloadsPath: () => '/in-memory',
        showSaveDialog
      })
      try {
        useSessionStore
          .getState()
          .hydrateSessions([
            materializeSessionConversationGraph(
              createSession({ revision: 2, updatedAt: 4, messages: durable.messages })
            )
          ])
        const queuedSource = useSessionStore.getState().sessions[0]!
        useSessionStore.getState().upsertPersistedSession(taskSnapshot)
        if (delivery === 'save-receipt-after-echo')
          useSessionStore.getState().applyDurableSessionProjection({
            source: useSessionStore.getState().sessions[0]!,
            session: durable,
            mode: 'archive-authority'
          })
        if (delivery === 'remote-update') useSessionStore.getState().upsertPersistedSession(durable)
        else
          useSessionStore
            .getState()
            .applyDurableSessionProjection({ source: queuedSource, session: durable })
        // A newly opened dialog reviews the store again; reopening must not retain an obsolete head.
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const preview = useSessionStore.getState().sessions[0]!
          await expect(
            service.exportConversation({
              projectId: durable.projectId,
              sessionId: durable.id,
              format: 'markdown',
              expectedContentHash: await hashConversationExportContent(preview)
            })
          ).resolves.toEqual({ saved: false })
        }
        expect(showSaveDialog).toHaveBeenCalledTimes(2)

        useSessionStore.getState().appendUserMessage({
          sessionId: durable.id,
          content: 'Keep this unsaved follow-up'
        })
        const local = useSessionStore.getState().sessions[0]!
        useSessionStore.getState().applyDurableSessionProjection({
          source: queuedSource,
          session: { ...durable, revision: 6 }
        })
        const afterReceipt = useSessionStore.getState().sessions[0]!
        expect(afterReceipt.messages).toEqual(local.messages)
        expect(afterReceipt.activeRun).toBe(local.activeRun)
        expect(afterReceipt.status).toBe('running')
      } finally {
        useSessionStore.setState(initialState, true)
      }
    }
  )

  it('exports a settled conversation after a delayed stop and durable refresh', async () => {
    const durable = createSession()
    const initialState = useSessionStore.getState()
    useSessionStore.getState().hydrateSessions([durable])
    vi.spyOn(Date, 'now').mockReturnValue(10)
    // The durable completion can arrive before its runtime stop event reaches the renderer.
    useSessionStore.getState().finishRun(durable.id)
    useSessionStore.getState().applyDurableSessionProjection({
      source: useSessionStore.getState().sessions[0]!,
      session: durable,
      mode: 'runtime-context-authority'
    })
    const snapshot = useSessionStore.getState().sessions[0]!
    const writeFile = vi.fn().mockResolvedValue(undefined)
    const onClose = vi.fn()
    const service = createConversationExportService({
      loadSession: async () => durable,
      isSessionActive: () => false,
      showSaveDialog: async () => ({ canceled: false, filePath: '/in-memory/export.md' }),
      getDownloadsPath: () => '/in-memory',
      writeFile,
      publishUserFile: async (path, write) => {
        await write(path)
      }
    })
    try {
      expect(snapshot.status).toBe('idle')
      const preview = createConversationExportDocument(snapshot, 0)
      const saved = createConversationExportDocument(durable, 0)
      expect(preview.updatedAt).not.toBe(saved.updatedAt)
      expect({ ...preview, updatedAt: saved.updatedAt }).toEqual(saved)
      expect(snapshot.messages.map(({ content }) => content)).toEqual(
        durable.messages.map(({ content }) => content)
      )
      const render = (session: ChatSession | undefined): void => {
        root.render(
          <ConversationExportDialog
            session={session}
            currentSession={snapshot}
            onClose={onClose}
            onExport={service.exportConversation}
          />
        )
      }
      act(() => render(snapshot))
      act(() => render(undefined))
      act(() => render(snapshot))
      act(() => findControl('radio', 'Markdown')?.click())
      await act(async () => {
        document.body
          .querySelector<HTMLButtonElement>('[data-testid="conversation-export-confirm"]')
          ?.click()
      })
      await waitFor(() =>
        expect(
          document.body.querySelector<HTMLButtonElement>(
            '[data-testid="conversation-export-confirm"]'
          )?.disabled
        ).toBe(false)
      )
      expect(document.body.querySelector('[role="alert"]')?.textContent ?? '').toBe('')
      expect(writeFile).toHaveBeenCalledWith(
        '/in-memory/export.md',
        expect.stringContaining('The selected limitations')
      )
      expect(writeFile.mock.calls[0]?.[1]).toContain(
        `updated: ${JSON.stringify(new Date(durable.updatedAt).toISOString())}`
      )
      expect(onClose).toHaveBeenCalledOnce()
    } finally {
      useSessionStore.setState(initialState, true)
    }
  })

  it('keeps export available when only the current Session update time changes', async () => {
    const session = createSession()
    const onExport = vi.fn().mockResolvedValue({ saved: true })
    const onClose = vi.fn()
    act(() =>
      root.render(
        <ConversationExportDialog
          session={session}
          currentSession={{ ...session, updatedAt: session.updatedAt + 1 }}
          onClose={onClose}
          onExport={onExport}
        />
      )
    )
    const confirm = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="conversation-export-confirm"]'
    )!
    expect(confirm.disabled).toBe(false)
    expect(document.body.textContent).not.toContain('The conversation changed.')
    await act(async () => {
      confirm.click()
    })
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(onExport).toHaveBeenCalledOnce()
  })

  it('keeps the conversation dialog focused on PDF and Markdown', () => {
    const session = createSession()
    vi.stubGlobal('api', { sessions: { exportPackage: vi.fn() } })
    act(() =>
      root.render(
        <ConversationExportDialog session={session} currentSession={session} onClose={vi.fn()} />
      )
    )
    expect(document.body.textContent).not.toContain('Export Session package')
    expect(findControl('radio', 'PDF')).toBeDefined()
    expect(findControl('radio', 'Markdown')).toBeDefined()
  })

  it('defaults to the whole PDF export and omits a selection field', async () => {
    const session = createSession()
    const onClose = vi.fn()
    const onExport = vi.fn().mockResolvedValue({ saved: false })
    act(() => {
      root.render(
        <ConversationExportDialog
          session={session}
          currentSession={session}
          onClose={onClose}
          onExport={onExport}
        />
      )
    })

    expect(findControl('radio', 'PDF')?.getAttribute('aria-checked')).toBe('true')
    expect(findControl('radio', 'Entire conversation')?.getAttribute('aria-checked')).toBe('true')
    const confirm = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="conversation-export-confirm"]'
    )
    expect(confirm?.textContent).toContain('Export PDF')
    expect(confirm?.disabled).toBe(false)

    await act(async () => {
      confirm?.click()
      await waitFor(() => expect(onExport).toHaveBeenCalled())
    })

    expect(onExport).toHaveBeenCalledWith({
      projectId: 'project-1',
      sessionId: 'session-1',
      format: 'pdf',
      expectedContentHash: expect.stringMatching(/^[a-f0-9]{64}$/)
    })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('starts selected content empty, preserves selection after cancel, and submits in order', async () => {
    const session = createSession()
    const onClose = vi.fn()
    const onExport = vi
      .fn()
      .mockResolvedValueOnce({ saved: false })
      .mockResolvedValueOnce({ saved: true, filePath: '/downloads/selection.md' })
    act(() => {
      root.render(
        <ConversationExportDialog
          session={session}
          currentSession={session}
          onClose={onClose}
          onExport={onExport}
        />
      )
    })

    act(() => findControl('radio', 'Selected')?.click())
    const confirm = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="conversation-export-confirm"]'
    )
    expect(document.body.textContent).toContain('0 of 2 selected')
    expect(confirm?.disabled).toBe(true)

    act(() => findControl('checkbox', 'Summarize the limitations')?.click())
    act(() => findControl('checkbox', 'Compare the papers')?.click())
    expect(findControl('checkbox', 'Select all')?.getAttribute('aria-checked')).toBe('true')
    act(() => findControl('radio', 'Markdown')?.click())
    expect(confirm?.textContent).toContain('Export Markdown')

    await act(async () => {
      confirm?.click()
      await waitFor(() => expect(onExport).toHaveBeenCalled())
    })
    expect(onClose).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('2 of 2 selected')
    expect(onExport).toHaveBeenLastCalledWith({
      projectId: 'project-1',
      sessionId: 'session-1',
      format: 'markdown',
      expectedContentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      selectedPromptMessageIds: ['prompt-1', 'prompt-2']
    })

    await act(async () => {
      confirm?.click()
      await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it.each(['delayed', 'failed', 'changed after saving'] as const)(
    'never exports an old saved answer when persistence is %s',
    async (mode) => {
      const session = createSession({ messages: createSession().messages.slice(0, 2) })
      session.messages[1] = { ...session.messages[1], content: 'NEW answer reviewed in the dialog' }
      let durable = {
        ...session,
        messages: session.messages.map((message) =>
          message.role === 'agent' ? { ...message, content: 'Old saved answer' } : message
        )
      }
      let release!: () => void
      const blocked = new Promise<void>((resolve) => {
        release = resolve
      })
      const saveSession = vi.fn(async (next: ChatSession) => {
        await blocked
        if (mode === 'failed') throw new Error('Disk is full')
        durable =
          mode === 'changed after saving'
            ? {
                ...next,
                messages: next.messages.map((message) =>
                  message.role === 'agent'
                    ? { ...message, content: 'An answer from another writer' }
                    : message
                )
              }
            : next
        return next
      })
      vi.stubGlobal('api', undefined)
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: { sessions: { saveSession } }
      })
      const pendingSave = saveSessionInOrder(session).catch(() => undefined)
      const writeFile = vi.fn().mockResolvedValue(undefined)
      const service = createConversationExportService({
        loadSession: async () => durable,
        isSessionActive: () => false,
        showSaveDialog: async () => ({ canceled: false, filePath: '/in-memory/export.md' }),
        getDownloadsPath: () => '/in-memory',
        writeFile,
        publishUserFile: async (path, write) => {
          await write(path)
        }
      })
      const onClose = vi.fn()
      act(() =>
        root.render(
          <ConversationExportDialog
            session={session}
            currentSession={session}
            onClose={onClose}
            onExport={service.exportConversation}
          />
        )
      )
      act(() => findControl('radio', 'Selected')?.click())
      expect(document.body.textContent).toContain('NEW answer reviewed in the dialog')
      act(() => findControl('checkbox', 'Compare the papers')?.click())
      act(() => findControl('radio', 'Markdown')?.click())
      try {
        await act(async () => {
          document.body
            .querySelector<HTMLButtonElement>('[data-testid="conversation-export-confirm"]')
            ?.click()
        })
        await act(async () => {
          release()
          await pendingSave
        })
        await waitFor(() => {
          const confirm = document.body.querySelector<HTMLButtonElement>(
            '[data-testid="conversation-export-confirm"]'
          )
          expect(confirm?.disabled).toBe(false)
        })
        if (mode !== 'delayed') {
          expect(writeFile).not.toHaveBeenCalled()
          expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
            mode === 'failed' ? 'Disk is full' : 'The conversation changed.'
          )
          expect(onClose).not.toHaveBeenCalled()
        } else {
          expect(writeFile).toHaveBeenCalledWith(
            '/in-memory/export.md',
            expect.stringContaining('NEW answer reviewed in the dialog')
          )
          expect(writeFile.mock.calls[0]?.[1]).not.toContain('Old saved answer')
        }
      } finally {
        release()
        await pendingSave
      }
    }
  )

  it('does not count removed turns when reopening the same conversation', async () => {
    const session = createSession({ messages: createSession().messages.slice(0, 2) })
    const onExport = vi.fn().mockResolvedValue({ saved: false })
    const render = (snapshot: ChatSession | undefined): void => {
      root.render(
        <ConversationExportDialog
          session={snapshot}
          currentSession={snapshot}
          onClose={vi.fn()}
          onExport={onExport}
        />
      )
    }
    act(() => render(session))
    act(() => findControl('radio', 'Selected')?.click())
    act(() => findControl('checkbox', 'Compare the papers')?.click())
    expect(document.body.textContent).toContain('1 of 1 selected')
    act(() => render(undefined))
    const replacement = createSession({
      messages: session.messages.map((message) => ({ ...message, id: `${message.id}-new` }))
    })
    act(() => render(replacement))
    act(() => findControl('radio', 'Selected')?.click())
    expect(findControl('checkbox', 'Compare the papers')?.getAttribute('aria-checked')).toBe(
      'false'
    )
    expect(document.body.textContent).toContain('0 of 1 selected')
    expect(findControl('checkbox', 'Select all')?.getAttribute('aria-checked')).toBe('false')
    const confirm = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="conversation-export-confirm"]'
    )
    expect(confirm?.disabled).toBe(true)
    await act(async () => {
      confirm?.click()
    })
    expect(onExport).not.toHaveBeenCalled()
  })

  it('keeps long message previews inside the vertical scroll surface', () => {
    const longPrompt = `Compare-${'unbroken'.repeat(80)}`
    const longResponse = `Result-${'continuous'.repeat(80)}`
    const session = createSession({
      messages: createSession().messages.map((message) => {
        if (message.id === 'prompt-1') return { ...message, content: longPrompt }
        if (message.id === 'answer-1') return { ...message, content: longResponse }
        return message
      })
    })

    act(() => {
      root.render(
        <ConversationExportDialog
          session={session}
          currentSession={session}
          onClose={vi.fn()}
          onExport={vi.fn().mockResolvedValue({ saved: false })}
        />
      )
    })

    act(() => findControl('radio', 'Selected')?.click())

    const scrollSurface = document.body.querySelector('.overflow-y-auto')
    const messageGroup = document.body.querySelector(
      '[role="group"][aria-label="Content to export"]'
    )
    const messageOption = findControl('checkbox', longPrompt)
    const promptPreview = [...document.body.querySelectorAll('span')].find(
      (element) => element.textContent === longPrompt
    )
    const responsePreview = [...document.body.querySelectorAll('span')].find(
      (element) => element.textContent === longResponse
    )

    expect(scrollSurface?.classList.contains('overflow-x-hidden')).toBe(true)
    expect(messageGroup?.classList.contains('min-w-0')).toBe(true)
    expect(messageOption?.classList.contains('min-w-0')).toBe(true)
    expect(promptPreview?.classList.contains('truncate')).toBe(true)
    expect(responsePreview?.classList.contains('truncate')).toBe(true)
  })

  it('shows inline failures and disables an outdated preview', async () => {
    const session = createSession()
    const onExport = vi.fn().mockRejectedValue(new Error('Disk is full'))
    const { messages } = session
    const changedSession = createSession({
      messages: [
        ...messages,
        {
          id: 'prompt-3',
          role: 'user',
          content: 'A new turn',
          status: 'complete',
          eventIds: [],
          createdAt: 5,
          updatedAt: 5
        }
      ]
    })
    act(() => {
      root.render(
        <ConversationExportDialog
          session={session}
          currentSession={session}
          onClose={vi.fn()}
          onExport={onExport}
        />
      )
    })

    const confirm = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="conversation-export-confirm"]'
    )
    await act(async () => {
      confirm?.click()
    })
    await waitFor(() => expect(document.body.querySelector('[role="alert"]')).not.toBeNull())
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('Disk is full')

    act(() => {
      root.render(
        <ConversationExportDialog
          session={session}
          currentSession={changedSession}
          onClose={vi.fn()}
          onExport={onExport}
        />
      )
    })
    expect(document.body.textContent).toContain('The conversation changed.')
    expect(confirm?.disabled).toBe(true)
  })

  it('detects exported content changes and delegated activity without changing message ids', () => {
    const session = createSession()
    const onExport = vi.fn().mockResolvedValue({ saved: true })
    act(() => {
      root.render(
        <ConversationExportDialog
          session={session}
          currentSession={createSession({
            messages: session.messages.map((message) =>
              message.id === 'answer-1'
                ? { ...message, content: 'An updated comparison', updatedAt: 5 }
                : message
            ),
            updatedAt: 5
          })}
          onClose={vi.fn()}
          onExport={onExport}
        />
      )
    })

    const confirm = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="conversation-export-confirm"]'
    )
    expect(document.body.textContent).toContain('The conversation changed.')
    expect(confirm?.disabled).toBe(true)

    act(() => {
      root.render(
        <ConversationExportDialog
          session={session}
          currentSession={createSession({
            runtimeContext: {
              version: 1,
              revision: 1,
              delegatedWork: {
                records: [
                  {
                    agentFrameId: 'frame-1',
                    attempts: [
                      {
                        id: 'attempt-1',
                        status: 'running',
                        startedAt: 5,
                        resolvedAgent: { kind: 'main' },
                        runtimeSegmentIds: []
                      }
                    ]
                  }
                ]
              }
            }
          })}
          onClose={vi.fn()}
          onExport={onExport}
        />
      )
    })

    expect(document.body.textContent).toContain(
      'Wait for the conversation to finish before exporting it.'
    )
    expect(confirm?.disabled).toBe(true)
    expect(onExport).not.toHaveBeenCalled()
  })
})
