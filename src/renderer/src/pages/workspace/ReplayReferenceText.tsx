import { Fragment, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ErrorNotice } from '@/components/error-notice'
import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'
import { useNavigationStore } from '@/stores/navigation-store'
import { splitReplayReferenceText } from './replay-reference-text'
import { createResearchReplayItem } from './workspace-research-controller'
import { requestReplaySeek } from './replay/replay-context'

export const ReplayReferenceText = ({
  text,
  projectId
}: {
  text: string
  projectId?: string
}): React.JSX.Element => {
  const navigationRevision = useNavigationStore((state) => state.explicitNavigationRevision)
  return (
    <ScopedReplayReferenceText
      key={JSON.stringify([projectId, text, navigationRevision])}
      text={text}
      projectId={projectId}
      navigationRevision={navigationRevision}
    />
  )
}

const ScopedReplayReferenceText = ({
  text,
  projectId,
  navigationRevision
}: {
  text: string
  projectId?: string
  navigationRevision: number
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [error, setError] = useState<string>()
  const [pending, setPending] = useState<string>()
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
      usePreviewWorkbenchStore
        .getState()
        .upsertAndActivateItem(
          createResearchReplayItem(
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
