import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { useNavigationStore } from '@/stores/navigation-store'
import { useSessionStore } from '@/stores/session-store'
import { useResearchWorkspaceStore } from '@/stores/research-workspace-store'
import { useProjectStore } from '@/stores/project-store'
import type { PreviewToolItem } from '@/stores/preview-workbench-store'

/** The target belongs to the viewer, not to the selected conversation. Keep that distinction
 * visible while the user discusses one Session and reads another Session's evidence. */
export const ReplaySourceBar = ({
  item,
  variant = 'bar'
}: {
  item: PreviewToolItem
  variant?: 'bar' | 'details'
}): React.JSX.Element => {
  const { t } = useTranslation()
  const target = item.replayRecordingTarget ??
    item.replayRunTarget ?? {
      projectId: item.replaySourceProjectId ?? item.projectId,
      sessionId: item.replaySourceSessionId ?? item.sessionId
    }
  const source = useSessionStore((state) =>
    state.sessions.find(
      (session) => session.projectId === target.projectId && session.id === target.sessionId
    )
  )
  const sourceProject = useProjectStore((state) =>
    state.projects.find((project) => project.id === target.projectId)
  )
  const current = useSessionStore((state) =>
    state.sessions.find((session) => session.id === state.selectedSessionId)
  )
  const projectId = useNavigationStore((state) => state.activeProjectId)
  const draft = useResearchWorkspaceStore((state) => state.draftResearchByProject[projectId ?? ''])
  const membership = current?.researchMembership ?? (!current ? draft : undefined)
  const own = current?.projectId === target.projectId && current?.id === target.sessionId
  const referenced =
    membership?.sourceProjectId === target.projectId &&
    membership?.sourceSessionId === target.sessionId &&
    membership?.sourceImportId ===
      (source?.packageOrigin?.importId ?? source?.importedResearch?.importId)
  const available = Boolean(
    sourceProject &&
    sourceProject.archivedAt === undefined &&
    source &&
    source.archivedAt === undefined &&
    !source.isPending
  )

  return (
    <div
      data-testid="replay-source-bar"
      className={
        variant === 'details'
          ? 'w-full min-w-0 border-t border-border pt-3 text-xs'
          : 'shrink-0 border-b border-border-200 bg-bg-000 px-3 py-2 text-xs'
      }
    >
      <div
        className={
          variant === 'details'
            ? 'flex min-w-0 flex-wrap items-center gap-2'
            : 'flex min-w-0 items-center gap-2'
        }
      >
        {variant === 'bar' ? (
          <span className="shrink-0 font-medium text-text-100">
            {item.replayRecordingTarget
              ? t('Saved run recording')
              : item.replayRunTarget
                ? t('Run observation')
                : t('Research materials')}
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-text-200" title={source?.title ?? item.title}>
          {t('Source: {{title}}', { title: source?.title ?? item.title })}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 shrink-0 px-1 text-xs"
          disabled={!available}
          onClick={() => {
            if (available && target.projectId)
              useNavigationStore.getState().openSession(target.projectId, target.sessionId, 'user')
          }}
        >
          {t('Open source record')}
        </Button>
      </div>
      <p className="mt-1 break-words text-text-300">
        {own
          ? t('From this conversation')
          : referenced
            ? t('Research referenced by this discussion')
            : t('Reference from another conversation')}
        {!available ? ` · ${t('Source information is unavailable.')}` : ''}
      </p>
    </div>
  )
}
