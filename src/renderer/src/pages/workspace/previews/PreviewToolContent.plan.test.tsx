// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ActivePlanProjection } from '../../../../../shared/session-plan/contract'
import { normalizeSessionFile } from '../../../../../shared/session-persistence'
import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'
import { useSessionStore } from '@/stores/session-store'

const sideChatState = vi.hoisted(() => ({ parentSessionId: undefined as string | undefined }))

vi.mock('../NotebookPreview', () => ({ NotebookPreview: () => null }))
vi.mock('../ProjectFilesView', () => ({ ProjectFilesView: () => null }))
vi.mock('../SessionReviewerPanel', () => ({ SessionReviewerPanel: () => null }))
vi.mock('../use-side-chat-controller', () => ({
  useIsSideChatOpenForSession: (sessionId: string) => sideChatState.parentSessionId === sessionId
}))

import { PreviewToolContent } from './PreviewToolContent'

const pendingProjection: ActivePlanProjection = {
  artifactId: 'artifact-1',
  artifactVersionId: 'version-1',
  artifactChecksum: 'a'.repeat(64),
  revision: 3,
  approval: 'pending',
  lifecycle: 'awaiting_approval',
  document: {
    schema_version: 1,
    task_summary: 'Analyze one dataset',
    phases: [
      {
        name: 'Analysis',
        delegations: [
          {
            name: 'Primary agent',
            steps: [{ title: 'Analyze the data', description: 'Produce the result.' }]
          }
        ]
      }
    ],
    desired_outputs: [],
    feasibility: { confidence: 'high', rationale: 'Inputs are available.' }
  },
  stepStatuses: {},
  stepStates: { 'Analyze the data': { status: 'not_started' } },
  counts: { phases: 1, delegations: 1, steps: 1, completed: 0, inProgress: 0 }
}

const approvedProjection: ActivePlanProjection = {
  ...pendingProjection,
  revision: 4,
  approval: 'approved',
  lifecycle: 'approved'
}

const respondPlan = vi.fn()
const respondToRestoredPlan = vi.fn()
const getPlanProjection = vi.fn()
const saveBlobFile = vi.fn()

// Single source for the artifact metadata matching pendingProjection's version identity.
const planArtifactFilename = 'plan-cedc6ffa.json'
const sessionPlanArtifacts = [
  {
    id: pendingProjection.artifactId,
    versionId: pendingProjection.artifactVersionId,
    name: planArtifactFilename,
    path: `/artifacts/${planArtifactFilename}`
  }
]

beforeEach(() => {
  sideChatState.parentSessionId = undefined
  respondPlan.mockReset().mockResolvedValue({ projection: approvedProjection, changed: true })
  respondToRestoredPlan.mockReset().mockResolvedValue(undefined)
  getPlanProjection.mockReset().mockResolvedValue(approvedProjection)
  saveBlobFile.mockReset().mockResolvedValue({ saved: true })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { acp: { respondPlan, getPlanProjection }, saveBlobFile }
  })
  useSessionStore.setState({
    sessions: [
      {
        id: 'session-1',
        projectId: 'project-1',
        status: 'waiting-plan-approval',
        activeRun: { promptMessageId: 'interaction-1', startedAt: 1 },
        activePlanProjection: pendingProjection,
        artifacts: sessionPlanArtifacts
      } as never
    ]
  })
  usePreviewWorkbenchStore.setState({ expandedToolItemId: null })
})

afterEach(cleanup)

