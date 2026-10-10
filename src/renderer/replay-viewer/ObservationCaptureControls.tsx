import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../src/components/ui/button'
import { ErrorNotice } from '../src/components/error-notice'
import type {
  ObservationMediaCaptureOptions,
  ObservationMediaCaptureRequest,
  ObservationMediaCaptureResult
} from '../../shared/run-observation-capture'
import type { ReplayViewerClient } from './client'

export const ObservationCaptureControls = ({
  client,
  enabled,
  hostViewOpen
}: {
  client: ReplayViewerClient
  enabled: boolean
  hostViewOpen: boolean
}): React.JSX.Element | null => {
  const { t } = useTranslation()
  const [options, setOptions] = useState<ObservationMediaCaptureOptions>()
  const [optionsFailed, setOptionsFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ObservationMediaCaptureResult>()
  const pending = useRef(false)
  // Uncertain transport outcomes keep their key across inspect/follow changes and retries.
  const attempt = useRef<ObservationMediaCaptureRequest | undefined>(undefined)
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    void client.captureOptions(controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) {
          setOptions(value)
          setOptionsFailed(false)
        }
      },
      () => {
        if (!controller.signal.aborted) {
          setOptions(undefined)
          setOptionsFailed(true)
        }
      }
    )
    return () => controller.abort()
  }, [client, enabled, hostViewOpen, retry])
  const capture = async (
    requested: { source: 'host-view' } | { source: 'project-export'; exportKey: string }
  ): Promise<void> => {
    if (!enabled || pending.current) return
    const request = attempt.current ?? { ...requested, idempotencyKey: crypto.randomUUID() }
    attempt.current = request
    pending.current = true
    setBusy(true)
    setFailed(false)
    try {
      const captured = await client.capture(request)
      setResult(captured)
      attempt.current = undefined
    } catch {
      setFailed(true)
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  // Keep state while inspecting history, but never expose capture actions on a historical frame.
  if (!enabled) return null
  if (optionsFailed)
    return (
      <ErrorNotice
        inline
        title={t('Capture options are unavailable.')}
        primaryButton={{ label: t('Retry'), onClick: () => setRetry((value) => value + 1) }}
      />
    )
  if (!options || (!options.hostView && options.projectExports.length === 0)) return null
  return (
    <div className="shrink-0 space-y-1 border-b border-border-200 px-3 py-1">
      <div className="flex flex-wrap items-center gap-2">
        {options.hostView ? (
          <Button
            size="sm"
            variant="outline"
            disabled={!hostViewOpen || busy || failed}
            onClick={() => {
              void capture({ source: 'host-view' })
            }}
          >
            {t('Save project screenshot')}
          </Button>
        ) : null}
        {options.projectExports.map((name) => (
          <Button
            key={name}
            size="sm"
            variant="outline"
            disabled={busy || failed}
            onClick={() => {
              void capture({ source: 'project-export', exportKey: name })
            }}
          >
            {t('Save project image: {{name}}', { name })}
          </Button>
        ))}
      </div>
      {options.hostView && !hostViewOpen ? (
        <p className="text-xs text-muted-foreground">
          {t('Open the project interface before capturing it.')}
        </p>
      ) : null}
      {failed ? (
        <ErrorNotice
          inline
          title={t('Could not confirm the saved image. Retry the same capture.')}
          primaryButton={{
            label: t('Retry'),
            onClick: () => {
              if (attempt.current) void capture(attempt.current)
            }
          }}
        />
      ) : null}
      <div className="h-8 overflow-auto text-xs" data-testid="capture-feedback">
        {busy ? (
          <p role="status">{t('Saving project image…')}</p>
        ) : result ? (
          <details className="break-words">
            <summary className="cursor-pointer">
              <span role="status">
                {result.publication === 'published'
                  ? t('Image published for recorded step {{step}}.', { step: result.stepKey })
                  : t('This captured image is awaiting archive publication.')}
              </span>
            </summary>
            {result.publication !== 'published' ? (
              <p className="mt-1 break-all">
                {t('Image captured for recorded step {{step}}; awaiting archive publication.', {
                  step: result.stepKey
                })}
              </p>
            ) : null}
            <p className="mt-1">
              {t('Captured from {{start}} to {{end}}.', {
                start: new Date(result.capture.startedAt).toISOString(),
                end: new Date(result.capture.finishedAt).toISOString()
              })}
            </p>
          </details>
        ) : null}
      </div>
    </div>
  )
}
