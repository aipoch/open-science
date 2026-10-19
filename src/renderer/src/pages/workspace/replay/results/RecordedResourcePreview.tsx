import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ErrorNotice } from '@/components/error-notice'
import type { ReplayResource } from '../../../../../../shared/replay'
import { staticHtml } from '@/lib/replay/static-html'
import { replayImageSource } from '../replay-svg'
import { useRegisterPreviewContextMenuFrame } from '../../preview-actions/preview-action-hooks'
import {
  fixedReplayResource,
  type RecordedResourceContent,
  type RecordedResourceReader
} from './recorded-resource-reader'

/** Static bytes only. This renderer has no runtime, Notebook, or project-service dependency. */
export function RecordedResourcePreview({
  read,
  resource
}: {
  read: RecordedResourceReader
  resource: ReplayResource
}): React.JSX.Element {
  const { t } = useTranslation()
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  useRegisterPreviewContextMenuFrame({
    id: 'recorded-resource-' + resource.id,
    frameUrl: 'about:srcdoc',
    frameRef,
    // Opaque static documents have no unique managed-preview identity. Keep native text/image
    // actions; never impersonate a trusted protocol or relax Main's frame allowlist for srcdoc.
    enabled: false
  })
  const fixed = useMemo(() => fixedReplayResource(resource), [resource])
  const [loaded, setLoaded] = useState<{
    resource: ReplayResource
    read: RecordedResourceReader
    result: RecordedResourceContent | null
  }>()
  useEffect(() => {
    if (!fixed) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
      setLoaded({ resource, read, result: null })
    }, 5000)
    void Promise.resolve()
      .then(() => read(fixed, controller.signal))
      .then(
        (result) => {
          if (!controller.signal.aborted) setLoaded({ resource, read, result })
        },
        () => {
          if (!controller.signal.aborted) setLoaded({ resource, read, result: null })
        }
      )
      .finally(() => clearTimeout(timer))
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [read, resource, fixed])
  const result = loaded?.resource === resource && loaded.read === read ? loaded.result : undefined
  if (!fixed) return <ErrorNotice inline title={t('The recorded evidence is unavailable.')} />
  if (result === undefined)
    return <p className="p-4 text-sm">{t('Preparing recorded material…')}</p>
  if (result === null)
    return <ErrorNotice inline title={t('Could not read the recorded material.')} />
  const truncated = result.truncated ? (
    <p className="p-2 text-xs text-status-warning-foreground">
      {t('Preview is truncated. Open the evidence for the complete file.')}
    </p>
  ) : null
  if (result.mimeType === 'text/html' || /\.html?$/i.test(resource.name))
    return (
      <div className="flex h-full min-h-0 flex-col" data-preview-context-menu-passthrough>
        <p className="shrink-0 p-2 text-xs text-muted-foreground">
          {t('Saved HTML preview. Scripts and external connections are disabled.')}
        </p>
        {truncated}
        <iframe
          ref={frameRef}
          data-preview-context-menu-passthrough
          title={resource.name}
          sandbox=""
          referrerPolicy="no-referrer"
          srcDoc={staticHtml(result.content)}
          className="min-h-0 w-full flex-1 border-0"
        />
      </div>
    )
  if (result.mimeType.startsWith('image/')) {
    const source = !result.truncated && replayImageSource(result.mimeType, result.content)
    return source ? (
      <img alt={resource.name} src={source} className="max-h-full max-w-full object-contain" />
    ) : (
      <ErrorNotice inline title={t('This file preview is unavailable here.')} />
    )
  }
  if (
    !result.mimeType.startsWith('text/') &&
    !/^application\/(?:json|xml|javascript|x-yaml)$/.test(result.mimeType)
  )
    return <ErrorNotice inline title={t('This file preview is unavailable here.')} />
  return (
    <div className="h-full overflow-auto p-4">
      {truncated}
      <pre className="whitespace-pre-wrap break-words text-xs">{result.content}</pre>
    </div>
  )
}
