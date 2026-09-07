// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ComputeJobAnalysisTransition, JobSummary } from '../../../../shared/compute'
import type { PersistedChatSession } from '../../../../shared/session-persistence'
import { createInitialSessionJobState, useSessionJobStore } from '../../stores/session-job-store'
import { createInitialSessionState, useSessionStore } from '../../stores/session-store'
import { useJobAnalysisEffect } from './useJobAnalysisEffect'
import { buildAnalysisPrompt } from './job-analysis-trigger'
import { sendWorkspaceMessage } from '../acp/workspace-runtime-command-owner'

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

  const recordAnalysisRun = (input: Parameters<AnalysisSendMessage>[0]): void => {
    const messageId = input.messageId ?? 'message-1'
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === (input.sessionId ?? 'session-1')
          ? {
              ...session,
              status: 'running',
              activeRun: { promptMessageId: messageId, startedAt: 1400 },
              messages: [
                ...session.messages.filter((message) => message.id !== messageId),
                {
                  id: messageId,
                  role: 'user',
                  content: input.text,
                  status: 'complete',
                  eventIds: [],
                  createdAt: 1400,
                  updatedAt: 1400
                },
                {
                  id: `${messageId}-reply`,
                  role: 'agent',
                  responseToMessageId: messageId,
                  content: 'Analysis in progress',
                  status: 'streaming',
                  eventIds: [],
                  createdAt: 1500,
                  updatedAt: 1500
                }
              ]
            }
          : session
      )
    }))
  }
  const sendMessage = vi.fn(async (input: Parameters<AnalysisSendMessage>[0]) => {
    recordAnalysisRun(input)
    return { sessionId: input.sessionId ?? 'session-1', messageId: input.messageId ?? 'message-1' }
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
    jobsList
      .mockReset()
      .mockImplementation(async () => [...useSessionJobStore.getState().jobsById.values()])
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

  it.each([
    'unchanged input',
    'reordered jobs',
    'changed output files',
    'missing attribution',
    'inactive branch'
  ])('reuses the saved batch prompt through runtime admission after %s', async (change) => {
    const messageId = 'analysis-saved-batch'
    const first = makeCompletedJob({ job_id: 'first-job', featured_files: ['original.csv'] })
    const second = makeCompletedJob({ job_id: 'second-job' })
    const originalText = buildAnalysisPrompt([first, second])
    const recovered =
      change === 'reordered jobs'
        ? [second, first]
        : change === 'changed output files'
          ? [{ ...first, featured_files: ['new.csv', 'original.csv'] }, second]
          : [first, second]
    jobsPendingNotification.mockResolvedValueOnce(
      recovered.map((job) => ({
        ...job,
        analysis_state: 'dispatched',
        analysis_message_id: messageId
      }))
    )
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        messages: [
          {
            id: messageId,
            role: 'user',
            content: originalText,
            status: 'complete',
            eventIds: [],
            createdAt: 1400,
            updatedAt: 1400,
            attribution: {
              kind: 'application',
              feature: 'compute',
              purpose: 'job-completion-analysis',
              deliveryKey: 'compute_done:session-1:first-job,second-job',
              jobIds: ['first-job', 'second-job']
            }
          }
        ]
      }))
    }))
    if (change === 'missing attribution') {
      useSessionStore.setState((state) => ({
        sessions: state.sessions.map((session) => ({
          ...session,
          messages: session.messages.map((message) => ({ ...message, attribution: undefined }))
        }))
      }))
    }
    if (change === 'inactive branch') {
      useSessionStore.getState().finishRun('session-1')
      useSessionStore.getState().truncateSessionFromMessage('session-1', messageId)
      expect(useSessionStore.getState().sessions[0]!.messages).toEqual([])
    }
    const runtime: Parameters<typeof sendWorkspaceMessage>[0] = {
      state: {
        status: 'connected',
        cwd: '/workspace/project-a',
        sessionIds: ['session-1'],
        events: [],
        pendingPermissions: [],
        permissionProfiles: {},
        permissionGrants: {},
        contextUsageBySession: {},
        promptInFlight: false,
        promptInFlightSessionIds: []
      },
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn().mockResolvedValue(undefined)
    }
    window.api.sessions.saveSession = vi.fn(async (session) => session)
    const admission = vi.fn<AnalysisSendMessage>((input) =>
      sendWorkspaceMessage(runtime, {
        ...input,
        agentFrameworkId: 'claude-code'
      })
    )

    await act(async () => root.render(<Probe enabled onSendMessage={admission} />))

    expect(admission).toHaveBeenCalledOnce()
    expect
      .soft(await admission.mock.results[0]?.value)
      .toEqual({ sessionId: 'session-1', messageId })
    expect.soft(admission.mock.calls[0]?.[0].text).toBe(originalText)
    expect.soft(runtime.sendPrompt).toHaveBeenCalledOnce()
    expect(jobsTransitionAnalysis).not.toHaveBeenCalledWith(
      expect.objectContaining({ state: 'failed' })
    )
  })

  it('settles the completed analysis independently of a later failing user turn', async () => {
    jobsPendingNotification.mockResolvedValueOnce([])
    let accept!: () => void
    let analysisMessageId!: string
    const admission = vi.fn<AnalysisSendMessage>((input) => {
      analysisMessageId = input.messageId!
      return new Promise((resolve) => {
        accept = () => resolve({ sessionId: 'session-1', messageId: analysisMessageId })
      })
    })
    await act(async () => root.render(<Probe enabled onSendMessage={admission} />))
    await act(async () => useSessionJobStore.getState().applyUpdate(makeCompletedJob()))
    expect(admission).toHaveBeenCalledOnce()
    await act(async () => {
      useSessionStore.setState((state) => ({
        sessions: state.sessions.map((session) => ({
          ...session,
          status: 'running',
          activeRun: { promptMessageId: 'later-user-message', startedAt: 1600 },
          messages: [
            {
              id: analysisMessageId,
              role: 'user',
              content: admission.mock.calls[0]![0].text,
              status: 'complete',
              eventIds: [],
              createdAt: 1400,
              updatedAt: 1400
            },
            {
              id: 'analysis-reply',
              role: 'agent',
              responseToMessageId: analysisMessageId,
              content: 'Completed analysis',
              status: 'complete',
              eventIds: [],
              createdAt: 1500,
              updatedAt: 1500
            },
            {
              id: 'later-user-message',
              role: 'user',
              content: 'An unrelated request',
              status: 'complete',
              eventIds: [],
              createdAt: 1600,
              updatedAt: 1600
            }
          ]
        }))
      }))
      accept()
    })
    await act(async () => {
      useSessionStore.getState().failRun('session-1', 'Later turn failed')
    })
    expect(jobsTransitionAnalysis).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messageId: analysisMessageId,
        state: 'succeeded'
      })
    )
    expect(jobsTransitionAnalysis).not.toHaveBeenCalledWith(
      expect.objectContaining({ state: 'failed' })
    )
  })

  it('retries a transient recovered Session read without terminalizing the analysis', async () => {
    vi.useFakeTimers()
    const messageId = 'analysis-read-retry'
    jobsPendingNotification.mockResolvedValueOnce([
      makeCompletedJob({
        analysis_state: 'dispatched',
        analysis_message_id: messageId
      })
    ])
    const session = useSessionStore.getState().sessions[0]!
    useSessionStore.setState({ sessions: [{ ...session, contentLoaded: false }] })
    loadOne.mockRejectedValueOnce(new Error('Temporary local read failure')).mockResolvedValue({
      ...session,
      messages: [
        {
          id: messageId,
          role: 'user',
          content: 'Saved analysis',
          status: 'complete',
          eventIds: [],
          createdAt: 1400,
          updatedAt: 1400
        },
        {
          id: 'saved-reply',
          role: 'agent',
          responseToMessageId: messageId,
          content: 'Done',
          status: 'complete',
          eventIds: [],
          createdAt: 1500,
          updatedAt: 1500
        }
      ]
    })
    await act(async () => root.render(<Probe enabled />))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })

    expect(sendMessage).not.toHaveBeenCalled()
    expect(jobsTransitionAnalysis).not.toHaveBeenCalledWith(
      expect.objectContaining({ state: 'failed' })
    )
    expect(loadOne).toHaveBeenCalledTimes(2)
    expect(jobsTransitionAnalysis).toHaveBeenLastCalledWith(
      expect.objectContaining({ messageId, state: 'succeeded' })
    )
  })

  it('preserves cancellation when a recovered analysis has a partial error reply', async () => {
    const messageId = 'analysis-cancelled-with-output'
    jobsPendingNotification.mockResolvedValueOnce([
      makeCompletedJob({
        analysis_state: 'dispatched',
        analysis_message_id: messageId
      })
    ])
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        status: 'error',
        resumeRecovery: { kind: 'resume-required', cause: 'cancelled', promptMessageId: messageId },
        messages: [
          {
            id: messageId,
            role: 'user',
            content: 'Saved analysis',
            status: 'complete',
            eventIds: [],
            createdAt: 1400,
            updatedAt: 1400
          },
          {
            id: 'partial-reply',
            role: 'agent',
            responseToMessageId: messageId,
            content: 'Partial analysis',
            status: 'error',
            eventIds: [],
            createdAt: 1500,
            updatedAt: 1500
          }
        ]
      }))
    }))
    await act(async () => root.render(<Probe enabled />))

    expect(sendMessage).not.toHaveBeenCalled()
    expect(jobsTransitionAnalysis).toHaveBeenLastCalledWith(
      expect.objectContaining({ messageId, state: 'cancelled' })
    )
  })

  it.each([
    'wrong job',
    'wrong session',
    'wrong message',
    'incomplete batch',
    'wrong role',
    'wrong attribution'
  ])('rejects reuse of a saved prompt with %s', async (mismatch) => {
    const messageId = 'analysis-bound'
    const job = makeCompletedJob({ analysis_state: 'dispatched', analysis_message_id: messageId })
    jobsPendingNotification.mockResolvedValueOnce([job])
    jobsList.mockResolvedValue([
      {
        ...job,
        ...(mismatch === 'wrong job' ? { job_id: 'different-job' } : {}),
        ...(mismatch === 'wrong session' ? { session_id: 'different-session' } : {}),
        ...(mismatch === 'wrong message' ? { analysis_message_id: 'different-message' } : {})
      },
      ...(mismatch === 'incomplete batch' ? [{ ...job, job_id: 'unscanned-job' }] : [])
    ])
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        messages: [
          {
            id: messageId,
            role: mismatch === 'wrong role' ? 'agent' : 'user',
            content: 'Saved original',
            status: 'complete',
            eventIds: [],
            createdAt: 1400,
            updatedAt: 1400,
            ...(mismatch === 'wrong attribution'
              ? {
                  attribution: {
                    kind: 'application' as const,
                    feature: 'compute' as const,
                    purpose: 'job-completion-analysis' as const,
                    deliveryKey: 'compute_done:session-1:other-job',
                    jobIds: ['other-job']
                  }
                }
              : {})
          }
        ]
      }))
    }))
    await act(async () => root.render(<Probe enabled />))
    expect(sendMessage).not.toHaveBeenCalled()
    expect(jobsTransitionAnalysis).toHaveBeenLastCalledWith(
      expect.objectContaining({ messageId, state: 'failed' })
    )
  })

  it('reads completed analysis on an inactive branch without switching the visible branch', async () => {
    const messageId = 'analysis-inactive-complete'
    recordAnalysisRun({ sessionId: 'session-1', messageId, text: 'Saved analysis' })
    useSessionStore.getState().finishRun('session-1')
    useSessionStore.getState().truncateSessionFromMessage('session-1', messageId)
    const graph = useSessionStore.getState().sessions[0]!.conversationGraph
    jobsPendingNotification.mockResolvedValueOnce([
      makeCompletedJob({ analysis_state: 'dispatched', analysis_message_id: messageId })
    ])
    await act(async () => root.render(<Probe enabled />))
    expect(sendMessage).not.toHaveBeenCalled()
    expect(jobsTransitionAnalysis).toHaveBeenLastCalledWith(
      expect.objectContaining({ messageId, state: 'succeeded' })
    )
    expect(useSessionStore.getState().sessions[0]!.conversationGraph).toBe(graph)
    expect(useSessionStore.getState().sessions[0]!.messages).toEqual([])
  })

  it('ignores unrelated outcomes while the matching analysis has no terminal evidence', async () => {
    jobsPendingNotification.mockResolvedValueOnce([])
    await act(async () => root.render(<Probe enabled />))
    await act(async () => useSessionJobStore.getState().applyUpdate(makeCompletedJob()))
    const messageId = sendMessage.mock.calls[0]![0].messageId!
    await act(async () => {
      useSessionStore.setState((state) => ({
        sessions: state.sessions.map((session) => ({
          ...session,
          status: 'error',
          activeRun: undefined,
          resumeRecovery: {
            kind: 'resume-required',
            cause: 'cancelled',
            promptMessageId: 'unrelated-message'
          }
        }))
      }))
    })
    expect(jobsTransitionAnalysis).toHaveBeenCalledTimes(1)
    await act(async () => {
      useSessionStore.getState().interruptRun('session-1', 'cancelled', 'Stopped', messageId)
    })
    expect(jobsTransitionAnalysis).toHaveBeenLastCalledWith(
      expect.objectContaining({ messageId, state: 'cancelled' })
    )
    const count = jobsTransitionAnalysis.mock.calls.length
    await act(async () => useSessionStore.getState().finishRun('session-1'))
    expect(jobsTransitionAnalysis).toHaveBeenCalledTimes(count)
  })

  it.each(['succeeded', 'failed'] as const)(
    'settles an observed analysis %s even when it produced no text reply',
    async (outcome) => {
      jobsPendingNotification.mockResolvedValueOnce([])
      const admission = vi.fn<AnalysisSendMessage>(async (input) => {
        recordAnalysisRun(input)
        useSessionStore.setState((state) => ({
          sessions: state.sessions.map((session) => ({
            ...session,
            messages: session.messages.filter((message) => message.role !== 'agent')
          }))
        }))
        return { sessionId: 'session-1', messageId: input.messageId! }
      })
      await act(async () => root.render(<Probe enabled onSendMessage={admission} />))
      await act(async () => useSessionJobStore.getState().applyUpdate(makeCompletedJob()))
      expect(admission).toHaveBeenCalledOnce()
      await act(async () => {
        if (outcome === 'failed')
          useSessionStore.getState().failRun('session-1', 'Provider failed before output')
        else useSessionStore.getState().finishRun('session-1')
      })
      expect(jobsTransitionAnalysis).toHaveBeenLastCalledWith(
        expect.objectContaining({
          messageId: admission.mock.calls[0]![0].messageId,
          state: outcome
        })
      )
    }
  )

  it('waits for a rearmed analysis despite an old partial error reply', async () => {
    const messageId = 'analysis-rearmed'
    recordAnalysisRun({ sessionId: 'session-1', messageId, text: 'Saved analysis' })
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        messages: session.messages.map((message) =>
          message.role === 'agent' ? { ...message, status: 'error' } : message
        )
      }))
    }))
    jobsPendingNotification.mockResolvedValueOnce([
      makeCompletedJob({ analysis_state: 'dispatched', analysis_message_id: messageId })
    ])
    await act(async () => root.render(<Probe enabled />))
    expect(sendMessage).not.toHaveBeenCalled()
    expect(jobsTransitionAnalysis).not.toHaveBeenCalled()
    await act(async () =>
      useSessionStore.getState().interruptRun('session-1', 'cancelled', 'Stopped', messageId)
    )
    expect(jobsTransitionAnalysis).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: 'cancelled' })
    )
  })

  it('retries a failed batch read with the saved message identity', async () => {
    vi.useFakeTimers()
    const messageId = 'analysis-batch-read'
    const job = makeCompletedJob({ analysis_state: 'dispatched', analysis_message_id: messageId })
    jobsPendingNotification.mockResolvedValueOnce([job])
    jobsList
      .mockRejectedValueOnce(new Error('Temporary batch read failure'))
      .mockResolvedValue([job])
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        messages: [
          {
            id: messageId,
            role: 'user',
            content: 'Saved original',
            status: 'complete',
            eventIds: [],
            createdAt: 1400,
            updatedAt: 1400
          }
        ]
      }))
    }))
    await act(async () => root.render(<Probe enabled />))
    expect(jobsTransitionAnalysis).not.toHaveBeenCalled()
    expect(sendMessage).not.toHaveBeenCalled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ messageId, text: 'Saved original' })
    )
    expect(jobsTransitionAnalysis).not.toHaveBeenCalled()
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

  it('removes a delivery turn-end listener when persistence becomes unavailable', async () => {
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

    expect(sendMessage).toHaveBeenCalledOnce()
    expect(jobsTransitionAnalysis).toHaveBeenCalledOnce()
    expect(jobsTransitionAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'dispatched' })
    )

    await act(async () => root.render(<Probe enabled={false} />))
    act(() => useSessionStore.getState().finishRun('session-1'))
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))

    expect(sendMessage).toHaveBeenCalledOnce()
    expect(jobsTransitionAnalysis).toHaveBeenCalledOnce()
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
      recordAnalysisRun(input)
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
    act(() => useSessionStore.getState().finishRun('session-1'))
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
      recordAnalysisRun(input)
      useSessionStore.getState().finishRun('session-1')
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

  it('waits for a CLI-owned durable turn to settle without replacing newer local content', async () => {
    vi.useFakeTimers()
    const durableBase: PersistedChatSession = {
      id: 'session-1',
      projectId: 'project-a',
      title: 'CLI Session',
      cwd: '/workspace/project-a',
      status: 'running',
      activeRun: { promptMessageId: 'cli-prompt', startedAt: 2 },
      messages: [
        {
          id: 'cli-prompt',
          role: 'user',
          content: 'Run the remote workload',
          status: 'complete',
          eventIds: [],
          createdAt: 2,
          updatedAt: 2
        }
      ],
      createdAt: 1,
      updatedAt: 2
    }
    loadOne.mockResolvedValueOnce(durableBase).mockResolvedValueOnce({
      ...durableBase,
      status: 'idle',
      activeRun: undefined,
      taskRunCommitId: 'task-run-1',
      revision: 3,
      updatedAt: 3
    })
    useSessionStore.setState({
      sessions: [
        {
          id: 'session-1',
          projectId: 'project-a',
          title: 'CLI Session',
          cwd: '/workspace/project-a',
          status: 'idle',
          messages: [
            {
              id: 'local-message',
              role: 'user',
              content: 'A newer local edit',
              status: 'complete',
              eventIds: [],
              createdAt: 4,
              updatedAt: 4
            }
          ],
          createdAt: 1,
          updatedAt: 4
        }
      ],
      selectedSessionId: 'session-1'
    })

    await act(async () => root.render(<Probe enabled />))
    await act(async () => Promise.resolve())

    expect(sendMessage).not.toHaveBeenCalled()
    expect(useSessionStore.getState().sessions[0]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'local-message', content: 'A newer local edit' })
      ])
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })

    expect(sendMessage).toHaveBeenCalledOnce()
    expect(useSessionStore.getState().sessions[0]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'local-message', content: 'A newer local edit' })
      ])
    )
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
      messages: expect.arrayContaining([
        expect.objectContaining({ id: 'earlier-message', content: 'Earlier question' })
      ])
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
    act(() => useSessionStore.getState().finishRun('session-1'))
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
    act(() => useSessionStore.getState().failRun('session-1', 'Analysis turn failed'))
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
