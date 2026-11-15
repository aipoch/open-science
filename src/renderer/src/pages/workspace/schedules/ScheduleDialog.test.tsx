import { ApplicationCommandError } from '../../../../../shared/application-command-contract'
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ScheduleEditRequest, ScheduleView } from '../../../../../shared/session-schedules'
import { ScheduleDialog } from './ScheduleDialog'
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } })
}))
vi.mock('@/stores/session-store', () => ({
  useSessionStore: (select: (state: { sessions: unknown[] }) => unknown) => select({ sessions: [] })
}))
afterEach(cleanup)
it('keeps the draft CAS baseline through live updates until explicit review', async () => {
  const original = Object.getOwnPropertyDescriptor(window, 'api')
  const task: ScheduleView = {
    id: 'job',
    revision: 1,
    target: { projectId: 'p', sessionId: null, agentFrameId: null, messageBranchId: null },
    originPromptId: null,
    pausedAt: null,
    finishedAt: null,
    pauseReason: null,
    nextDueAt: Date.now() + 86400000,
    draft: {
      name: 'Original',
      rule: { kind: 'daily', time: '09:00', timeZone: 'UTC' },
      action: { kind: 'send_session_message', message: 'Original instructions' }
    }
  }
  const latest: ScheduleView = {
    ...task,
    revision: 2,
    draft: {
      ...task.draft,
      rule: { kind: 'daily', time: '10:30', timeZone: 'UTC' },
      action: { kind: 'send_session_message', message: 'New remote instructions' }
    }
  }
  const edit = vi.fn(async (request: ScheduleEditRequest) => {
    if (request.expectedRevision !== latest.revision) throw new Error('Conflict')
    return latest
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { schedules: { edit, get: async () => latest } }
  })
  try {
    const props = { projectId: 'p', onSaved: vi.fn(), onClose: vi.fn() }
    const view = render(<ScheduleDialog {...props} task={task} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
      target: { value: 'My title' }
    })
    view.rerender(<ScheduleDialog {...props} task={latest} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText('This task changed while you were editing.')
    expect(edit.mock.calls[0][0].expectedRevision).toBe(1)
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveProperty('value', 'My title')
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: 'Review my changes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(edit).toHaveBeenCalledTimes(2))
    expect(edit.mock.calls[1][0]).toMatchObject({
      expectedRevision: 2,
      change: {
        draft: {
          name: 'My title',
          rule: { time: '10:30' },
          action: { message: 'New remote instructions' }
        }
      }
    })
    expect(props.onSaved).toHaveBeenCalledTimes(1)
  } finally {
    cleanup()
    if (original) Object.defineProperty(window, 'api', original)
    else Reflect.deleteProperty(window, 'api')
  }
})

it('shows a stored date offset rather than the computers current seasonal offset', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-14T00:00:00Z'))
  try {
    render(
      <ScheduleDialog
        projectId="p"
        onClose={() => {}}
        onSaved={() => {}}
        task={{
          id: 'past',
          revision: 1,
          target: { projectId: 'p', sessionId: null, agentFrameId: null, messageBranchId: null },
          originPromptId: null,
          pausedAt: 1,
          finishedAt: null,
          pauseReason: null,
          nextDueAt: null,
          draft: {
            name: 'Past run',
            action: { kind: 'send_session_message', message: 'Check' },
            rule: {
              kind: 'once',
              at: Date.parse('2026-07-01T00:00:00Z'),
              timeZone: 'Australia/Sydney'
            }
          }
        }}
      />
    )
    expect(screen.getByLabelText('Time zone').textContent).toBe('GMT+10')
  } finally {
    cleanup()
    vi.useRealTimers()
  }
})

