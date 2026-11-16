// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { PersistedToolActivity } from '../../../../../shared/session-message-contract'
import type { ScheduleView } from '../../../../../shared/session-schedules'
import {
  subscribeScheduleHistory,
  useSchedules,
  useScheduleRunSession,
  useScheduleDetail
} from './use-schedules'
import { ScheduleRunPanel } from './ScheduleRunPanel'
import { ScheduleStarterPanel } from './ScheduleStarterPanel'
import {
  ScheduleCardsProvider,
  SessionScheduleBanner,
  ScheduleMessageCards
} from './ScheduleMessageCard'
import type { ChatMessage } from '@/stores/session-store'
vi.mock('@/components/ui/resizable', () => ({
  ResizablePanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))
import { ScheduleTiming } from './SchedulePage'
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } })
}))
vi.mock('@/stores/session-store', () => ({
  useSessionStore: (select: (state: { sessions: unknown[] }) => unknown) => select({ sessions: [] })
}))
const task: ScheduleView = {
  id: 'pending',
  revision: 1,
  target: { projectId: 'p', sessionId: 's', agentFrameId: 'f', messageBranchId: 'b' },
  originPromptId: null,
  nextDueAt: null,
  pausedAt: null,
  finishedAt: null,
  pauseReason: null,
  draft: {
    name: 'Queued',
    rule: { kind: 'once', at: 123, timeZone: 'UTC' },
    action: { kind: 'send_session_message', message: 'Queued' }
  },
  currentRun: {
    status: 'dispatching',
    scheduledAt: 123,
    reason: null,
    runSessionId: null,
    scriptRunId: null
  }
}
afterEach(cleanup)

it('shows the actual pending or running occurrence independently of the next cursor', () => {
  const { rerender } = render(<ScheduleTiming task={task} />)
  expect(screen.getByText('Pending')).toBeTruthy()
  expect(screen.queryByText('Running')).toBeNull()
  rerender(
    <ScheduleTiming
      task={{ ...task, nextDueAt: 180000, currentRun: { ...task.currentRun!, status: 'admitted' } }}
    />
  )
  expect(screen.getByText('Running')).toBeTruthy()
  expect(screen.getByText(/Next run/)).toBeTruthy()
})

it('shares project reads, coalesces in-flight changes, retains data on failure and cleans up', async () => {
  const original = Object.getOwnPropertyDescriptor(window, 'api')
  const initial = Promise.withResolvers<ScheduleView[]>()
  const list = vi.fn().mockReturnValueOnce(initial.promise).mockResolvedValue([task])
  const listeners = new Set<(event: { projectId: string; sessionId: string | null }) => void>()
  const onChanged = vi.fn(
    (fn: (event: { projectId: string; sessionId: string | null }) => void) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    }
  )
  const emit = (projectId = 'p'): void =>
    listeners.forEach((fn) => fn({ projectId, sessionId: 's' }))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { schedules: { list, onChanged } }
  })
  try {
    const sidebar = renderHook(() => useSchedules('p'))
    const card = renderHook(({ sessionId }) => useSchedules('p', sessionId), {
      initialProps: { sessionId: 's' }
    })
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1))
    expect(onChanged).toHaveBeenCalledTimes(1)
    await act(async () => {
      for (let i = 0; i < 32; i++) emit()
    })
    expect(list).toHaveBeenCalledTimes(1)
    await act(async () => initial.resolve([task]))
    expect(list).toHaveBeenCalledTimes(2)
    expect(sidebar.result.current.tasks).toEqual([task])
    expect(card.result.current.tasks).toEqual([task])
    list.mockRejectedValueOnce(new Error('Temporary read failure'))
    await act(async () => emit())
    expect(card.result.current.tasks).toEqual([task])
    expect(card.result.current.error).toContain('Temporary read failure')
    card.rerender({ sessionId: 'other' })
    expect(card.result.current.tasks).toEqual([])
    expect(sidebar.result.current.tasks).toEqual([task])
    await act(async () => sidebar.result.current.refresh())
    expect(sidebar.result.current.error).toBe('')
    const calls = list.mock.calls.length
    await act(async () => emit('another-project'))
    expect(list).toHaveBeenCalledTimes(calls)
    sidebar.unmount()
    expect(listeners.size).toBe(1)
    await act(async () => card.unmount())
    expect(listeners.size).toBe(0)
    const late = Promise.withResolvers<ScheduleView[]>()
    list.mockReturnValueOnce(late.promise)
    const reloaded = renderHook(({ projectId }) => useSchedules(projectId), {
      initialProps: { projectId: 'p' }
    })
    await waitFor(() => expect(list).toHaveBeenCalledTimes(calls + 1))
    list.mockResolvedValue([])
    reloaded.rerender({ projectId: 'new' })
    await act(async () => late.resolve([task]))
    expect(reloaded.result.current.tasks).toEqual([])
    await act(async () => reloaded.unmount())
    expect(listeners.size).toBe(0)
  } finally {
    cleanup()
    if (original) Object.defineProperty(window, 'api', original)
    else Reflect.deleteProperty(window, 'api')
  }
})

