// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SessionPersistenceFlushRequest } from '../../../shared/session-persistence-flush'
import { useDesktopRuntimeRecoveryStore } from '../stores/desktop-runtime-recovery-store'
import {
  createInitialSessionState,
  toPersistedSession,
  useSessionStore
} from '../stores/session-store'
import type { PersistedChatSession } from '../../../shared/session-persistence'
import {
  resetSessionPersistenceWriteFailuresForTests,
  assertSessionPersistenceSavedForRecoveryRestart,
  saveSessionInOrder,
  loadPersistedSession,
  hydratePersistedSessionIfPresent,
  useSessionPersistence
} from '../lib/session-persistence/session-persistence'
import { resetWorkspaceRuntimeEventOwnerForTests } from '../lib/acp/workspace-runtime-event-owner'
import { resetSessionConversationIntentsForTests } from '../stores/session-conversation-intents'
import {
  configureComposerDraftStorage,
  registerComposerDraftWriter,
  revokeComposerDraftStorage,
  writeComposerDraft
} from '../pages/workspace/composer-draft-storage'
import { useQuitPersistenceFlush } from './useQuitPersistenceFlush'

beforeEach(() => {
  useSessionStore.setState(createInitialSessionState())
  resetSessionPersistenceWriteFailuresForTests()
  resetSessionConversationIntentsForTests()
  resetWorkspaceRuntimeEventOwnerForTests()
})

const installBridge = (): {
  remote: ReturnType<typeof vi.fn>
  acknowledge: ReturnType<typeof vi.fn>
  request(value: SessionPersistenceFlushRequest): void
} => {
  const remote = vi.fn(async () => {
    throw new Error('Local service unavailable')
  })
  const acknowledge = vi.fn()
  let request!: (value: SessionPersistenceFlushRequest) => void
  window.api = {
    acp: { getState: remote },
    preview: { save: remote, load: remote },
    sessions: {
      saveSession: remote,
      saveManifest: remote,
      onFlushRequest: (listener: typeof request) => {
        request = listener
        return () => {}
      },
      sendFlushResponse: acknowledge
    }
  } as unknown as Window['api']
  return { remote, acknowledge, request: (value) => request(value) }
}

const savedSession = (): PersistedChatSession => ({
  id: 'session',
  projectId: 'project',
  cwd: '/workspace',
  title: 'Saved',
  status: 'idle',
  messages: [],
  createdAt: 1,
  updatedAt: 1
})

afterEach(() => {
  cleanup()
  revokeComposerDraftStorage()
  useDesktopRuntimeRecoveryStore.setState({ phase: 'connected', epoch: 0, closing: false })
  vi.restoreAllMocks()
})

it('blocks offline restart while a remote Session write is still unacknowledged', async () => {
  useDesktopRuntimeRecoveryStore.setState({ phase: 'connected', epoch: 0, closing: false })
  const bridge = installBridge()
  const pending = Promise.withResolvers<PersistedChatSession>()
  const save = vi.fn(() => pending.promise)
  window.api.sessions.saveSession = save
  const submitted = savedSession()
  const writing = saveSessionInOrder(submitted).catch(() => undefined)
  try {
    await waitFor(() => expect(save).toHaveBeenCalledOnce())
    useDesktopRuntimeRecoveryStore.setState({ phase: 'unavailable', epoch: 1, closing: false })
    renderHook(() => useQuitPersistenceFlush())
    await act(async () => bridge.request({ requestId: 'pending', purpose: 'recovery-restart' }))
    expect(bridge.acknowledge).toHaveBeenCalledWith({ requestId: 'pending', status: 'failed' })
    expect(bridge.remote).not.toHaveBeenCalled()
    expect(save).toHaveBeenCalledOnce()
  } finally {
    pending.resolve(submitted)
    await writing
  }
})

it('retains failed write evidence when disconnection invalidates scheduled Session saves', async () => {
  useDesktopRuntimeRecoveryStore.setState({ phase: 'connected', epoch: 0, closing: false })
  const bridge = installBridge()
  window.api.sessions.saveSession = vi.fn(async () => {
    throw new Error('disk full')
  })
  await expect(saveSessionInOrder(savedSession())).rejects.toThrow('disk full')
  window.api.sessions.loadOne = vi.fn(async () => ({ ...savedSession(), revision: 1 }))
  await loadPersistedSession({ projectId: 'project', sessionId: 'session' }, window.api.sessions, {
    bypassCache: true
  })
  useDesktopRuntimeRecoveryStore.setState({ phase: 'unavailable', epoch: 1, closing: false })
  renderHook(() => {
    useSessionPersistence()
    return useQuitPersistenceFlush()
  })
  await act(async () => bridge.request({ requestId: 'failed', purpose: 'recovery-restart' }))
  expect(bridge.acknowledge).toHaveBeenCalledWith({ requestId: 'failed', status: 'failed' })
  expect(bridge.remote).not.toHaveBeenCalled()
})

