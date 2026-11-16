// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ScheduleView } from '../../../../../shared/session-schedules'
import { useScheduleSelection } from './use-schedule-selection'

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  hydrate: vi.fn(),
  open: vi.fn(),
  preview: vi.fn(),
  history: vi.fn(),
  notebook: vi.fn(),
  upsert: vi.fn(),
  activate: vi.fn(),
  focus: vi.fn(),
  extraSessions: [] as unknown[],
  nav: { explicitNavigationRevision: 0, userNavigationRevision: 0 },
  session: { id: 's', projectId: 'p', contentLoaded: false, cwd: '/workspace' },
  changed: undefined as undefined | ((event: { projectId: string; sessionId: string }) => void)
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/lib/session-persistence/session-persistence', () => ({
  loadPersistedSession: mocks.load,
  hydratePersistedSessionIfPresent: mocks.hydrate
}))
vi.mock('@/stores/navigation-store', () => ({
  useNavigationStore: { getState: () => ({ ...mocks.nav, openSession: mocks.open }) }
}))
vi.mock('@/stores/session-store', () => ({
  useSessionStore: {
    getState: () => ({
      sessions: [mocks.session, ...mocks.extraSessions],
      upsertPersistedSession: mocks.upsert,
      activateMessageBranch: mocks.activate
    })
  }
}))
vi.mock('@/stores/preview-workbench-store', () => ({
  createNotebookPreviewItem: (reference: unknown) => reference,
  usePreviewWorkbenchStore: { getState: () => ({ upsertAndActivateItem: mocks.preview }) }
}))
vi.mock('@/stores/search-message-focus-store', () => ({
  useSearchMessageFocusStore: { getState: () => ({ request: mocks.focus }) }
}))

const task: ScheduleView = {
  id: 'job',
  target: { projectId: 'p', sessionId: 's', agentFrameId: 'f', messageBranchId: 'b' },
  revision: 1,
  originPromptId: null,
  nextDueAt: 100,
  finishedAt: null,
  pausedAt: null,
  pauseReason: null,
  draft: {
    name: 'Check',
    rule: { kind: 'once', at: 100, timeZone: 'UTC' },
    action: { kind: 'run_script', language: 'python', code: 'print(42)' }
  }
}
const previousApi = Object.getOwnPropertyDescriptor(window, 'api')
beforeEach(() => {
  vi.resetAllMocks()
  mocks.nav.explicitNavigationRevision = 0
  mocks.extraSessions = []
  mocks.session.contentLoaded = false
  mocks.open.mockImplementation(() => {
    mocks.nav.explicitNavigationRevision++
    return true
  })
  mocks.history.mockResolvedValue([{ scheduledAt: 1, status: 'succeeded', scriptRunId: 'run' }])
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      schedules: {
        history: mocks.history,
        onChanged: (fn: typeof mocks.changed) => {
          mocks.changed = fn
          return () => {
            mocks.changed = undefined
          }
        }
      },
      notebook: { getReference: mocks.notebook }
    }
  })
})
afterEach(() => {
  cleanup()
  if (previousApi) Object.defineProperty(window, 'api', previousApi)
  else Reflect.deleteProperty(window, 'api')
})

it('does not navigate after a newer user intent supersedes session hydration', async () => {
  const loaded = Promise.withResolvers<unknown>()
  mocks.load.mockReturnValue(loaded.promise)
  const { result } = renderHook(() => useScheduleSelection())
  act(() => result.current.select(task))
  await waitFor(() => expect(mocks.load).toHaveBeenCalledOnce())
  mocks.nav.explicitNavigationRevision++
  await act(async () => {
    loaded.resolve(mocks.session)
  })
  expect(mocks.hydrate).not.toHaveBeenCalled()
  expect(mocks.open).not.toHaveBeenCalled()
})

it('does not reopen a late Notebook result or repeat navigation after history refresh', async () => {
  const reference = Promise.withResolvers<unknown>()
  mocks.session.contentLoaded = true
  mocks.notebook.mockReturnValue(reference.promise)
  const { result, unmount } = renderHook(() => useScheduleSelection())
  act(() => result.current.select(task))
  await waitFor(() => expect(mocks.notebook).toHaveBeenCalledOnce())
  mocks.nav.explicitNavigationRevision++
  await act(async () => {
    reference.resolve({ sessionId: 's' })
  })
  expect(mocks.preview).not.toHaveBeenCalled()
  await act(async () => {
    for (let i = 0; i < 32; i++) mocks.changed?.({ projectId: 'p', sessionId: 's' })
  })
  expect(mocks.history).toHaveBeenCalledOnce()
  expect(mocks.open).toHaveBeenCalledOnce()
  unmount()
  expect(mocks.changed).toBeUndefined()
})

it('opens a cold independent run through the shared loader and selects its attributed branch', async () => {
  const attribution = { feature: 'schedule', scheduleId: 'job', scheduledAt: 123 }
  const prompt = { id: 'wake', introducedOnBranchId: 'run-branch', attribution }
  const session = {
    id: 'run-session',
    projectId: 'p',
    messages: [prompt],
    conversationGraph: {
      activeFrameId: 'frame',
      frames: [{ id: 'frame', activeBranchId: 'run-branch' }],
      branches: [{ id: 'run-branch', agentFrameId: 'frame' }],
      messages: [prompt]
    }
  }
  mocks.load.mockResolvedValue(session)
  mocks.upsert.mockImplementation((persisted) => mocks.extraSessions.push(persisted))
  const independent = {
    ...task,
    target: { projectId: 'p', sessionId: null, agentFrameId: null, messageBranchId: null },
    draft: { ...task.draft, action: { kind: 'send_session_message' as const, message: 'Review' } }
  }
  const { result } = renderHook(() => useScheduleSelection())
  act(() => result.current.select(independent, undefined, 123, 'run-session'))
  await waitFor(() =>
    expect(mocks.focus).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'run-session', messageId: 'wake' })
    )
  )
  expect(mocks.upsert).toHaveBeenCalledOnce()
  expect(mocks.history).not.toHaveBeenCalled()
  expect(result.current.error).toBe('')
})

it('coalesces repeated clicks while the same conversation is loading', async () => {
  const pending = Promise.withResolvers<undefined>()
  mocks.load.mockReturnValue(pending.promise)
  const { result } = renderHook(() => useScheduleSelection())
  act(() => result.current.select(task, 'run'))
  await waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(1))
  act(() => result.current.select(task, 'run'))
  expect(mocks.load).toHaveBeenCalledTimes(1)
  await act(async () => pending.resolve(undefined))
  // A settled request must not prevent a deliberate retry.
  act(() => result.current.select(task, 'run'))
  await waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(2))
})

it.each(['conversation', 'notebook'])(
  'discards late %s load failures after navigating elsewhere',
  async (stage) => {
    const pending = Promise.withResolvers<never>()
    const read = stage === 'conversation' ? mocks.load : mocks.notebook
    mocks.session.contentLoaded = stage === 'notebook'
    read.mockReturnValue(pending.promise)
    const { result } = renderHook(() => useScheduleSelection())
    act(() => result.current.select(task, 'run'))
    await waitFor(() => expect(read).toHaveBeenCalledOnce())
    mocks.nav.explicitNavigationRevision++
    await act(async () => pending.reject(new Error('Late read failure')))
    expect(result.current.error).toBe('')
  }
)