it('bounds detail history reads and suppresses invalidated or unmounted responses', async () => {
  const original = Object.getOwnPropertyDescriptor(window, 'api')
  const listeners = new Set<(event: { projectId: string; sessionId: string | null }) => void>()
  const history = vi.fn().mockResolvedValue([])
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      schedules: {
        list: async () => [],
        history,
        onChanged: (fn: (event: { projectId: string; sessionId: string | null }) => void) => {
          listeners.add(fn)
          return () => listeners.delete(fn)
        }
      }
    }
  })
  const emit = (sessionId: string | null = null): void =>
    listeners.forEach((fn) => fn({ projectId: 'p', sessionId }))
  try {
    const panel = render(
      <ScheduleRunPanel
        task={{
          ...task,
          target: {
            projectId: task.target.projectId,
            sessionId: null,
            agentFrameId: null,
            messageBranchId: null
          }
        }}
        onOpenSession={() => {}}
      />
    )
    await waitFor(() => expect(history).toHaveBeenCalledTimes(1))
    await act(async () => {
      for (let i = 0; i < 32; i++) emit()
    })
    expect(history).toHaveBeenCalledTimes(2)
    await act(async () => panel.unmount())
    expect(listeners.size).toBe(0)

    const rows = vi.fn(),
      error = vi.fn()
    const delayed = Promise.withResolvers<[]>()
    history.mockReturnValueOnce(delayed.promise)
    const stop = subscribeScheduleHistory(
      { projectId: 'p', sessionId: null, scheduleId: 'job' },
      rows,
      error
    )
    await waitFor(() => expect(history).toHaveBeenCalledTimes(3))
    for (let i = 0; i < 32; i++) emit()
    history.mockResolvedValueOnce([])
    delayed.resolve([])
    await waitFor(() => expect(history).toHaveBeenCalledTimes(4))
    expect(rows).toHaveBeenCalledTimes(1)
    emit('unrelated-session')
    expect(history).toHaveBeenCalledTimes(4)
    history.mockRejectedValueOnce(new Error('Read failed'))
    emit()
    await waitFor(() => expect(error).toHaveBeenCalledTimes(1))
    expect(rows).toHaveBeenCalledTimes(1)
    const late = Promise.withResolvers<[]>()
    history.mockReturnValueOnce(late.promise)
    emit()
    await waitFor(() => expect(history).toHaveBeenCalledTimes(6))
    stop()
    late.resolve([])
    await Promise.resolve()
    expect(rows).toHaveBeenCalledTimes(1)
    expect(listeners.size).toBe(0)
  } finally {
    cleanup()
    if (original) Object.defineProperty(window, 'api', original)
    else Reflect.deleteProperty(window, 'api')
  }
})

