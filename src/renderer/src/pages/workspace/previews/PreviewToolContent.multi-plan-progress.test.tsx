// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ActivePlanProjection } from '../../../../../shared/session-plan/contract'
import type { PreviewToolItem } from '@/stores/preview-workbench-store'
import { useSessionStore } from '@/stores/session-store'

vi.mock('../NotebookPreview', () => ({ NotebookPreview: () => null }))
vi.mock('../ProjectFilesView', () => ({ ProjectFilesView: () => null }))
vi.mock('../SessionReviewerPanel', () => ({ SessionReviewerPanel: () => null }))
vi.mock('../use-side-chat-controller', () => ({
  useIsSideChatOpenForSession: () => false
}))

import { PreviewToolContent } from './PreviewToolContent'

const sessionId = '45d48cfc-0b26-4f99-b603-6768841c42dd'
const sharedStepTitles = ['Inspect inputs', 'Publish results']

const projection = ({
  artifactId,
  artifactVersionId,
  checksum,
  summary,
  statuses
}: {
  artifactId: string
  artifactVersionId: string
  checksum: string
  summary: string
  statuses: ActivePlanProjection['stepStatuses']
}): ActivePlanProjection => {
  const completed = sharedStepTitles.filter(
    (title) => statuses[title]?.status === 'completed' || statuses[title]?.status === 'skipped'
  ).length
  const inProgress = sharedStepTitles.filter(
    (title) => statuses[title]?.status === 'in_progress'
  ).length

  return {
    artifactId,
    artifactVersionId,
    artifactChecksum: checksum,
    revision: completed + inProgress,
    approval: 'approved',
    lifecycle: completed === sharedStepTitles.length ? 'completed' : 'in_progress',
    document: {
      schema_version: 1,
      task_summary: summary,
      phases: [
        {
          name: 'Execution',
          delegations: [
            {
              name: 'Primary agent',
              steps: sharedStepTitles.map((title) => ({
                title,
                description: `Complete ${title}.`
              }))
            }
          ]
        }
      ],
      desired_outputs: [],
      feasibility: { confidence: 'high', rationale: 'All inputs are available.' }
    },
    stepStatuses: statuses,
    stepStates: Object.fromEntries(
      sharedStepTitles.map((title) => [
        title,
        { status: statuses[title]?.status ?? ('not_started' as const) }
      ])
    ),
    counts: { phases: 1, delegations: 1, steps: 2, completed, inProgress }
  }
}

const planA = projection({
  artifactId: 'artifact-plan-a',
  artifactVersionId: 'version-plan-a',
  checksum: 'a'.repeat(64),
  summary: 'Historical Plan A',
  statuses: { 'Inspect inputs': { status: 'completed', updatedAt: 2 } }
})

const planBHistory = projection({
  artifactId: 'artifact-plan-b',
  artifactVersionId: 'version-plan-b',
  checksum: 'b'.repeat(64),
  summary: 'Current Plan B',
  statuses: {}
})

const planBLatest = projection({
  artifactId: planBHistory.artifactId,
  artifactVersionId: planBHistory.artifactVersionId,
  checksum: planBHistory.artifactChecksum,
  summary: planBHistory.document.task_summary,
  statuses: {
    'Inspect inputs': { status: 'completed', updatedAt: 6 },
    'Publish results': { status: 'completed', updatedAt: 7 }
  }
})

const planItem = (planArtifactVersionId: string): PreviewToolItem => ({
  id: `tool:${sessionId}:plan:${planArtifactVersionId}`,
  projectId: 'project-1',
  sessionId,
  type: 'tool' as const,
  toolKind: 'plan' as const,
  title: 'Session Plan',
  planArtifactVersionId
})

beforeEach(() => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { saveBlobFile: vi.fn() }
  })
  useSessionStore.setState({
    sessions: [
      {
        id: sessionId,
        projectId: 'project-1',
        title: 'Session with two Plans',
        cwd: '/workspace',
        status: 'running',
        messages: [],
        runtimeContext: {
          version: 1,
          revision: 7,
          plan: {
            artifactId: planBLatest.artifactId,
            artifactVersionId: planBLatest.artifactVersionId,
            artifactChecksum: planBLatest.artifactChecksum,
            approval: planBLatest.approval,
            stepStatuses: planBLatest.stepStatuses
          }
        },
        activePlanProjection: undefined,
        planHistoryProjections: [planA, planBHistory],
        createdAt: 1,
        updatedAt: 7
      } as never
    ]
  })
})

afterEach(cleanup)

describe('Session Plan progress with multiple Plan versions', () => {
  it('keeps historical progress isolated from the current Plan runtime progress', () => {
    const view = render(<PreviewToolContent item={planItem(planA.artifactVersionId)} />)

    expect(screen.getByRole('heading', { level: 1, name: 'Historical Plan A' })).toBeTruthy()
    expect(
      screen.getByText(/This plan has been replaced by another plan and is no longer current\./u)
    ).toBeTruthy()
    expect(screen.getByLabelText('Inspect inputs status: completed')).toBeTruthy()
    expect(screen.getByLabelText('Publish results status: not started')).toBeTruthy()

    view.rerender(<PreviewToolContent item={planItem(planBHistory.artifactVersionId)} />)

    expect(screen.getByRole('heading', { level: 1, name: 'Current Plan B' })).toBeTruthy()
    expect(
      screen.queryByText(/This plan has been replaced by another plan and is no longer current\./u)
    ).toBeNull()
    expect(screen.getByLabelText('Inspect inputs status: completed')).toBeTruthy()
    expect(screen.getByLabelText('Publish results status: completed')).toBeTruthy()

    act(() => useSessionStore.getState().setActivePlanProjection(sessionId, planBLatest))

    expect(screen.getByLabelText('Inspect inputs status: completed')).toBeTruthy()
    expect(screen.getByLabelText('Publish results status: completed')).toBeTruthy()

    view.rerender(<PreviewToolContent item={planItem(planA.artifactVersionId)} />)

    expect(screen.getByRole('heading', { level: 1, name: 'Historical Plan A' })).toBeTruthy()
    expect(screen.getByLabelText('Inspect inputs status: completed')).toBeTruthy()
    expect(screen.getByLabelText('Publish results status: not started')).toBeTruthy()
  })
})