it('does not mistake a retained unsaved title for durable Session authority', async () => {
  useDesktopRuntimeRecoveryStore.setState({ phase: 'connected', epoch: 0, closing: false })
  const bridge = installBridge()
  useSessionStore.getState().hydrateSessions([savedSession()])
  const snapshot = toPersistedSession(useSessionStore.getState().sessions[0]!)
  window.api.sessions.saveSession = vi.fn(async (value) => value)
  await saveSessionInOrder(snapshot)
  useSessionStore.setState((state) => ({
    sessions: state.sessions.map((session) => ({ ...session, unsavedTitle: true as const }))
  }))
  useDesktopRuntimeRecoveryStore.setState({ phase: 'unavailable', epoch: 1, closing: false })
  renderHook(() => useQuitPersistenceFlush())
  await act(async () => bridge.request({ requestId: 'dirty', purpose: 'recovery-restart' }))
  expect(bridge.acknowledge).toHaveBeenCalledWith({ requestId: 'dirty', status: 'failed' })
  expect(bridge.remote).not.toHaveBeenCalled()
})

it('accepts an acknowledged Session without writing it again during offline restart', async () => {
  useDesktopRuntimeRecoveryStore.setState({ phase: 'connected', epoch: 0, closing: false })
  const bridge = installBridge()
  useSessionStore.getState().hydrateSessions([savedSession()])
  const snapshot = toPersistedSession(useSessionStore.getState().sessions[0]!)
  const save = vi.fn(async (value: PersistedChatSession) => value)
  window.api.sessions.saveSession = save
  const durable = await saveSessionInOrder(snapshot)
  expect(toPersistedSession(useSessionStore.getState().sessions[0]!)).toMatchObject({
    title: durable.title,
    messages: durable.messages
  })
  useDesktopRuntimeRecoveryStore.setState({ phase: 'unavailable', epoch: 1, closing: false })
  expect(() => assertSessionPersistenceSavedForRecoveryRestart()).not.toThrow()
  renderHook(() => useQuitPersistenceFlush())
  await act(async () => bridge.request({ requestId: 'clean-session', purpose: 'recovery-restart' }))
  expect(bridge.acknowledge).toHaveBeenCalledWith({
    requestId: 'clean-session',
    status: 'completed'
  })
  expect(save).toHaveBeenCalledOnce()
  expect(bridge.remote).not.toHaveBeenCalled()
})

it('accepts durable lazy-loaded Session authority without requiring a renderer write receipt', async () => {
  useDesktopRuntimeRecoveryStore.setState({ phase: 'connected', epoch: 0, closing: false })
  const bridge = installBridge()
  const durable = { ...savedSession(), id: 'lazy-loaded-session', revision: 1 }
  useSessionStore.getState().hydrateSessions([durable])
  useSessionStore.setState((state) => ({
    sessions: state.sessions.map((session) => ({ ...session, contentLoaded: false }))
  }))
  window.api.sessions.loadOne = vi.fn(async () => durable)
  const loaded = await loadPersistedSession({ projectId: durable.projectId, sessionId: durable.id })
  hydratePersistedSessionIfPresent(loaded!)
  useSessionStore.getState().setBranchSwitchBlocked(durable.id, true)
  useSessionStore.getState().setBranchSwitchBlocked(durable.id, false)
  useDesktopRuntimeRecoveryStore.setState({ phase: 'unavailable', epoch: 1, closing: false })
  expect(() => assertSessionPersistenceSavedForRecoveryRestart()).not.toThrow()
  renderHook(() => useQuitPersistenceFlush())
  await act(async () =>
    bridge.request({ requestId: 'read-authority', purpose: 'recovery-restart' })
  )
  expect(bridge.acknowledge).toHaveBeenCalledWith({
    requestId: 'read-authority',
    status: 'completed'
  })
  expect(bridge.remote).not.toHaveBeenCalled()
})

it('saves a clean local draft for offline recovery restart without requesting runtime snapshots or remote writes', async () => {
  useSessionStore.setState(createInitialSessionState())
  useDesktopRuntimeRecoveryStore.setState({ phase: 'unavailable', epoch: 1, closing: false })
  configureComposerDraftStorage('offline-restart', 'profile')
  const unregister = registerComposerDraftWriter(() =>
    writeComposerDraft('project', 'session', {
      doc: { nodes: [{ type: 'text', text: 'Offline retained draft' }] },
      annotations: [],
      attachments: [],
      attachmentTransfers: [],
      automaticReadingEnabled: false
    })
  )
  const { remote, acknowledge, request } = installBridge()
  try {
    renderHook(() => useQuitPersistenceFlush())
    await act(async () => request({ requestId: 'offline', purpose: 'recovery-restart' }))
    await waitFor(() =>
      expect(acknowledge).toHaveBeenCalledWith({ requestId: 'offline', status: 'completed' })
    )
    expect(remote).not.toHaveBeenCalled()
    expect(localStorage.getItem('open-science-composer-drafts-v1')).toContain(
      'Offline retained draft'
    )
  } finally {
    unregister()
  }
})
