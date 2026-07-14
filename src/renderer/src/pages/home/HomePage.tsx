import {
  Archive,
  Building2,
  Clock,
  MoreVertical,
  Pencil,
  Plus,
  Settings,
  Trash2
} from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { useMemo, useState } from 'react'

import { formatRelativeTime } from '@/lib/format-relative-time'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useNavigationStore } from '@/stores/navigation-store'
import type { ChatSession } from '@/stores/session-store'
import { useSessionStore } from '@/stores/session-store'
import { useProjectStore } from '@/stores/project-store'
import { useSettingsStore } from '@/stores/settings-store'
import { GitHubStarBadge } from '@/components/GitHubStarBadge'
import { UpdateCapsule } from '@/components/UpdateCapsule'
import { APP } from '../../../../shared/app-config'
import type { Project } from '../../../../shared/projects'

import { DeleteProjectDialog } from './DeleteProjectDialog'
import { ProjectFormDialog } from './ProjectFormDialog'

const RECENT_SESSION_LIMIT = 5

type ProjectSummary = {
  project: Project
  sessionCount: number
  lastActivityAt: number
}

type ProjectFormState = { mode: 'create' } | { mode: 'edit'; projectId: string }

// Returns the first user prompt as a one-line preview for a session row.
const getSessionPreview = (session: ChatSession): string =>
  session.messages
    .find((message) => message.role === 'user')
    ?.content.replace(/\s+/g, ' ')
    .trim() ?? ''

const sectionHeadingClassName =
  'mb-3 flex items-center gap-2 text-[17px] font-medium leading-6 text-text-000'

const listCardClassName = 'rounded-2xl border border-border-200/70 bg-bg-000 p-1.5 shadow-card'

const rowClassName =
  'group flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left transition-colors duration-150 ease-out hover:bg-bg-300'

const rowActionClassName =
  'shrink-0 rounded p-0.5 text-text-300 opacity-0 transition-[opacity,color,background-color] duration-150 ease-out hover:bg-bg-400 hover:text-text-000 focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100'

const menuContentClassName =
  'z-modal min-w-[9rem] rounded-xl border-[0.5px] border-border-200 bg-bg-000 p-1.5 shadow-menu'

const menuItemClassName =
  'flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-text-100 transition-colors duration-150 ease-out outline-none data-[highlighted]:bg-bg-200 data-[highlighted]:text-text-000'

const menuDangerItemClassName =
  'flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-danger-000 transition-colors duration-150 ease-out outline-none data-[highlighted]:bg-danger-900'

