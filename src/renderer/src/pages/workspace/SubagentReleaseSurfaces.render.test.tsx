// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useLayoutEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChatSession } from '@/stores/session-store'
import type { AcpAgentRuntimeUpdate } from '../../../../shared/acp'
import { useSubagentRuntimePresentation } from '@/lib/acp/workspace-subagent-runtime-presentation'

const runtimeUpdateHarness = vi.hoisted(() => {
  const listeners = new Set<(update: AcpAgentRuntimeUpdate) => void>()
  return {
    publish(update: AcpAgentRuntimeUpdate) {
      for (const listener of listeners) listener(update)
    },
    reset() {
      listeners.clear()
    },
    subscribe(listener: (update: AcpAgentRuntimeUpdate) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
})

vi.mock('@/lib/acp/useWorkspaceAgentRuntime', async () => {
  const { useSubagentRuntimePresentation } =
    await import('@/lib/acp/workspace-subagent-runtime-presentation')
  return {
    useWorkspaceSubagentRuntimeSession: (
      session: ChatSession,
      detail: Parameters<typeof useSubagentRuntimePresentation>[2]
    ) => useSubagentRuntimePresentation(runtimeUpdateHarness.subscribe, session, detail)
  }
})

import {
  createInitialPreviewWorkbenchState,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import { createInitialSessionState, useSessionStore } from '@/stores/session-store'

import {
  SubagentAvailabilityNotice,
  SubagentPreview,
  SubagentsBar
} from './SubagentReleaseSurfaces'
import { MobilePreviewSheet } from './MobilePreviewSheet'

const renderSurface = (surface: React.ReactNode): ReturnType<typeof render> => render(surface)

const RuntimePresentationProbe = ({
  session,
  detail,
  publishAfterLayout
}: {
  session: ChatSession
  detail: Parameters<typeof useSubagentRuntimePresentation>[2]
  publishAfterLayout?: () => void
}): React.JSX.Element => {
  const projected = useSubagentRuntimePresentation(runtimeUpdateHarness.subscribe, session, detail)
  useLayoutEffect(() => publishAfterLayout?.(), [publishAfterLayout])
  return (
    <pre data-testid="runtime-presentation-probe">
      {JSON.stringify({
        status: projected.status,
        error: projected.error,
        agentStatus: projected.agentStatus,
        activeRun: Boolean(projected.activeRun),
        agentPromptInFlight: Boolean(projected.agentPromptInFlight),
        awaitingFirstAgentOutput: Boolean(projected.awaitingFirstAgentOutput),
        interactionState: Boolean(projected.interactionState),
        messages: projected.messages.map(({ content }) => content),
        activities: projected.activities?.map(
          ({
            id,
            title,
            status,
            activityGroupId,
            eventIds,
            terminalOutput,
            rawOutput,
            providerToolName
          }) => ({
            id,
            title,
            status,
            activityGroupId,
            eventIds,
            terminalOutput,
            rawOutput,
            providerToolName
          })
        ),
        activityGroups: projected.activityGroups?.map(({ id, activityIds }) => ({
          id,
          activityIds
        }))
      })}
    </pre>
  )
}

const createSession = (): ChatSession => {
  const now = 1_700_000_000_000
  return {
    id: 'session-1',
    projectId: 'project-1',
    title: 'Release gate',
    cwd: '/tmp/release-gate',
    status: 'running',
    messages: [],
    createdAt: now,
    updatedAt: now,
    conversationGraph: {
      schemaVersion: 1,
      rootFrameId: 'root',
      activeFrameId: 'root',
      frames: [
        {
          id: 'root',
          originBindingState: 'root',
          kind: 'root',
          status: 'running',
          activeBranchId: 'root-branch',
          createdAt: now
        },
        {
          id: 'child-a',
          parentFrameId: 'root',
          originMessageId: 'root-prompt',
          originBindingState: 'validated',
          kind: 'delegate',
          delegateName: 'Evidence landscape',
          agentName: 'Main Agent',
          status: 'running',
          activeBranchId: 'child-a-branch',
          createdAt: now + 1
        },
        {
          id: 'child-b',
          parentFrameId: 'root',
          originMessageId: 'root-prompt',
          originBindingState: 'validated',
          kind: 'delegate',
          delegateName: 'Challenge assumptions',
          agentName: 'Risk Specialist',
          status: 'error',
          activeBranchId: 'child-b-branch',
          createdAt: now + 2
        }
      ],
      branches: [
        {
          id: 'root-branch',
          agentFrameId: 'root',
          headMessageId: 'root-prompt',
          createdAt: now,
          updatedAt: now
        },
        {
          id: 'child-a-branch',
          agentFrameId: 'child-a',
          headMessageId: 'child-a-answer',
          createdAt: now + 1,
          updatedAt: now + 3
        },
        {
          id: 'child-b-branch',
          agentFrameId: 'child-b',
          headMessageId: 'child-b-prompt',
          createdAt: now + 2,
          updatedAt: now + 2
        }
      ],
      messages: [
        {
          id: 'root-prompt',
          role: 'user',
          content: 'Compare the evidence',
          status: 'complete',
          eventIds: [],
          createdAt: now,
          updatedAt: now,
          agentFrameId: 'root',
          introducedOnBranchId: 'root-branch'
        },
        {
          id: 'child-a-prompt',
          role: 'user',
          content: 'Map the evidence',
          status: 'complete',
          eventIds: [],
          createdAt: now + 1,
          updatedAt: now + 1,
          agentFrameId: 'child-a',
          introducedOnBranchId: 'child-a-branch',
          runtimeSegmentId: 'runtime-a'
        },
        {
          id: 'child-a-answer',
          role: 'agent',
          content: 'Fourteen strong studies remain.',
          status: 'complete',
          eventIds: [],
          responseToMessageId: 'child-a-prompt',
          createdAt: now + 3,
          updatedAt: now + 3,
          agentFrameId: 'child-a',
          introducedOnBranchId: 'child-a-branch',
          parentMessageId: 'child-a-prompt',
          runtimeSegmentId: 'runtime-a'
        },
        {
          id: 'child-b-prompt',
          role: 'user',
          content: 'Challenge assumptions',
          status: 'complete',
          eventIds: [],
          createdAt: now + 2,
          updatedAt: now + 2,
          agentFrameId: 'child-b',
          introducedOnBranchId: 'child-b-branch',
          runtimeSegmentId: 'runtime-b'
        }
      ],
      activities: [],
      activityGroups: [],
      runtimeSegments: [
        {
          id: 'runtime-a',
          agentFrameId: 'child-a',
          frameworkId: 'claude-code',
          startedAt: now + 1
        },
        {
          id: 'runtime-b',
          agentFrameId: 'child-b',
          frameworkId: 'claude-code',
          startedAt: now + 2
        }
      ]
    },
    runtimeContext: {
      version: 1,
      revision: 2,
      delegatedWork: {
        records: [
          {
            agentFrameId: 'child-a',
            attempts: [
              {
                id: 'attempt-a',
                status: 'running',
                resolvedAgent: { kind: 'main' },
                runtimeSegmentIds: ['runtime-a'],
                startedAt: now + 1
              }
            ]
          },
          {
            agentFrameId: 'child-b',
            attempts: [
              {
                id: 'attempt-b',
                status: 'error',
                resolvedAgent: {
                  kind: 'specialist',
                  profileId: 'risk',
                  revision: 2,
                  displayName: 'Risk Specialist'
                },
                runtimeSegmentIds: ['runtime-b'],
                startedAt: now + 2,
                endedAt: now + 4,
                error: { code: 'provider', message: 'Provider turn failed' }
              }
            ]
          }
        ]
      }
    }
  }
}

describe('release-gate Subagent surfaces', () => {
  afterEach(cleanup)

  beforeEach(() => {
    runtimeUpdateHarness.reset()
    usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
    useSessionStore.setState({ ...createInitialSessionState(), sessions: [createSession()] })
  })

  it('shows total and running counts, then switches the stable preview from the expanded bar', () => {
    const session = createSession()
    renderSurface(<SubagentsBar session={session} permissions={[]} />)

    const bar = screen.getByRole('button', { name: '2 subagents, 1 running' })
    expect(bar.textContent).toContain('2 subagents')
    expect(bar.textContent).toContain('1 running')
    expect(bar.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('button', { name: /Evidence landscape, running/i })).toBeNull()

    fireEvent.click(bar)
    expect(bar.getAttribute('aria-expanded')).toBe('true')
    const errorRow = screen.getByRole('button', { name: /Challenge assumptions, error/i })
    expect(errorRow.className).toContain('border-border-300/15')
    expect(within(errorRow).getByTitle('Challenge assumptions').className).toContain(
      'font-semibold'
    )
    fireEvent.click(errorRow)
    expect(
      usePreviewWorkbenchStore
        .getState()
        .items.filter((item) => item.id === 'tool:session-1:subagents')
    ).toHaveLength(1)

    expect(usePreviewWorkbenchStore.getState().items[0]).toMatchObject({
      selectedAgentFrameId: 'child-b'
    })
    expect(bar.getAttribute('aria-expanded')).toBe('false')
  })

  it('shows a terminal child continuation as running before its first Agent response', () => {
    const completed = structuredClone(createSession())
    const completedFrame = completed.conversationGraph?.frames.find(({ id }) => id === 'child-a')
    const completedAttempt = completed.runtimeContext?.delegatedWork?.records
      .find(({ agentFrameId }) => agentFrameId === 'child-a')
      ?.attempts.at(-1)
    if (!completedFrame || !completedAttempt) throw new Error('Expected child-a fixtures')
    completedFrame.status = 'completed'
    completedFrame.completedAt = completed.updatedAt + 4
    Object.assign(completedAttempt, {
      status: 'completed',
      endedAt: completed.updatedAt + 4
    })
    useSessionStore.getState().hydrateSessions([completed])

    const continued = structuredClone(completed)
    const continuedGraph = continued.conversationGraph!
    const continuedFrame = continuedGraph.frames.find(({ id }) => id === 'child-a')!
    const continuedBranch = continuedGraph.branches.find(
      ({ id }) => id === continuedFrame.activeBranchId
    )!
    const continuedAt = completed.updatedAt + 5
    const continuedRuntime = continued.runtimeContext!
    const continuedDelegatedWork = continuedRuntime.delegatedWork!
    continued.runtimeContext = {
      ...continuedRuntime,
      revision: continuedRuntime.revision + 1,
      delegatedWork: {
        ...continuedDelegatedWork,
        records: continuedDelegatedWork.records.map((record) =>
          record.agentFrameId === 'child-a'
            ? {
                ...record,
                attempts: [
                  ...record.attempts,
                  {
                    id: 'attempt-a-continuation',
                    status: 'running' as const,
                    resolvedAgent: { kind: 'main' as const },
                    runtimeSegmentIds: [],
                    startedAt: continuedAt
                  }
                ]
              }
            : record
        )
      }
    }
    continuedFrame.status = 'running'
    delete continuedFrame.completedAt
    continuedGraph.messages.push({
      id: 'child-a-continuation',
      role: 'user',
      content: 'Continue with the new evidence.',
      status: 'complete',
      eventIds: [],
      agentFrameId: 'child-a',
      introducedOnBranchId: continuedBranch.id,
      parentMessageId: continuedBranch.headMessageId,
      createdAt: continuedAt,
      updatedAt: continuedAt
    })
    continuedBranch.headMessageId = 'child-a-continuation'
    continuedBranch.updatedAt = continuedAt

    useSessionStore.getState().upsertPersistedSession(continued)

    const merged = useSessionStore.getState().sessions[0]
    expect(merged.conversationGraph?.messages.some(({ id }) => id === 'child-a-continuation')).toBe(
      true
    )
    renderSurface(<SubagentsBar session={merged} permissions={[]} />)
    expect(screen.getByRole('button', { name: '2 subagents, 1 running' })).toBeTruthy()
  })

  it('collapses the expanded list when clicking elsewhere in the app', () => {
    const session = createSession()
    renderSurface(
      <>
        <span data-testid="app-surface">elsewhere in the app</span>
        <SubagentsBar session={session} permissions={[]} />
      </>
    )

    const bar = screen.getByRole('button', { name: '2 subagents, 1 running' })
    fireEvent.click(bar)
    expect(bar.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByLabelText('Subagents')).toBeTruthy()

    fireEvent.click(screen.getByTestId('app-surface'))

    expect(bar.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByLabelText('Subagents')).toBeNull()
  })

  it('collapses the expanded list on Escape', () => {
    const session = createSession()
    renderSurface(<SubagentsBar session={session} permissions={[]} />)

    const bar = screen.getByRole('button', { name: '2 subagents, 1 running' })
    fireEvent.click(bar)
    expect(bar.getAttribute('aria-expanded')).toBe('true')

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(bar.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByLabelText('Subagents')).toBeNull()
  })

  it('shows a truncated single name with hover text and only a running icon', () => {
    const session = createSession()
    const longName = 'Reproduce the complete statistical analysis with sensitivity checks'
    const singleSession: ChatSession = {
      ...session,
      conversationGraph: session.conversationGraph
        ? {
            ...session.conversationGraph,
            frames: session.conversationGraph.frames
              .filter(({ id }) => id !== 'child-b')
              .map((frame) =>
                frame.id === 'child-a' ? { ...frame, delegateName: longName } : frame
              )
          }
        : undefined,
      runtimeContext: session.runtimeContext
        ? {
            ...session.runtimeContext,
            delegatedWork: session.runtimeContext.delegatedWork
              ? {
                  ...session.runtimeContext.delegatedWork,
                  records: session.runtimeContext.delegatedWork.records.filter(
                    ({ agentFrameId }) => agentFrameId !== 'child-b'
                  )
                }
              : undefined
          }
        : undefined
    }
    renderSurface(<SubagentsBar session={singleSession} permissions={[]} />)

    const bar = screen.getByRole('button', { name: `${longName}, running` })
    expect(bar.title).toBe(longName)
    expect(bar.querySelector('.truncate')?.textContent).toBe(longName)
    expect(within(bar).getByLabelText('Running')).toBeTruthy()
    expect(bar.textContent).not.toContain('1 subagent')
    expect(bar.textContent).not.toContain('running')
    expect(bar.getAttribute('aria-expanded')).toBeNull()

    fireEvent.click(bar)

    expect(screen.queryByLabelText('Subagents')).toBeNull()
    expect(usePreviewWorkbenchStore.getState().items[0]).toMatchObject({
      selectedAgentFrameId: 'child-a'
    })
  })

  it('provides a read-only Frame selector, raw status, error detail, and Close focus return', () => {
    const trigger = document.createElement('button')
    trigger.textContent = 'Open Subagents'
    document.body.append(trigger)
    trigger.focus()

    renderSurface(
      <SubagentPreview
        item={{
          id: 'tool:session-1:subagents',
          type: 'tool',
          toolKind: 'subagents',
          title: 'Subagents',
          sessionId: 'session-1',
          projectId: 'project-1',
          selectedAgentFrameId: 'child-b'
        }}
        returnFocus={trigger}
      />
    )

    expect(screen.getByLabelText('Subagent Frame').className).toContain('focus-visible:ring-3')
    expect(screen.getByText('Failed')).toBeTruthy()
    expect(screen.getByText('Provider turn failed')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /stop/i })).toBeNull()

    const closeButton = screen.getByRole('button', { name: 'Close Subagents preview' })
    expect(closeButton.className).toContain('focus-visible:ring-[3px]')
    fireEvent.click(closeButton)
    expect(document.activeElement).toBe(trigger)
  })

  it('provides a visible tooltip for the icon-only Preview close control', async () => {
    renderSurface(
      <SubagentPreview
        item={{
          id: 'tool:session-1:subagents',
          type: 'tool',
          toolKind: 'subagents',
          title: 'Subagents',
          sessionId: 'session-1',
          selectedAgentFrameId: 'child-a'
        }}
      />
    )

    const closeButton = screen.getByRole('button', { name: 'Close Subagents preview' })
    fireEvent.focus(closeButton)
    expect((await screen.findByRole('tooltip')).textContent).toContain('Close Subagents preview')
  })

  it('selects another Frame through the shared Select without opening a second preview', () => {
    const item = {
      id: 'tool:session-1:subagents',
      type: 'tool' as const,
      toolKind: 'subagents' as const,
      title: 'Subagents',
      sessionId: 'session-1',
      projectId: 'project-1',
      selectedAgentFrameId: 'child-b'
    }
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(item)
    const { rerender } = renderSurface(<SubagentPreview item={item} />)
    expect(screen.getByText('Provider turn failed')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('Subagent Frame'))
    fireEvent.click(screen.getByRole('option', { name: 'Evidence landscape' }))

    expect(usePreviewWorkbenchStore.getState().items).toHaveLength(1)
    expect(usePreviewWorkbenchStore.getState().items[0]).toMatchObject({
      selectedAgentFrameId: 'child-a'
    })
    const updatedItem = usePreviewWorkbenchStore.getState().items[0]
    if (updatedItem?.type !== 'tool') throw new Error('Expected the Subagents preview item')
    rerender(<SubagentPreview item={updatedItem} />)

    expect(screen.getByText('Fourteen strong studies remain.')).toBeTruthy()
    expect(screen.queryByText('Provider turn failed')).toBeNull()
  })

  it('streams the selected running Frame without mutating root state and completes token usage on stop', async () => {
    const session = createSession()
    const childBranch = session.conversationGraph?.branches.find(
      (branch) => branch.id === 'child-a-branch'
    )
    if (childBranch) childBranch.headMessageId = 'child-a-prompt'
    if (session.conversationGraph) {
      session.conversationGraph.messages = session.conversationGraph.messages.filter(
        (message) => message.id !== 'child-a-answer'
      )
    }
    session.agentStatus = 'root retry status'
    useSessionStore.setState({ ...createInitialSessionState(), sessions: [session] })
    const rootBefore = structuredClone(useSessionStore.getState().sessions[0])

    renderSurface(
      <SubagentPreview
        item={{
          id: 'tool:session-1:subagents',
          type: 'tool',
          toolKind: 'subagents',
          title: 'Subagents',
          sessionId: 'session-1',
          projectId: 'project-1',
          selectedAgentFrameId: 'child-a'
        }}
      />
    )

    expect(screen.getByText('Thinking')).toBeTruthy()
    await act(async () => {
      runtimeUpdateHarness.publish({
        scope: {
          projectId: 'project-1',
          sessionId: 'session-1',
          agentFrameId: 'child-a',
          attemptId: 'attempt-a',
          runtimeSegmentId: 'runtime-a',
          promptMessageId: 'child-a-prompt'
        },
        event: {
          id: 'child-warning-1',
          timestamp: 1_700_000_000_005,
          kind: 'system',
          level: 'warning',
          text: 'child retry status'
        }
      })
    })
    expect(screen.getByText('child retry status')).toBeTruthy()
    expect(screen.queryByText('root retry status')).toBeNull()

    await act(async () => {
      runtimeUpdateHarness.publish({
        scope: {
          projectId: 'project-1',
          sessionId: 'session-1',
          agentFrameId: 'child-a',
          attemptId: 'attempt-a',
          runtimeSegmentId: 'runtime-a',
          promptMessageId: 'stale-child-prompt'
        },
        event: {
          id: 'stale-child-message',
          timestamp: 1_700_000_000_009,
          kind: 'message',
          level: 'info',
          role: 'assistant',
          messageId: 'stale-child-stream',
          text: 'Stale child output'
        }
      })
      runtimeUpdateHarness.publish({
        scope: {
          projectId: 'project-1',
          sessionId: 'session-1',
          agentFrameId: 'child-a',
          attemptId: 'attempt-a',
          runtimeSegmentId: 'runtime-a',
          promptMessageId: 'child-a-prompt'
        },
        event: {
          id: 'child-message-1',
          timestamp: 1_700_000_000_010,
          kind: 'message',
          level: 'info',
          role: 'assistant',
          messageId: 'child-stream',
          text: 'Live child evidence'
        }
      })
    })

    expect(await screen.findByText('Live child evidence')).toBeTruthy()
    expect(screen.queryByText('Stale child output')).toBeNull()
    expect(useSessionStore.getState().sessions[0]).toEqual(rootBefore)

    await act(async () => {
      runtimeUpdateHarness.publish({
        scope: {
          projectId: 'project-1',
          sessionId: 'session-1',
          agentFrameId: 'child-a',
          attemptId: 'attempt-a',
          runtimeSegmentId: 'runtime-a',
          promptMessageId: 'child-a-prompt'
        },
        event: {
          id: 'child-stop-1',
          timestamp: 1_700_000_000_020,
          kind: 'stop',
          level: 'info',
          turnUsage: { inputTokens: 31, cacheTokens: 15, outputTokens: 14 }
        }
      })
    })

    expect(screen.getByRole('button', { name: 'Token usage for this response' })).toBeTruthy()
    expect(screen.queryByText('Thinking')).toBeNull()
    expect(useSessionStore.getState().sessions[0]).toEqual(rootBefore)
  })

  it.each(['cancelled', 'error', 'awaiting_user'] as const)(
    'clears the isolated running presentation when durable child state becomes %s',
    async (status) => {
      const running = createSession()
      const childBranch = running.conversationGraph?.branches.find(
        (branch) => branch.id === 'child-a-branch'
      )
      if (childBranch) childBranch.headMessageId = 'child-a-prompt'
      if (running.conversationGraph) {
        running.conversationGraph.messages = running.conversationGraph.messages.filter(
          (message) => message.id !== 'child-a-answer'
        )
      }
      useSessionStore.setState({ ...createInitialSessionState(), sessions: [running] })

      renderSurface(
        <SubagentPreview
          item={{
            id: 'tool:session-1:subagents',
            type: 'tool',
            toolKind: 'subagents',
            title: 'Subagents',
            sessionId: 'session-1',
            projectId: 'project-1',
            selectedAgentFrameId: 'child-a'
          }}
        />
      )
      expect(screen.getByText('Thinking')).toBeTruthy()
      await act(async () => {
        runtimeUpdateHarness.publish({
          scope: {
            projectId: 'project-1',
            sessionId: 'session-1',
            agentFrameId: 'child-a',
            attemptId: 'attempt-a',
            runtimeSegmentId: 'runtime-a',
            promptMessageId: 'child-a-prompt'
          },
          event: {
            id: `child-warning-${status}`,
            timestamp: running.updatedAt + 1,
            kind: 'system',
            level: 'warning',
            text: 'Retrying child request'
          }
        })
      })
      expect(screen.getByText('Retrying child request')).toBeTruthy()

      const durable = structuredClone(running)
      const runtimeContext = durable.runtimeContext!
      durable.runtimeContext = { ...runtimeContext, revision: runtimeContext.revision + 1 }
      const frame = durable.conversationGraph?.frames.find(({ id }) => id === 'child-a')
      const attempt = durable.runtimeContext.delegatedWork?.records
        .find(({ agentFrameId }) => agentFrameId === 'child-a')
        ?.attempts.at(-1)
      if (!frame || !attempt) throw new Error('Expected child-a durable fixtures')

      if (status === 'awaiting_user') {
        Object.assign(durable.runtimeContext.delegatedWork!, {
          questionRequests: [
            {
              requestId: 'question-a',
              canonicalDigest: 'a'.repeat(64),
              sourceFrameId: 'child-a',
              sourceAttemptId: 'attempt-a',
              sourceRuntimeSegmentId: 'runtime-a',
              sourceMessageBranchId: 'child-a-branch',
              rootOriginMessageId: 'root-prompt',
              rootBranchId: 'root-branch',
              sourceName: 'Evidence landscape',
              questions: [{ question: 'Continue?', options: [{ label: 'Yes' }, { label: 'No' }] }],
              askedAt: running.updatedAt,
              status: 'pending',
              draftAnswers: [],
              draftQuestionIndex: 0
            }
          ]
        })
      } else {
        frame.status = status
        frame.completedAt = running.updatedAt
        Object.assign(attempt, {
          status,
          endedAt: running.updatedAt,
          ...(status === 'cancelled'
            ? { cancellationReason: 'main_agent_stop' as const }
            : { error: { code: 'provider', message: 'Child failed durably' } })
        })
      }

      await act(async () => {
        useSessionStore.getState().upsertPersistedSession(durable)
      })

      expect(document.querySelector(`[data-subagent-status="${status}"]`)).not.toBeNull()
      expect(screen.queryByText('Thinking')).toBeNull()
      expect(screen.queryByText('Retrying child request')).toBeNull()
      if (status === 'error') expect(screen.getByText('Child failed durably')).toBeTruthy()

      await act(async () => {
        runtimeUpdateHarness.publish({
          scope: {
            projectId: 'project-1',
            sessionId: 'session-1',
            agentFrameId: 'child-a',
            attemptId: 'attempt-a',
            runtimeSegmentId: 'runtime-a',
            promptMessageId: 'child-a-prompt'
          },
          event: {
            id: `child-late-warning-${status}`,
            timestamp: running.updatedAt + 20,
            kind: 'system',
            level: 'warning',
            text: 'Late child warning'
          }
        })
        runtimeUpdateHarness.publish({
          scope: {
            projectId: 'project-1',
            sessionId: 'session-1',
            agentFrameId: 'child-a',
            attemptId: 'attempt-a',
            runtimeSegmentId: 'runtime-a',
            promptMessageId: 'child-a-prompt'
          },
          event: {
            id: `child-late-error-${status}`,
            timestamp: running.updatedAt + 21,
            kind: 'error',
            level: 'error',
            text: 'Late runtime error'
          }
        })
      })

      expect(document.querySelector(`[data-subagent-status="${status}"]`)).not.toBeNull()
      expect(screen.queryByText('Provider notice')).toBeNull()
      expect(screen.queryByText('Provider error')).toBeNull()
      expect(screen.queryByText('Late child warning')).toBeNull()
      expect(screen.queryByText('Late runtime error')).toBeNull()
      expect(screen.queryByText('Thinking')).toBeNull()
    }
  )

  it('preserves accepted content and applies same-runtime events after durable termination', async () => {
    const running = createSession()
    const prompt = running.conversationGraph!.messages.find(({ id }) => id === 'child-a-prompt')!
    const attempt = running.runtimeContext!.delegatedWork!.records.find(
      ({ agentFrameId }) => agentFrameId === 'child-a'
    )!.attempts[0]
    const runningDetail = {
      frameId: 'child-a',
      status: 'running' as const,
      attempt,
      messages: [prompt]
    }
    const rendered = render(<RuntimePresentationProbe session={running} detail={runningDetail} />)
    const scope = {
      projectId: 'project-1',
      sessionId: 'session-1',
      agentFrameId: 'child-a',
      attemptId: 'attempt-a',
      runtimeSegmentId: 'runtime-a',
      promptMessageId: 'child-a-prompt'
    }

    await act(async () => {
      runtimeUpdateHarness.publish({
        scope,
        event: {
          id: 'live-group-start',
          timestamp: running.updatedAt + 10,
          kind: 'tool',
          level: 'info',
          toolCallId: 'live-group-call',
          providerToolName: 'mcp__open-science-activity__begin_activity_group',
          rawInput: { title: 'Accepted live group' },
          status: 'in_progress'
        }
      })
      runtimeUpdateHarness.publish({
        scope,
        event: {
          id: 'live-ghost-message',
          timestamp: running.updatedAt + 11,
          kind: 'message',
          level: 'info',
          role: 'assistant',
          messageId: 'live-ghost-stream',
          text: 'Live ghost message'
        }
      })
      runtimeUpdateHarness.publish({
        scope,
        event: {
          id: 'live-ghost-tail',
          timestamp: running.updatedAt + 12,
          kind: 'message',
          level: 'info',
          role: 'assistant',
          messageId: 'live-ghost-stream',
          text: ' with live tail'
        }
      })
      runtimeUpdateHarness.publish({
        scope,
        event: {
          id: 'live-ghost-tool',
          timestamp: running.updatedAt + 13,
          kind: 'tool',
          level: 'info',
          toolCallId: 'live-ghost-tool-call',
          providerToolName: 'Read',
          toolKind: 'read',
          title: 'Live ghost tool',
          status: 'in_progress'
        }
      })
      runtimeUpdateHarness.publish({
        scope,
        event: {
          id: 'live-ghost-tool-complete',
          timestamp: running.updatedAt + 14,
          kind: 'tool',
          level: 'info',
          toolCallId: 'live-ghost-tool-call',
          providerToolName: 'Read',
          toolKind: 'read',
          title: 'Live ghost tool',
          status: 'completed',
          terminalOutput: 'Accepted completion output',
          rawOutput: { phase: 'complete' }
        }
      })
      runtimeUpdateHarness.publish({
        scope,
        event: {
          id: 'live-only-message',
          timestamp: running.updatedAt + 15,
          kind: 'message',
          level: 'info',
          role: 'assistant',
          messageId: 'live-only-stream',
          text: 'Accepted live-only message'
        }
      })
      runtimeUpdateHarness.publish({
        scope,
        event: {
          id: 'live-warning',
          timestamp: running.updatedAt + 16,
          kind: 'system',
          level: 'warning',
          text: 'Transient live warning'
        }
      })
    })
    const probe = screen.getByTestId('runtime-presentation-probe')
    expect(probe.textContent).toContain('Live ghost message with live tail')
    expect(probe.textContent).toContain('Accepted live-only message')
    expect(probe.textContent).toContain('Live ghost tool')
    expect(probe.textContent).toContain('Transient live warning')
    expect(probe.textContent).toContain('"activeRun":true')
    expect(probe.textContent).toContain('"agentPromptInFlight":true')

    const terminal = structuredClone(running)
    const terminalFrame = terminal.conversationGraph!.frames.find(({ id }) => id === 'child-a')!
    const terminalAttempt = terminal.runtimeContext!.delegatedWork!.records.find(
      ({ agentFrameId }) => agentFrameId === 'child-a'
    )!.attempts[0]
    terminalFrame.status = 'cancelled'
    terminalFrame.completedAt = running.updatedAt + 12
    Object.assign(terminalAttempt, {
      status: 'cancelled',
      endedAt: running.updatedAt + 12,
      cancellationReason: 'main_agent_stop'
    })
    terminal.conversationGraph!.activities.push({
      id: 'agent-runtime:runtime-a:live-ghost-tool-call',
      kind: 'tool',
      title: 'Live ghost tool',
      activityGroupId: 'agent-runtime:runtime-a:live-group-call',
      promptMessageId: 'child-a-prompt',
      status: 'failed',
      sortIndex: 2,
      eventIds: ['live-ghost-tool'],
      providerToolName: 'Read',
      toolKind: 'read',
      terminalOutput: 'Durable stale output',
      rawOutput: { phase: 'start' },
      createdAt: running.updatedAt + 13,
      updatedAt: running.updatedAt + 16,
      agentFrameId: 'child-a',
      messageBranchId: 'child-a-branch',
      runtimeSegmentId: 'runtime-a'
    })
    terminal.conversationGraph!.activityGroups.push({
      id: 'agent-runtime:runtime-a:live-group-call',
      title: 'Accepted live group',
      sortIndex: 1,
      activityIds: ['agent-runtime:runtime-a:live-ghost-tool-call'],
      promptMessageId: 'child-a-prompt',
      createdAt: running.updatedAt + 10,
      updatedAt: running.updatedAt + 16,
      completedAt: running.updatedAt + 16,
      agentFrameId: 'child-a',
      messageBranchId: 'child-a-branch'
    })
    const terminalDetail = {
      frameId: 'child-a',
      status: 'cancelled' as const,
      attempt: terminalAttempt,
      messages: [
        prompt,
        {
          id: 'durable-live-message',
          role: 'agent' as const,
          content: 'Live ghost message',
          status: 'complete' as const,
          eventIds: ['live-ghost-message'],
          responseToMessageId: 'child-a-prompt',
          createdAt: running.updatedAt + 10,
          updatedAt: running.updatedAt + 12
        }
      ]
    }
    await act(async () => {
      rendered.rerender(
        <RuntimePresentationProbe
          session={terminal}
          detail={terminalDetail}
          publishAfterLayout={() => {
            runtimeUpdateHarness.publish({
              scope,
              event: {
                id: 'layout-gap-message',
                timestamp: running.updatedAt + 17,
                kind: 'message',
                level: 'info',
                role: 'assistant',
                messageId: 'layout-gap-stream',
                text: 'Evidence from the layout-to-passive cleanup gap'
              }
            })
            runtimeUpdateHarness.publish({
              scope,
              event: {
                id: 'layout-gap-error',
                timestamp: running.updatedAt + 18,
                kind: 'error',
                level: 'error',
                text: 'Error from the layout-to-passive cleanup gap'
              }
            })
          }}
        />
      )
    })

    expect(probe.textContent).toContain('"status":"idle"')
    expect(probe.textContent?.match(/Live ghost message with live tail/g)).toHaveLength(1)
    expect(probe.textContent).toContain('Accepted live-only message')
    expect(probe.textContent?.match(/Live ghost tool/g)).toHaveLength(1)
    expect(probe.textContent).toContain('agent-runtime:runtime-a:live-ghost-tool-call')
    expect(probe.textContent).not.toContain('"id":"live-ghost-tool-call"')
    expect(probe.textContent).toContain(
      '"activityIds":["agent-runtime:runtime-a:live-ghost-tool-call"]'
    )
    expect(probe.textContent).toContain('"eventIds":["live-ghost-tool","live-ghost-tool-complete"]')
    expect(probe.textContent).toContain('"status":"completed"')
    expect(probe.textContent).toContain('"terminalOutput":"Accepted completion output"')
    expect(probe.textContent).toContain('"rawOutput":{"phase":"complete"}')
    expect(probe.textContent).not.toContain('Durable stale output')
    expect(probe.textContent).not.toContain('Transient live warning')
    expect(probe.textContent).toContain('Evidence from the layout-to-passive cleanup gap')
    expect(probe.textContent).toContain('Error from the layout-to-passive cleanup gap')
    expect(probe.textContent).not.toContain('AgentRuntimeEvidence')
    expect(probe.textContent).toContain('"activeRun":false')
    expect(probe.textContent).toContain('"agentPromptInFlight":false')
    expect(probe.textContent).toContain('"awaitingFirstAgentOutput":false')
    expect(probe.textContent).toContain('"interactionState":false')

    await act(async () => {
      runtimeUpdateHarness.publish({
        scope,
        event: {
          id: 'late-terminal-message-prefix',
          timestamp: running.updatedAt + 20,
          kind: 'message',
          level: 'info',
          role: 'assistant',
          messageId: 'late-terminal-stream',
          text: 'Late terminal message'
        }
      })
      runtimeUpdateHarness.publish({
        scope,
        event: {
          id: 'late-terminal-message-final',
          timestamp: running.updatedAt + 21,
          kind: 'message',
          level: 'info',
          role: 'assistant',
          messageId: 'late-terminal-stream',
          text: ' final'
        }
      })
      runtimeUpdateHarness.publish({
        scope,
        event: {
          id: 'late-terminal-tool',
          timestamp: running.updatedAt + 22,
          kind: 'tool',
          level: 'info',
          toolCallId: 'late-terminal-tool-call',
          providerToolName: 'Read',
          toolKind: 'read',
          title: 'Late terminal tool',
          status: 'in_progress'
        }
      })
      runtimeUpdateHarness.publish({
        scope,
        event: {
          id: 'late-terminal-tool-complete',
          timestamp: running.updatedAt + 23,
          kind: 'tool',
          level: 'info',
          toolCallId: 'late-terminal-tool-call',
          providerToolName: 'Read',
          toolKind: 'read',
          title: 'Late terminal tool',
          status: 'completed',
          terminalOutput: 'Late tool output'
        }
      })
      runtimeUpdateHarness.publish({
        scope,
        event: {
          id: 'late-terminal-stop',
          timestamp: running.updatedAt + 24,
          kind: 'stop',
          level: 'info',
          turnUsage: { inputTokens: 9, cacheTokens: 0, outputTokens: 4 }
        }
      })
      runtimeUpdateHarness.publish({
        scope,
        event: {
          id: 'late-terminal-error',
          timestamp: running.updatedAt + 25,
          kind: 'error',
          level: 'error',
          text: 'Late provider error must not replace cancellation'
        }
      })
      runtimeUpdateHarness.publish({
        scope,
        event: {
          id: 'late-terminal-warning',
          timestamp: running.updatedAt + 26,
          kind: 'system',
          level: 'warning',
          text: 'Late provider warning evidence'
        }
      })
      runtimeUpdateHarness.publish({
        scope,
        event: {
          id: 'late-terminal-message-final',
          timestamp: running.updatedAt + 27,
          kind: 'message',
          level: 'info',
          role: 'assistant',
          messageId: 'late-terminal-stream',
          text: ' duplicated final'
        }
      })
      runtimeUpdateHarness.publish({
        scope: { ...scope, attemptId: 'different-attempt' },
        event: {
          id: 'wrong-attempt-message',
          timestamp: running.updatedAt + 28,
          kind: 'message',
          level: 'info',
          role: 'assistant',
          messageId: 'wrong-attempt-stream',
          text: 'Wrong attempt evidence'
        }
      })
      runtimeUpdateHarness.publish({
        scope: { ...scope, runtimeSegmentId: 'different-runtime' },
        event: {
          id: 'wrong-runtime-message',
          timestamp: running.updatedAt + 29,
          kind: 'message',
          level: 'info',
          role: 'assistant',
          messageId: 'wrong-runtime-stream',
          text: 'Wrong runtime evidence'
        }
      })
      runtimeUpdateHarness.publish({
        scope: { ...scope, promptMessageId: 'different-prompt' },
        event: {
          id: 'wrong-prompt-message',
          timestamp: running.updatedAt + 30,
          kind: 'message',
          level: 'info',
          role: 'assistant',
          messageId: 'wrong-prompt-stream',
          text: 'Wrong prompt evidence'
        }
      })
    })

    expect(probe.textContent).toContain('"status":"idle"')
    expect(probe.textContent).toContain('Late terminal message final')
    expect(probe.textContent).toContain('Late terminal tool')
    expect(probe.textContent).toContain('Late tool output')
    expect(probe.textContent).not.toContain('duplicated final')
    expect(probe.textContent).not.toContain('Wrong attempt evidence')
    expect(probe.textContent).not.toContain('Wrong runtime evidence')
    expect(probe.textContent).not.toContain('Wrong prompt evidence')
    expect(probe.textContent).toContain('Late provider error must not replace cancellation')
    expect(probe.textContent).not.toContain('Late provider warning evidence')
    expect(probe.textContent).not.toContain('AgentRuntimeEvidence')
    expect(probe.textContent).toContain('"activeRun":false')
    expect(probe.textContent).toContain('"agentPromptInFlight":false')
    expect(probe.textContent).toContain('"awaitingFirstAgentOutput":false')
    expect(probe.textContent).toContain('"interactionState":false')
  })

  it('reconciles a newer durable projection for the same running Attempt', async () => {
    const running = createSession()
    const childBranch = running.conversationGraph?.branches.find(
      (branch) => branch.id === 'child-a-branch'
    )
    if (childBranch) childBranch.headMessageId = 'child-a-prompt'
    if (running.conversationGraph) {
      running.conversationGraph.messages = running.conversationGraph.messages.filter(
        (message) => message.id !== 'child-a-answer'
      )
    }
    useSessionStore.setState({ ...createInitialSessionState(), sessions: [running] })

    renderSurface(
      <SubagentPreview
        item={{
          id: 'tool:session-1:subagents',
          type: 'tool',
          toolKind: 'subagents',
          title: 'Subagents',
          sessionId: 'session-1',
          projectId: 'project-1',
          selectedAgentFrameId: 'child-a'
        }}
      />
    )
    expect(screen.getByText('Thinking')).toBeTruthy()
    expect(screen.queryByText('Durable child evidence')).toBeNull()

    const completed = structuredClone(running)
    completed.updatedAt += 100
    const completedFrame = completed.conversationGraph?.frames.find(({ id }) => id === 'child-a')
    const completedBranch = completed.conversationGraph?.branches.find(
      ({ id }) => id === 'child-a-branch'
    )
    const completedAttempt = completed.runtimeContext?.delegatedWork?.records
      .find(({ agentFrameId }) => agentFrameId === 'child-a')
      ?.attempts.at(-1)
    if (!completed.conversationGraph || !completedFrame || !completedBranch || !completedAttempt) {
      throw new Error('Expected child-a durable fixtures')
    }
    completedFrame.status = 'completed'
    completedFrame.completedAt = completed.updatedAt
    Object.assign(completedAttempt, {
      status: 'completed',
      endedAt: completed.updatedAt
    })
    completedBranch.headMessageId = 'child-a-durable-answer'
    completed.conversationGraph.messages.push({
      id: 'child-a-durable-answer',
      role: 'agent',
      content: 'Durable child evidence',
      status: 'complete',
      eventIds: [],
      responseToMessageId: 'child-a-prompt',
      createdAt: completed.updatedAt,
      updatedAt: completed.updatedAt,
      agentFrameId: 'child-a',
      introducedOnBranchId: 'child-a-branch',
      parentMessageId: 'child-a-prompt',
      runtimeSegmentId: 'runtime-a'
    })

    await act(async () => {
      useSessionStore.setState({ sessions: [completed] })
    })

    expect(screen.getByText('Durable child evidence')).toBeTruthy()
    expect(screen.queryByText('Thinking')).toBeNull()
  })

  it('falls back to the first existing Frame when the selected Frame was removed', () => {
    renderSurface(
      <SubagentPreview
        item={{
          id: 'tool:session-1:subagents',
          type: 'tool',
          toolKind: 'subagents',
          title: 'Subagents',
          sessionId: 'session-1',
          selectedAgentFrameId: 'missing'
        }}
      />
    )

    expect(screen.getByLabelText('Subagent Frame').textContent).toContain('Evidence landscape')
    expect(screen.getByText('Fourteen strong studies remain.')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('uses distinct terminal labels and the warning color for cancellation', () => {
    const session = createSession()
    const cancelledFrame = session.conversationGraph!.frames.find(({ id }) => id === 'child-a')!
    const cancelledAttempt = session.runtimeContext!.delegatedWork!.records.find(
      ({ agentFrameId }) => agentFrameId === 'child-a'
    )!.attempts[0]
    Object.assign(cancelledFrame, { status: 'cancelled' })
    Object.assign(cancelledAttempt, { status: 'cancelled' })

    renderSurface(<SubagentsBar session={session} permissions={[]} />)
    fireEvent.click(screen.getByRole('button', { name: '2 subagents' }))

    const cancelled = screen.getByText('Cancelled')
    const failed = screen.getByText('Failed')
    expect(cancelled.getAttribute('data-subagent-status')).toBe('cancelled')
    expect(cancelled.previousElementSibling?.className).toContain('bg-warning-100')
    expect(failed.getAttribute('data-subagent-status')).toBe('error')
  })

  it('shows an actionable unavailable notice and no false support claim', () => {
    const onOpenSettings = vi.fn()
    renderSurface(
      <SubagentAvailabilityNotice
        frameworkId="opencode"
        frameworks={[
          {
            id: 'opencode',
            displayName: 'OpenCode',
            supportsSkills: true,
            supportsDelegatedWork: false
          }
        ]}
        onOpenSettings={onOpenSettings}
      />
    )

    expect(screen.getByRole('status').textContent).toContain('Subagents unavailable for OpenCode')
    const settingsButton = screen.getByRole('button', { name: 'Open Settings' })
    expect(settingsButton.className).toContain('focus-visible:ring-[3px]')
    fireEvent.click(settingsButton)
    expect(onOpenSettings).toHaveBeenCalledOnce()
  })

  it('shows a production admission rejection as an actionable product notice', () => {
    const onOpenSettings = vi.fn()
    renderSurface(
      <SubagentAvailabilityNotice
        frameworkId="opencode"
        frameworks={[
          {
            id: 'opencode',
            displayName: 'OpenCode',
            supportsSkills: true,
            supportsDelegatedWork: true
          }
        ]}
        unavailableReason="The requested Specialist configuration is unavailable."
        onOpenSettings={onOpenSettings}
      />
    )

    expect(screen.getByRole('status').textContent).toContain(
      'Subagents unavailable for this configuration'
    )
    expect(screen.getByRole('status').textContent).toContain(
      'The requested Specialist configuration is unavailable.'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }))
    expect(onOpenSettings).toHaveBeenCalledOnce()
  })

  it('renders the same Frame selector and close controls in the mobile Preview sheet', () => {
    usePreviewWorkbenchStore.getState().upsertAndActivateItem({
      id: 'tool:session-1:subagents',
      type: 'tool',
      toolKind: 'subagents',
      title: 'Subagents',
      sessionId: 'session-1',
      projectId: 'project-1',
      selectedAgentFrameId: 'child-a'
    })
    renderSurface(<MobilePreviewSheet open onClose={vi.fn()} />)

    const sheet = screen.getByTestId('mobile-preview-sheet')
    expect(within(sheet).getByLabelText('Subagent Frame')).toBeTruthy()
    expect(within(sheet).getByRole('button', { name: 'Close Subagents preview' })).toBeTruthy()
    expect(within(sheet).getByText('Fourteen strong studies remain.')).toBeTruthy()
  })
})
