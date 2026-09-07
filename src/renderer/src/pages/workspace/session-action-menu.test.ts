import { Pin, PinOff } from 'lucide-react'
import { describe, expect, it, vi } from 'vitest'

import { resolveActionMenuEntries } from '@/components/action-menu'
import type { ChatSession } from '@/stores/session-store'

import {
  SESSION_ACTION_CATALOG,
  SESSION_ACTION_RECIPE,
  createSessionActionBindings,
  type SessionActionInvocation
} from './session-action-menu'

const createSession = (overrides: Partial<ChatSession> = {}): ChatSession => ({
  id: 'session-1',
  projectId: 'project-1',
  title: 'Analysis session',
  cwd: '/workspace',
  status: 'idle',
  messages: [
    {
      id: 'message-1',
      role: 'user',
      content: 'Ready',
      status: 'complete',
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    }
  ],
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

const invocation = (session: ChatSession): SessionActionInvocation => ({
  session,
  presentedStatus: session.status
})

describe('session action menu', () => {
  it('preserves the existing action order and executes every action for the invocation session', async () => {
    const session = createSession()
    const handlers = {
      onTogglePin: vi.fn(),
      onRenameSession: vi.fn(),
      onDownloadArtifacts: vi.fn(),
      onViewNotebook: vi.fn(),
      onExportSession: vi.fn(),
      onArchiveSession: vi.fn(),
      onDeleteSession: vi.fn()
    }
    const bindings = createSessionActionBindings({
      canMutateConversations: true,
      canDeleteConversations: true,
      canDownloadArtifacts: true,
      canArchiveSession: () => true,
      ...handlers
    })
    const context = invocation(session)
    const entries = resolveActionMenuEntries(
      {
        identityKey: session.id,
        catalog: SESSION_ACTION_CATALOG,
        recipe: SESSION_ACTION_RECIPE,
        bindings
      },
      context
    )

    expect(entries.map((entry) => (entry.kind === 'action' ? entry.action : '|'))).toEqual([
      'toggle-pin',
      'edit',
      '|',
      'download-artifacts',
      'view-notebook',
      'export',
      'archive',
      '|',
      'delete'
    ])

    for (const action of entries) {
      if (action.kind === 'action') await bindings[action.action]?.execute(context)
    }
    expect(handlers.onTogglePin).toHaveBeenCalledWith(session)
    expect(handlers.onRenameSession).toHaveBeenCalledWith(session)
    expect(handlers.onDownloadArtifacts).toHaveBeenCalledWith(session)
    expect(handlers.onViewNotebook).toHaveBeenCalledWith(session)
    expect(handlers.onExportSession).toHaveBeenCalledWith(session)
    expect(handlers.onArchiveSession).toHaveBeenCalledWith(session)
    expect(handlers.onDeleteSession).toHaveBeenCalledWith(session)
  })

  it('derives pin copy and icon from the invocation and keeps Delete dangerous', () => {
    const bindings = createSessionActionBindings({
      canMutateConversations: true,
      canDeleteConversations: true,
      canDownloadArtifacts: true,
      onTogglePin: vi.fn(),
      onRenameSession: vi.fn(),
      onDownloadArtifacts: vi.fn(),
      onViewNotebook: vi.fn(),
      onDeleteSession: vi.fn()
    })
    const unpinned = resolveActionMenuEntries(
      {
        identityKey: 'unpinned',
        catalog: SESSION_ACTION_CATALOG,
        recipe: SESSION_ACTION_RECIPE,
        bindings
      },
      invocation(createSession())
    )
    const pinned = resolveActionMenuEntries(
      {
        identityKey: 'pinned',
        catalog: SESSION_ACTION_CATALOG,
        recipe: SESSION_ACTION_RECIPE,
        bindings
      },
      invocation(createSession({ pinned: true }))
    )

    expect(unpinned[0]).toMatchObject({ labelKey: 'Pin', icon: Pin })
    expect(pinned[0]).toMatchObject({ labelKey: 'Unpin', icon: PinOff })
    expect(
      pinned.find((entry) => entry.kind === 'action' && entry.action === 'delete')
    ).toMatchObject({ danger: true })
  })

  it('owns hidden and disabled rules for permissions, availability, running, and empty sessions', () => {
    const bindings = createSessionActionBindings({
      canMutateConversations: false,
      canDeleteConversations: false,
      canDownloadArtifacts: false,
      canArchiveSession: () => false,
      onTogglePin: vi.fn(),
      onRenameSession: vi.fn(),
      onDownloadArtifacts: vi.fn(),
      onViewNotebook: vi.fn(),
      onExportSession: vi.fn(),
      onDeleteSession: vi.fn()
    })
    const entries = resolveActionMenuEntries(
      {
        identityKey: 'running',
        catalog: SESSION_ACTION_CATALOG,
        recipe: SESSION_ACTION_RECIPE,
        bindings
      },
      { session: createSession({ status: 'running' }), presentedStatus: 'running' }
    )
    const actions = entries.filter((entry) => entry.kind === 'action')

    expect(actions.map((entry) => entry.action)).toEqual([
      'toggle-pin',
      'edit',
      'view-notebook',
      'export',
      'archive',
      'delete'
    ])
    expect(actions.find((entry) => entry.action === 'toggle-pin')?.disabled).toBe(true)
    expect(actions.find((entry) => entry.action === 'edit')?.disabled).toBe(true)
    expect(actions.find((entry) => entry.action === 'export')?.disabled).toBe(true)
    expect(actions.find((entry) => entry.action === 'archive')?.disabled).toBe(true)
    expect(actions.find((entry) => entry.action === 'delete')?.disabled).toBe(true)

    const emptyExport = resolveActionMenuEntries(
      {
        identityKey: 'empty',
        catalog: SESSION_ACTION_CATALOG,
        recipe: SESSION_ACTION_RECIPE,
        bindings
      },
      invocation(createSession({ messages: [] }))
    )
    expect(
      emptyExport.find((entry) => entry.kind === 'action' && entry.action === 'export')
    ).toMatchObject({ disabled: true })
  })
})
