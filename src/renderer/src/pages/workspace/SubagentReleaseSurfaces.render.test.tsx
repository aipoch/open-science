// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChatSession } from '@/stores/session-store'
import type { AcpAgentRuntimeUpdate } from '../../../../shared/acp'

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
import { useSubagentRuntimePresentation } from '@/lib/acp/workspace-subagent-runtime-presentation'

import {
  SubagentAvailabilityNotice,
  SubagentPreview,
  SubagentsBar
} from './SubagentReleaseSurfaces'
import { MobilePreviewSheet } from './MobilePreviewSheet'

const renderSurface = (surface: React.ReactNode): ReturnType<typeof render> => render(surface)

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

  it('marks imported Subagent history when its origin Message is unavailable', () => {
    const session = createSession()
    const importedFrame = session.conversationGraph?.frames.find(({ id }) => id === 'child-a')
    if (!importedFrame) throw new Error('Expected child-a fixture')
    importedFrame.originBindingState = 'legacy-unavailable'
    delete importedFrame.originMessageId

    renderSurface(<SubagentsBar session={session} permissions={[]} />)
    fireEvent.click(screen.getByRole('button', { name: '2 subagents, 1 running' }))

    const importedRow = screen.getByRole('button', {
      name: 'Evidence landscape, running',
      description: 'Imported history may be incomplete'
    })
    expect(within(importedRow).getByText('Imported history may be incomplete')).toBeTruthy()
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
    expect(screen.getByText('error')).toBeTruthy()
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
    const detail = {
      frameId: 'child-a',
      status: 'running' as const,
      attempt: session.runtimeContext?.delegatedWork?.records
        .find(({ agentFrameId }) => agentFrameId === 'child-a')
        ?.attempts.at(-1),
      messages:
        session.conversationGraph?.messages.filter(
          ({ agentFrameId }) => agentFrameId === 'child-a'
        ) ?? []
    }
    const presentation = renderHook(() =>
      useSubagentRuntimePresentation(runtimeUpdateHarness.subscribe, session, detail)
    )

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
          turnUsage: { inputTokens: 31, cacheTokens: 15, outputTokens: 14 },
          modelCallUsage: [
            {
              id: 'child-stream:model-call:0',
              index: 0,
              sourceInvocationId: 'provider-child-call-1',
              inputTokens: 31,
              cacheTokens: 15,
              outputTokens: 14,
              contextUsedTokens: 46,
              contextWindowSize: 128_000
            }
          ]
        }
      })
    })

    expect(screen.getByRole('button', { name: 'Token usage for this response' })).toBeTruthy()
    expect(screen.queryByText('Thinking')).toBeNull()
    expect(presentation.result.current.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          streamId: 'child-stream',
          modelCallUsage: [
            expect.objectContaining({
              id: 'child-stream:model-call:0',
              sourceInvocationId: 'provider-child-call-1'
            })
          ]
        })
      ])
    )
    expect(useSessionStore.getState().sessions[0]).toEqual(rootBefore)
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

  it('offers Retry when the selected durable Frame cannot be read', () => {
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

    expect(screen.getByRole('alert').textContent).toContain('could not be read')
    expect(screen.getByRole('button', { name: 'Retry Subagent preview' }).className).toContain(
      'focus-visible:ring-[3px]'
    )
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
