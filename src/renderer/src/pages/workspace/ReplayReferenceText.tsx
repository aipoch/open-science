import { Fragment, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ErrorNotice } from '@/components/error-notice'
import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'
import { useNavigationStore } from '@/stores/navigation-store'
import { splitReplayReferenceText } from './replay-reference-text'
import { createSessionReplayItem } from './workspace-session-actions'
import { requestReplaySeek } from './replay/replay-context'

export const ReplayReferenceText = ({
  text,
  projectId,
  deletedDiscussionSourceId
}: {
  text: string
  projectId?: string
  deletedDiscussionSourceId?: string
}): React.JSX.Element => {
  const navigationRevision = useNavigationStore((state) => state.explicitNavigationRevision)
  return (
    <ScopedReplayReferenceText
      key={JSON.stringify([projectId, text, navigationRevision, deletedDiscussionSourceId])}
      text={text}
      projectId={projectId}
      navigationRevision={navigationRevision}
      deletedDiscussionSourceId={deletedDiscussionSourceId}
    />
  )
}

const ScopedReplayReferenceText = ({
  text,
  projectId,
  navigationRevision,
  deletedDiscussionSourceId
}: {
  text: string
  projectId?: string
  navigationRevision: number
  deletedDiscussionSourceId?: string
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [error, setError] = useState<string>()
  const [pending, setPending] = useState<string>()
  const [deletedLinks, setDeletedLinks] = useState<ReadonlySet<string>>()
  useEffect(() => {
    if (
      !deletedDiscussionSourceId ||
      !projectId ||
      !window.api?.sessionReplay?.getSelectionSnapshot
    )
      return
    // Legacy inline links carry the snapshot ID, not the source Session ID.
    const ids = new Set(
      splitReplayReferenceText(text).flatMap((part) =>
        part.kind === 'reference' && (part.projectId ?? projectId) === projectId ? [part.id] : []
      )
    )
    if (!ids.size) return
    let active = true
    void Promise.all(
      [...ids].map(async (id) => {
        const snapshot = await window.api.sessionReplay
          .getSelectionSnapshot({ projectId, id })
          .catch(() => undefined)
        return snapshot?.sourceSessionId === deletedDiscussionSourceId ? id : undefined
      })
    ).then((matches) => {
      if (active) setDeletedLinks(new Set(matches.filter((id): id is string => id !== undefined)))
    })
    return () => {
      active = false
    }
  }, [deletedDiscussionSourceId, projectId, text])
  const request = useRef(0)
  useEffect(() => {
    return () => {
      request.current += 1
    }
  }, [])
  const open = async (id: string, sourceProjectId = projectId): Promise<void> => {
    if (!projectId || !window.api?.sessionReplay?.getSelectionSnapshot) {
      setError(t('This replay reference is unavailable on this device.'))
      return
    }
    setPending(id)
    setError(undefined)
    const token = ++request.current
    const isCurrent = (): boolean => {
      const navigation = useNavigationStore.getState()
      return (
        request.current === token &&
        navigation.view === 'workspace' &&
        navigation.activeProjectId === projectId &&
        navigation.explicitNavigationRevision === navigationRevision
      )
    }
    try {
      const context = await window.api.sessionReplay.getSelectionSnapshot({
        projectId: sourceProjectId!,
        id
      })
      if (!isCurrent()) return
      if (!context) {
        setError(t('This replay reference is unavailable on this device.'))
        return
      }
      if (
        context.projectId === projectId &&
        context.sourceSessionId === deletedDiscussionSourceId
      ) {
        setDeletedLinks((previous) => new Set(previous).add(id))
        return
      }
      usePreviewWorkbenchStore
        .getState()
        .upsertAndActivateItem(
          createSessionReplayItem(
            context.projectId,
            context.sourceSessionId,
            t('Research replay'),
            projectId
          )
        )
      requestReplaySeek(context)
    } catch (reason) {
      if (isCurrent()) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (isCurrent()) setPending(undefined)
    }
  }
  return (
    <>
      {splitReplayReferenceText(text).map((part, index) =>
        part.kind === 'text' ? (
          <Fragment key={index}>{part.text}</Fragment>
        ) : (part.projectId ?? projectId) === projectId && deletedLinks?.has(part.id) ? (
          <span key={index} className="text-xs text-muted-foreground">
            {part.label} · {t('Source deleted')}
          </span>
        ) : (
          <button
            key={index}
            type="button"
            disabled={Boolean(pending)}
            className="inline-flex rounded-md border border-border bg-accent px-2 py-0.5 text-xs text-accent-foreground disabled:opacity-50"
            onClick={() => {
              void open(part.id, part.projectId)
            }}
          >
            {part.label}
          </button>
        )
      )}
      {error ? <ErrorNotice inline tone="amber" role="alert" description={error} /> : null}
    </>
  )
}