describe('Plan Preview workbench integration', () => {
  it('resolves a persisted historical Plan by exact version after hydration', () => {
    const historical = {
      ...approvedProjection,
      artifactId: 'artifact-history',
      artifactVersionId: 'version-history',
      originatingPromptMessageId: 'prompt-history',
      document: { ...approvedProjection.document, task_summary: 'Historical branch Plan' }
    }
    const restored = normalizeSessionFile({
      id: 'session-1',
      projectId: 'project-1',
      title: 'Branched Plans',
      cwd: '/workspace',
      status: 'idle',
      messages: [],
      planHistoryProjections: [historical],
      createdAt: 1,
      updatedAt: 2
    })
    if (!restored) throw new Error('Session fixture did not restore.')
    useSessionStore.getState().hydrateSessions([restored])
    useSessionStore.getState().setActivePlanProjection('session-1', {
      ...approvedProjection,
      artifactId: 'artifact-current',
      artifactVersionId: 'version-current',
      originatingPromptMessageId: 'prompt-current'
    })

    render(
      <PreviewToolContent
        item={{
          id: 'tool:session-1:plan:version-history',
          projectId: 'project-1',
          sessionId: 'session-1',
          type: 'tool',
          toolKind: 'plan',
          title: 'Session Plan',
          planArtifactVersionId: 'version-history'
        }}
      />
    )

    expect(screen.getByRole('heading', { level: 1, name: 'Historical branch Plan' })).toBeTruthy()
  })

  it('uses the shared full-screen state and applies the approved projection', async () => {
    render(
      <PreviewToolContent
        item={{
          id: 'tool:session-1:plan',
          projectId: 'project-1',
          sessionId: 'session-1',
          type: 'tool',
          toolKind: 'plan',
          title: 'Session Plan'
        }}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Enter full screen' }))
    expect(usePreviewWorkbenchStore.getState().expandedToolItemId).toBe('tool:session-1:plan')
    expect(screen.getByRole('button', { name: 'Exit full screen' })).toBeTruthy()

    // The header shows the real artifact filename (never one fabricated from the Artifact
    // Version id) as selectable text, with no label prefix in front of it.
    expect(screen.getByText(planArtifactFilename)).toBeTruthy()
    expect(screen.queryByText('Session Plan')).toBeNull()
    expect(screen.queryByText(`plan-${pendingProjection.artifactVersionId}.json`)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Download Plan' }))
    await waitFor(() => expect(saveBlobFile).toHaveBeenCalledOnce())
    expect(saveBlobFile).toHaveBeenCalledWith(
      expect.objectContaining({
        suggestedName: 'plan-version-1.json',
        mimeType: 'application/json'
      })
    )
    const savedRequest = saveBlobFile.mock.calls[0][0] as { data: ArrayBuffer }
    expect(savedRequest.data.byteLength).toBeGreaterThan(0)
    expect(JSON.parse(new TextDecoder().decode(savedRequest.data))).toEqual(
      pendingProjection.document
    )

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() =>
      expect(respondPlan).toHaveBeenCalledWith({
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactVersionId: 'version-1',
        expectedRevision: 3,
        decision: 'approved'
      })
    )
    await waitFor(() =>
      expect(useSessionStore.getState().sessions[0].activePlanProjection).toBe(approvedProjection)
    )
    expect(useSessionStore.getState().sessions[0].status).toBe('running')
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
  })

  it('makes an orphaned pending Plan read-only instead of offering ineffective controls', () => {
    useSessionStore.setState({
      sessions: [
        {
          id: 'session-1',
          projectId: 'project-1',
          status: 'idle',
          activePlanProjection: pendingProjection
        } as never
      ]
    })

    // Without loaded artifact metadata the header falls back to the document label.

    render(
      <PreviewToolContent
        item={{
          id: 'tool:session-1:plan',
          projectId: 'project-1',
          sessionId: 'session-1',
          type: 'tool',
          toolKind: 'plan',
          title: 'Session Plan'
        }}
      />
    )

    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull()
    expect(screen.getByText('Session Plan')).toBeTruthy()
  })

  it('preserves the Plan scroll position across a streamed durable progress refresh', () => {
    useSessionStore.setState({
      sessions: [
        {
          id: 'session-1',
          projectId: 'project-1',
          title: 'Plan progress',
          cwd: '/workspace',
          status: 'running',
          messages: [],
          runtimeContext: {
            version: 1,
            revision: pendingProjection.revision,
            plan: {
              artifactId: pendingProjection.artifactId,
              artifactVersionId: pendingProjection.artifactVersionId,
              artifactChecksum: pendingProjection.artifactChecksum,
              approval: pendingProjection.approval,
              stepStatuses: pendingProjection.stepStatuses
            }
          },
          activePlanProjection: pendingProjection,
          artifacts: sessionPlanArtifacts,
          createdAt: 1,
          updatedAt: 2
        } as never
      ]
    })
    const item = {
      id: 'tool:session-1:plan:version-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      type: 'tool' as const,
      toolKind: 'plan' as const,
      title: 'Session Plan',
      planArtifactVersionId: 'version-1'
    }
    const { container, rerender } = render(<PreviewToolContent item={item} />)
    const viewport = container.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')
    expect(viewport).not.toBeNull()
    if (!viewport) return

    viewport.scrollTop = 240
    const source = useSessionStore.getState().sessions[0]
    const streamedStepStatuses = {
      'Analyze the data': { status: 'in_progress' as const, updatedAt: 3 }
    }
    act(() => {
      useSessionStore.getState().applyDurableSessionProjection({
        source,
        session: {
          ...source,
          activePlanProjection: undefined,
          runtimeContext: {
            ...source.runtimeContext!,
            revision: 4,
            plan: { ...source.runtimeContext!.plan!, stepStatuses: streamedStepStatuses }
          },
          updatedAt: 3
        } as never,
        mode: 'runtime-context-authority'
      })
    })
    const streamingViewport = container.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]'
    )
    expect(streamingViewport).toBe(viewport)
    expect(streamingViewport?.scrollTop).toBe(240)

    rerender(<PreviewToolContent item={{ ...item }} />)
    expect(container.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')).toBe(
      viewport
    )

    const refreshedProjection: ActivePlanProjection = {
      ...pendingProjection,
      revision: 4,
      lifecycle: 'in_progress',
      stepStatuses: streamedStepStatuses,
      stepStates: streamedStepStatuses,
      counts: { ...pendingProjection.counts, inProgress: 1 }
    }
    act(() => {
      useSessionStore.getState().setActivePlanProjection('session-1', refreshedProjection)
    })

    const updatedViewport = container.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]'
    )
    expect(updatedViewport).toBe(viewport)
    expect(updatedViewport?.scrollTop).toBe(240)
  })

  it('routes restored pending Plan decisions through the session-bound responder', async () => {
    useSessionStore.setState({
      sessions: [
        {
          id: 'session-1',
          projectId: 'project-1',
          status: 'waiting-plan-approval',
          activePlanProjection: pendingProjection
        } as never
      ]
    })

    const item = {
      id: 'tool:session-1:plan',
      projectId: 'project-1',
      sessionId: 'session-1',
      type: 'tool' as const,
      toolKind: 'plan' as const,
      title: 'Session Plan'
    }
    const { rerender } = render(
      <PreviewToolContent
        item={item}
        restoredPlanResponder={{
          sessionId: 'session-2',
          respond: respondToRestoredPlan
        }}
      />
    )

    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull()
    rerender(
      <PreviewToolContent
        item={item}
        restoredPlanResponder={{
          sessionId: 'session-1',
          respond: respondToRestoredPlan
        }}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await waitFor(() =>
      expect(respondToRestoredPlan).toHaveBeenCalledWith({ decision: 'rejected' })
    )
    expect(respondPlan).not.toHaveBeenCalled()
  })

  it('keeps the parent Plan read-only while its Side chat is open', () => {
    sideChatState.parentSessionId = 'session-1'

    render(
      <PreviewToolContent
        item={{
          id: 'tool:session-1:plan',
          projectId: 'project-1',
          sessionId: 'session-1',
          type: 'tool',
          toolKind: 'plan',
          title: 'Session Plan'
        }}
      />
    )

    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull()
  })
})