it('shares cold run reads and releases them when the last consumer leaves', async () => {
  const original = Object.getOwnPropertyDescriptor(window, 'api')
  const pending = Promise.withResolvers<undefined>()
  const loadOne = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined)
  Object.defineProperty(window, 'api', { configurable: true, value: { sessions: { loadOne } } })
  const run = { ...task.currentRun!, status: 'admitted' as const, runSessionId: 'run' }
  try {
    const first = renderHook(() => useScheduleRunSession('p', run))
    const second = renderHook(() => useScheduleRunSession('p', run))
    expect(loadOne).toHaveBeenCalledOnce()
    first.unmount()
    await act(async () => pending.resolve(undefined))
    expect(second.result.current).toBeUndefined()
    second.unmount()
    const third = renderHook(() => useScheduleRunSession('p', run))
    await waitFor(() => expect(loadOne).toHaveBeenCalledTimes(2))
    third.unmount()
  } finally {
    cleanup()
    if (original) Object.defineProperty(window, 'api', original)
    else Reflect.deleteProperty(window, 'api')
  }
})

it('reads a definition only for its revision and ignores superseded detail responses', async () => {
  const original = Object.getOwnPropertyDescriptor(window, 'api')
  const pending = Promise.withResolvers<ScheduleView>()
  const get = vi
    .fn()
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValue({ ...task, id: 'other' })
  Object.defineProperty(window, 'api', { configurable: true, value: { schedules: { get } } })
  const summary = {
    ...task,
    draft: { ...task.draft, action: { kind: 'send_session_message' as const } }
  }
  try {
    const hook = renderHook(({ value }) => useScheduleDetail(value), {
      initialProps: { value: summary }
    })
    expect(get).toHaveBeenCalledWith({ projectId: 'p', sessionId: 's', scheduleId: task.id })
    hook.rerender({ value: { ...summary, nextDueAt: 456 } })
    expect(get).toHaveBeenCalledOnce()
    hook.rerender({ value: { ...summary, id: 'other' } })
    await waitFor(() => expect(hook.result.current.detail?.id).toBe('other'))
    await act(async () => pending.resolve(task))
    expect(hook.result.current.detail?.id).toBe('other')
    hook.unmount()
  } finally {
    cleanup()
    if (original) Object.defineProperty(window, 'api', original)
    else Reflect.deleteProperty(window, 'api')
  }
})

it('keeps the last confirmed catalog while an invalidated response is replaced', async () => {
  const original = Object.getOwnPropertyDescriptor(window, 'api')
  const stale = Promise.withResolvers<ScheduleView[]>()
  const fresh = Promise.withResolvers<ScheduleView[]>()
  const list = vi
    .fn()
    .mockResolvedValueOnce([task])
    .mockReturnValueOnce(stale.promise)
    .mockReturnValueOnce(fresh.promise)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { schedules: { list, onChanged: () => () => {} } }
  })
  try {
    const hook = renderHook(() => useSchedules('p'))
    await waitFor(() => expect(hook.result.current.tasks).toEqual([task]))
    let refreshed!: Promise<boolean>
    await act(async () => {
      refreshed = hook.result.current.refresh()
    })
    const settled = vi.fn()
    void refreshed.then(settled)
    await act(async () => {
      expect(hook.result.current.refresh()).toBe(refreshed)
    })
    await act(async () => stale.resolve([]))
    expect(settled).not.toHaveBeenCalled()
    expect(list).toHaveBeenCalledTimes(3)
    expect(hook.result.current.tasks).toEqual([task])
    expect(hook.result.current.isEmpty).toBe(false)
    await act(async () => fresh.resolve([{ ...task, revision: 2 }]))
    expect(hook.result.current.tasks[0].revision).toBe(2)
    await expect(refreshed).resolves.toBe(true)
  } finally {
    cleanup()
    if (original) Object.defineProperty(window, 'api', original)
    else Reflect.deleteProperty(window, 'api')
  }
})

