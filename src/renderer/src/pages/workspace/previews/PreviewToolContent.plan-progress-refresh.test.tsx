// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ActivePlanProjection } from '../../../../../shared/session-plan/contract'
import { useSessionStore } from '@/stores/session-store'

vi.mock('../NotebookPreview', () => ({ NotebookPreview: () => null }))
vi.mock('../ProjectFilesView', () => ({ ProjectFilesView: () => null }))
vi.mock('../SessionReviewerPanel', () => ({ SessionReviewerPanel: () => null }))
vi.mock('../use-side-chat-controller', () => ({
  useIsSideChatOpenForSession: () => false
}))

import { PreviewToolContent } from './PreviewToolContent'

const respondPlan = vi.fn()
const getPlanProjection = vi.fn()
const sessionId = '45d48cfc-0b26-4f99-b603-6768841c42dd'
const stepTitles = Array.from({ length: 7 }, (_, index) => `Execution step ${index + 1}`)
const completedStepStatuses = Object.fromEntries(
  stepTitles.map((title) => [title, { status: 'completed' as const, updatedAt: 7 }])
)
const historicalProjection: ActivePlanProjection = {
  artifactId: 'artifact-session-plan',
  artifactVersionId: 'version-session-plan',
  artifactChecksum: 'a'.repeat(64),
  revision: 1,
  approval: 'approved',
  lifecycle: 'in_progress',
  document: {
    schema_version: 1,
    task_summary: 'Execute the seven-step session plan',
    phases: [
      {
        name: 'Execution',
        delegations: [
          {
            name: 'Primary agent',
            steps: stepTitles.map((title) => ({ title, description: `Complete ${title}.` }))
          }
        ]
      }
    ],
    desired_outputs: [],
    feasibility: { confidence: 'high', rationale: 'All inputs are available.' }
  },
  stepStatuses: { [stepTitles[0]]: { status: 'completed', updatedAt: 1 } },
  stepStates: Object.fromEntries(
    stepTitles.map((title, index) => [
      title,
      { status: index === 0 ? ('completed' as const) : ('not_started' as const) }
    ])
  ),
  counts: { phases: 1, delegations: 1, steps: 7, completed: 1, inProgress: 0 }
}

const recoveredProjection: ActivePlanProjection = {
  ...historicalProjection,
  revision: 7,
  lifecycle: 'completed',
  stepStatuses: completedStepStatuses,
  stepStates: completedStepStatuses,
  counts: { ...historicalProjection.counts, completed: 7 }
}

beforeEach(() => {
  respondPlan.mockReset().mockResolvedValue(null)
  getPlanProjection.mockReset().mockResolvedValue(null)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      saveBlobFile: vi.fn(),
      acp: { respondPlan, getPlanProjection }
    }
  })
  useSessionStore.setState({
    sessions: [
      {
        id: sessionId,
        projectId: 'project-1',
        title: 'Seven-step plan',
        cwd: '/workspace',
        status: 'running',
        messages: [],
        runtimeContext: {
          version: 1,
          revision: recoveredProjection.revision,
          plan: {
            artifactId: recoveredProjection.artifactId,
            artifactVersionId: recoveredProjection.artifactVersionId,
            artifactChecksum: recoveredProjection.artifactChecksum,
            approval: recoveredProjection.approval,
            stepStatuses: completedStepStatuses
          }
        },
        activePlanProjection: undefined,
        planHistoryProjections: [historicalProjection],
        createdAt: 1,
        updatedAt: 2
      } as never
    ]
  })
})

afterEach(cleanup)

describe('Session Plan durable progress refresh', () => {
  const renderPlan = (): void => {
    render(
      <PreviewToolContent
        item={{
          id: `tool:${sessionId}:plan:version-session-plan`,
          projectId: 'project-1',
          sessionId,
          type: 'tool',
          toolKind: 'plan',
          title: 'Session Plan',
          planArtifactVersionId: historicalProjection.artifactVersionId
        }}
      />
    )
  }

  it('projects persisted runtime progress before the active projection is recovered', () => {
    renderPlan()

    expect(useSessionStore.getState().sessions[0].activePlanProjection).toBeUndefined()
    expect(useSessionStore.getState().sessions[0].runtimeContext?.plan?.stepStatuses).toEqual(
      completedStepStatuses
    )
    expect(screen.getAllByLabelText(/status: completed$/u)).toHaveLength(7)
  })

  it('prefers the recovered active projection over stale history for the same version', () => {
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId
          ? { ...session, activePlanProjection: recoveredProjection }
          : session
      )
    }))

    renderPlan()

    const recoveredSession = useSessionStore.getState().sessions[0]
    expect(recoveredSession.planHistoryProjections?.[0].counts.completed).toBe(1)
    expect(recoveredSession.activePlanProjection?.counts.completed).toBe(7)
    expect(screen.getAllByLabelText(/status: completed$/u)).toHaveLength(7)
    for (const title of stepTitles) {
      expect(screen.getByLabelText(`${title} status: completed`)).toBeTruthy()
    }
  })

  it('responds to a pending runtime projection with its durable revision before recovery', async () => {
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              status: 'waiting-plan-approval',
              activeRun: { promptMessageId: 'prompt-1', startedAt: 1 },
              runtimeContext: {
                ...session.runtimeContext!,
                plan: { ...session.runtimeContext!.plan!, approval: 'pending' }
              }
            }
          : session
      )
    }))

    renderPlan()
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))

    await waitFor(() =>
      expect(respondPlan).toHaveBeenCalledWith({
        projectId: 'project-1',
        sessionId,
        artifactVersionId: historicalProjection.artifactVersionId,
        expectedRevision: recoveredProjection.revision,
        decision: 'approved'
      })
    )
  })
})
