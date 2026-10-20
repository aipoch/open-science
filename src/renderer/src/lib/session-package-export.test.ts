// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { exportSessionPackage } from './session-package-export'
import { drainWorkspaceRuntimeEventsForPersistence } from './acp/useWorkspaceAgentRuntime'
import { flushSessionPersistence } from './session-persistence/session-persistence'
import { usePackageOperationStore } from '@/stores/package-operation-store'
import type { ChatSession } from '@/stores/session-store'
vi.mock('./acp/useWorkspaceAgentRuntime', () => ({
  drainWorkspaceRuntimeEventsForPersistence: vi.fn(async () => undefined)
}))
vi.mock('./session-persistence/session-persistence', () => ({
  flushSessionPersistence: vi.fn(async () => undefined)
}))
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
it('drains runtime events and pending saves before requesting the export reservation', async () => {
  usePackageOperationStore.setState({ operation: null })
  let release!: () => void
  vi.mocked(flushSessionPersistence).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
  )
  const exportPackage = vi.fn(async () => ({ saved: false }))
  vi.stubGlobal('api', { sessions: { exportPackage } })
  const session: ChatSession = {
    id: 'session',
    projectId: 'project',
    title: 'Study',
    cwd: '',
    status: 'idle',
    messages: [],
    createdAt: 1,
    updatedAt: 1
  }
  const pending = exportSessionPackage(session)
  await vi.waitFor(() => expect(flushSessionPersistence).toHaveBeenCalled())
  expect(drainWorkspaceRuntimeEventsForPersistence).toHaveBeenCalledWith('session')
  expect(exportPackage).not.toHaveBeenCalled()
  release()
  await pending
  expect(exportPackage).toHaveBeenCalledWith({ projectId: 'project', sessionId: 'session' })
})

it.each([
  { status: 'error', allowed: true },
  { status: 'idle', allowed: true },
  { status: 'running', allowed: false },
  { status: 'waiting-permission', allowed: false },
  { status: 'waiting-for-user', allowed: false },
  { status: 'waiting-plan-approval', allowed: false },
  { status: 'error', activeRun: { promptMessageId: 'prompt', startedAt: 1 }, allowed: false },
  { status: 'error', compacting: true, allowed: false },
  { status: 'error', agentPromptInFlight: true, allowed: false }
] satisfies (Partial<ChatSession> & { allowed: boolean })[])(
  'exports by activity instead of the legacy result: %j',
  async ({ allowed, ...overrides }) => {
    usePackageOperationStore.setState({ operation: null })
    const exportPackage = vi.fn(async () => ({ saved: false }))
    vi.stubGlobal('api', { sessions: { exportPackage } })
    await exportSessionPackage({
      id: 'session',
      projectId: 'project',
      title: 'Study',
      cwd: '',
      messages: [],
      createdAt: 1,
      updatedAt: 1,
      ...overrides
    })
    expect(exportPackage).toHaveBeenCalledTimes(allowed ? 1 : 0)
  }
)

it('forwards imported history with a pending Plan without enabling live execution', async () => {
  usePackageOperationStore.setState({ operation: null })
  const exportPackage = vi.fn(async () => ({ saved: false }))
  vi.stubGlobal('api', { sessions: { exportPackage } })
  const session: ChatSession = {
    id: 'session',
    projectId: 'project',
    title: 'Imported',
    cwd: '',
    status: 'waiting-plan-approval',
    messages: [],
    createdAt: 1,
    updatedAt: 1,
    packageOrigin: {
      importId: 'import-1',
      sourceProjectId: 'source-project',
      sourceSessionId: 'source-session',
      importedAt: 1,
      manifestChecksum: 'a'.repeat(64)
    },
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
  await exportSessionPackage(session)
  expect(exportPackage).toHaveBeenCalledOnce()
  expect(session.runtimeContext?.plan?.approval).toBe('pending')
})