it('does not carry detail errors into another task or a retry', async () => {
  const original = Object.getOwnPropertyDescriptor(window, 'api')
  const pending = Promise.withResolvers<ScheduleView>()
  const get = vi
    .fn()
    .mockRejectedValueOnce(new Error('Unavailable'))
    .mockReturnValueOnce(pending.promise)
    .mockRejectedValueOnce(new Error('Retry needed'))
    .mockReturnValueOnce(pending.promise)
  Object.defineProperty(window, 'api', { configurable: true, value: { schedules: { get } } })
  const summary = {
    ...task,
    draft: { ...task.draft, action: { kind: 'send_session_message' as const } }
  }
  try {
    const hook = renderHook(({ value }) => useScheduleDetail(value), {
      initialProps: { value: summary }
    })
    await waitFor(() => expect(hook.result.current.error).toBeInstanceOf(Error))
    hook.rerender({ value: { ...summary, id: 'other' } })
    expect(hook.result.current.error).toBeUndefined()
    await act(async () => pending.resolve({ ...task, id: 'other' }))
    await act(async () => hook.result.current.refresh())
    await waitFor(() => expect(hook.result.current.error).toBeInstanceOf(Error))
    act(() => hook.result.current.refresh())
    expect(hook.result.current.error).toBeUndefined()
    await act(async () => {})
  } finally {
    cleanup()
    if (original) Object.defineProperty(window, 'api', original)
    else Reflect.deleteProperty(window, 'api')
  }
})

it('keeps the conversation mounted while entering and leaving a populated schedule panel', async () => {
  const original = Object.getOwnPropertyDescriptor(window, 'api')
  const list = vi.fn().mockResolvedValue([task])
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { schedules: { list, onChanged: () => () => {} } }
  })
  const conversation = <input aria-label="Conversation draft" defaultValue="Unsaved text" />
  const view = (active: boolean): React.JSX.Element => (
    <ScheduleStarterPanel projectId="p" active={active} onOpenTask={() => {}}>
      {conversation}
    </ScheduleStarterPanel>
  )
  try {
    const panel = render(view(false))
    const input = screen.getByRole('textbox')
    panel.rerender(view(true))
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('textbox')).toBe(input)
    panel.rerender(view(true))
    expect(list).toHaveBeenCalledTimes(1)
    panel.rerender(view(false))
    expect(screen.getByRole('textbox')).toBe(input)
  } finally {
    cleanup()
    if (original) Object.defineProperty(window, 'api', original)
    else Reflect.deleteProperty(window, 'api')
  }
})

it('reuses the loaded directory across synchronous conversation remounts', async () => {
  const original = Object.getOwnPropertyDescriptor(window, 'api')
  const list = vi.fn().mockResolvedValue([task])
  const unsubscribe = vi.fn()
  const onChanged = vi.fn(() => unsubscribe)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { schedules: { list, onChanged } }
  })
  try {
    const first = renderHook(() => useSchedules('p', 's'))
    await waitFor(() => expect(first.result.current.tasks).toHaveLength(1))
    first.unmount()
    const next = renderHook(() => useSchedules('p', 's'))
    expect(next.result.current.tasks).toEqual([task])
    await act(async () => {})
    expect(list).toHaveBeenCalledOnce()
    expect(onChanged).toHaveBeenCalledOnce()
    expect(unsubscribe).not.toHaveBeenCalled()
    await act(async () => next.unmount())
    expect(unsubscribe).toHaveBeenCalledOnce()
  } finally {
    cleanup()
    if (original) Object.defineProperty(window, 'api', original)
    else Reflect.deleteProperty(window, 'api')
  }
})

