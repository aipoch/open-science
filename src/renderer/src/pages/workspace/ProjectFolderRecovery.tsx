import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { FolderLock, FolderSearch } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { ProjectFolderValidationResult } from '../../../../shared/projects'
import { ErrorNotice } from '@/components/error-notice'
import { isDesktopRenderer } from '@/lib/interface-scale'
import { projectFolderAccessAvailable } from '@/lib/project-folder'
import { projectFolderFailure } from '@/lib/project-folder-error'
import { useReviewStore } from '@/stores/review-store'
import { useProjectStore } from '@/stores/project-store'

type Problem = Extract<ProjectFolderValidationResult, { ok: false }>

const folderProblem = (error: unknown): Problem => ({
  ok: false,
  ...(projectFolderFailure(error) ?? {
    kind: 'unavailable' as const,
    diagnostics: error instanceof Error ? error.message : String(error)
  })
})

export function ProjectFolderRecovery({
  projectId,
  sessionId,
  rootPath
}: {
  projectId: string
  sessionId?: string
  rootPath?: string
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const available = projectFolderAccessAvailable()
  const identity = JSON.stringify([projectId, rootPath])
  const [state, setState] = useState<{ identity: string; problem?: Problem; busy: boolean }>({
    identity,
    busy: false
  })
  const currentIdentity = useRef(identity)
  useLayoutEffect(() => {
    currentIdentity.current = identity
  }, [identity])
  const sequence = useRef(0)
  const busy = useRef(false)
  const retryRecoveredReviews = useCallback((): void => {
    if (sessionId) useReviewStore.getState().retryReviewsAfterFolderRecovery(sessionId, projectId)
  }, [projectId, sessionId])
  const refresh = useCallback(async (): Promise<void> => {
    if (!available || !rootPath || busy.current) return
    const generation = ++sequence.current
    busy.current = true
    await window.api.projects
      .checkFolder({ projectId })
      .then(
        (result) => {
          if (currentIdentity.current === identity && generation === sequence.current) {
            setState({ identity, busy: false, problem: result?.ok === false ? result : undefined })
            if (result?.ok === true) retryRecoveredReviews()
          }
        },
        (error) => {
          if (currentIdentity.current === identity && generation === sequence.current)
            setState({ identity, busy: false, problem: folderProblem(error) })
        }
      )
      .finally(() => {
        if (generation === sequence.current) busy.current = false
      })
  }, [available, identity, projectId, rootPath, retryRecoveredReviews])
  useEffect(() => {
    busy.current = false
    void refresh()
    const onFocus = (): void => {
      void refresh()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      sequence.current += 1
      window.removeEventListener('focus', onFocus)
    }
  }, [refresh])

  const locate = async (): Promise<void> => {
    if (!rootPath || !isDesktopRenderer() || busy.current) return
    busy.current = true
    const generation = ++sequence.current
    setState((previous) => ({ ...previous, busy: true }))
    try {
      const selected = await window.api.storage.pickDirectory()
      if (!selected || currentIdentity.current !== identity || sequence.current !== generation)
        return
      const project = await window.api.projects.locateFolder({
        projectId,
        path: selected,
        expectedRootPath: rootPath
      })
      useProjectStore.getState().upsertProject(project)
      retryRecoveredReviews()
      if (currentIdentity.current === identity && sequence.current === generation)
        setState({ identity, busy: false })
    } catch (error) {
      if (currentIdentity.current === identity && sequence.current === generation)
        setState({ identity, busy: false, problem: folderProblem(error) })
    } finally {
      if (sequence.current === generation) {
        busy.current = false
        setState((previous) =>
          previous.identity === identity ? { ...previous, busy: false } : previous
        )
      }
    }
  }

  const problem = state.identity === identity ? state.problem : undefined
  if (!available || !rootPath || !problem) return null
  const missing = problem.kind === 'not-found'
  const recordsUnavailable = problem.kind === 'records-unavailable'
  const desktop = isDesktopRenderer()
  const canLocate = missing && desktop
  const diagnostics =
    missing && !desktop
      ? [problem.diagnostics, t('Use the desktop app to locate this folder.')]
          .filter(Boolean)
          .join('\n')
      : problem.diagnostics
  const retryButton = { label: t('Retry'), onClick: () => void refresh(), loading: state.busy }
  return (
    <ErrorNotice
      role="alert"
      level="warning"
      icon={problem.kind === 'not-found' ? FolderSearch : FolderLock}
      title={
        problem.kind === 'not-found'
          ? t('Project folder not found')
          : recordsUnavailable
            ? t('Some research records could not be restored')
            : problem.kind === 'conflict'
              ? t('Project folder is already in use')
              : t('Unable to access project folder')
      }
      description={
        recordsUnavailable
          ? t(
              'You can keep using project files and conversations. Restore a valid copy of the research records, then retry.'
            )
          : undefined
      }
      errorCode={diagnostics}
      diagnosticsLabel={t('Details')}
      secondaryButton={canLocate ? retryButton : undefined}
      primaryButton={
        canLocate
          ? { label: t('Locate folder…'), onClick: () => void locate(), disabled: state.busy }
          : retryButton
      }
    />
  )
}
