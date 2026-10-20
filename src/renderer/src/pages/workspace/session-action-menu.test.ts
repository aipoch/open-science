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
  it('hides capabilities omitted by a menu owner', () => {
    const bindings = createSessionActionBindings({
      canMutateConversations: true,
      canDeleteConversations: true,
      canDownloadArtifacts: true,
      onTogglePin: vi.fn(),
      onRenameSession: vi.fn()
    })
    const entries = resolveActionMenuEntries(
      {
        identityKey: 'limited-owner',
        catalog: SESSION_ACTION_CATALOG,
        recipe: SESSION_ACTION_RECIPE,
        bindings
      },
      invocation(createSession())
    )
    const actions = entries.flatMap((entry) => (entry.kind === 'action' ? [entry.action] : []))
    expect(actions).not.toContain('download-artifacts')
    expect(actions).not.toContain('view-notebook')
    expect(actions).not.toContain('delete')
  })

  it('offers discussion and replay for ordinary running Sessions and forwards the selected source', async () => {
    const onViewReplay = vi.fn()
    const onDiscussSession = vi.fn(async () => undefined)
    const bindings = createSessionActionBindings({
      canMutateConversations: true,
      canDeleteConversations: true,
      canDownloadArtifacts: false,
      onTogglePin: vi.fn(),
      onRenameSession: vi.fn(),
      onDownloadArtifacts: vi.fn(),
      onViewNotebook: vi.fn(),
      onDeleteSession: vi.fn(),
      onViewReplay,
      onDiscussSession
    })
    const context = invocation(createSession({ status: 'running' }))
    const entries = resolveActionMenuEntries(
      {
        identityKey: 'source',
        catalog: SESSION_ACTION_CATALOG,
        recipe: SESSION_ACTION_RECIPE,
        bindings
      },
      context
    )
    for (const action of ['discuss', 'view-replay'] as const) {
      expect(
        entries.find((entry) => entry.kind === 'action' && entry.action === action)
      ).toMatchObject({ disabled: false })
      await bindings[action].execute(context)
    }
    expect(onViewReplay).toHaveBeenCalledWith(context.session)
    expect(onDiscussSession).toHaveBeenCalledWith(context.session)
  })
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

it('groups conversation and package exports while keeping package admission independent of active-branch messages', async () => {
  const onExportPackage = vi.fn(async () => undefined)
  const bindings = createSessionActionBindings({
    canMutateConversations: true,
    canDeleteConversations: true,
    canDownloadArtifacts: false,
    onTogglePin: vi.fn(),
    onRenameSession: vi.fn(),
    onDownloadArtifacts: vi.fn(),
    onViewNotebook: vi.fn(),
    onExportSession: vi.fn(),
    onExportPackage,
    onDeleteSession: vi.fn()
  })
  const context = invocation(createSession({ messages: [] }))
  const entries = resolveActionMenuEntries(
    {
      identityKey: 'session',
      catalog: SESSION_ACTION_CATALOG,
      recipe: SESSION_ACTION_RECIPE,
      bindings
    },
    context
  )
  const exports = entries.filter((entry) => entry.kind === 'action' && entry.submenu)
  expect(exports).toMatchObject([
    { action: 'export', disabled: true, submenu: { labelKey: 'Export' } },
    { action: 'export-package', disabled: false, submenu: { labelKey: 'Export' } }
  ])
  await bindings['export-package'].execute(context)
  expect(onExportPackage).toHaveBeenCalledWith(context.session)
})

