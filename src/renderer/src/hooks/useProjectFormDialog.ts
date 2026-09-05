import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { Project } from '../../../shared/projects'
import { useNavigationStore } from '@/stores/navigation-store'
import { useProjectStore } from '@/stores/project-store'

type ProjectFormState =
  { mode: 'create' } | { mode: 'edit'; projectId: string; expectedUpdatedAt: number }

// Structurally matches ProjectFormDialog's props; the dialog stays a controlled component.
type ProjectFormDialogProps = {
  open: boolean
  title: string
  description: string
  submitLabel: string
  nameDraft: string
  descriptionDraft: string
  agentContextDraft: string
  isSubmitting: boolean
  error: string | undefined
  errorDetail?: string
  onNameChange: (value: string) => void
  onDescriptionChange: (value: string) => void
  onAgentContextChange: (value: string) => void
  onCancel: () => void
  onConfirm: (event: React.FormEvent<HTMLFormElement>) => void
}

type UseProjectFormDialogResult = {
  openCreateDialog: () => void
  openEditDialog: (project: Project) => void
  dialogProps: ProjectFormDialogProps
}

// Owns the create/edit Project form state machine shared by the Home page and the Workspace sidebar
// project menu. Submissions go through the project store; a successful create navigates into the new
// project, matching the original HomePage behavior.
const useProjectFormDialog = (): UseProjectFormDialogResult => {
  const { t } = useTranslation()
  const createProject = useProjectStore((state) => state.createProject)
  const updateProject = useProjectStore((state) => state.updateProject)
  const openProject = useNavigationStore((state) => state.openProject)

  const [formState, setFormState] = useState<ProjectFormState | null>(null)
  const [nameDraft, setNameDraft] = useState('')
  const [descriptionDraft, setDescriptionDraft] = useState('')
  const [agentContextDraft, setAgentContextDraft] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [errorDetail, setErrorDetail] = useState<string>()
  const [formError, setFormError] = useState<string | undefined>(undefined)

  const openCreateDialog = useCallback((): void => {
    // A submission is in flight: ignore reopens so the pending mutation keeps its drafts.
    if (isSubmitting) return

    setFormState({ mode: 'create' })
    setNameDraft('')
    setDescriptionDraft('')
    setAgentContextDraft('')
    setFormError(undefined)
    setErrorDetail(undefined)
  }, [isSubmitting])

  const openEditDialog = useCallback(
    (project: Project): void => {
      // A submission is in flight: ignore reopens so the pending mutation keeps its drafts.
      if (isSubmitting) return

      setFormState({
        mode: 'edit',
        projectId: project.id,
        expectedUpdatedAt: project.updatedAt
      })
      setNameDraft(project.name)
      setDescriptionDraft(project.description)
      setAgentContextDraft(project.agentContext ?? '')
      setFormError(undefined)
      setErrorDetail(undefined)
    },
    [isSubmitting]
  )

  const closeFormDialog = (): void => {
    if (isSubmitting) return

    setFormState(null)
  }

  // Creates or renames a project. On create, navigate into the new (empty) workspace. Failures keep
  // the dialog open with an inline message instead of an unhandled rejection.
  const confirmForm = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()

    const name = nameDraft.trim()

    if (!formState || !name || isSubmitting) return

    const description = descriptionDraft.trim()
    const agentContext = agentContextDraft.trim()
    const isCreate = formState.mode === 'create'

    setIsSubmitting(true)
    setFormError(undefined)
    setErrorDetail(undefined)

    const request = isCreate
      ? createProject({ name, description, agentContext })
      : updateProject({
          id: formState.projectId,
          name,
          description,
          agentContext,
          expectedUpdatedAt: formState.expectedUpdatedAt
        })

    void request
      .then((project) => {
        // The store resolves undefined when the IPC layer returns no project row; surface that
        // instead of silently swallowing the save.
        if (!project) {
          setFormError(t('Could not save project. Please try again.'))
          return
        }

        setFormState(null)

        if (isCreate) openProject(project.id, 'user')
      })
      .catch((error: unknown) => {
        setErrorDetail(error instanceof Error ? error.message : String(error))
        setFormError(
          error instanceof Error && error.message === 'Project changed elsewhere.'
            ? t('Project changed elsewhere. Reopen Project Settings and try again.')
            : t('Could not save project. Please try again.')
        )
      })
      .finally(() => {
        setIsSubmitting(false)
      })
  }

  const isEdit = formState?.mode === 'edit'

  return {
    openCreateDialog,
    openEditDialog,
    dialogProps: {
      open: formState !== null,
      title: isEdit ? t('Project Settings') : t('New project'),
      description: isEdit
        ? t("Update this project's name, description, and agent context.")
        : t('Group related sessions under a project. You can rename it later.'),
      submitLabel: isSubmitting
        ? isEdit
          ? t('Saving…')
          : t('Creating…')
        : isEdit
          ? t('Save')
          : t('Create project'),
      nameDraft,
      descriptionDraft,
      agentContextDraft,
      isSubmitting,
      error: formError,
      errorDetail,
      onNameChange: setNameDraft,
      onDescriptionChange: setDescriptionDraft,
      onAgentContextChange: setAgentContextDraft,
      onCancel: closeFormDialog,
      onConfirm: confirmForm
    }
  }
}

export { useProjectFormDialog }
export type { ProjectFormState, UseProjectFormDialogResult }
