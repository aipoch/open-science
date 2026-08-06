import { Archive, RotateCcw, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { DeleteProjectDialog } from '@/pages/home/DeleteProjectDialog'
import { DeleteSessionDialog } from '@/pages/workspace/DeleteSessionDialog'
import { useArchiveUndoStore } from '@/stores/archive-undo-store'
import { useProjectStore } from '@/stores/project-store'
import type { ChatSession } from '@/stores/session-store'
import { useSessionStore } from '@/stores/session-store'
import type { Project } from '../../../../shared/projects'

export type ArchivedView = { kind: 'list' } | { kind: 'project'; projectId: string }

type ArchivedPanelProps = {
  view: ArchivedView
  onNavigate: (view: ArchivedView) => void
}

const formatArchivedAt = (archivedAt: number): string =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(archivedAt)

const describeError = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback

// Archive recovery stays in Settings so active workspace surfaces only need to reason about active data.
const ArchivedPanel = ({ view, onNavigate }: ArchivedPanelProps): React.JSX.Element => {
  const projects = useProjectStore((state) => state.projects)
  const updateProjectArchive = useProjectStore((state) => state.updateProjectArchive)
  const deleteProject = useProjectStore((state) => state.deleteProject)
  const sessions = useSessionStore((state) => state.sessions)
  const updateSessionArchive = useSessionStore((state) => state.updateSessionArchive)
  const [projectToDelete, setProjectToDelete] = useState<Project | undefined>()
  const [sessionToDelete, setSessionToDelete] = useState<ChatSession | undefined>()
  const [busyKey, setBusyKey] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()

  const archivedProjects = useMemo(
    () => projects.filter((project) => project.archivedAt !== undefined),
    [projects]
  )
  const selectedProject =
    view.kind === 'project'
      ? archivedProjects.find((project) => project.id === view.projectId)
      : undefined
  const selectedProjectSessions = useMemo(
    () => sessions.filter((session) => session.projectId === selectedProject?.id),
    [selectedProject?.id, sessions]
  )
  const individuallyArchivedSessions = useMemo(
    () =>
      sessions.filter(
        (session) =>
          session.archivedAt !== undefined &&
          projects.some(
            (project) => project.id === session.projectId && project.archivedAt === undefined
          )
      ),
    [projects, sessions]
  )

  const restoreProject = (project: Project): void => {
    if (project.archivedAt === undefined) return
    setBusyKey(`project:${project.id}`)
    setError(undefined)
    void updateProjectArchive({
      id: project.id,
      archived: false,
      expectedArchivedAt: project.archivedAt
    })
      .then(() => onNavigate({ kind: 'list' }))
      .catch((restoreError: unknown) =>
        setError(describeError(restoreError, 'Could not restore project.'))
      )
      .finally(() => setBusyKey(undefined))
  }

  const restoreSession = (session: ChatSession): void => {
    if (session.archivedAt === undefined) return
    setBusyKey(`session:${session.id}`)
    setError(undefined)
    void updateSessionArchive({
      projectId: session.projectId,
      sessionId: session.id,
      archived: false,
      expectedArchivedAt: session.archivedAt
    })
      .catch((restoreError: unknown) =>
        setError(describeError(restoreError, 'Could not restore session.'))
      )
      .finally(() => setBusyKey(undefined))
  }

  const deleteArchivedSession = (): void => {
    const session = sessionToDelete
    if (!session) return

    setBusyKey(`session:${session.id}`)
    setError(undefined)
    void (async () => {
      const state = await window.api.acp.getState()
      if (state.sessionIds.includes(session.id)) {
        await window.api.acp.deleteSession({ sessionId: session.id })
      }
      await window.api.sessions.deleteSession({
        projectId: session.projectId,
        sessionId: session.id
      })
      useSessionStore.getState().deleteSession(session.id)
      useArchiveUndoStore.getState().dismissSession(session.id)
      setSessionToDelete(undefined)
    })()
      .catch((deleteError: unknown) =>
        setError(describeError(deleteError, 'Could not delete session.'))
      )
      .finally(() => setBusyKey(undefined))
  }

  const deleteArchivedProject = (): void => {
    const project = projectToDelete
    if (!project) return

    setBusyKey(`project:${project.id}`)
    setError(undefined)
    void (async () => {
      const state = await window.api.acp.getState()
      const liveIds = new Set(state.sessionIds)
      for (const session of sessions) {
        if (session.projectId === project.id && liveIds.has(session.id)) {
          await window.api.acp.deleteSession({ sessionId: session.id })
        }
      }
      await deleteProject(project.id)
      useSessionStore.getState().removeSessionsForProject(project.id)
      useArchiveUndoStore.getState().dismissProject(project.id)
      setProjectToDelete(undefined)
    })()
      .then(() => onNavigate({ kind: 'list' }))
      .catch((deleteError: unknown) =>
        setError(describeError(deleteError, 'Could not delete project.'))
      )
      .finally(() => setBusyKey(undefined))
  }

  const sessionRow = (session: ChatSession, projectArchived: boolean): React.JSX.Element => (
    <div key={session.id} className="flex items-center gap-3 rounded-lg border border-border p-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{session.title}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {session.archivedAt === undefined
            ? 'Hidden because its project is archived.'
            : `Archived ${formatArchivedAt(session.archivedAt)}`}
        </p>
      </div>
      {session.archivedAt !== undefined ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={projectArchived || busyKey === `session:${session.id}`}
          title={projectArchived ? 'Restore the project first.' : undefined}
          onClick={() => restoreSession(session)}
        >
          <RotateCcw className="size-3.5" aria-hidden="true" />
          Restore
        </Button>
      ) : null}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="text-danger-000 hover:text-danger-000"
        disabled={busyKey === `session:${session.id}`}
        onClick={() => setSessionToDelete(session)}
      >
        <Trash2 className="size-3.5" aria-hidden="true" />
        Delete
      </Button>
    </div>
  )

  return (
    <div className="space-y-5 p-5">
      {error ? (
        <p role="alert" className="text-sm text-danger-000">
          {error}
        </p>
      ) : null}
      {selectedProject ? (
        <>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="truncate text-base font-semibold text-foreground">
                {selectedProject.name}
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Archived {formatArchivedAt(selectedProject.archivedAt!)}
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busyKey === `project:${selectedProject.id}`}
                onClick={() => restoreProject(selectedProject)}
              >
                <RotateCcw className="size-3.5" aria-hidden="true" />
                Restore project
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="text-danger-000 hover:text-danger-000"
                disabled={busyKey === `project:${selectedProject.id}`}
                onClick={() => setProjectToDelete(selectedProject)}
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
                Delete project
              </Button>
            </div>
          </div>
          <section className="space-y-2">
            <h4 className="text-sm font-medium text-foreground">Sessions</h4>
            {selectedProjectSessions.length > 0 ? (
              selectedProjectSessions.map((session) => sessionRow(session, true))
            ) : (
              <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
                This project has no saved sessions.
              </p>
            )}
          </section>
        </>
      ) : (
        <>
          <div>
            <h3 className="text-base font-semibold text-foreground">Archived</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Restore archived work here, or permanently delete it after confirming.
            </p>
          </div>
          <section className="space-y-2">
            <h4 className="text-sm font-medium text-foreground">Projects</h4>
            {archivedProjects.length > 0 ? (
              archivedProjects.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  className="flex w-full items-center gap-3 rounded-lg border border-border p-3 text-left transition-colors hover:bg-muted"
                  onClick={() => onNavigate({ kind: 'project', projectId: project.id })}
                >
                  <Archive className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">
                      {project.name}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      Archived {formatArchivedAt(project.archivedAt!)}
                    </span>
                  </span>
                  <span className="text-xs text-muted-foreground">Manage</span>
                </button>
              ))
            ) : (
              <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
                No archived projects.
              </p>
            )}
          </section>
          <section className="space-y-2">
            <h4 className="text-sm font-medium text-foreground">Sessions</h4>
            {individuallyArchivedSessions.length > 0 ? (
              individuallyArchivedSessions.map((session) => sessionRow(session, false))
            ) : (
              <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
                No individually archived sessions.
              </p>
            )}
          </section>
        </>
      )}

      <DeleteProjectDialog
        project={projectToDelete}
        sessionCount={
          sessions.filter((session) => session.projectId === projectToDelete?.id).length
        }
        hasCompleteSessionCatalog
        canDelete
        isDeleting={busyKey === `project:${projectToDelete?.id}`}
        error={error}
        onCancel={() => setProjectToDelete(undefined)}
        onConfirmDelete={deleteArchivedProject}
      />
      <DeleteSessionDialog
        session={sessionToDelete}
        canDelete
        onCancel={() => setSessionToDelete(undefined)}
        onConfirmDelete={deleteArchivedSession}
      />
    </div>
  )
}

export { ArchivedPanel }
