// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChatSession } from '@/stores/session-store'
import { ConversationExportDialog } from './ConversationExportDialog'

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
  })

  afterEach(() => {
    act(() => root.unmount())
    document.body.innerHTML = ''
    vi.restoreAllMocks()
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
      await Promise.resolve()
    })

    expect(onExport).toHaveBeenCalledWith({
      projectId: 'project-1',
      sessionId: 'session-1',
      format: 'pdf'
    })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('starts selected turns empty, preserves selection after cancel, and submits in order', async () => {
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

    act(() => findControl('radio', 'Selected turns')?.click())
    const confirm = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="conversation-export-confirm"]'
    )
    expect(document.body.textContent).toContain('0 of 2 turns selected')
    expect(confirm?.disabled).toBe(true)

    act(() => findControl('checkbox', 'Summarize the limitations')?.click())
    act(() => findControl('checkbox', 'Compare the papers')?.click())
    expect(findControl('checkbox', 'All turns')?.getAttribute('aria-checked')).toBe('true')
    act(() => findControl('radio', 'Markdown')?.click())
    expect(confirm?.textContent).toContain('Export Markdown')

    await act(async () => {
      confirm?.click()
      await Promise.resolve()
    })
    expect(onClose).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('2 of 2 turns selected')
    expect(onExport).toHaveBeenLastCalledWith({
      projectId: 'project-1',
      sessionId: 'session-1',
      format: 'markdown',
      selectedPromptMessageIds: ['prompt-1', 'prompt-2']
    })

    await act(async () => {
      confirm?.click()
      await Promise.resolve()
    })
    expect(onClose).toHaveBeenCalledOnce()
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
      await Promise.resolve()
    })
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
