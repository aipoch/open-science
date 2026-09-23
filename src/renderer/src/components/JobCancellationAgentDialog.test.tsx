// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeJob } from '@/test-utils/compute-job'
import { JobCancellationAgentDialog } from './JobCancellationAgentDialog'

const state = vi.hoisted(() => ({
  session: {
    id: 'original-session',
    projectId: 'project-1',
    cwd: '/project',
    status: 'idle',
    contentLoaded: true,
    activeRun: undefined as object | undefined
  },
  sendMessage: vi.fn()
}))
vi.mock('@/stores/session-store', () => ({
  useSessionStore: (selector: (value: { sessions: (typeof state.session)[] }) => unknown) =>
    selector({ sessions: [state.session] })
}))
vi.mock('@/lib/acp/useWorkspaceAgentRuntime', () => ({
  useWorkspaceAgentRuntime: () => ({ sendMessage: state.sendMessage })
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (value: string) => value }) }))

const job = makeJob({
  project_id: 'project-1',
  session_id: 'original-session',
  status: 'running',
  cancellation_status: 'cancel_failed',
  cancellation: { failureCode: 'timeout', attemptCount: 3, requestedAt: 100, updatedAt: 200 }
})
const confirm = (): HTMLButtonElement => screen.getByTestId('job-agent-confirm')

beforeEach(() => {
  state.session = {
    id: 'original-session',
    projectId: 'project-1',
    cwd: '/project',
    status: 'idle',
    contentLoaded: true,
    activeRun: undefined
  }
  state.sendMessage.mockReset().mockResolvedValue({ sessionId: 'original-session', messageId: 'm' })
})
afterEach(cleanup)

describe('job cancellation agent consent', () => {
  it('sends only the reviewed request to the original session after explicit confirmation', async () => {
    const onClose = vi.fn()
    render(<JobCancellationAgentDialog job={job} onClose={onClose} />)
    expect(state.sendMessage).not.toHaveBeenCalled()
    const reviewed = screen.getByTestId('job-agent-payload').textContent
    expect(reviewed).toContain('Authorization applies only to this job.')
    expect(reviewed).toContain('require separate approval.')
    await act(async () => fireEvent.click(confirm()))
    expect(state.sendMessage).toHaveBeenCalledExactlyOnceWith({
      sessionId: 'original-session',
      projectId: 'project-1',
      cwd: '/project',
      text: reviewed,
      requireExistingSession: true,
      preserveSelection: true
    })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it.each([
    { id: 'another-session' },
    { projectId: 'another-project' },
    { status: 'running' },
    { activeRun: {} },
    { contentLoaded: false }
  ])('does not admit an unavailable original session: %j', async (change) => {
    Object.assign(state.session, change)
    render(<JobCancellationAgentDialog job={job} onClose={vi.fn()} />)
    expect(confirm().disabled).toBe(true)
    await act(async () => fireEvent.click(confirm()))
    expect(state.sendMessage).not.toHaveBeenCalled()
  })

  it('invalidates consent when cancellation state changes while the dialog is open', () => {
    const { rerender } = render(<JobCancellationAgentDialog job={job} onClose={vi.fn()} />)
    rerender(
      <JobCancellationAgentDialog
        job={{ ...job, cancellation: { ...job.cancellation!, updatedAt: 300 } }}
        onClose={vi.fn()}
      />
    )
    expect(confirm().disabled).toBe(true)
    expect(state.sendMessage).not.toHaveBeenCalled()
  })

  it('deduplicates pending submission and allows an explicitly retried failed send', async () => {
    let resolve!: (value: undefined) => void
    state.sendMessage.mockImplementationOnce(() => new Promise((done) => (resolve = done)))
    const onClose = vi.fn()
    render(<JobCancellationAgentDialog job={job} onClose={onClose} />)
    await act(async () => {
      fireEvent.click(confirm())
      fireEvent.click(confirm())
    })
    expect(state.sendMessage).toHaveBeenCalledOnce()
    expect(confirm().disabled).toBe(true)
    await act(async () => resolve(undefined))
    expect(screen.getByRole('alert').textContent).toBe('Unable to send the inspection request.')
    expect(onClose).not.toHaveBeenCalled()
    expect(confirm().disabled).toBe(false)
    await act(async () => fireEvent.click(confirm()))
    expect(state.sendMessage).toHaveBeenCalledTimes(2)
    expect(onClose).toHaveBeenCalledOnce()
  })
})
