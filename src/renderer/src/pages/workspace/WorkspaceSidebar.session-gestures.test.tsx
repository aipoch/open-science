// @vitest-environment jsdom

import { act, useState, type ComponentProps, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatSession } from '@/stores/session-store'
import { useUpdateStore } from '@/stores/update-store'
import { useComputeStore } from '@/stores/compute-store'
import { useSettingsStore } from '@/stores/settings-store'
import { createInitialSkillImportState, useSkillImportStore } from '@/stores/skill-import-store'
import { createI18nTestStub } from '../../../../../test/i18n-test-stub'

vi.mock('react-i18next', () => createI18nTestStub())
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/lib/utils', () => ({
  cn: (...values: Array<string | false | undefined>) => values.filter(Boolean).join(' ')
}))

const createSession = (overrides: Partial<ChatSession>): ChatSession => ({
  id: 'session-1',
  projectId: 'default',
  title: 'Analysis session',
  cwd: '/workspace',
  status: 'idle',
  messages: [],
  createdAt: 1710000000000,
  updatedAt: 1710000000000,
  ...overrides
})

beforeEach(() => {
  useComputeStore.setState({ pendingApprovals: [] })
  useSettingsStore.setState({ pendingApprovals: [], pendingCredentialRequests: [] })
  useSkillImportStore.setState(createInitialSkillImportState())
  useUpdateStore.setState({
    status: { state: 'up-to-date', current: '0.2.0', latest: '0.2.0' },
    isDialogOpen: false
  })
})