it('keeps inactive Attention sessions available for fork and package export', () => {
  const bindings = createSessionActionBindings({
    canMutateConversations: true,
    canDeleteConversations: false,
    canDownloadArtifacts: true,
    onTogglePin: vi.fn(),
    onRenameSession: vi.fn(),
    onDownloadArtifacts: vi.fn(),
    onViewNotebook: vi.fn(),
    onDeleteSession: vi.fn(),
    onForkSession: vi.fn(async () => undefined),
    onExportPackage: vi.fn(async () => undefined)
  })
  const context = invocation(
    createSession({ status: 'error', attention: { recordProblems: ['size-limit'] } })
  )
  const entries = resolveActionMenuEntries(
    {
      identityKey: context.session.id,
      catalog: SESSION_ACTION_CATALOG,
      recipe: [
        { kind: 'action', action: 'export-package' },
        { kind: 'action', action: 'fork' }
      ],
      bindings
    },
    context
  )
  expect(entries).toMatchObject([{ disabled: false }, { disabled: false }])
})

it.each([
  'idle',
  'running',
  'waiting-permission',
  'waiting-plan-approval',
  'waiting-for-user'
] as const)(
  'places Fork between Export and Archive and disables it when busy (%s)',
  async (status) => {
    const onForkSession = vi.fn(async () => undefined)
    const bindings = createSessionActionBindings({
      canMutateConversations: true,
      canDeleteConversations: false,
      canDownloadArtifacts: true,
      onTogglePin: vi.fn(),
      onRenameSession: vi.fn(),
      onDownloadArtifacts: vi.fn(),
      onViewNotebook: vi.fn(),
      onDeleteSession: vi.fn(),
      onForkSession,
      onExportPackage: vi.fn(async () => undefined)
    })
    const context = invocation(createSession({ status }))
    const entries = resolveActionMenuEntries(
      {
        identityKey: context.session.id,
        catalog: SESSION_ACTION_CATALOG,
        recipe: SESSION_ACTION_RECIPE,
        bindings
      },
      context
    )
    const actions = entries.filter((entry) => entry.kind === 'action')
    const forkIndex = actions.findIndex((entry) => entry.action === 'fork')
    expect(actions[forkIndex - 1].action).toBe('export-package')
    expect(actions[forkIndex + 1].action).toBe('archive')
    expect(actions[forkIndex].disabled).toBe(status !== 'idle')
    if (status !== 'idle') expect(actions[forkIndex].disabledDescription).toBeTruthy()
    await bindings.fork.execute(context)
    expect(onForkSession).toHaveBeenCalledWith(context.session)
  }
)

it.each([
  { canMutateConversations: true, packageBusy: false, disabled: false },
  { canMutateConversations: true, packageBusy: true, disabled: true },
  { canMutateConversations: false, packageBusy: false, disabled: true }
])('allows read-only imports to fork when storage and transfer are ready (%j)', (state) => {
  const bindings = createSessionActionBindings({
    ...state,
    canDeleteConversations: false,
    canDownloadArtifacts: true,
    onTogglePin: vi.fn(),
    onRenameSession: vi.fn(),
    onDownloadArtifacts: vi.fn(),
    onViewNotebook: vi.fn(),
    onDeleteSession: vi.fn(),
    onForkSession: vi.fn(async () => undefined)
  })
  const context = invocation(
    createSession({
      packageOrigin: {
        importId: 'receipt',
        sourceProjectId: 'source',
        sourceSessionId: 'source',
        importedAt: 1,
        manifestChecksum: 'a'.repeat(64)
      }
    })
  )
  const [entry] = resolveActionMenuEntries(
    {
      identityKey: 'session-1',
      catalog: SESSION_ACTION_CATALOG,
      recipe: [{ kind: 'action', action: 'fork' }],
      bindings
    },
    context
  )
  expect(entry).toMatchObject({ disabled: state.disabled })
  if (state.disabled) expect(entry).toHaveProperty('disabledDescription', expect.any(String))
})

