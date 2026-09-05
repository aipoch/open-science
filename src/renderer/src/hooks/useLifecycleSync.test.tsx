// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  MAIN_DELEGATED_WORK_LIFECYCLE_CLIENT_ID,
  MAIN_DELEGATION_POLICY_LIFECYCLE_CLIENT_ID,
  MAIN_DURABLE_CONTINUATION_LIFECYCLE_CLIENT_ID,
  MAIN_ENABLED_COMPUTE_HOSTS_LIFECYCLE_CLIENT_ID,
  MAIN_PERMISSION_WAIT_LIFECYCLE_CLIENT_ID,
  MAIN_RUNTIME_CONTEXT_LIFECYCLE_CLIENT_ID,
  MAIN_SESSION_DETAILS_LIFECYCLE_CLIENT_ID,
  type ProjectDeletedEvent,
  type SessionDeletedEvent,
  type SessionUpsertEvent
} from '../../../shared/lifecycle-events'
import type { Project } from '../../../shared/projects'
import type { ActivePlanProjection } from '../../../shared/session-plan/contract'
import { hasCurrentRunningDelegatedAttempt } from '../../../shared/delegated-work-projection'
import {
  createLinearConversationGraph,
  getActiveConversationContext,
  synchronizeActiveConversationMessages
} from '../../../shared/conversation-graph'
import { validateDurableMessageOwnership } from '../../../main/artifacts/provenance-message-finalization'
import { createInitialProjectState, useProjectStore } from '@/stores/project-store'
import { useNavigationStore } from '@/stores/navigation-store'
import { useArchiveUndoStore } from '@/stores/archive-undo-store'
import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'
import {
  createInitialSessionState,
  toPersistedSession,
  useSessionStore
} from '@/stores/session-store'
import { useLifecycleSync } from './useLifecycleSync'

const listeners: {
  projectCreated?: (project: Project) => void
  projectUpdated?: (project: Project) => void
  projectDeleted?: (event: ProjectDeletedEvent) => void
  projectDeletionCleanupChanged?: () => void
  sessionCreated?: (event: SessionUpsertEvent) => void
  sessionUpdated?: (event: SessionUpsertEvent) => void
  sessionDeleted?: (event: SessionDeletedEvent) => void
} = {}

const Harness = ({
  isSessionPersistenceHydrated = true
}: {
  isSessionPersistenceHydrated?: boolean
}): React.JSX.Element => {
  const lifecycleSync = useLifecycleSync({ isSessionPersistenceHydrated })
  return (
    <button
      type="button"
      data-notice-session={lifecycleSync.notice?.sessionId ?? ''}
      onClick={lifecycleSync.viewNotice}
    >
      View notice
    </button>
  )
}

const project: Project = {
  id: 'project-1',
  name: 'Project',
  description: '',
  isExample: false,
  createdAt: 1,
  updatedAt: 1
}

const session: SessionUpsertEvent['session'] = {
  id: 'session-1',
  projectId: project.id,
  title: 'External session',
  cwd: '/workspace',
  status: 'idle',
  messages: [],
  createdAt: 1,
  updatedAt: 1
}

const completedPlanHistoryProjection: ActivePlanProjection = {
  artifactId: 'historical-plan',
  artifactVersionId: 'historical-plan-version',
  artifactChecksum: 'b'.repeat(64),
  originatingPromptMessageId: 'historical-plan-prompt',
  revision: 1,
  approval: 'approved',
  lifecycle: 'completed',
  document: {
    schema_version: 1,
    task_summary: 'Completed historical Plan',
    phases: [
      {
        name: 'Execution',
        delegations: [
          {
            name: 'Primary agent',
            steps: [{ title: 'Finish history', description: 'Complete the work.' }]
          }
        ]
      }
    ],
    desired_outputs: [],
    feasibility: { confidence: 'high', rationale: 'The work is complete.' }
  },
  stepStatuses: { 'Finish history': { status: 'completed', updatedAt: 1 } },
  stepStates: { 'Finish history': { status: 'completed' } },
  counts: { phases: 1, delegations: 1, steps: 1, completed: 1, inProgress: 0 }
}

