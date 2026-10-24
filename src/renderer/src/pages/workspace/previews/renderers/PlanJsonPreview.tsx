import { WEB_CALLER_LOCATION_ATTRIBUTE } from '../../../../../../shared/web-caller-location'
import { lazy, Suspense, useMemo, useState } from 'react'
import { Code2, ListChecks } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { useSessionStore } from '@/stores/session-store'

import { PlanDocumentBody, PlanNoticeBanner } from '../../session-plan/SessionPlanSurfaces'
import {
  resolvePlanFileProjection,
  snapshotPlanProjection
} from '../../session-plan/plan-file-projection'
import { parsePlanDocumentFromPreviewContent } from '../../session-plan/plan-document-sniff'

import type { PreviewFileRendererProps } from '../preview-types'
import { createPreviewResourceKey } from '../preview-resource-key'
import { usePreviewFileContent } from '../usePreviewFileContent'
import { JsonPreviewBody } from './JsonPreview'

import {
  isRecordedObservationContent,
  isProjectRecordingContent,
  isBrowserRecordingContent,
  recordedObservationTargetForFile
} from '../../replay/recorded-file-entry'
import { useRunObservationQuestionStore } from '@/stores/run-observation-question-store'
import { useObservationQuestionRecovery } from '../../replay/use-observation-question-recovery'
const RunObservationPreview = lazy(() =>
  import('../../RunObservationPreview').then((module) => ({
    default: module.RunObservationPreview
  }))
)

type PlanViewMode = 'plan' | 'raw'

// A saved Session Plan artifact is a plain JSON file on disk. This renderer sniffs the previewed
// content and, when it parses as a Plan document, shows the Plan document view instead of raw JSON:
// live step status when the Session's stored projection matches the previewed Artifact Version, a
// read-only snapshot otherwise. Ordinary JSON files never leave the raw view, so the switch row and
// banners below only exist once a Plan document has been recognized.
export const PlanJsonPreview = ({
  item,
  readOnly
}: PreviewFileRendererProps): React.JSX.Element => {
  const { t } = useTranslation()
  const state = usePreviewFileContent(item)
  const session = useSessionStore((store) =>
    store.sessions.find((candidate) => candidate.id === item.sessionId)
  )

  // Truncated or paginated content cannot be trusted to represent the whole document, so sniffing
  // only runs on a complete first page.
  const content =
    state.status === 'ready' &&
    state.preview.encoding === 'utf8' &&
    !state.preview.truncated &&
    state.pagination.pageNumber === 1
      ? state.preview.content
      : undefined
  const planDocument = useMemo(
    () => (content !== undefined ? parsePlanDocumentFromPreviewContent(content) : undefined),
    [content]
  )

  // The Files-tab dialog updates the previewed item in place instead of remounting, so the toggle
  // resets whenever the underlying file (not just the component) changes.
  const resourceKey = createPreviewResourceKey(item)
  const [recordedViewKey, setRecordedViewKey] = useState<string>()
  const [viewState, setViewState] = useState<{ key: string; view: PlanViewMode }>()
  const view = viewState?.key === resourceKey ? viewState.view : 'plan'

  const recordedTarget = recordedObservationTargetForFile(item)
  const questionRecovery = useObservationQuestionRecovery(recordedTarget)
  const recordedContent =
    state.status === 'ready' &&
    state.preview.encoding === 'utf8' &&
    state.pagination.pageNumber === 1 &&
    isRecordedObservationContent(state.preview.content, !state.preview.truncated)
  const projectContent =
    state.status === 'ready' &&
    state.preview.encoding === 'utf8' &&
    state.pagination.pageNumber === 1 &&
    isProjectRecordingContent(state.preview.content, !state.preview.truncated)
  const browserContent =
    state.status === 'ready' &&
    state.preview.encoding === 'utf8' &&
    state.pagination.pageNumber === 1 &&
    isBrowserRecordingContent(state.preview.content, !state.preview.truncated)
  if (
    recordedTarget &&
    (recordedContent || projectContent || browserContent) &&
    !document.documentElement.hasAttribute(WEB_CALLER_LOCATION_ATTRIBUTE) &&
    typeof window.api?.observations?.openRecorded === 'function'
  ) {
    const viewing = recordedViewKey === resourceKey
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 justify-end border-b border-border-200 p-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setRecordedViewKey(viewing ? undefined : resourceKey)}
          >
            {viewing ? t('View raw JSON') : t('View archived replay')}
          </Button>
        </div>
        <div className="min-h-0 flex-1">
          {viewing ? (
            <Suspense
              fallback={
                <p role="status" className="p-4 text-sm">
                  {t('Loading…')}
                </p>
              }
            >
              <RunObservationPreview
                mode="recorded"
                format={
                  browserContent
                    ? 'web-recording'
                    : projectContent
                      ? 'project-recording'
                      : undefined
                }
                onAskBrowserMoment={(selection) => {
                  if (!useRunObservationQuestionStore.getState().askRecorded(selection))
                    throw new Error('Discussion unavailable')
                }}
                onAskArchiveFile={(selection) => {
                  if (!useRunObservationQuestionStore.getState().askRecorded(selection))
                    throw new Error('Discussion unavailable')
                }}
                target={recordedTarget}
                questionRecovery={questionRecovery}
                title={item.title}
                isActive
                onAskArchiveSelection={(selection) => {
                  if (!useRunObservationQuestionStore.getState().askRecorded(selection))
                    throw new Error(
                      t(
                        'Open an editable Session in this Project, or use Discuss from the imported research, to ask about this step.'
                      )
                    )
                }}
              />
            </Suspense>
          ) : (
            <JsonPreviewBody item={item} state={state} />
          )}
        </div>
      </div>
    )
  }
  if (!planDocument) return <JsonPreviewBody item={item} state={state} />

  const resolved = readOnly ? undefined : resolvePlanFileProjection(session, item.selectedVersionId)
  const projection = resolved?.projection ?? snapshotPlanProjection(planDocument)
  const stale = resolved?.stale ?? false
  const snapshot = resolved === undefined

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-10 text-foreground">
      <div className="flex h-8 shrink-0 items-center justify-end gap-1 border-b border-border px-2">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-label={view === 'plan' ? t('View raw JSON') : t('View plan')}
          onClick={() => setViewState({ key: resourceKey, view: view === 'plan' ? 'raw' : 'plan' })}
        >
          {view === 'plan' ? (
            <Code2 className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
          ) : (
            <ListChecks className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
          )}
          {view === 'plan' ? t('View raw JSON') : t('View plan')}
        </Button>
      </div>
      {view === 'plan' ? (
        <>
          {stale ? (
            <PlanNoticeBanner>
              {t('⚠ This plan has been replaced by another plan and is no longer current.')}
            </PlanNoticeBanner>
          ) : null}
          {snapshot ? (
            <PlanNoticeBanner>
              {t(
                'This plan is shown as a saved snapshot. Step progress is unavailable for archived sessions.'
              )}
            </PlanNoticeBanner>
          ) : null}
          <PlanDocumentBody projection={projection} />
        </>
      ) : (
        <JsonPreviewBody item={item} state={state} />
      )}
    </div>
  )
}