it.each([undefined, false] as const)(
  'keeps diagnostics available with contentLoaded=%s when storage and ordinary exports are blocked',
  async (contentLoaded) => {
    const onExportDiagnostics = vi.fn()
    const bindings = createSessionActionBindings({
      canMutateConversations: false,
      canDeleteConversations: false,
      canDownloadArtifacts: false,
      packageBusy: true,
      onTogglePin: vi.fn(),
      onRenameSession: vi.fn(),
      onDownloadArtifacts: vi.fn(),
      onViewNotebook: vi.fn(),
      onDeleteSession: vi.fn(),
      onExportDiagnostics
    })
    const context = invocation(createSession({ status: 'running', messages: [], contentLoaded }))
    expect(bindings['export-diagnostics'].hidden).toBe(false)
    expect(bindings['export-diagnostics'].disabled).toBeUndefined()
    await bindings['export-diagnostics'].execute(context)
    expect(onExportDiagnostics).toHaveBeenCalledWith(context.session)
  }
)

it.each([
  { status: 'running', activeRun: { promptMessageId: 'message-1', startedAt: 1 } },
  { status: 'waiting-permission' },
  { status: 'waiting-for-user' },
  {
    status: 'waiting-plan-approval',
    runtimeContext: {
      version: 1,
      revision: 1,
      plan: {
        artifactId: 'plan',
        artifactVersionId: 'version',
        artifactChecksum: 'a'.repeat(64),
        approval: 'pending',
        stepStatuses: {}
      }
    }
  }
] satisfies Partial<ChatSession>[])(
  'offers imported exports without weakening fork or live-transfer admission: %j',
  async (history) => {
    const imported = createSession({
      ...history,
      packageOrigin: {
        importId: 'import-1',
        sourceProjectId: 'source-project',
        sourceSessionId: 'source-session',
        importedAt: 1,
        manifestChecksum: 'a'.repeat(64)
      }
    })
    const options = {
      canMutateConversations: true,
      canDeleteConversations: true,
      canDownloadArtifacts: true,
      onTogglePin: vi.fn(),
      onRenameSession: vi.fn(),
      onDownloadArtifacts: vi.fn(),
      onViewNotebook: vi.fn(),
      onDeleteSession: vi.fn(),
      onExportSession: vi.fn(),
      onExportPackage: vi.fn(async () => undefined),
      onForkSession: vi.fn(async () => undefined)
    }
    const entriesFor = (
      session: ChatSession,
      overrides: Partial<typeof options> & { packageBusy?: boolean } = {}
    ): ReturnType<typeof resolveActionMenuEntries> =>
      resolveActionMenuEntries(
        {
          identityKey: session.id,
          catalog: SESSION_ACTION_CATALOG,
          recipe: [
            { kind: 'action', action: 'export' },
            { kind: 'action', action: 'export-package' },
            { kind: 'action', action: 'fork' }
          ],
          bindings: createSessionActionBindings({ ...options, ...overrides })
        },
        invocation(session)
      )
    expect(entriesFor(imported)).toMatchObject([
      { disabled: false },
      { disabled: false },
      { disabled: true }
    ])
    const bindings = createSessionActionBindings(options)
    await bindings.export.execute(invocation(imported))
    await bindings['export-package'].execute(invocation(imported))
    expect(options.onExportSession).toHaveBeenCalledWith(imported)
    expect(options.onExportPackage).toHaveBeenCalledWith(imported)
    expect(entriesFor({ ...imported, packageOrigin: undefined })).toMatchObject([
      { disabled: true },
      { disabled: true },
      { disabled: true }
    ])
    for (const live of [{ agentPromptInFlight: true }, { compacting: true }])
      expect(entriesFor({ ...imported, ...live })).toMatchObject([
        { disabled: true },
        { disabled: true },
        { disabled: true }
      ])
    expect(entriesFor(imported, { packageBusy: true })[1]).toMatchObject({ disabled: true })
    expect(entriesFor(imported, { canMutateConversations: false })[1]).toMatchObject({
      disabled: true
    })
    expect(entriesFor({ ...imported, messages: [] })[0]).toMatchObject({ disabled: true })
  }
)
