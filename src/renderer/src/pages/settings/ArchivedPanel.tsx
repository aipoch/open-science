import { Archive, RotateCcw, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { ProjectDeletionCleanupNotice } from '@/components/ProjectDeletionCleanupNotice'
import { SessionCatalogRecoveryAlert } from '@/components/SessionCatalogRecoveryAlert'
import type { SessionCatalogRecovery } from '@/lib/session-persistence/session-persistence'
import { DeleteProjectDialog } from '@/pages/home/DeleteProjectDialog'
import { useDateTimeFormat } from '@/hooks/useDateTimeFormat'
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
  catalogRecovery?: SessionCatalogRecovery
  hasCompleteSessionCatalog?: boolean
  canDeleteProjects?: boolean
  onRetryCatalogRecovery?: () => void
}

const describeError = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback

// Archive recovery stays in Settings so active workspace surfaces only need to reason about active data.
const ArchivedPanel = ({
  view,
  onNavigate,
  catalogRecovery = { kind: 'ready' },
  hasCompleteSessionCatalog = true,
  canDeleteProjects = true,
  onRetryCatalogRecovery
}: ArchivedPanelProps): React.JSX.Element => {
  const { t } = useTranslation()
  const formatDate = useDateTimeFormat()
  const projects = useProjectStore((state) => state.projects)
  const updateProjectArchive = useProjectStore((state) => state.updateProjectArchive)
  const deleteProject = useProjectStore((state) => state.deleteProject)
  const sessions = useSessionStore((state) => state.sessions)
  const updateSessionArchive = useSessionStore((state) => state.updateSessionArchive)
  const [projectToDelete, setProjectToDelete] = useState<Project | undefined>()
  const [sessionToDelete, setSessionToDelete] = useState<ChatSession | undefined>()
  const [busyKeys, setBusyKeys] = useState<Set<string>>(() => new Set())
  const [panelError, setPanelError] = useState<string | undefined>()
  const [projectDeleteError, setProjectDeleteError] = useState<string | undefined>()
  const [sessionDeleteError, setSessionDeleteError] = useState<
    'runtime' | 'persistence' | undefined
  >()

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

  const beginOperation = (key: string): void => setBusyKeys((current) => new Set(current).add(key))
  const finishOperation = (key: string): void =>
    setBusyKeys((current) => {
      const next = new Set(current)
      next.delete(key)
      return next
    })

  const restoreProject = (project: Project): void => {
    if (project.archivedAt === undefined) return
    const key = `project:${project.id}`
    if (busyKeys.has(key)) return
    beginOperation(key)
    setPanelError(undefined)
    void updateProjectArchive({
      id: project.id,
      archived: false,
      expectedArchivedAt: project.archivedAt
    })
      .then(() => onNavigate({ kind: 'list' }))
      .catch((restoreError: unknown) =>
        setPanelError(describeError(restoreError, t('Could not restore project.')))
      )
      .finally(() => finishOperation(key))
  }

  const restoreSession = (session: ChatSession): void => {
    if (session.archivedAt === undefined) return
    const key = `session:${session.id}`
    if (busyKeys.has(key)) return
    beginOperation(key)
    setPanelError(undefined)
    void updateSessionArchive({
      projectId: session.projectId,
      sessionId: session.id,
      archived: false,
      expectedArchivedAt: session.archivedAt
    })
      .catch((restoreError: unknown) =>
        setPanelError(describeError(restoreError, t('Could not restore session.')))
      )
      .finally(() => finishOperation(key))
  }

  const deleteArchivedSession = (): void => {
    const session = sessionToDelete
    const key = `session:${session?.id}`
    if (!session || !canDeleteProjects || busyKeys.has(key)) return

    beginOperation(key)
    setPanelError(undefined)
    setSessionDeleteError(undefined)
    void window.api.sessions
      .deleteSession({
        projectId: session.projectId,
        sessionId: session.id
      })
      .then((result) => {
        if (result.status === 'failed') {
          setSessionDeleteError(result.reason)
          return
        }
        if (result.cleanupPending)
          setPanelError(t('The Session was deleted, but some cleanup could not be completed.'))
        useArchiveUndoStore.getState().dismissSession(session.id)
        setSessionToDelete(undefined)
      })
      .catch((deleteError: unknown) =>
        setPanelError(describeError(deleteError, t('Could not delete session.')))
      )
      .finally(() => finishOperation(key))
  }

  const openProjectDeleteDialog = (project: Project): void => {
    if (!canDeleteProjects) return
    setProjectDeleteError(undefined)
    setProjectToDelete(project)
  }

  const closeProjectDeleteDialog = (): void => {
    if (busyKeys.has(`project:${projectToDelete?.id}`)) return

    setProjectToDelete(undefined)
    setProjectDeleteError(undefined)
  }

  const deleteArchivedProject = (): void => {
    const project = projectToDelete
    if (!project || !canDeleteProjects) return

    const key = `project:${project.id}`
    if (busyKeys.has(key)) return
    beginOperation(key)
    setProjectDeleteError(undefined)
    void (async () => {
      await deleteProject(project.id)
      useSessionStore.getState().removeSessionsForProject(project.id)
      useArchiveUndoStore.getState().dismissProject(project.id)
      setProjectToDelete(undefined)
    })()
      .then(() => onNavigate({ kind: 'list' }))
      .catch((deleteError: unknown) => {
        console.warn('Project deletion failed', deleteError)
        setProjectDeleteError(t('Could not delete project.'))
      })
      .finally(() => finishOperation(key))
  }

  const sessionRow = (session: ChatSession, projectArchived: boolean): React.JSX.Element => (
    <div key={session.id} className="flex items-center gap-3 rounded-lg border border-border p-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{session.title}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {session.archivedAt === undefined
            ? t('Hidden because its project is archived.')
            : t('Archived {{when}}', { when: formatDate(session.archivedAt, 'dateTime') })}
        </p>
      </div>
      {session.archivedAt !== undefined ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={projectArchived || busyKeys.has(`session:${session.id}`)}
          title={projectArchived ? t('Restore the project first.') : undefined}
          onClick={() => restoreSession(session)}
        >
          <RotateCcw className="size-3.5" aria-hidden="true" />
          {t('Restore')}
        </Button>
      ) : null}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="text-danger-000 hover:text-danger-000"
        disabled={!canDeleteProjects || busyKeys.has(`session:${session.id}`)}
        title={
          canDeleteProjects ? undefined : t('Retry project recovery before deleting projects.')
        }
        onClick={() => {
          setPanelError(undefined)
          setSessionDeleteError(undefined)
          setSessionToDelete(session)
        }}
      >
        <Trash2 className="size-3.5" aria-hidden="true" />
        {t('Delete')}
      </Button>
    </div>
  )

  return (
    <div className="space-y-5 p-5">
      <SessionCatalogRecoveryAlert
        recovery={catalogRecovery}
        inline
        onRetry={onRetryCatalogRecovery}
        onOpenRecoveryFolder={window.api.sessions.openRecoveryFolder}
      />
      {panelError ? (
        <p role="alert" className="text-sm text-danger-000">
          {panelError}
        </p>
      ) : null}
      <ProjectDeletionCleanupNotice />
      {selectedProject ? (
        <>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="truncate text-base font-semibold text-foreground">
                {selectedProject.name}
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {t('Archived {{when}}', {
                  when: formatDate(selectedProject.archivedAt!, 'dateTime')
                })}
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busyKeys.has(`project:${selectedProject.id}`)}
                onClick={() => restoreProject(selectedProject)}
              >
                <RotateCcw className="size-3.5" aria-hidden="true" />
                {t('Restore project')}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="text-danger-000 hover:text-danger-000"
                disabled={!canDeleteProjects || busyKeys.has(`project:${selectedProject.id}`)}
                title={
                  canDeleteProjects
                    ? undefined
                    : t('Retry project recovery before deleting projects.')
                }
                onClick={() => openProjectDeleteDialog(selectedProject)}
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
                {t('Delete project')}
              </Button>
            </div>
          </div>
          <section className="space-y-2">
            <h4 className="text-sm font-medium text-foreground">{t('Sessions')}</h4>
            {selectedProjectSessions.length > 0 ? (
              selectedProjectSessions.map((session) => sessionRow(session, true))
            ) : (
              <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
                {t('This project has no saved sessions.')}
              </p>
            )}
          </section>
        </>
      ) : (
        <>
          <div>
            <h3 className="text-base font-semibold text-foreground">{t('Archived')}</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('Restore archived work here, or permanently delete it after confirming.')}
            </p>
          </div>
          <section className="space-y-2">
            <h4 className="text-sm font-medium text-foreground">{t('Projects')}</h4>
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
                      {t('Archived {{when}}', {
                        when: formatDate(project.archivedAt!, 'dateTime')
                      })}
                    </span>
                  </span>
                  <span className="text-xs text-muted-foreground">{t('Manage')}</span>
                </button>
              ))
            ) : (
              <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
                {t('No archived projects.')}
              </p>
            )}
          </section>
          <section className="space-y-2">
            <h4 className="text-sm font-medium text-foreground">{t('Sessions')}</h4>
            {individuallyArchivedSessions.length > 0 ? (
              individuallyArchivedSessions.map((session) => sessionRow(session, false))
            ) : (
              <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
                {t('No individually archived sessions.')}
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
        hasCompleteSessionCatalog={hasCompleteSessionCatalog}
        canDelete={canDeleteProjects}
        isDeleting={busyKeys.has(`project:${projectToDelete?.id}`)}
        error={projectDeleteError}
        onCancel={closeProjectDeleteDialog}
        onConfirmDelete={deleteArchivedProject}
      />
      <DeleteSessionDialog
        session={sessionToDelete}
        canDelete={canDeleteProjects}
        isDeleting={busyKeys.has(`session:${sessionToDelete?.id}`)}
        error={sessionDeleteError}
        onCancel={() => {
          setSessionToDelete(undefined)
          setSessionDeleteError(undefined)
        }}
        onConfirmDelete={deleteArchivedSession}
      />
    </div>
  )
}

export { ArchivedPanel }