it('anchors stopped tasks to their own branch prompt while active tasks follow the latest reply', async () => {
  const original = Object.getOwnPropertyDescriptor(window, 'api')
  const stopped = {
    ...task,
    id: 'stopped',
    currentRun: undefined,
    finishedAt: 20,
    finishReason: 'cancelled',
    originPromptId: 'created',
    draft: { ...task.draft, name: 'Stopped task' }
  }
  const active = {
    ...task,
    id: 'active',
    currentRun: undefined,
    draft: { ...task.draft, name: 'Active task' }
  }
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { schedules: { list: async () => [stopped, active], onChanged: () => () => {} } }
  })
  const messages: ChatMessage[] = [
    {
      id: 'wake',
      status: 'complete',
      eventIds: [],
      updatedAt: 1,
      role: 'user',
      content: 'Wake',
      createdAt: 1,
      attribution: {
        kind: 'application',
        feature: 'schedule',
        purpose: 'scheduled-wake',
        occurrenceId: 'wake-run',
        scheduleId: 'stopped',
        scheduledAt: 1
      }
    }
  ]
  const view = (latest: string, branch: ChatMessage[] = messages): React.JSX.Element => (
    <ScheduleCardsProvider projectId="p" sessionId="s" messages={branch}>
      {['wake', 'later', 'newest'].map((promptId) => (
        <section key={promptId} aria-label={promptId}>
          <SessionScheduleBanner promptId={promptId} latest={promptId === latest} />
        </section>
      ))}
    </ScheduleCardsProvider>
  )
  try {
    const panel = render(view('later'))
    await waitFor(() =>
      expect(
        within(screen.getByRole('region', { name: 'wake' })).getByText('Stopped task')
      ).toBeTruthy()
    )
    expect(
      within(screen.getByRole('region', { name: 'later' })).getByText('Active task')
    ).toBeTruthy()
    panel.rerender(view('newest'))
    expect(
      within(screen.getByRole('region', { name: 'wake' })).getByText('Stopped task')
    ).toBeTruthy()
    expect(screen.getByRole('region', { name: 'later' }).textContent).toBe('')
    expect(
      within(screen.getByRole('region', { name: 'newest' })).getByText('Active task')
    ).toBeTruthy()
    panel.rerender(view('newest', []))
    expect(screen.queryByText('Stopped task')).toBeNull()
  } finally {
    cleanup()
    if (original) Object.defineProperty(window, 'api', original)
    else Reflect.deleteProperty(window, 'api')
  }
})