// Landing screen: pick a project or jump back into a recent session.
const HomePage = (): React.JSX.Element => {
  const projects = useProjectStore((state) => state.projects)
  const loadError = useProjectStore((state) => state.loadError)
  const createProject = useProjectStore((state) => state.createProject)
  const updateProject = useProjectStore((state) => state.updateProject)
  const deleteProject = useProjectStore((state) => state.deleteProject)
  const sessions = useSessionStore((state) => state.sessions)
  const openProject = useNavigationStore((state) => state.openProject)
  const openSession = useNavigationStore((state) => state.openSession)
  const openSettings = useSettingsStore((state) => state.openSettings)

  const [formState, setFormState] = useState<ProjectFormState | null>(null)
  const [nameDraft, setNameDraft] = useState('')
  const [descriptionDraft, setDescriptionDraft] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | undefined>(undefined)
  const [projectToDelete, setProjectToDelete] = useState<Project | undefined>(undefined)

  // Non-pending sessions only; pending ones have no durable project yet.
  const persistedSessions = useMemo(
    () => sessions.filter((session) => !session.isPending),
    [sessions]
  )

  // Per-project session counts and last activity, ordered by most recent activity.
  const projectSummaries = useMemo<ProjectSummary[]>(() => {
    const summaries = projects.map((project) => {
      const projectSessions = persistedSessions.filter(
        (session) => session.projectId === project.id
      )
      const lastActivityAt = projectSessions.reduce(
        (latest, session) => Math.max(latest, session.updatedAt),
        project.updatedAt
      )

      return { project, sessionCount: projectSessions.length, lastActivityAt }
    })

    return summaries.sort((left, right) => right.lastActivityAt - left.lastActivityAt)
  }, [persistedSessions, projects])

  const recentSessions = useMemo(
    () =>
      [...persistedSessions]
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, RECENT_SESSION_LIMIT),
    [persistedSessions]
  )

  const deleteTargetSessionCount = useMemo(
    () =>
      projectToDelete
        ? persistedSessions.filter((session) => session.projectId === projectToDelete.id).length
        : 0,
    [persistedSessions, projectToDelete]
  )

  const openCreateDialog = (): void => {
    setFormState({ mode: 'create' })
    setNameDraft('')
    setDescriptionDraft('')
    setFormError(undefined)
  }

  const openEditDialog = (project: Project): void => {
    setFormState({ mode: 'edit', projectId: project.id })
    setNameDraft(project.name)
    setDescriptionDraft(project.description)
    setFormError(undefined)
  }

  const closeFormDialog = (): void => {
    if (isSubmitting) return

    setFormState(null)
  }

  // Creates or renames a project. On create, navigate into the new (empty) workspace. Failures keep the
  // dialog open with an inline message instead of an unhandled rejection.
  const confirmForm = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()

    const name = nameDraft.trim()

    if (!formState || !name || isSubmitting) return

    const description = descriptionDraft.trim()
    const isCreate = formState.mode === 'create'

    setIsSubmitting(true)
    setFormError(undefined)

    const request = isCreate
      ? createProject({ name, description })
      : updateProject({ id: formState.projectId, name, description })

    void request
      .then((project) => {
        if (!project) return

        setFormState(null)

        if (isCreate) openProject(project.id)
      })
      .catch((error: unknown) => {
        setFormError(error instanceof Error ? error.message : 'Could not save project.')
      })
      .finally(() => {
        setIsSubmitting(false)
      })
  }

  // Deletes the project, then cascades its sessions: memory is cleared (the persistence bridge removes
  // each session file) and the now-empty project directory is removed on disk. Artifacts are kept.
  const confirmDeleteProject = (): void => {
    if (!projectToDelete) return

    const projectId = projectToDelete.id

    setProjectToDelete(undefined)

    void deleteProject(projectId)
      .then(() => {
        useSessionStore.getState().removeSessionsForProject(projectId)
        void window.api.sessions.deleteProjectSessions({ projectId })
        void window.api.preview.delete({ projectId })
      })
      .catch(() => {
        // Deletion failed in the DB; leave the project (and its sessions) untouched.
      })
  }

  const formTitle = formState?.mode === 'edit' ? 'Edit project' : 'New project'
  const formDescription =
    formState?.mode === 'edit'
      ? 'Rename this project or update its description.'
      : 'Group related sessions under a project. You can rename it later.'
  const formSubmitLabel = formState?.mode === 'edit' ? 'Save changes' : 'Create project'

  return (
    <main className="min-h-svh bg-bg-10 text-text-000">
      <div className="mx-auto max-w-[1080px] px-8 py-7 pb-16">
        <header className="flex items-center justify-between">
          <div>
            <a
              href={APP.links.website}
              target="_blank"
              rel="noreferrer"
              className="font-serif text-[26px] font-medium leading-none tracking-[-0.02em] text-text-000 transition-colors duration-150 ease-out hover:text-text-100"
            >
              Open Science
            </a>
            <div className="mt-1 text-[11px] text-text-100">Beta</div>
          </div>
          <div className="flex items-center gap-2">
            <UpdateCapsule />
            <GitHubStarBadge />
            <button
              type="button"
              aria-label="Model settings"
              onClick={openSettings}
              className="inline-flex size-9 items-center justify-center rounded-lg text-text-300 transition-colors duration-150 ease-out hover:bg-bg-300 hover:text-text-000"
            >
              <Settings className="size-4" strokeWidth={2} aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="Account"
              className="inline-flex size-9 items-center justify-center rounded-lg text-text-300 transition-colors duration-150 ease-out hover:bg-bg-300 hover:text-text-000"
            >
              <Building2 className="size-4" strokeWidth={2} aria-hidden="true" />
            </button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1 rounded-md px-3 text-xs"
              onClick={openCreateDialog}
            >
              <Plus className="size-3.5" strokeWidth={2} aria-hidden="true" />
              New project
            </Button>
          </div>
        </header>

        <div className="mt-10 grid grid-cols-1 gap-8 lg:grid-cols-2">
          <section aria-label="Projects">
            <h2 className={sectionHeadingClassName}>
              <Archive className="size-4 text-text-100" strokeWidth={2} aria-hidden="true" />
              Projects
            </h2>
            {loadError ? (
              <div
                className="rounded-2xl border border-danger-000/30 px-4 py-6 text-center text-sm text-danger-000"
                role="alert"
              >
                Could not load projects: {loadError}
              </div>
            ) : projectSummaries.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border-200/70 px-4 py-10 text-center text-sm text-text-100">
                No projects yet. Create one to get started.
              </div>
            ) : (
              <div className={listCardClassName}>
                {projectSummaries.map(({ project, sessionCount, lastActivityAt }) => (
                  <div
                    key={project.id}
                    className={rowClassName}
                    title={project.description || project.name}
                  >
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
                      onClick={() => openProject(project.id)}
                    >
                      <span className="truncate font-semibold text-text-000">{project.name}</span>
                      {project.isExample ? (
                        <span className="shrink-0 rounded bg-bg-300 px-1.5 py-0.5 text-[10px] font-medium text-text-100">
                          Example
                        </span>
                      ) : null}
                    </button>
                    <span className="shrink-0 text-xs text-text-100">
                      {sessionCount} {sessionCount === 1 ? 'session' : 'sessions'}
                    </span>
                    <span className="w-8 shrink-0 text-right text-xs text-text-300">
                      {formatRelativeTime(lastActivityAt)}
                    </span>
                    <DropdownMenu.Root>
                      <DropdownMenu.Trigger asChild>
                        <button
                          type="button"
                          className={rowActionClassName}
                          aria-label={`Open actions for ${project.name}`}
                        >
                          <MoreVertical className="size-3.5" strokeWidth={2} aria-hidden="true" />
                        </button>
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Portal>
                        <DropdownMenu.Content
                          aria-label="Project actions"
                          className={menuContentClassName}
                          align="end"
                          sideOffset={6}
                        >
                          <DropdownMenu.Item
                            className={menuItemClassName}
                            onSelect={() => openEditDialog(project)}
                          >
                            <Pencil className="size-4" strokeWidth={2} aria-hidden="true" />
                            Rename…
                          </DropdownMenu.Item>
                          <DropdownMenu.Separator className="mx-1 my-1 h-px bg-border-300" />
                          <DropdownMenu.Item
                            className={menuDangerItemClassName}
                            onSelect={() => setProjectToDelete(project)}
                          >
                            <Trash2 className="size-4" strokeWidth={2} aria-hidden="true" />
                            Delete
                          </DropdownMenu.Item>
                        </DropdownMenu.Content>
                      </DropdownMenu.Portal>
                    </DropdownMenu.Root>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section aria-label="Recent sessions">
            <h2 className={sectionHeadingClassName}>
              <Clock className="size-4 text-text-100" strokeWidth={2} aria-hidden="true" />
              Recent sessions
            </h2>
            {recentSessions.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border-200/70 px-4 py-10 text-center text-sm text-text-100">
                Sessions you start will appear here.
              </div>
            ) : (
              <div className={listCardClassName}>
                {recentSessions.map((session) => {
                  const preview = getSessionPreview(session)

                  return (
                    <button
                      key={session.id}
                      type="button"
                      className={cn(rowClassName, 'cursor-pointer items-start')}
                      onClick={() => openSession(session.projectId, session.id)}
                      title={session.title}
                    >
                      <span
                        className="mt-1 inline-flex size-3 shrink-0 items-center justify-center"
                        aria-hidden="true"
                      >
                        <span className="size-[7px] rounded-full border border-text-100" />
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="truncate text-sm font-medium text-text-000">
                          {session.title}
                        </span>
                        {preview ? (
                          <span className="truncate text-xs text-text-100">{preview}</span>
                        ) : null}
                      </span>
                      <span className="shrink-0 text-xs text-text-300">
                        {formatRelativeTime(session.updatedAt)}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </section>
        </div>
      </div>

      <ProjectFormDialog
        open={formState !== null}
        title={formTitle}
        description={formDescription}
        submitLabel={formSubmitLabel}
        nameDraft={nameDraft}
        descriptionDraft={descriptionDraft}
        isSubmitting={isSubmitting}
        error={formError}
        onNameChange={setNameDraft}
        onDescriptionChange={setDescriptionDraft}
        onCancel={closeFormDialog}
        onConfirm={confirmForm}
      />

      <DeleteProjectDialog
        project={projectToDelete}
        sessionCount={deleteTargetSessionCount}
        onCancel={() => setProjectToDelete(undefined)}
        onConfirmDelete={confirmDeleteProject}
      />
    </main>
  )
}

export { HomePage }