const mountSessionGestureSidebar = async (
  mobileMode = true
): Promise<{
  sessions: ChatSession[]
  onOpenSession: ReturnType<typeof vi.fn>
  onRenameSession: ReturnType<typeof vi.fn>
  container: HTMLElement
  click: (id?: string, detail?: number, type?: string) => Promise<void>
  rerender: (
    props: Partial<ComponentProps<typeof import('./WorkspaceSidebar').WorkspaceSidebar>>
  ) => Promise<void>
  cleanup: () => void
}> => {
  const { WorkspaceSidebar } = await import('./WorkspaceSidebar')
  const sessions = [createSession({ id: 'first' }), createSession({ id: 'second' })]
  const onOpenSession = vi.fn()
  const onRenameSession = vi.fn()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  let overrides: Partial<ComponentProps<typeof WorkspaceSidebar>> = {}
  const Harness = (): ReactElement => {
    const [isOpen, setIsOpen] = useState(true)
    return (
      <WorkspaceSidebar
        projectName="Example project"
        sessions={sessions}
        activeSessionId={sessions[0].id}
        canCreateConversation
        canMutateConversations
        canDeleteConversations
        onGoHome={vi.fn()}
        onNewConversation={vi.fn()}
        isFilesOpen={false}
        onOpenFiles={vi.fn()}
        onOpenSession={(id) => {
          onOpenSession(id)
          if (mobileMode) setIsOpen(false)
        }}
        onRenameSession={(session) => {
          onRenameSession(session)
          if (mobileMode) setIsOpen(false)
        }}
        canDownloadArtifacts
        onDownloadArtifacts={vi.fn()}
        onViewNotebook={vi.fn()}
        onTogglePin={vi.fn()}
        onDeleteSession={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenProjectSettings={vi.fn()}
        onNewProject={vi.fn()}
        mobileMode={mobileMode}
        isMobileOpen={isOpen}
        {...overrides}
      />
    )
  }
  await act(async () => root.render(<Harness />))
  return {
    sessions,
    onOpenSession,
    onRenameSession,
    container,
    click: async (id = 'second', detail = 1, type = 'click') => {
      const button = container.querySelector<HTMLButtonElement>(
        `[data-session-id="${id}"] [data-slot="session-open-button"]`
      )
      if (!button) throw new Error('Session button did not render')
      await act(async () => button.dispatchEvent(new MouseEvent(type, { bubbles: true, detail })))
    },
    rerender: async (props: typeof overrides) => {
      overrides = props
      await act(async () => root.render(<Harness />))
    },
    cleanup: () => {
      act(() => root.unmount())
      container.remove()
    }
  }
}

describe('WorkspaceSidebar mobile session gestures', () => {
  it('keeps the sidebar interactive until a double-click opens the editor without navigating', async () => {
    vi.useFakeTimers()
    const sidebar = await mountSessionGestureSidebar()
    try {
      await sidebar.click()
      expect(sidebar.onOpenSession).not.toHaveBeenCalled()
      expect(sidebar.container.querySelector('aside')?.hasAttribute('inert')).toBe(false)
      await act(async () => vi.advanceTimersByTimeAsync(100))
      await sidebar.click('second', 2)
      await sidebar.click('second', 2, 'dblclick')
      expect(sidebar.onRenameSession).toHaveBeenCalledExactlyOnceWith(sidebar.sessions[1])
      expect(sidebar.container.querySelector('aside')?.hasAttribute('inert')).toBe(true)
      await act(async () => vi.advanceTimersByTimeAsync(1000))
      expect(sidebar.onOpenSession).not.toHaveBeenCalled()
    } finally {
      sidebar.cleanup()
      vi.useRealTimers()
    }
  })

  it('opens a single pointer click after 300ms and closes the mobile sidebar', async () => {
    vi.useFakeTimers()
    const sidebar = await mountSessionGestureSidebar()
    try {
      await sidebar.click()
      await act(async () => vi.advanceTimersByTimeAsync(299))
      expect(sidebar.onOpenSession).not.toHaveBeenCalled()
      await act(async () => vi.advanceTimersByTimeAsync(1))
      expect(sidebar.onOpenSession).toHaveBeenCalledExactlyOnceWith('second')
      expect(sidebar.container.querySelector('aside')?.hasAttribute('inert')).toBe(true)
    } finally {
      sidebar.cleanup()
      vi.useRealTimers()
    }
  })

  it.each([false, true])('opens keyboard clicks immediately (mobile: %s)', async (mobileMode) => {
    const sidebar = await mountSessionGestureSidebar(mobileMode)
    try {
      await sidebar.click('second', 0)
      expect(sidebar.onOpenSession).toHaveBeenCalledExactlyOnceWith('second')
    } finally {
      sidebar.cleanup()
    }
  })

  it('opens desktop pointer clicks immediately', async () => {
    const sidebar = await mountSessionGestureSidebar(false)
    try {
      await sidebar.click()
      expect(sidebar.onOpenSession).toHaveBeenCalledExactlyOnceWith('second')
    } finally {
      sidebar.cleanup()
    }
  })

  it.each(['hide', 'unmount', 'remove'] as const)(
    'cancels a pending click on %s',
    async (reason) => {
      vi.useFakeTimers()
      const sidebar = await mountSessionGestureSidebar()
      try {
        await sidebar.click()
        if (reason === 'unmount') sidebar.cleanup()
        else await sidebar.rerender(reason === 'hide' ? { isMobileOpen: false } : { sessions: [] })
        await act(async () => vi.advanceTimersByTimeAsync(1000))
        expect(sidebar.onOpenSession).not.toHaveBeenCalled()
      } finally {
        if (reason !== 'unmount') sidebar.cleanup()
        vi.useRealTimers()
      }
    }
  )

  it('keeps double-click editing disabled when conversations cannot be mutated', async () => {
    vi.useFakeTimers()
    const sidebar = await mountSessionGestureSidebar()
    try {
      await sidebar.rerender({ canMutateConversations: false })
      await sidebar.click()
      await sidebar.click('second', 2)
      await sidebar.click('second', 2, 'dblclick')
      await act(async () => vi.advanceTimersByTimeAsync(300))
      expect(sidebar.onRenameSession).not.toHaveBeenCalled()
      expect(sidebar.onOpenSession).toHaveBeenCalledExactlyOnceWith('second')
    } finally {
      sidebar.cleanup()
      vi.useRealTimers()
    }
  })

  it.each(['dropdown', 'context menu'])(
    'cancels a pending click when the %s opens',
    async (menu) => {
      vi.useFakeTimers()
      const sidebar = await mountSessionGestureSidebar()
      try {
        await sidebar.click()
        const trigger = sidebar.container.querySelector<HTMLElement>(
          menu === 'dropdown'
            ? '[data-session-id="second"] button[aria-label^="Open actions for"]'
            : '[data-session-id="second"]'
        )
        if (!trigger) throw new Error('Session actions trigger did not render')
        await act(async () =>
          trigger.dispatchEvent(
            new MouseEvent(menu === 'dropdown' ? 'pointerdown' : 'contextmenu', {
              bubbles: true,
              button: menu === 'dropdown' ? 0 : 2
            })
          )
        )
        expect(document.body.querySelector('[role="menu"]')).not.toBeNull()
        await act(async () => vi.advanceTimersByTimeAsync(1000))
        expect(sidebar.onOpenSession).not.toHaveBeenCalled()
      } finally {
        sidebar.cleanup()
        vi.useRealTimers()
      }
    }
  )

  it('replaces a pending click when a different session is clicked', async () => {
    vi.useFakeTimers()
    const sidebar = await mountSessionGestureSidebar()
    try {
      await sidebar.click('first')
      await act(async () => vi.advanceTimersByTimeAsync(100))
      await sidebar.click('second')
      await act(async () => vi.advanceTimersByTimeAsync(300))
      expect(sidebar.onOpenSession).toHaveBeenCalledExactlyOnceWith('second')
    } finally {
      sidebar.cleanup()
      vi.useRealTimers()
    }
  })
})
