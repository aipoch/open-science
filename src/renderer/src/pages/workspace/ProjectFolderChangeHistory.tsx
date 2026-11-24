import { useProjectStore } from '@/stores/project-store'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import { errorDetail } from '@/lib/error-detail'
import type {
  ProjectFolderChange,
  ProjectFolderChangeScope
} from '../../../../shared/project-folder-changes'
import { ProjectFolderChangeReview } from './ProjectFolderChangeReview'

// Reload saved receipts when an approval settles or the app regains focus. No filesystem watcher or
// background scan: the Main service returns a bounded, session-owned history page.
const ProjectFolderChangeHistoryContent = ({
  scope,
  revision
}: {
  scope: ProjectFolderChangeScope
  revision: string
}): React.JSX.Element | null => {
  const { t } = useTranslation()
  const { projectId, sessionId } = scope
  const bound = useProjectStore((state) =>
    Boolean(state.projects.find((project) => project.id === projectId)?.rootPath)
  )
  const generation = useRef(0)
  const [changes, setChanges] = useState<ProjectFolderChange[]>([])
  const [nextId, setNextId] = useState<string>()
  const [error, setError] = useState<unknown>()
  const [busy, setBusy] = useState(false)
  const [refresh, setRefresh] = useState(0)
  useEffect(
    () =>
      window.api.notebook.onProjectFolderChangesChanged?.((event) => {
        if (event.projectId === projectId && event.sessionId === sessionId)
          setRefresh((value) => value + 1)
      }),
    [projectId, sessionId]
  )
  useEffect(() => {
    const focus = (): void => setRefresh((value) => value + 1)
    window.addEventListener('focus', focus)
    return () => window.removeEventListener('focus', focus)
  }, [])
  useEffect(() => {
    const currentGeneration = ++generation.current
    let active = true
    if (!bound)
      return () => {
        active = false
      }
    void window.api.notebook.listProjectFolderChanges({ projectId, sessionId, limit: 20 }).then(
      (page) => {
        if (!active || generation.current !== currentGeneration) return
        setBusy(false)
        setError(undefined)
        setChanges(page.changes)
        setNextId(page.nextId)
      },
      (reason) => {
        if (active) setError(reason)
      }
    )
    return () => {
      active = false
      generation.current += 1
    }
  }, [projectId, sessionId, revision, refresh, bound])
  const loadMore = async (): Promise<void> => {
    if (!nextId || busy) return
    const currentGeneration = generation.current
    setBusy(true)
    try {
      const page = await window.api.notebook.listProjectFolderChanges({
        ...scope,
        afterId: nextId,
        limit: 20
      })
      if (generation.current !== currentGeneration) return
      setChanges((current) => [...current, ...page.changes])
      setNextId(page.nextId)
    } catch (reason) {
      if (generation.current === currentGeneration) setError(reason)
    } finally {
      if (generation.current === currentGeneration) setBusy(false)
    }
  }
  const receipts = changes.filter(
    (change) => change.requiresConfirmation && change.state !== 'prepared'
  )
  if (!bound || (!receipts.length && !error && !nextId)) return null
  return (
    <details
      open
      className="my-3 rounded-lg border border-border p-3 text-sm"
      data-testid="project-folder-change-history"
    >
      <summary className="cursor-pointer font-medium">{t('Project file changes')}</summary>
      <div className="mt-3 space-y-4">
        {receipts.map((change) => (
          <ProjectFolderChangeReview key={change.id} change={change} receipt />
        ))}
        {nextId ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void loadMore()}
          >
            {t('Load more')}
          </Button>
        ) : null}
        {error ? (
          <ErrorNotice
            inline
            title={t('Could not load file change history')}
            content={errorDetail(error)}
            primaryButton={{
              label: t('Try again'),
              onClick: () => setRefresh((value) => value + 1)
            }}
          />
        ) : null}
      </div>
    </details>
  )
}

export const ProjectFolderChangeHistory = (props: {
  scope: ProjectFolderChangeScope
  revision: string
}): React.JSX.Element => (
  <ProjectFolderChangeHistoryContent
    key={`${props.scope.projectId}:${props.scope.sessionId}`}
    {...props}
  />
)
