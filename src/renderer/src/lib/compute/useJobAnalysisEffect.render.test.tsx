// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ComputeJobAnalysisTransition, JobSummary } from '../../../../shared/compute'
import type { PersistedChatSession } from '../../../../shared/session-persistence'
import { createInitialSessionJobState, useSessionJobStore } from '../../stores/session-job-store'
import { createInitialSessionState, useSessionStore } from '../../stores/session-store'
import { useJobAnalysisEffect } from './useJobAnalysisEffect'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const makeCompletedJob = (overrides: Partial<JobSummary> = {}): JobSummary => ({
  job_id: 'job-1',
  provider_id: 'ssh:biowulf',
  display_name: 'biowulf',
  shape: 'direct_ssh',
  session_id: 'session-1',
  status: 'success',
  intent: 'Analyze results',
  created_at: 1000,
  started_at: 1100,
  finished_at: 1200,
  exit_code: 0,
  error_code: undefined,
  remote_workdir: undefined,
  stdout_tail: undefined,
  stderr_tail: undefined,
  notified_at: 1300,
  notification_consumed_at: undefined,
  featured_files: [],
  featured_file_count: 0,
  left_on_remote_count: 0,
  ...overrides
})

describe('useJobAnalysisEffect persistence readiness', () => {
  let container: HTMLDivElement
  let root: Root
  type AnalysisSendMessage = Parameters<typeof useJobAnalysisEffect>[0]['sendMessage']

  const sendMessage = vi.fn(async (input: Parameters<AnalysisSendMessage>[0]) => {
    const sessionId = input.sessionId ?? 'session-1'
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId ? { ...session, status: 'running' } : session
      )
    }))
    return { sessionId, messageId: input.messageId ?? 'message-1' }
  })
  const jobsPendingNotification = vi.fn().mockResolvedValue([makeCompletedJob()])
  const jobsMarkConsumed = vi.fn().mockResolvedValue(undefined)
  const jobsTransitionAnalysis = vi.fn(async (request: ComputeJobAnalysisTransition) => [
    makeCompletedJob({
      analysis_state: request.state,
      analysis_message_id: request.messageId,
      analysis_updated_at: 1400,
      ...(request.state === 'succeeded' ? { notification_consumed_at: 1500 } : {})
    })
  ])
  const jobsList = vi.fn().mockResolvedValue([])
  const loadOne = vi.fn().mockResolvedValue(undefined)

  const Probe = ({
    enabled,
    onSendMessage = sendMessage
  }: {
    enabled: boolean
    onSendMessage?: AnalysisSendMessage
  }): null => {
    useJobAnalysisEffect({ enabled, sendMessage: onSendMessage })
    return null
  }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    sendMessage.mockClear()
    jobsPendingNotification.mockClear()
    jobsMarkConsumed.mockClear()
    jobsTransitionAnalysis.mockReset().mockImplementation(async (request) => [
      makeCompletedJob({
        analysis_state: request.state,
        analysis_message_id: request.messageId,
        analysis_updated_at: 1400,
        ...(request.state === 'succeeded' ? { notification_consumed_at: 1500 } : {})
      })
    ])
    jobsList.mockClear()
    loadOne.mockReset().mockResolvedValue(undefined)
    useSessionJobStore.setState({
      ...createInitialSessionJobState(),
      hydratedSessionId: 'session-1',
      isLoaded: true
    })
    useSessionStore.setState({
      sessions: [
        {
          id: 'session-1',
          projectId: 'project-a',
          title: 'Ready',
          cwd: '/workspace/project-a',
          status: 'idle',
          messages: [],
          createdAt: 1,
          updatedAt: 1
        }
      ],
      selectedSessionId: 'session-1'
    })
    window.api = {
      compute: {
        jobsPendingNotification,
        jobsMarkConsumed,
        jobsTransitionAnalysis,
        jobsList
      },
      sessions: { loadOne }
    } as unknown as Window['api']
  })

  afterEach(() => {
    vi.useRealTimers()
    act(() => root.unmount())
    container.remove()
  })

  it('does not start job analysis while Session persistence is not ready', async () => {
    await act(async () => {
      root.render(<Probe enabled={false} />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(sendMessage).not.toHaveBeenCalled()
    expect(jobsTransitionAnalysis).not.toHaveBeenCalled()
  })

  it('rechecks readiness before dispatching a delayed pending-job scan', async () => {
    let resolvePendingJobs: ((jobs: JobSummary[]) => void) | undefined
    jobsPendingNotification.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePendingJobs = resolve
        })
    )

    await act(async () => {
      root.render(<Probe enabled />)
      await Promise.resolve()
    })
    expect(jobsPendingNotification).toHaveBeenCalledWith({ allSessions: true })

    await act(async () => root.render(<Probe enabled={false} />))
    await act(async () => {
      resolvePendingJobs?.([makeCompletedJob()])
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(sendMessage).not.toHaveBeenCalled()
    expect(jobsTransitionAnalysis).not.toHaveBeenCalled()
  })

  it('rechecks readiness before a queued broadcast dispatch reaches the runtime', async () => {
    jobsPendingNotification.mockResolvedValueOnce([])
    await act(async () => root.render(<Probe enabled />))

    act(() => {
      useSessionJobStore.getState().applyUpdate(makeCompletedJob())
      root.render(<Probe enabled={false} />)
    })
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))

    expect(sendMessage).not.toHaveBeenCalled()
    expect(jobsTransitionAnalysis).not.toHaveBeenCalled()
  })

  it('removes a queued turn-end listener when persistence becomes unavailable', async () => {
    jobsPendingNotification.mockResolvedValueOnce([])
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [
        {
          id: 'session-1',
          projectId: 'project-a',
          title: 'Running',
          cwd: '/workspace/project-a',
          status: 'running',
          messages: [],
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })

    await act(async () => root.render(<Probe enabled />))
    act(() => useSessionJobStore.getState().applyUpdate(makeCompletedJob()))
    await act(async () => Promise.resolve())

    await act(async () => root.render(<Probe enabled={false} />))
    act(() => {
      useSessionStore.setState((state) => ({
        sessions: state.sessions.map((session) =>
          session.id === 'session-1' ? { ...session, status: 'idle' } : session
        )
      }))
    })
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))

    expect(sendMessage).not.toHaveBeenCalled()
    expect(jobsTransitionAnalysis).not.toHaveBeenCalled()
  })

  it('keeps one trigger when the runtime send callback changes during an analysis turn', async () => {
    jobsPendingNotification.mockResolvedValueOnce([])
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [
        {
          id: 'session-1',
          projectId: 'project-a',
          title: 'Ready',
          cwd: '/workspace/project-a',
          status: 'idle',
          messages: [],
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })
    const firstSend = vi.fn<AnalysisSendMessage>(async (input) => {
      useSessionStore.setState((state) => ({
        sessions: state.sessions.map((session) =>
          session.id === 'session-1' ? { ...session, status: 'running' } : session
        )
      }))
      return { sessionId: 'session-1', messageId: input.messageId ?? 'message-1' }
    })
    const replacementSend = vi.fn<AnalysisSendMessage>(async (input) => ({
      sessionId: 'session-1',
      messageId: input.messageId ?? 'message-2'
    }))

    await act(async () => root.render(<Probe enabled onSendMessage={firstSend} />))
    act(() => useSessionJobStore.getState().applyUpdate(makeCompletedJob()))
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(firstSend).toHaveBeenCalledOnce()

    await act(async () => root.render(<Probe enabled onSendMessage={replacementSend} />))
    act(() => {
      useSessionStore.setState((state) => ({
        sessions: state.sessions.map((session) =>
          session.id === 'session-1' ? { ...session, status: 'idle' } : session
        )
      }))
    })
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))

    expect(firstSend).toHaveBeenCalledOnce()
    expect(replacementSend).not.toHaveBeenCalled()
    expect(jobsTransitionAnalysis).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: 'succeeded' })
    )
  })

  it('settles when the analysis turn ends before its completion listener is registered', async () => {
    jobsPendingNotification.mockResolvedValueOnce([])
    const immediateSend = vi.fn<AnalysisSendMessage>(async (input) => {
      useSessionStore.setState((state) => ({
        sessions: state.sessions.map((session) =>
          session.id === 'session-1' ? { ...session, status: 'running' } : session
        )
      }))
      useSessionStore.setState((state) => ({
        sessions: state.sessions.map((session) =>
          session.id === 'session-1' ? { ...session, status: 'idle' } : session
        )
      }))
      return { sessionId: 'session-1', messageId: input.messageId ?? 'message-1' }
    })

    await act(async () => root.render(<Probe enabled onSendMessage={immediateSend} />))
    act(() => useSessionJobStore.getState().applyUpdate(makeCompletedJob()))
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))

    expect(immediateSend).toHaveBeenCalledOnce()
    expect(jobsTransitionAnalysis).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: 'succeeded' })
    )
  })

  it('scans and dispatches pending analysis after persistence becomes ready', async () => {
    await act(async () => root.render(<Probe enabled={false} />))
    expect(jobsPendingNotification).not.toHaveBeenCalled()

    await act(async () => {
      root.render(<Probe enabled />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(jobsPendingNotification).toHaveBeenCalledWith({ allSessions: true })
    expect(sendMessage).toHaveBeenCalledOnce()
  })

  it('recovers pending analysis across all Sessions from the App-level owner', async () => {
    const persistedBackground: PersistedChatSession = {
      id: 'session-1',
      projectId: 'project-a',
      title: 'Background Session',
      cwd: '/workspace/project-a',
      status: 'idle',
      agentFrameworkId: 'claude-code',
      agentConfiguration: {
        providerId: 'session-provider',
        model: 'session-model',
        reasoningEffort: 'high'
      },
      messages: [
        {
          id: 'earlier-message',
          role: 'user',
          content: 'Earlier question',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1
        }
      ],
      createdAt: 1,
      updatedAt: 2
    }
    loadOne.mockResolvedValueOnce(persistedBackground)
    useSessionStore.setState({
      sessions: [
        {
          id: 'visible-session',
          projectId: 'project-a',
          title: 'Visible Session',
          cwd: '/workspace/visible',
          status: 'idle',
          messages: [],
          createdAt: 1,
          updatedAt: 3
        },
        {
          id: 'session-1',
          projectId: 'project-a',
          title: 'Background Session',
          cwd: '',
          status: 'idle',
          messages: [],
          createdAt: 1,
          updatedAt: 2,
          contentLoaded: false
        }
      ],
      selectedSessionId: 'visible-session'
    })

    await act(async () => {
      root.render(<Probe enabled />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(jobsPendingNotification).toHaveBeenCalledWith({ allSessions: true })
    expect(loadOne).toHaveBeenCalledWith({ projectId: 'project-a', sessionId: 'session-1' })
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        cwd: '/workspace/project-a',
        projectId: 'project-a',
        preserveSelection: true
      })
    )
    expect(useSessionStore.getState().selectedSessionId).toBe('visible-session')
    const hydratedBackground = useSessionStore
      .getState()
      .sessions.find((session) => session.id === 'session-1')
    expect(hydratedBackground?.contentLoaded).not.toBe(false)
    expect(hydratedBackground).toMatchObject({
      cwd: '/workspace/project-a',
      agentConfiguration: persistedBackground.agentConfiguration,
      messages: [{ id: 'earlier-message', content: 'Earlier question' }]
    })
  })

  it('adds pending-scan jobs to the local store before dispatching analysis', async () => {
    await act(async () => {
      root.render(<Probe enabled />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(useSessionJobStore.getState().jobsById.get('job-1')).toMatchObject({
      ...makeCompletedJob(),
      analysis_state: 'dispatched',
      analysis_message_id: expect.any(String)
    })
    expect(sendMessage).toHaveBeenCalledOnce()
  })

  it('retries a pending-analysis scan after a transient transport failure', async () => {
    vi.useFakeTimers()
    jobsPendingNotification
      .mockRejectedValueOnce(new Error('main process unavailable'))
      .mockResolvedValueOnce([makeCompletedJob()])

    await act(async () => root.render(<Probe enabled />))
    await act(async () => {
      await vi.runOnlyPendingTimersAsync()
    })

    expect(jobsPendingNotification).toHaveBeenCalledTimes(2)
    expect(sendMessage).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('projects successful consumption locally without waiting for a follow-up hydration', async () => {
    jobsPendingNotification.mockResolvedValueOnce([])
    jobsList.mockImplementationOnce(() => new Promise(() => undefined))
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [
        {
          id: 'session-1',
          projectId: 'project-a',
          title: 'Ready',
          cwd: '/workspace/project-a',
          status: 'idle',
          messages: [],
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })

    await act(async () => root.render(<Probe enabled />))
    act(() => useSessionJobStore.getState().applyUpdate(makeCompletedJob()))
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))

    expect(sendMessage).toHaveBeenCalledOnce()
    act(() => {
      useSessionStore.setState((state) => ({
        sessions: state.sessions.map((session) =>
          session.id === 'session-1' ? { ...session, status: 'running' } : session
        )
      }))
      useSessionStore.setState((state) => ({
        sessions: state.sessions.map((session) =>
          session.id === 'session-1' ? { ...session, status: 'idle' } : session
        )
      }))
    })
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))

    expect(jobsTransitionAnalysis).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        jobIds: ['job-1'],
        state: 'succeeded'
      })
    )
    expect(useSessionJobStore.getState().jobsById.get('job-1')?.notification_consumed_at).toEqual(
      expect.any(Number)
    )
  })

  it('does not consume a job notification when its analysis turn fails', async () => {
    jobsPendingNotification.mockResolvedValueOnce([])

    await act(async () => root.render(<Probe enabled />))
    act(() => useSessionJobStore.getState().applyUpdate(makeCompletedJob()))
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))

    expect(sendMessage).toHaveBeenCalledOnce()
    act(() => {
      useSessionStore.setState((state) => ({
        sessions: state.sessions.map((session) =>
          session.id === 'session-1' ? { ...session, status: 'running' } : session
        )
      }))
      useSessionStore.setState((state) => ({
        sessions: state.sessions.map((session) =>
          session.id === 'session-1'
            ? { ...session, status: 'error', error: 'Analysis turn failed' }
            : session
        )
      }))
    })
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))

    expect(jobsTransitionAnalysis).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: 'failed' })
    )
    expect(
      useSessionJobStore.getState().jobsById.get('job-1')?.notification_consumed_at
    ).toBeUndefined()
  })

  it('settles recovered analysis from a lazy-loaded Session before attempting to resend', async () => {
    const messageId = 'analysis-recovered'
    const persistedBackground: PersistedChatSession = {
      id: 'session-1',
      projectId: 'project-a',
      title: 'Background Session',
      cwd: '/workspace/project-a',
      status: 'idle',
      agentFrameworkId: 'claude-code',
      messages: [
        {
          id: messageId,
          role: 'user',
          content: 'Analyze the completed remote job',
          status: 'complete',
          eventIds: [],
          createdAt: 1400,
          updatedAt: 1400
        },
        {
          id: 'analysis-response-1',
          role: 'agent',
          responseToMessageId: messageId,
          content: 'Analysis complete',
          status: 'complete',
          eventIds: [],
          createdAt: 1500,
          updatedAt: 1500
        }
      ],
      createdAt: 1,
      updatedAt: 2
    }
    loadOne.mockResolvedValueOnce(persistedBackground)
    jobsPendingNotification.mockResolvedValueOnce([
      makeCompletedJob({
        analysis_state: 'dispatched',
        analysis_message_id: messageId,
        analysis_updated_at: 1400
      })
    ])
    useSessionStore.setState({
      sessions: [
        {
          id: 'session-1',
          projectId: 'project-a',
          title: 'Background Session',
          cwd: '',
          status: 'idle',
          messages: [],
          createdAt: 1,
          updatedAt: 2,
          contentLoaded: false
        }
      ],
      selectedSessionId: 'session-1'
    })

    await act(async () => {
      root.render(<Probe enabled />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(loadOne).toHaveBeenCalledWith({ projectId: 'project-a', sessionId: 'session-1' })
    expect(sendMessage).not.toHaveBeenCalled()
    expect(jobsTransitionAnalysis).toHaveBeenLastCalledWith({
      sessionId: 'session-1',
      jobIds: ['job-1'],
      messageId,
      state: 'succeeded'
    })
  })

  it('resends a recovered prompt without a matching response instead of inferring idle success', async () => {
    const messageId = 'analysis-without-response'
    jobsPendingNotification.mockResolvedValueOnce([
      makeCompletedJob({
        analysis_state: 'dispatched',
        analysis_message_id: messageId,
        analysis_updated_at: 1400
      })
    ])
    useSessionStore.setState({
      sessions: [
        {
          id: 'session-1',
          projectId: 'project-a',
          title: 'Recovered Session',
          cwd: '/workspace/project-a',
          status: 'idle',
          messages: [
            {
              id: messageId,
              role: 'user',
              content: 'Analyze the completed remote job',
              status: 'complete',
              eventIds: [],
              createdAt: 1400,
              updatedAt: 1400
            }
          ],
          createdAt: 1,
          updatedAt: 2
        }
      ],
      selectedSessionId: 'session-1'
    })

    await act(async () => {
      root.render(<Probe enabled />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1', messageId })
    )
    expect(jobsTransitionAnalysis).not.toHaveBeenCalledWith(
      expect.objectContaining({ messageId, state: 'succeeded' })
    )
  })

  it('rearms an app-restart recovery without a matching response', async () => {
    const messageId = 'analysis-interrupted-by-restart'
    jobsPendingNotification.mockResolvedValueOnce([
      makeCompletedJob({
        analysis_state: 'dispatched',
        analysis_message_id: messageId,
        analysis_updated_at: 1400
      })
    ])
    useSessionStore.setState({
      sessions: [
        {
          id: 'session-1',
          projectId: 'project-a',
          title: 'Restarted Session',
          cwd: '/workspace/project-a',
          status: 'error',
          messages: [
            {
              id: messageId,
              role: 'user',
              content: 'Analyze the completed remote job',
              status: 'complete',
              eventIds: [],
              createdAt: 1400,
              updatedAt: 1400
            }
          ],
          resumeRecovery: {
            kind: 'resume-required',
            cause: 'app-restart',
            promptMessageId: messageId
          },
          error: 'The app exited while this turn was running.',
          createdAt: 1,
          updatedAt: 2
        }
      ],
      selectedSessionId: 'session-1'
    })

    await act(async () => {
      root.render(<Probe enabled />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1', messageId })
    )
    expect(jobsTransitionAnalysis).not.toHaveBeenCalledWith(
      expect.objectContaining({ messageId, state: 'failed' })
    )
  })

  it('does not resend an analysis prompt after restart when completion consumption was interrupted', async () => {
    let durableJob = makeCompletedJob()
    jobsPendingNotification.mockResolvedValueOnce([])
    jobsTransitionAnalysis.mockImplementation(async (request) => {
      if (request.state === 'succeeded') return new Promise(() => undefined)
      durableJob = makeCompletedJob({
        analysis_state: request.state,
        analysis_message_id: request.messageId,
        analysis_updated_at: 1400
      })
      return [durableJob]
    })

    await act(async () => root.render(<Probe enabled />))
    act(() => useSessionJobStore.getState().applyUpdate(makeCompletedJob()))
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    const sent = sendMessage.mock.calls[0]?.[0]
    if (!sent?.messageId) throw new Error('Expected a stable analysis Message identity.')
    const messageId = sent.messageId
    act(() => {
      useSessionStore.setState((state) => ({
        sessions: state.sessions.map((session) =>
          session.id === 'session-1'
            ? {
                ...session,
                status: 'running',
                activeRun: { promptMessageId: messageId, startedAt: 1400 },
                messages: [
                  {
                    id: messageId,
                    role: 'user',
                    content: sent.text,
                    status: 'complete',
                    eventIds: [],
                    createdAt: 1400,
                    updatedAt: 1400
                  }
                ]
              }
            : session
        )
      }))
      useSessionStore.setState((state) => ({
        sessions: state.sessions.map((session) =>
          session.id === 'session-1'
            ? {
                ...session,
                status: 'idle',
                activeRun: undefined,
                messages: [
                  ...session.messages,
                  {
                    id: 'analysis-response-1',
                    role: 'agent',
                    responseToMessageId: messageId,
                    content: 'Analysis complete',
                    status: 'complete',
                    eventIds: [],
                    createdAt: 1500,
                    updatedAt: 1500
                  }
                ]
              }
            : session
        )
      }))
    })
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))

    expect(sendMessage).toHaveBeenCalledOnce()
    expect(jobsTransitionAnalysis).toHaveBeenLastCalledWith(
      expect.objectContaining({ messageId, state: 'succeeded' })
    )

    act(() => root.unmount())
    useSessionJobStore.setState({
      ...createInitialSessionJobState(),
      hydratedSessionId: 'session-1',
      isLoaded: true
    })
    jobsTransitionAnalysis.mockImplementation(async (request) => [
      makeCompletedJob({
        analysis_state: request.state,
        analysis_message_id: request.messageId,
        analysis_updated_at: 1600,
        ...(request.state === 'succeeded' ? { notification_consumed_at: 1600 } : {})
      })
    ])
    jobsPendingNotification.mockResolvedValueOnce([durableJob])
    root = createRoot(container)
    await act(async () => {
      root.render(<Probe enabled />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(sendMessage).toHaveBeenCalledOnce()
  })
})