describe('useLifecycleSync', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    useProjectStore.setState({ ...createInitialProjectState(), isLoaded: true })
    useSessionStore.setState(createInitialSessionState())
    useArchiveUndoStore.setState({ notices: [], restoringKey: undefined })
    useNavigationStore.setState({
      view: 'home',
      activeProjectId: undefined,
      userNavigationRevision: 0
    })

    const subscribe =
      <Payload,>(key: keyof typeof listeners) =>
      (listener: (payload: Payload) => void): (() => void) => {
        listeners[key] = listener as never
        return vi.fn()
      }

    window.api = {
      lifecycle: {
        getClientId: vi.fn().mockResolvedValue('electron:7')
      },
      projects: {
        onCreated: subscribe<Project>('projectCreated'),
        onUpdated: subscribe<Project>('projectUpdated'),
        onDeleted: subscribe<ProjectDeletedEvent>('projectDeleted'),
        onDeletionCleanupChanged: subscribe<undefined>('projectDeletionCleanupChanged'),
        listDeletionCleanup: vi.fn().mockResolvedValue([])
      },
      sessions: {
        onCreated: subscribe<SessionUpsertEvent>('sessionCreated'),
        onUpdated: subscribe<SessionUpsertEvent>('sessionUpdated'),
        onDeleted: subscribe<SessionDeletedEvent>('sessionDeleted')
      }
    } as unknown as Window['api']

    root = createRoot(container)
    await act(async () => root.render(<Harness />))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it.each(['web:external', 'electron:7'])(
    'ignores obsolete archive event effects from %s',
    async (originClientId) => {
      useSessionStore.getState().hydrateSessions([{ ...session, revision: 5 }])
      useSessionStore.getState().selectSession(session.id)
      const removeItems = vi.spyOn(usePreviewWorkbenchStore.getState(), 'removeSessionItems')
      removeItems.mockClear()
      await act(async () => {
        listeners.sessionUpdated?.({
          session: { ...session, revision: 4, archivedAt: 20 },
          originClientId
        })
      })
      expect(useSessionStore.getState().selectedSessionId).toBe(session.id)
      expect(useSessionStore.getState().sessions[0]).toMatchObject({ revision: 5 })
      expect(useSessionStore.getState().sessions[0].archivedAt).toBeUndefined()
      expect(removeItems).not.toHaveBeenCalled()
      removeItems.mockRestore()
    }
  )

  it('keeps a cross-window restore when an older archive RPC finishes later', async () => {
    useSessionStore.getState().hydrateSessions([{ ...session, revision: 3 }])
    let resolve!: (value: typeof session) => void
    window.api.sessions.updateArchive = vi.fn(
      () =>
        new Promise<typeof session>((done) => {
          resolve = done
        })
    )
    const archiving = useSessionStore.getState().updateSessionArchive({
      projectId: project.id,
      sessionId: session.id,
      archived: true,
      expectedArchivedAt: null
    })
    await act(async () => {
      listeners.sessionUpdated?.({
        session: { ...session, revision: 5 },
        originClientId: 'web:external'
      })
      resolve({ ...session, revision: 4, archivedAt: 20 })
      await archiving
    })
    expect(useSessionStore.getState().sessions[0]).toMatchObject({ revision: 5 })
    expect(useSessionStore.getState().sessions[0].archivedAt).toBeUndefined()
  })

  it.each(['cleanup-pending', 'deleted', 'archived'] as const)(
    'does not revive a project after %s supersedes an in-flight undo',
    async (status) => {
      useProjectStore.getState().upsertProject({ ...project, archivedAt: 2 })
      useArchiveUndoStore.getState().enqueueProject({ ...project, archivedAt: 2 })
      let resolve!: (value: Project) => void
      window.api.projects.updateArchive = vi.fn(
        () =>
          new Promise<Project>((done) => {
            resolve = done
          })
      )
      const key = useArchiveUndoStore.getState().notices[0].key
      const undo = useArchiveUndoStore.getState().undo(key)
      await act(async () => {
        if (status === 'archived') listeners.projectUpdated?.({ ...project, archivedAt: 30 })
        else listeners.projectDeleted?.({ projectId: project.id, status })
        useArchiveUndoStore.getState().dismiss(key)
        resolve(project)
        await undo
      })
      expect(useProjectStore.getState().projects).toEqual(
        status === 'archived' ? [{ ...project, archivedAt: 30 }] : []
      )
      expect(useArchiveUndoStore.getState()).toMatchObject({ notices: [], restoringKey: undefined })
    }
  )

  it.each(['cleanup-pending', 'deleted', 'session-deleted', 'archived'] as const)(
    'does not revive a session after %s supersedes an in-flight undo',
    async (status) => {
      const archived = { ...session, revision: 3, archivedAt: 2 }
      useSessionStore.getState().hydrateSessions([archived])
      useArchiveUndoStore.getState().enqueueSession(archived)
      let resolve!: (value: typeof session) => void
      window.api.sessions.updateArchive = vi.fn(
        () =>
          new Promise<typeof session>((done) => {
            resolve = done
          })
      )
      const key = useArchiveUndoStore.getState().notices[0].key
      const undo = useArchiveUndoStore.getState().undo(key)
      await act(async () => {
        if (status === 'archived')
          listeners.sessionUpdated?.({
            session: { ...session, revision: 5, archivedAt: 30 },
            originClientId: 'web:external'
          })
        else if (status === 'session-deleted')
          listeners.sessionDeleted?.({ projectId: project.id, sessionId: session.id })
        else listeners.projectDeleted?.({ projectId: project.id, status })
        useArchiveUndoStore.getState().dismiss(key)
        resolve({ ...session, revision: 4 })
        await undo
      })
      if (status === 'archived')
        expect(useSessionStore.getState().sessions[0]).toMatchObject({
          revision: 5,
          archivedAt: 30
        })
      else expect(useSessionStore.getState().sessions).toEqual([])
      expect(useArchiveUndoStore.getState()).toMatchObject({ notices: [], restoringKey: undefined })
    }
  )

  it('upserts external projects and sessions and opens the toast target', async () => {
    await act(async () => {
      listeners.projectCreated?.(project)
      listeners.sessionCreated?.({ session, originClientId: 'web:external' })
    })

    expect(useProjectStore.getState().projects).toEqual([project])
    expect(useSessionStore.getState().sessions[0]?.id).toBe(session.id)
    const noticeButton = container.querySelector<HTMLButtonElement>('button')
    expect(noticeButton?.dataset.noticeSession).toBe(session.id)

    await act(async () => noticeButton?.click())

    expect(useNavigationStore.getState()).toMatchObject({
      view: 'workspace',
      activeProjectId: project.id
    })
    expect(useSessionStore.getState().selectedSessionId).toBe(session.id)
    expect(noticeButton?.dataset.noticeSession).toBe('')
  })

  it('replays lifecycle events after initial snapshots finish hydrating', async () => {
    await act(async () => {
      useProjectStore.setState(createInitialProjectState())
      root.render(<Harness isSessionPersistenceHydrated={false} />)
    })
    await act(async () => {
      listeners.projectCreated?.(project)
      listeners.sessionCreated?.({ session, originClientId: 'web:external' })
    })

    await act(async () => {
      useProjectStore.setState({ ...createInitialProjectState(), isLoaded: true })
      useSessionStore.getState().hydrateSessions([])
      root.render(<Harness />)
    })

    expect(useProjectStore.getState().projects).toEqual([project])
    expect(useSessionStore.getState().sessions[0]?.id).toBe(session.id)
    expect(container.querySelector<HTMLButtonElement>('button')?.dataset.noticeSession).toBe(
      session.id
    )
  })

  it('applies only the latest queued snapshot for one Session after hydration', async () => {
    await act(async () => {
      useProjectStore.setState(createInitialProjectState())
      root.render(<Harness isSessionPersistenceHydrated={false} />)
    })
    await act(async () => {
      for (let revision = 1; revision <= 50; revision += 1) {
        listeners.sessionCreated?.({
          session: {
            ...session,
            title: `Queued snapshot ${revision}`,
            updatedAt: revision
          },
          originClientId: 'web:external'
        })
      }
    })
    const upsertPersistedSession = vi.spyOn(useSessionStore.getState(), 'upsertPersistedSession')

    await act(async () => {
      useProjectStore.setState({ ...createInitialProjectState(), isLoaded: true })
      useSessionStore.getState().hydrateSessions([])
      root.render(<Harness />)
    })

    expect(upsertPersistedSession).toHaveBeenCalledTimes(1)
    expect(useSessionStore.getState().sessions[0]?.title).toBe('Queued snapshot 50')
  })

  it('preserves queued Session creation when a later same-client update replaces it', async () => {
    await act(async () => {
      useProjectStore.setState(createInitialProjectState())
      root.render(<Harness isSessionPersistenceHydrated={false} />)
    })
    await act(async () => {
      listeners.sessionCreated?.({ session, originClientId: 'electron:7' })
      listeners.sessionUpdated?.({
        session: { ...session, title: 'Updated before hydration', updatedAt: 2 },
        originClientId: 'electron:7'
      })
    })

    await act(async () => {
      useProjectStore.setState({ ...createInitialProjectState(), isLoaded: true })
      useSessionStore.getState().hydrateSessions([])
      root.render(<Harness />)
    })

    expect(useSessionStore.getState().sessions[0]?.title).toBe('Updated before hydration')
    expect(container.querySelector<HTMLButtonElement>('button')?.dataset.noticeSession).toBe('')
  })

  it('preserves an external creation notice when its queued snapshot is updated', async () => {
    await act(async () => {
      useProjectStore.setState(createInitialProjectState())
      root.render(<Harness isSessionPersistenceHydrated={false} />)
    })
    await act(async () => {
      listeners.sessionCreated?.({ session, originClientId: 'web:external' })
      listeners.sessionUpdated?.({
        session: { ...session, title: 'Updated external session', updatedAt: 2 },
        originClientId: 'web:external'
      })
    })

    await act(async () => {
      useProjectStore.setState({ ...createInitialProjectState(), isLoaded: true })
      useSessionStore.getState().hydrateSessions([])
      root.render(<Harness />)
    })

    expect(useSessionStore.getState().sessions[0]?.title).toBe('Updated external session')
    expect(container.querySelector<HTMLButtonElement>('button')?.dataset.noticeSession).toBe(
      session.id
    )
  })

  it('keeps a queued Session deletion terminal when a stale snapshot arrives later', async () => {
    await act(async () => {
      useProjectStore.setState(createInitialProjectState())
      root.render(<Harness isSessionPersistenceHydrated={false} />)
    })
    await act(async () => {
      listeners.sessionDeleted?.({ projectId: project.id, sessionId: session.id })
      listeners.sessionCreated?.({
        session: { ...session, title: 'Stale snapshot after deletion' },
        originClientId: 'web:external'
      })
    })

    await act(async () => {
      useProjectStore.setState({ ...createInitialProjectState(), isLoaded: true })
      useSessionStore.getState().hydrateSessions([session])
      root.render(<Harness />)
    })

    expect(useSessionStore.getState().sessions).toEqual([])
    expect(container.querySelector<HTMLButtonElement>('button')?.dataset.noticeSession).toBe('')
  })

  it('does not classify Session events as external when client identity is unavailable', async () => {
    await act(async () => root.unmount())
    useSessionStore.setState(createInitialSessionState())
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    window.api.lifecycle.getClientId = vi.fn().mockRejectedValue(new Error('client unavailable'))
    root = createRoot(container)
    await act(async () => root.render(<Harness />))

    await act(async () => {
      listeners.sessionCreated?.({ session, originClientId: 'electron:7' })
    })

    expect(useSessionStore.getState().sessions[0]?.id).toBe(session.id)
    expect(container.querySelector<HTMLButtonElement>('button')?.dataset.noticeSession).toBe('')
    expect(consoleWarn).toHaveBeenCalledWith(
      'Unable to identify lifecycle client',
      expect.any(Error)
    )
  })

  it('still applies Session updates when client identity is unavailable', async () => {
    await act(async () => root.unmount())
    useSessionStore.getState().hydrateSessions([session])
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    window.api.lifecycle.getClientId = vi.fn().mockRejectedValue(new Error('client unavailable'))
    root = createRoot(container)
    await act(async () => root.render(<Harness />))

    await act(async () => {
      listeners.sessionUpdated?.({
        session: { ...session, title: 'Updated without identity', updatedAt: 2 },
        originClientId: 'electron:7'
      })
    })

    expect(useSessionStore.getState().sessions[0]?.title).toBe('Updated without identity')
    expect(container.querySelector<HTMLButtonElement>('button')?.dataset.noticeSession).toBe('')
    expect(consoleWarn).toHaveBeenCalledWith(
      'Unable to identify lifecycle client',
      expect.any(Error)
    )
  })

  it('does not notify for a session created by this renderer', async () => {
    await act(async () => {
      listeners.sessionCreated?.({ session, originClientId: 'electron:7' })
    })

    expect(useSessionStore.getState().sessions[0]?.id).toBe(session.id)
    expect(container.querySelector<HTMLButtonElement>('button')?.dataset.noticeSession).toBe('')
  })

  it('applies session updates without showing a created notice', async () => {
    const updatedSession = { ...session, title: 'Updated session', updatedAt: 2 }

    await act(async () => {
      listeners.sessionUpdated?.({ session: updatedSession, originClientId: 'web:external' })
    })

    expect(useSessionStore.getState().sessions[0]?.title).toBe('Updated session')
    expect(container.querySelector<HTMLButtonElement>('button')?.dataset.noticeSession).toBe('')
  })

  it('converges to an external Delegation policy update without accepting an older revision', async () => {
    useSessionStore.getState().hydrateSessions([
      {
        ...session,
        revision: 1,
        title: 'Live renderer title',
        status: 'running',
        delegationPolicy: 'allow',
        runtimeContext: {
          version: 1,
          revision: 2,
          delegatedWork: { records: [] }
        }
      }
    ])
    useSessionStore.getState().appendUserMessage({
      sessionId: session.id,
      content: 'Keep this live prompt'
    })
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((candidate) =>
        candidate.id === session.id
          ? { ...candidate, agentStatus: 'Thinking', awaitingFirstAgentOutput: true }
          : candidate
      )
    }))

    await act(async () => {
      listeners.sessionUpdated?.({
        session: { ...session, revision: 3, delegationPolicy: 'deny', updatedAt: 3 },
        originClientId: MAIN_DELEGATION_POLICY_LIFECYCLE_CLIENT_ID
      })
    })
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      revision: 3,
      title: 'Live renderer title',
      status: 'running',
      delegationPolicy: 'deny',
      agentStatus: 'Thinking',
      awaitingFirstAgentOutput: true,
      runtimeContext: {
        revision: 2,
        delegatedWork: { records: [] }
      },
      messages: [expect.objectContaining({ content: 'Keep this live prompt' })]
    })

    await act(async () => {
      listeners.sessionUpdated?.({
        session: { ...session, revision: 2, delegationPolicy: 'allow', updatedAt: 4 },
        originClientId: MAIN_DELEGATION_POLICY_LIFECYCLE_CLIENT_ID
      })
    })
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      revision: 3,
      delegationPolicy: 'deny'
    })
  })

  it('keeps acknowledged Delegation policy while applying a later running continuation projection', async () => {
    useSessionStore.getState().hydrateSessions([
      {
        ...session,
        revision: 1,
        status: 'running',
        delegationPolicy: 'allow'
      }
    ])
    const source = useSessionStore.getState().sessions[0]
    useSessionStore.getState().applyDelegationPolicyAuthority({
      ...toPersistedSession(source),
      revision: 2,
      delegationPolicy: 'deny',
      updatedAt: 2
    })

    await act(async () => {
      listeners.sessionUpdated?.({
        session: {
          ...session,
          revision: 3,
          title: 'Running activity updated',
          status: 'running',
          delegationPolicy: 'allow',
          updatedAt: 3
        },
        originClientId: MAIN_DURABLE_CONTINUATION_LIFECYCLE_CLIENT_ID
      })
    })

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      revision: 3,
      title: 'Running activity updated',
      status: 'running',
      delegationPolicy: 'deny'
    })

    await act(async () => {
      listeners.sessionUpdated?.({
        session: {
          ...session,
          revision: 4,
          title: 'External policy authority',
          status: 'running',
          delegationPolicy: 'allow',
          updatedAt: 4
        },
        originClientId: MAIN_DELEGATION_POLICY_LIFECYCLE_CLIENT_ID
      })
    })

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      revision: 4,
      title: 'Running activity updated',
      status: 'running',
      delegationPolicy: 'allow'
    })
  })

  it('projects enabled Compute Host authority without replacing live chat state', async () => {
    useSessionStore.getState().hydrateSessions([session])
    const source = useSessionStore.getState().sessions[0]
    useSessionStore.getState().appendUserMessage({
      sessionId: session.id,
      content: 'Keep this live prompt'
    })

    await act(async () => {
      listeners.sessionUpdated?.({
        originClientId: MAIN_ENABLED_COMPUTE_HOSTS_LIFECYCLE_CLIENT_ID,
        session: {
          ...toPersistedSession(source),
          enabledComputeHosts: ['ssh:lab'],
          computeConcurrencyLimit: 2,
          updatedAt: source.updatedAt + 1
        }
      })
    })

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      enabledComputeHosts: ['ssh:lab'],
      computeConcurrencyLimit: 2,
      messages: [expect.objectContaining({ content: 'Keep this live prompt' })]
    })
  })

  it('applies main-owned delegated child lifecycle projections to the live Session store', async () => {
    const rootPrompt = {
      id: 'root-prompt',
      role: 'user' as const,
      content: 'Delegate this work',
      status: 'complete' as const,
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    }
    const graph = createLinearConversationGraph({
      sessionId: session.id,
      messages: [rootPrompt],
      createdAt: 1,
      updatedAt: 1
    })
    const rootFrameId = graph.rootFrameId
    graph.frames.push({
      id: 'child-frame',
      parentFrameId: rootFrameId,
      originMessageId: rootPrompt.id,
      originBindingState: 'validated',
      kind: 'delegate',
      status: 'running',
      activeBranchId: 'child-branch',
      createdAt: 2
    })
    graph.branches.push({
      id: 'child-branch',
      agentFrameId: 'child-frame',
      createdAt: 2,
      updatedAt: 2
    })
    useSessionStore.getState().hydrateSessions([{ ...session, messages: [rootPrompt] }])

    await act(async () => {
      listeners.sessionUpdated?.({
        originClientId: MAIN_DELEGATED_WORK_LIFECYCLE_CLIENT_ID,
        session: {
          ...session,
          messages: [rootPrompt],
          conversationGraph: graph,
          runtimeContext: {
            version: 1,
            revision: 1,
            delegatedWork: {
              records: [
                {
                  agentFrameId: 'child-frame',
                  attempts: [
                    {
                      id: 'child-attempt',
                      status: 'running',
                      resolvedAgent: { kind: 'main' },
                      runtimeSegmentIds: [],
                      startedAt: 2
                    }
                  ]
                }
              ]
            }
          },
          updatedAt: 2
        }
      })
    })

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      runtimeContext: {
        revision: 1,
        delegatedWork: { records: [{ agentFrameId: 'child-frame' }] }
      },
      conversationGraph: {
        frames: expect.arrayContaining([expect.objectContaining({ id: 'child-frame' })])
      }
    })

    const finishedGraph = structuredClone(graph)
    const childFrame = finishedGraph.frames.find(({ id }) => id === 'child-frame')!
    childFrame.status = 'cancelled'
    childFrame.completedAt = 3
    await act(async () => {
      listeners.sessionUpdated?.({
        originClientId: MAIN_DELEGATED_WORK_LIFECYCLE_CLIENT_ID,
        session: {
          ...session,
          messages: [rootPrompt],
          conversationGraph: finishedGraph,
          runtimeContext: {
            version: 1,
            revision: 2,
            delegatedWork: {
              records: [
                {
                  agentFrameId: 'child-frame',
                  attempts: [
                    {
                      id: 'child-attempt',
                      status: 'cancelled',
                      resolvedAgent: { kind: 'main' },
                      runtimeSegmentIds: [],
                      startedAt: 2,
                      endedAt: 3,
                      cancellationReason: 'main_agent_stop'
                    }
                  ]
                }
              ]
            }
          },
          updatedAt: 3
        }
      })
    })

    expect(
      useSessionStore.getState().sessions[0].runtimeContext?.delegatedWork?.records[0]?.attempts[0]
    ).toMatchObject({ status: 'cancelled', endedAt: 3 })
    expect(
      useSessionStore
        .getState()
        .sessions[0].conversationGraph?.frames.find(({ id }) => id === 'child-frame')
    ).toMatchObject({ status: 'cancelled', completedAt: 3 })
  })

  it('preserves newer live root state while applying a later delegated terminal snapshot', async () => {
    const rootPrompt = {
      id: 'root-prompt',
      role: 'user' as const,
      content: 'Delegate and continue locally',
      status: 'complete' as const,
      eventIds: [],
      createdAt: 10,
      updatedAt: 10
    }
    const localOutput = {
      id: 'root-output',
      role: 'agent' as const,
      content: 'Newer renderer output',
      status: 'streaming' as const,
      eventIds: ['local-event'],
      responseToMessageId: rootPrompt.id,
      createdAt: 20,
      updatedAt: 50
    }
    const localGraph = createLinearConversationGraph({
      sessionId: session.id,
      messages: [rootPrompt, localOutput],
      createdAt: 10,
      updatedAt: 50
    })
    localGraph.frames[0].status = 'running'
    delete localGraph.frames[0].completedAt
    useSessionStore.getState().hydrateSessions([
      {
        ...session,
        status: 'running',
        activeRun: { promptMessageId: rootPrompt.id, startedAt: 10 },
        messages: [rootPrompt, localOutput],
        conversationGraph: localGraph,
        updatedAt: 50
      }
    ])
    const incomingGraph = structuredClone(localGraph)
    incomingGraph.frames[0].status = 'completed'
    incomingGraph.frames[0].completedAt = 30
    const staleRootOutput = incomingGraph.messages.find(({ id }) => id === localOutput.id)!
    staleRootOutput.content = 'Stale durable output'
    staleRootOutput.status = 'complete'
    staleRootOutput.updatedAt = 30
    incomingGraph.frames.push({
      id: 'child-frame',
      parentFrameId: incomingGraph.rootFrameId,
      originMessageId: rootPrompt.id,
      originBindingState: 'validated',
      kind: 'delegate',
      status: 'cancelled',
      activeBranchId: 'child-branch',
      createdAt: 20,
      completedAt: 100
    })
    incomingGraph.branches.push({
      id: 'child-branch',
      agentFrameId: 'child-frame',
      createdAt: 20,
      updatedAt: 100
    })

    await act(async () => {
      listeners.sessionUpdated?.({
        originClientId: MAIN_DELEGATED_WORK_LIFECYCLE_CLIENT_ID,
        session: {
          ...session,
          status: 'idle',
          messages: [rootPrompt, { ...localOutput, ...staleRootOutput }],
          conversationGraph: incomingGraph,
          runtimeContext: {
            version: 1,
            revision: 1,
            delegatedWork: {
              records: [
                {
                  agentFrameId: 'child-frame',
                  attempts: [
                    {
                      id: 'child-attempt',
                      status: 'cancelled',
                      resolvedAgent: { kind: 'main' },
                      runtimeSegmentIds: [],
                      startedAt: 20,
                      endedAt: 100,
                      cancellationReason: 'main_agent_stop'
                    }
                  ]
                }
              ]
            }
          },
          updatedAt: 100
        }
      })
    })

    const projected = useSessionStore.getState().sessions[0]
    expect(projected).toMatchObject({
      status: 'running',
      activeRun: { promptMessageId: rootPrompt.id, startedAt: 10 },
      updatedAt: 50
    })
    expect(projected.messages.find(({ id }) => id === localOutput.id)).toMatchObject({
      content: 'Newer renderer output',
      status: 'streaming',
      updatedAt: 50
    })
    const projectedRoot = projected.conversationGraph?.frames.find(
      ({ id }) => id === incomingGraph.rootFrameId
    )
    expect(projectedRoot).toMatchObject({ status: 'running' })
    expect(projectedRoot).not.toHaveProperty('completedAt')
    expect(
      projected.conversationGraph?.messages.find(({ id }) => id === localOutput.id)
    ).toMatchObject({ content: 'Newer renderer output', status: 'streaming', updatedAt: 50 })
    expect(projected.runtimeContext?.delegatedWork?.records[0]?.attempts[0]).toMatchObject({
      status: 'cancelled',
      endedAt: 100
    })
    expect(
      projected.conversationGraph?.frames.find(({ id }) => id === 'child-frame')
    ).toMatchObject({ status: 'cancelled', completedAt: 100 })
  })

  it('merges inactive direct-child terminal output so switching the root branch back is current', async () => {
    const rootPrompt = {
      id: 'root-prompt',
      role: 'user' as const,
      content: 'Start delegated research',
      status: 'complete' as const,
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    }
    const graph = createLinearConversationGraph({
      sessionId: session.id,
      messages: [rootPrompt],
      createdAt: 1,
      updatedAt: 1
    })
    const rootFrame = graph.frames[0]
    const originalRootBranchId = rootFrame.activeBranchId
    graph.frames.push({
      id: 'inactive-child',
      parentFrameId: graph.rootFrameId,
      originMessageId: rootPrompt.id,
      originBindingState: 'validated',
      kind: 'delegate',
      status: 'running',
      activeBranchId: 'child-branch',
      createdAt: 2
    })
    graph.branches.push(
      {
        id: 'child-branch',
        agentFrameId: 'inactive-child',
        headMessageId: 'child-prompt',
        createdAt: 2,
        updatedAt: 2
      },
      {
        id: 'alternate-root-branch',
        agentFrameId: graph.rootFrameId,
        headMessageId: 'alternate-root-prompt',
        createdAt: 3,
        updatedAt: 3
      }
    )
    graph.messages.push(
      {
        id: 'child-prompt',
        role: 'user',
        content: 'Research the evidence',
        status: 'complete',
        eventIds: [],
        agentFrameId: 'inactive-child',
        introducedOnBranchId: 'child-branch',
        createdAt: 2,
        updatedAt: 2
      },
      {
        id: 'alternate-root-prompt',
        role: 'user',
        content: 'Work on an alternate root branch',
        status: 'complete',
        eventIds: [],
        agentFrameId: graph.rootFrameId,
        introducedOnBranchId: 'alternate-root-branch',
        createdAt: 3,
        updatedAt: 3
      }
    )
    rootFrame.activeBranchId = 'alternate-root-branch'
    useSessionStore.getState().hydrateSessions([
      {
        ...session,
        messages: [rootPrompt],
        conversationGraph: graph,
        runtimeContext: {
          version: 1,
          revision: 1,
          delegatedWork: {
            records: [
              {
                agentFrameId: 'inactive-child',
                attempts: [
                  {
                    id: 'child-attempt',
                    status: 'running',
                    resolvedAgent: { kind: 'main' },
                    runtimeSegmentIds: [],
                    startedAt: 2
                  }
                ]
              }
            ]
          }
        },
        updatedAt: 3
      }
    ])
    expect(hasCurrentRunningDelegatedAttempt(useSessionStore.getState().sessions[0])).toBe(true)

    const terminalGraph = structuredClone(graph)
    const terminalChild = terminalGraph.frames.find(({ id }) => id === 'inactive-child')!
    terminalChild.status = 'completed'
    terminalChild.completedAt = 5
    terminalGraph.branches.find(({ id }) => id === 'child-branch')!.headMessageId = 'child-answer'
    terminalGraph.messages.push({
      id: 'child-answer',
      role: 'agent',
      content: 'Terminal child result',
      status: 'complete',
      eventIds: [],
      artifactIds: ['child-artifact-version'],
      agentFrameId: 'inactive-child',
      introducedOnBranchId: 'child-branch',
      parentMessageId: 'child-prompt',
      createdAt: 5,
      updatedAt: 5
    })

    await act(async () => {
      listeners.sessionUpdated?.({
        originClientId: MAIN_DELEGATED_WORK_LIFECYCLE_CLIENT_ID,
        session: {
          ...session,
          messages: [rootPrompt],
          conversationGraph: terminalGraph,
          runtimeContext: {
            version: 1,
            revision: 2,
            delegatedWork: {
              records: [
                {
                  agentFrameId: 'inactive-child',
                  attempts: [
                    {
                      id: 'child-attempt',
                      status: 'completed',
                      resolvedAgent: { kind: 'main' },
                      runtimeSegmentIds: [],
                      startedAt: 2,
                      endedAt: 5,
                      terminalMessageId: 'child-answer'
                    }
                  ]
                }
              ]
            }
          },
          artifacts: [
            {
              id: 'child-artifact-version',
              kind: 'managed-file',
              path: 'child-result.md'
            }
          ],
          filesRevision: 1,
          updatedAt: 5
        }
      })
      useSessionStore.getState().activateMessageBranch(session.id, originalRootBranchId)
    })

    expect(hasCurrentRunningDelegatedAttempt(useSessionStore.getState().sessions[0])).toBe(false)

    const projected = useSessionStore.getState().sessions[0]
    expect(projected.runtimeContext?.delegatedWork?.records[0]?.attempts[0]).toMatchObject({
      status: 'completed',
      terminalMessageId: 'child-answer'
    })
    expect(
      projected.conversationGraph?.frames.find(({ id }) => id === 'inactive-child')
    ).toMatchObject({ status: 'completed', completedAt: 5 })
    expect(
      projected.conversationGraph?.messages.find(({ id }) => id === 'child-answer')
    ).toMatchObject({ content: 'Terminal child result', artifactIds: ['child-artifact-version'] })
    expect(projected.artifacts).toContainEqual(
      expect.objectContaining({ id: 'child-artifact-version', path: 'child-result.md' })
    )
    expect(
      projected.conversationGraph?.frames.find(({ id }) => id === graph.rootFrameId)?.activeBranchId
    ).toBe(originalRootBranchId)
  })

  it('merges Main-owned permission authority without replacing live chat state', async () => {
    useSessionStore.getState().hydrateSessions([session])
    const prompt = useSessionStore.getState().appendUserMessage({
      sessionId: session.id,
      content: 'Run the verification'
    })
    const durableBeforeOutput = toPersistedSession(useSessionStore.getState().sessions[0])
    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: session.id,
      streamId: 'run-1',
      eventId: 'agent-message-1',
      promptMessageId: prompt?.messageId,
      content: 'Preparing the command.'
    })

    const pendingAuthoritySession = {
      ...durableBeforeOutput,
      status: 'waiting-permission' as const,
      updatedAt: durableBeforeOutput.updatedAt + 1,
      runtimeContext: {
        version: 1 as const,
        revision: 1,
        permission: {
          state: 'pending' as const,
          request: {
            requestId: 'permission-1',
            sessionId: session.id,
            toolCallId: 'tool-1',
            title: 'Run npm test',
            options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' as const }]
          },
          originatingPromptMessageId: prompt!.messageId,
          fingerprint: 'a'.repeat(64),
          createdAt: 1
        }
      }
    }

    await act(async () => {
      listeners.sessionUpdated?.({
        originClientId: MAIN_PERMISSION_WAIT_LIFECYCLE_CLIENT_ID,
        session: pendingAuthoritySession
      })
    })

    const projected = useSessionStore.getState().sessions[0]
    expect(projected.status).toBe('waiting-permission')
    expect(projected.runtimeContext?.permission?.request.requestId).toBe('permission-1')
    expect(projected.messages.map((message) => message.content)).toEqual([
      'Run the verification',
      'Preparing the command.'
    ])
    expect(projected.activeRun?.promptMessageId).toBe(prompt?.messageId)

    await act(async () => {
      listeners.sessionUpdated?.({
        originClientId: MAIN_PERMISSION_WAIT_LIFECYCLE_CLIENT_ID,
        session: {
          ...durableBeforeOutput,
          status: 'running',
          updatedAt: durableBeforeOutput.updatedAt + 2,
          runtimeContext: { version: 1, revision: 2 }
        }
      })
    })

    const settled = useSessionStore.getState().sessions[0]
    expect(settled.status).toBe('running')
    expect(settled.runtimeContext?.permission).toBeUndefined()
    expect(settled.messages.map((message) => message.content)).toEqual([
      'Run the verification',
      'Preparing the command.'
    ])

    await act(async () => {
      listeners.sessionUpdated?.({
        originClientId: MAIN_PERMISSION_WAIT_LIFECYCLE_CLIENT_ID,
        session: {
          ...pendingAuthoritySession,
          updatedAt: durableBeforeOutput.updatedAt + 3
        }
      })
    })

    const afterStalePendingReplay = useSessionStore.getState().sessions[0]
    expect(afterStalePendingReplay.status).toBe('running')
    expect(afterStalePendingReplay.runtimeContext?.revision).toBe(2)
    expect(afterStalePendingReplay.runtimeContext?.permission).toBeUndefined()
    expect(afterStalePendingReplay.messages.map((message) => message.content)).toEqual([
      'Run the verification',
      'Preparing the command.'
    ])
  })

  it('applies a Main-owned runtime revision without replacing live chat state', async () => {
    useSessionStore.getState().hydrateSessions([{ ...session, revision: 2 }])
    const prompt = useSessionStore.getState().appendUserMessage({
      sessionId: session.id,
      content: 'Keep this live prompt'
    })
    const durableBeforeOutput = toPersistedSession(useSessionStore.getState().sessions[0])
    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: session.id,
      streamId: 'run-1',
      eventId: 'agent-message-1',
      promptMessageId: prompt?.messageId,
      content: 'Keep this live output.'
    })
    const replyTimestamp = durableBeforeOutput.updatedAt + 1
    const mainAppendedReply = {
      id: 'main-appended-reply',
      role: 'user' as const,
      content: 'Keep this Main-owned reply',
      status: 'complete' as const,
      eventIds: [],
      responseToMessageId: prompt?.messageId,
      createdAt: replyTimestamp,
      updatedAt: replyTimestamp
    }
    if (!durableBeforeOutput.conversationGraph) throw new Error('Expected a durable graph.')
    const durableWithReply = {
      ...durableBeforeOutput,
      messages: [...durableBeforeOutput.messages, mainAppendedReply],
      conversationGraph: synchronizeActiveConversationMessages(
        durableBeforeOutput.conversationGraph,
        [...durableBeforeOutput.messages, mainAppendedReply],
        replyTimestamp
      )
    }

    await act(async () => {
      listeners.sessionUpdated?.({
        originClientId: MAIN_RUNTIME_CONTEXT_LIFECYCLE_CLIENT_ID,
        session: {
          ...durableWithReply,
          revision: 3,
          status: 'waiting-plan-approval',
          updatedAt: replyTimestamp,
          planHistoryProjections: [completedPlanHistoryProjection],
          runtimeContext: {
            version: 1,
            revision: 1,
            plan: {
              artifactId: 'plan-1',
              artifactVersionId: 'plan-version-1',
              artifactChecksum: 'a'.repeat(64),
              approval: 'pending',
              stepStatuses: {}
            }
          }
        }
      })
    })

    const projected = useSessionStore.getState().sessions[0]
    expect(projected).toMatchObject({
      revision: 3,
      status: 'waiting-plan-approval',
      runtimeContext: { revision: 1, plan: { approval: 'pending' } },
      planHistoryProjections: [
        expect.objectContaining({ artifactVersionId: 'historical-plan-version' })
      ]
    })
    expect(projected.messages.map((message) => message.content)).toEqual([
      'Keep this live prompt',
      'Keep this live output.',
      'Keep this Main-owned reply'
    ])
    expect(projected.conversationGraph?.messages.map((message) => message.content)).toEqual([
      'Keep this live prompt',
      'Keep this Main-owned reply'
    ])
    expect(projected.activeRun?.promptMessageId).toBe(prompt?.messageId)
  })

  it('applies Main-owned Session details without replacing a live prompt or streaming output', async () => {
    useSessionStore.getState().hydrateSessions([{ ...session, revision: 2 }])
    const prompt = useSessionStore.getState().appendUserMessage({
      sessionId: session.id,
      content: 'Explain why the banner appears'
    })
    const durableBeforeOutput = toPersistedSession(useSessionStore.getState().sessions[0])
    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: session.id,
      streamId: 'run-1',
      eventId: 'agent-message-1',
      promptMessageId: prompt?.messageId,
      content: 'The live answer must remain.'
    })

    await act(async () => {
      listeners.sessionUpdated?.({
        originClientId: MAIN_SESSION_DETAILS_LIFECYCLE_CLIENT_ID,
        session: {
          ...durableBeforeOutput,
          revision: 5,
          title: 'Interrupted banner investigation',
          description: 'Investigate why an active Session shows an interrupted banner.',
          sessionDetailsSource: 'generated',
          sessionDetailsGenerationEligible: undefined,
          sessionDetailsGeneration: {
            status: 'succeeded',
            sourceMessageId: prompt!.messageId,
            requestId: 'details-1',
            queuedAt: 10,
            startedAt: 11,
            frameworkId: 'codex',
            providerId: 'provider-1',
            model: 'gpt-5.6-sol',
            reasoningEffort: 'low',
            completedAt: 12,
            usageUnavailable: true
          },
          status: 'error',
          activeRun: undefined,
          error: 'Session was interrupted before the app closed.',
          resumeRecovery: { kind: 'resume-required', cause: 'app-restart' }
        }
      })
    })

    const projected = useSessionStore.getState().sessions[0]
    expect(projected).toMatchObject({
      revision: 5,
      title: 'Interrupted banner investigation',
      description: 'Investigate why an active Session shows an interrupted banner.',
      sessionDetailsSource: 'generated',
      sessionDetailsGeneration: { status: 'succeeded' },
      status: 'running',
      activeRun: { promptMessageId: prompt?.messageId }
    })
    expect(projected.messages.map((message) => message.content)).toEqual([
      'Explain why the banner appears',
      'The live answer must remain.'
    ])
    expect(projected.error).toBeUndefined()
    expect(projected.resumeRecovery).toBeUndefined()
    expect(projected.interrupted).toBeUndefined()
  })

  it('applies a Main-owned continuation prompt before projecting later artifact events', async () => {
    const prompt = {
      id: 'prompt-original',
      role: 'user' as const,
      content: 'Choose an approach.',
      status: 'complete' as const,
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    }
    const preamble = {
      id: 'agent-question-preamble',
      role: 'agent' as const,
      content: 'Please choose one option.',
      status: 'complete' as const,
      responseToMessageId: prompt.id,
      eventIds: [],
      createdAt: 2,
      updatedAt: 2
    }
    const base = {
      ...session,
      messages: [prompt, preamble],
      conversationGraph: createLinearConversationGraph({
        sessionId: session.id,
        messages: [prompt, preamble],
        frameworkId: 'claude-code',
        createdAt: 1,
        updatedAt: 2
      }),
      updatedAt: 2
    }
    useSessionStore.getState().hydrateSessions([base])
    const revisionPrompt = {
      id: 'prompt-revision',
      role: 'user' as const,
      content: 'The user revised the previous structured answer: Approach: Expanded',
      status: 'complete' as const,
      responseToMessageId: preamble.id,
      eventIds: [],
      createdAt: 3,
      updatedAt: 3
    }
    const durable = {
      ...base,
      messages: [...base.messages, revisionPrompt],
      conversationGraph: synchronizeActiveConversationMessages(
        base.conversationGraph,
        [...base.messages, revisionPrompt],
        3
      ),
      updatedAt: 3
    }

    await act(async () => {
      listeners.sessionUpdated?.({
        session: durable,
        originClientId: MAIN_DURABLE_CONTINUATION_LIFECYCLE_CLIENT_ID
      })
    })

    const projected = toPersistedSession(useSessionStore.getState().sessions[0])
    expect(projected.messages.at(-1)).toMatchObject({ id: revisionPrompt.id })
    expect(projected.conversationGraph?.messages.at(-1)).toMatchObject({
      id: revisionPrompt.id,
      introducedOnBranchId: `message-branch-${session.id}`
    })
    const context = getActiveConversationContext(projected.conversationGraph!, revisionPrompt.id)
    const finalMessage = {
      id: 'agent-final',
      role: 'agent' as const,
      content: 'Created the revised artifact.',
      status: 'complete' as const,
      responseToMessageId: revisionPrompt.id,
      eventIds: [],
      createdAt: 4,
      updatedAt: 4
    }
    projected.messages.push(finalMessage)
    projected.conversationGraph = synchronizeActiveConversationMessages(
      projected.conversationGraph!,
      projected.messages,
      4,
      context.runtimeSegmentId
    )
    expect(() =>
      validateDurableMessageOwnership(projected, {
        ...context,
        messageId: finalMessage.id
      })
    ).not.toThrow()
  })

  it("does not roll back live conversation state from this renderer's save echo", async () => {
    useSessionStore.getState().hydrateSessions([
      {
        ...session,
        agentFrameworkId: 'codex',
        agentBackendId: 'codex-response',
        agentModel: 'gpt-5.5',
        runtimeContext: { version: 1, revision: 1 }
      }
    ])
    const earlierSave = toPersistedSession(useSessionStore.getState().sessions[0])
    const appended = useSessionStore.getState().appendUserMessage({
      sessionId: session.id,
      content: 'Create the report',
      agentFrameworkId: 'codex',
      agentBackendId: 'codex-response',
      agentModel: 'gpt-5.6-sol'
    })
    const live = useSessionStore.getState().sessions[0]
    const context = getActiveConversationContext(live.conversationGraph!, appended!.messageId)
    const response = useSessionStore.getState().appendAgentMessageChunk({
      sessionId: session.id,
      streamId: 'run-1',
      eventId: 'agent-message-1',
      promptMessageId: appended?.messageId,
      content: 'Saved the report.'
    })
    useSessionStore.getState().finishRun(session.id, undefined, appended?.messageId)

    await act(async () => {
      listeners.sessionUpdated?.({
        session: { ...earlierSave, updatedAt: live.updatedAt + 1 },
        originClientId: 'electron:7'
      })
    })

    expect(() =>
      validateDurableMessageOwnership(toPersistedSession(useSessionStore.getState().sessions[0]), {
        ...context,
        messageId: response!.messageId
      })
    ).not.toThrow()
  })

  it("keeps archive cleanup for this renderer's update echo", async () => {
    const removeSessionItems = vi.spyOn(usePreviewWorkbenchStore.getState(), 'removeSessionItems')
    useSessionStore.getState().hydrateSessions([{ ...session, title: 'Live title', updatedAt: 3 }])
    useSessionStore.setState({ selectedSessionId: session.id })

    await act(async () => {
      listeners.sessionUpdated?.({
        session: { ...session, title: 'Stale title', archivedAt: 2, updatedAt: 4 },
        originClientId: 'electron:7'
      })
    })

    expect(useSessionStore.getState().sessions[0]?.title).toBe('Live title')
    expect(useSessionStore.getState().sessions[0]?.archivedAt).toBe(2)
    expect(useSessionStore.getState().selectedSessionId).toBeUndefined()
    expect(removeSessionItems).toHaveBeenCalledWith(session.id)
  })

  it('clears a stale notice when its session is archived', async () => {
    await act(async () => {
      listeners.projectCreated?.(project)
      listeners.sessionCreated?.({ session, originClientId: 'web:external' })
    })
    expect(container.querySelector<HTMLButtonElement>('button')?.dataset.noticeSession).toBe(
      session.id
    )

    await act(async () => {
      listeners.sessionUpdated?.({
        session: { ...session, archivedAt: 2 },
        originClientId: 'web:external'
      })
    })

    expect(container.querySelector<HTMLButtonElement>('button')?.dataset.noticeSession).toBe('')
    expect(useNavigationStore.getState().view).toBe('home')
  })

  it('clears a stale notice when its project is archived', async () => {
    await act(async () => {
      listeners.projectCreated?.(project)
      listeners.sessionCreated?.({ session, originClientId: 'web:external' })
      listeners.projectUpdated?.({ ...project, archivedAt: 2 })
    })

    expect(container.querySelector<HTMLButtonElement>('button')?.dataset.noticeSession).toBe('')
  })

  it('removes a deleted session and clears its notice', async () => {
    await act(async () => {
      listeners.sessionCreated?.({ session, originClientId: 'web:external' })
      listeners.sessionDeleted?.({ projectId: project.id, sessionId: session.id })
    })

    expect(useSessionStore.getState().sessions).toEqual([])
    expect(container.querySelector<HTMLButtonElement>('button')?.dataset.noticeSession).toBe('')
  })

  it('upserts project updates', async () => {
    const updatedProject = { ...project, name: 'Updated project', updatedAt: 2 }

    await act(async () => {
      listeners.projectUpdated?.(updatedProject)
    })

    expect(useProjectStore.getState().projects).toEqual([updatedProject])
  })

  it('returns an open project to Home when another window archives it', async () => {
    await act(async () => {
      listeners.projectCreated?.(project)
      listeners.sessionCreated?.({ session, originClientId: 'web:external' })
    })
    await act(async () => container.querySelector<HTMLButtonElement>('button')?.click())
    await act(async () => {
      listeners.projectUpdated?.({ ...project, archivedAt: 2 })
    })

    expect(useNavigationStore.getState().view).toBe('home')
    expect(useSessionStore.getState().selectedSessionId).toBeUndefined()
  })

  it('clears a selected session when another window archives it', async () => {
    const removeSessionItems = vi.spyOn(usePreviewWorkbenchStore.getState(), 'removeSessionItems')
    await act(async () => {
      listeners.projectCreated?.(project)
      listeners.sessionCreated?.({ session, originClientId: 'web:external' })
    })
    await act(async () => container.querySelector<HTMLButtonElement>('button')?.click())
    await act(async () => {
      listeners.sessionUpdated?.({
        session: { ...session, archivedAt: 2 },
        originClientId: 'web:external'
      })
    })

    expect(useNavigationStore.getState().view).toBe('workspace')
    expect(useSessionStore.getState().selectedSessionId).toBeUndefined()
    expect(removeSessionItems).toHaveBeenCalledWith(session.id)
  })

  it('replays deletions after stale initial snapshots hydrate', async () => {
    await act(async () => {
      useProjectStore.setState(createInitialProjectState())
      useSessionStore.setState(createInitialSessionState())
      root.render(<Harness isSessionPersistenceHydrated={false} />)
    })
    await act(async () => {
      listeners.projectDeleted?.({ projectId: project.id, status: 'deleted' })
    })

    await act(async () => {
      useProjectStore.setState({
        ...createInitialProjectState(),
        projects: [project],
        isLoaded: true
      })
      useSessionStore.getState().hydrateSessions([session])
      root.render(<Harness />)
    })

    expect(useProjectStore.getState().projects).toEqual([])
    expect(useSessionStore.getState().sessions).toEqual([])
  })

  it('removes externally deleted data and returns an active project to Home', async () => {
    await act(async () => {
      listeners.projectCreated?.(project)
      listeners.sessionCreated?.({ session, originClientId: 'web:external' })
    })
    await act(async () => container.querySelector<HTMLButtonElement>('button')?.click())
    await act(async () => {
      listeners.projectDeleted?.({ projectId: project.id, status: 'deleted' })
    })

    expect(useProjectStore.getState().projects).toEqual([])
    expect(useSessionStore.getState().sessions).toEqual([])
    expect(useNavigationStore.getState().view).toBe('home')
  })

  it('removes another window committed deletion while tracking cleanup until terminal recovery', async () => {
    await act(async () => {
      listeners.projectCreated?.(project)
      listeners.sessionCreated?.({ session, originClientId: 'web:external' })
    })
    await act(async () => container.querySelector<HTMLButtonElement>('button')?.click())
    await act(async () => {
      listeners.projectDeleted?.({
        projectId: project.id,
        status: 'cleanup-pending'
      })
    })

    expect(useProjectStore.getState().projects).toEqual([])
    expect(useSessionStore.getState().sessions).toEqual([])
    expect(useProjectStore.getState().deletionCleanup).toEqual([
      {
        projectId: project.id,
        projectName: project.name,
        phase: 'running',
        failureCount: 0
      }
    ])
    expect(useNavigationStore.getState().view).toBe('home')

    await act(async () => {
      listeners.projectDeleted?.({
        projectId: project.id,
        status: 'deleted'
      })
    })

    expect(useProjectStore.getState().deletionCleanup).toEqual([])
  })

  it('refreshes sanitized cleanup status after a recovery lifecycle event', async () => {
    const cleanup = [
      {
        projectId: project.id,
        projectName: project.name,
        phase: 'retry-scheduled' as const,
        failureCount: 2,
        nextRetryAt: 6_000
      }
    ]
    vi.mocked(window.api.projects.listDeletionCleanup).mockResolvedValueOnce(cleanup)

    await act(async () => listeners.projectDeletionCleanupChanged?.())

    expect(useProjectStore.getState().deletionCleanup).toEqual(cleanup)
  })
})
