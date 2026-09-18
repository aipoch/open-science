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
