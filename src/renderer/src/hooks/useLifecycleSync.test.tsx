// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  MAIN_PERMISSION_WAIT_LIFECYCLE_CLIENT_ID,
  type ProjectDeletedEvent,
  type SessionDeletedEvent,
  type SessionUpsertEvent
} from '../../../shared/lifecycle-events'
import type { Project } from '../../../shared/projects'
import { getActiveConversationContext } from '../../../shared/conversation-graph'
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
        onDeleted: subscribe<ProjectDeletedEvent>('projectDeleted')
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

    await act(async () => {
      listeners.sessionUpdated?.({
        originClientId: MAIN_PERMISSION_WAIT_LIFECYCLE_CLIENT_ID,
        session: {
          ...durableBeforeOutput,
          status: 'waiting-permission',
          updatedAt: durableBeforeOutput.updatedAt + 1,
          runtimeContext: {
            version: 1,
            revision: 1,
            permission: {
              state: 'pending',
              request: {
                requestId: 'permission-1',
                sessionId: session.id,
                toolCallId: 'tool-1',
                title: 'Run npm test',
                options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }]
              },
              originatingPromptMessageId: prompt!.messageId,
              fingerprint: 'a'.repeat(64),
              createdAt: 1
            }
          }
        }
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
    expect(useSessionStore.getState().sessions[0]?.archivedAt).toBeUndefined()
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
      listeners.projectDeleted?.({ projectId: project.id })
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
      listeners.projectDeleted?.({ projectId: project.id })
    })

    expect(useProjectStore.getState().projects).toEqual([])
    expect(useSessionStore.getState().sessions).toEqual([])
    expect(useNavigationStore.getState().view).toBe('home')
  })
})
