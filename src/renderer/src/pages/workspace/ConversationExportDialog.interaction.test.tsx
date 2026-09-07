// @vitest-environment jsdom
import { act } from 'react'
import { webcrypto } from 'node:crypto'
import { waitFor } from '@testing-library/react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChatSession } from '@/stores/session-store'
import { ConversationExportDialog } from './ConversationExportDialog'
import {
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
