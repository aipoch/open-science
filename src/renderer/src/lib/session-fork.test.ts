// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { forkSession } from './session-fork'
import { flushSessionPersistence } from './session-persistence/session-persistence'
import { usePackageOperationStore } from '@/stores/package-operation-store'
const { openSession, navigation } = vi.hoisted(() => ({
  openSession: vi.fn(),
  navigation: { explicitNavigationRevision: 0 }
}))
vi.mock('@/stores/navigation-store', () => ({
  useNavigationStore: { getState: () => ({ openSession, ...navigation }) }
}))
vi.mock('./acp/useWorkspaceAgentRuntime', () => ({
  drainWorkspaceRuntimeEventsForPersistence: vi.fn(async () => undefined)
}))
vi.mock('./session-persistence/session-persistence', () => ({
  flushSessionPersistence: vi.fn(async () => undefined)
}))
vi.mock('@/i18n', () => ({ i18next: { t: (key: string) => key } }))
beforeEach(() => {
  navigation.explicitNavigationRevision = 0
  usePackageOperationStore.setState({ operation: null, importError: undefined, open: false })
})
afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})
it('flushes before copying an unopened Session and opens the published child', async () => {
  let release!: () => void
  vi.mocked(flushSessionPersistence).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
  )
  const fork = vi.fn(async () => ({ projectId: 'project', sessionId: 'child' }))
  vi.stubGlobal('api', { sessions: { fork } })
  const pending = forkSession({ projectId: 'project', id: 'source' })
  await vi.waitFor(() => expect(flushSessionPersistence).toHaveBeenCalled())
  expect(fork).not.toHaveBeenCalled()
  release()
  await pending
  expect(fork).toHaveBeenCalledWith({ projectId: 'project', sessionId: 'source' })
  expect(openSession).toHaveBeenCalledWith('project', 'child', 'user')
})
it('preserves newer navigation and leaves the completed fork accessible', async () => {
  let release!: (identity: { projectId: string; sessionId: string }) => void
  const fork = vi.fn(
    () =>
      new Promise<{ projectId: string; sessionId: string }>((resolve) => {
        release = resolve
      })
  )
  vi.stubGlobal('api', { sessions: { fork } })
  const pending = forkSession({ projectId: 'project', id: 'source' })
  await vi.waitFor(() => expect(fork).toHaveBeenCalled())
  navigation.explicitNavigationRevision += 1
  const operation = {
    id: 'operation',
    kind: 'fork' as const,
    state: 'succeeded' as const,
    progress: { phase: 'importing' as const },
    result: { imported: { projectId: 'project', sessionId: 'child' } }
  }
  usePackageOperationStore.setState({ operation, open: true })
  release(operation.result.imported)
  await pending
  expect(openSession).not.toHaveBeenCalled()
  expect(usePackageOperationStore.getState().operation).toEqual(operation)
  expect(usePackageOperationStore.getState().open).toBe(true)
})
it('opens the fork while preserving progress when cleanup is pending', async () => {
  vi.stubGlobal('api', {
    sessions: {
      fork: vi.fn(async () => {
        usePackageOperationStore.setState({
          open: true,
          operation: {
            id: 'operation',
            kind: 'fork',
            state: 'succeeded',
            progress: { phase: 'cleaning' },
            cleanupPending: true
          }
        })
        return { projectId: 'project', sessionId: 'child' }
      })
    }
  })
  await forkSession({ projectId: 'project', id: 'source' })
  expect(openSession).toHaveBeenCalledWith('project', 'child', 'user')
  expect(usePackageOperationStore.getState().open).toBe(true)
})
it('shows a pre-admission failure instead of silently ignoring the click', async () => {
  const fork = vi.fn(async () => {
    throw new Error('Session is still running')
  })
  vi.stubGlobal('api', { sessions: { fork, packageOperation: vi.fn(async () => null) } })
  await forkSession({ projectId: 'project', id: 'source' })
  expect(usePackageOperationStore.getState().importError).toBe('Session is still running')
  expect(usePackageOperationStore.getState().errorKind).toBe('fork')
  expect(openSession).not.toHaveBeenCalled()
})
it('uses the owned failure surface and preserves its recovery identity', async () => {
  const snapshot = {
    id: 'operation',
    kind: 'fork' as const,
    state: 'failed' as const,
    progress: { phase: 'importing' as const },
    error: 'Recovery required',
    result: {
      recovery: {
        projectId: 'project',
        sessionId: 'child',
        operationId: 'journal',
        outcome: 'committed' as const
      }
    }
  }
  vi.stubGlobal('api', {
    sessions: {
      fork: vi.fn(async () => {
        throw new Error('Recovery required')
      }),
      packageOperation: vi.fn(async () => snapshot)
    }
  })
  await forkSession({ projectId: 'project', id: 'source' })
  expect(usePackageOperationStore.getState().operation).toEqual(snapshot)
  expect(usePackageOperationStore.getState().open).toBe(true)
  expect(usePackageOperationStore.getState().importError).toBeUndefined()
})