it('shows deleted receipts only after a successful scoped read and keeps them on their message', async () => {
  const original = Object.getOwnPropertyDescriptor(window, 'api')
  const pending = Promise.withResolvers<ScheduleView[]>()
  const list = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue([])
  let changed: (event: { projectId: string }) => void = () => {}
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      schedules: {
        list,
        onChanged: (fn: typeof changed) => {
          changed = fn
          return () => {}
        }
      }
    }
  })
  const activities: PersistedToolActivity[] = [
    {
      id: 'create',
      kind: 'tool' as const,
      title: 'Create',
      status: 'completed' as const,
      providerToolName: 'mcp__open_science_schedule__create_schedule',
      promptMessageId: 'origin',
      toolContent: [{ type: 'content', content: { type: 'text', text: JSON.stringify(task) } }],
      createdAt: 1,
      updatedAt: 1,
      sortIndex: 0,
      eventIds: []
    }
  ]
  const view = (items = activities): React.JSX.Element => (
    <ScheduleCardsProvider projectId="p" sessionId="s" activities={items}>
      <section aria-label="origin">
        <ScheduleMessageCards promptId="origin" />
      </section>
      <section aria-label="later">
        <ScheduleMessageCards promptId="later" />
      </section>
    </ScheduleCardsProvider>
  )
  try {
    const panel = render(view())
    expect(screen.queryByText('Task deleted')).toBeNull()
    await act(async () => pending.reject(new Error('Read failed')))
    expect(screen.queryByText('Task deleted')).toBeNull()
    await act(async () => changed({ projectId: 'p' }))
    await waitFor(() =>
      expect(
        within(screen.getByRole('region', { name: 'origin' })).getByText('Task deleted')
      ).toBeTruthy()
    )
    expect(screen.getByRole('region', { name: 'later' }).textContent).toBe('')
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull()
    panel.rerender(view([{ ...activities[0], status: 'failed' }]))
    expect(screen.queryByText('Task deleted')).toBeNull()
    panel.rerender(
      view([
        {
          ...activities[0],
          toolContent: [
            {
              type: 'content',
              content: {
                type: 'text',
                text: JSON.stringify({ ...task, target: { ...task.target, sessionId: 'other' } })
              }
            }
          ]
        }
      ])
    )
    expect(screen.queryByText('Task deleted')).toBeNull()
    // A standalone task's execution session is not its owner; project presence still proves it exists.
    list.mockResolvedValue([
      {
        ...task,
        target: { projectId: 'p', sessionId: null, agentFrameId: null, messageBranchId: null }
      }
    ])
    await act(async () => changed({ projectId: 'p' }))
    panel.rerender(
      <ScheduleCardsProvider
        projectId="p"
        sessionId="s"
        messages={[
          {
            id: 'wake',
            role: 'user',
            content: 'Wake',
            status: 'complete',
            eventIds: [],
            createdAt: 1,
            updatedAt: 1,
            attribution: {
              kind: 'application',
              feature: 'schedule',
              purpose: 'scheduled-wake',
              scheduleId: task.id,
              occurrenceId: 'run',
              scheduledAt: 1
            }
          }
        ]}
      >
        <ScheduleMessageCards promptId="wake" />
      </ScheduleCardsProvider>
    )
    expect(screen.queryByText('Task deleted')).toBeNull()
  } finally {
    cleanup()
    if (original) Object.defineProperty(window, 'api', original)
    else Reflect.deleteProperty(window, 'api')
  }
})

it('revalidates a newly observed creation receipt before reporting it deleted', async () => {
  const original = Object.getOwnPropertyDescriptor(window, 'api')
  const fresh = Promise.withResolvers<ScheduleView[]>()
  const list = vi
    .fn()
    .mockResolvedValueOnce([])
    .mockReturnValueOnce(fresh.promise)
    .mockResolvedValue([])
  let changed: (event: { projectId: string }) => void = () => {}
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      schedules: {
        list,
        onChanged: (fn: typeof changed) => {
          changed = fn
          return () => {}
        }
      }
    }
  })
  const activities: PersistedToolActivity[] = [
    {
      id: 'create',
      kind: 'tool',
      title: 'Create',
      status: 'completed',
      providerToolName: 'mcp__open_science_schedule__create_schedule',
      promptMessageId: 'origin',
      toolContent: [{ type: 'content', content: { type: 'text', text: JSON.stringify(task) } }],
      createdAt: 1,
      updatedAt: 1,
      sortIndex: 0,
      eventIds: []
    }
  ]
  const view = (items: PersistedToolActivity[]): React.JSX.Element => (
    <ScheduleCardsProvider projectId="p" sessionId="s" activities={items}>
      <ScheduleMessageCards promptId="origin" />
    </ScheduleCardsProvider>
  )
  try {
    const panel = render(view([]))
    await act(async () => {})
    expect(list).toHaveBeenCalledTimes(1)
    panel.rerender(view(activities))
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
    expect(screen.queryByText('Task deleted')).toBeNull()
    await act(async () => fresh.resolve([{ ...task, originPromptId: 'origin' }]))
    expect(screen.queryByText('Task deleted')).toBeNull()
    expect(screen.getByText('Queued')).toBeTruthy()
    await act(async () => changed({ projectId: 'p' }))
    await waitFor(() => expect(screen.getByText('Task deleted')).toBeTruthy())
  } finally {
    cleanup()
    if (original) Object.defineProperty(window, 'api', original)
    else Reflect.deleteProperty(window, 'api')
  }
})