it.each(['live', 'rejected'] as const)(
  'preserves edits when admission becomes pending through %s state',
  async (source) => {
    const original = Object.getOwnPropertyDescriptor(window, 'api')
    const task: ScheduleView = {
      id: 'pending',
      revision: 1,
      target: { projectId: 'p', sessionId: null, agentFrameId: null, messageBranchId: null },
      originPromptId: null,
      pausedAt: null,
      finishedAt: null,
      pauseReason: null,
      nextDueAt: Date.now() + 86400000,
      draft: {
        name: 'Review',
        rule: { kind: 'daily', time: '09:00', timeZone: 'UTC' },
        action: { kind: 'send_session_message', message: 'Original instructions' }
      }
    }
    const pending: ScheduleView = {
      ...task,
      currentRun: {
        status: 'dispatching',
        scheduledAt: Date.now(),
        reason: null,
        runSessionId: null,
        scriptRunId: null
      }
    }
    const reason =
      'This task is waiting to run. Its instructions and schedule cannot be changed yet.'
    const edit = vi.fn(async (request: ScheduleEditRequest) => {
      if (
        request.change.kind === 'edit' &&
        request.change.draft.action.kind === 'send_session_message' &&
        request.change.draft.action.message !== 'Original instructions'
      )
        throw new ApplicationCommandError('schedule-pending', reason)
      return pending
    })
    Object.defineProperty(window, 'api', { configurable: true, value: { schedules: { edit } } })
    try {
      const props = { projectId: 'p', onSaved: vi.fn(), onClose: vi.fn() }
      const view = render(<ScheduleDialog {...props} task={task} />)
      fireEvent.change(screen.getByRole('textbox', { name: 'Instructions' }), {
        target: { value: 'My draft' }
      })
      if (source === 'live') view.rerender(<ScheduleDialog {...props} task={pending} />)
      else fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      await screen.findByText(reason)
      expect(screen.getByRole('textbox', { name: 'Instructions' })).toHaveProperty(
        'value',
        'My draft'
      )
      expect(screen.getByRole('textbox', { name: 'Instructions' }).matches(':disabled')).toBe(true)
      expect(screen.getByRole('combobox', { name: 'Repeat' }).matches(':disabled')).toBe(true)
      expect(screen.getByRole('button', { name: 'Save' }).matches(':disabled')).toBe(true)
      expect(props.onSaved).not.toHaveBeenCalled()
      view.rerender(<ScheduleDialog {...props} task={pending} />)
      fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))
      expect(screen.getByRole('textbox', { name: 'Instructions' })).toHaveProperty(
        'value',
        'Original instructions'
      )
      expect(screen.getByRole('button', { name: 'Pause' }).matches(':disabled')).toBe(false)
      fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
        target: { value: 'Renamed' }
      })
      expect(screen.getByRole('button', { name: 'Save' }).matches(':disabled')).toBe(false)
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(props.onSaved).toHaveBeenCalledTimes(1))
      expect(edit).toHaveBeenLastCalledWith(
        expect.objectContaining({
          expectedRevision: 1,
          change: {
            kind: 'edit',
            draft: { ...task.draft, name: 'Renamed', permissionProfile: 'ask' }
          }
        })
      )
    } finally {
      cleanup()
      if (original) Object.defineProperty(window, 'api', original)
      else Reflect.deleteProperty(window, 'api')
    }
  }
)

it('uses the committed cursor until the rule changes, including live claims', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-14T08:00:00Z'))
  try {
    const task: ScheduleView = {
      id: 'cursor',
      revision: 1,
      target: { projectId: 'p', sessionId: null, agentFrameId: null, messageBranchId: null },
      originPromptId: null,
      pausedAt: null,
      finishedAt: null,
      pauseReason: null,
      nextDueAt: Date.parse('2026-11-14T08:15:00Z'),
      draft: {
        name: 'Check',
        rule: { timeZone: 'UTC', time: '09:00', kind: 'daily' },
        action: { kind: 'send_session_message', message: 'Check' }
      }
    }
    const props = { projectId: 'p', onClose: vi.fn(), onSaved: vi.fn() }
    const rendered = render(<ScheduleDialog {...props} task={task} />)
    expect(screen.getByText('Next run').parentElement?.textContent).toContain('8:15 AM')
    const time = screen.getByLabelText('Time', { selector: 'input' })
    fireEvent.change(time, { target: { value: '10:00' } })
    expect(screen.getByText('Next run').parentElement?.textContent).toContain('10:00 AM')
    fireEvent.change(time, { target: { value: '09:00' } })
    expect(screen.getByText('Next run').parentElement?.textContent).toContain('8:15 AM')
    rendered.rerender(<ScheduleDialog {...props} task={{ ...task, nextDueAt: null }} />)
    expect(screen.queryByText('Next run')).toBeNull()
  } finally {
    vi.useRealTimers()
  }
})

it('saves a name-only edit while the final dated run waits for admission', async () => {
  const original = Object.getOwnPropertyDescriptor(window, 'api')
  const task: ScheduleView = {
    id: 'last-dated',
    revision: 1,
    target: { projectId: 'p', sessionId: null, agentFrameId: null, messageBranchId: null },
    originPromptId: null,
    pausedAt: null,
    finishedAt: null,
    pauseReason: null,
    nextDueAt: null,
    currentRun: {
      status: 'dispatching',
      scheduledAt: Date.parse('2026-11-14T09:00:00Z'),
      reason: null,
      runSessionId: null,
      scriptRunId: null
    },
    draft: {
      name: 'Original',
      endAt: Date.parse('2026-11-14T09:30:00Z'),
      rule: { kind: 'daily', time: '09:00', timeZone: 'UTC' },
      action: { kind: 'send_session_message', message: 'Check' }
    }
  }
  const edit = vi.fn().mockResolvedValue(task)
  Object.defineProperty(window, 'api', { configurable: true, value: { schedules: { edit } } })
  try {
    const onSaved = vi.fn()
    render(<ScheduleDialog projectId="p" task={task} onClose={() => {}} onSaved={onSaved} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
      target: { value: 'Renamed' }
    })
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', false)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce())
    expect(edit).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 1,
        change: {
          kind: 'edit',
          draft: { ...task.draft, name: 'Renamed', permissionProfile: 'ask' }
        }
      })
    )
  } finally {
    if (original) Object.defineProperty(window, 'api', original)
    else Reflect.deleteProperty(window, 'api')
  }
})
