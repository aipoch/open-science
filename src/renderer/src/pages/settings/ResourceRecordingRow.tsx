import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CircleDot, LoaderCircle, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import { ErrorNotice } from '@/components/error-notice'
import type { ResourceRecordingState } from '../../../../shared/resource-recording'
import { SettingsRow } from './SettingsLayout'

export function ResourceRecordingRow(): React.JSX.Element | null {
  const { t } = useTranslation()
  const api = window.api.resourceRecording!
  const [state, setState] = useState<ResourceRecordingState | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const revision = useRef({ value: 0 })
  const mounted = useRef(true)
  const trigger = useRef<HTMLButtonElement>(null)

  const refresh = useCallback((): Promise<void> => {
    const current = revision.current.value
    return Promise.resolve()
      .then(() => api.getState())
      .then(
        (next) => {
          if (mounted.current && current === revision.current.value) {
            setState(next)
            setError(false)
          }
        },
        () => {
          if (mounted.current && current === revision.current.value) setError(true)
        }
      )
  }, [api])

  useEffect(() => {
    mounted.current = true
    const version = revision.current
    const unsubscribe = api.onChanged((next) => {
      version.value++
      setState(next)
      setError(false)
    })
    void refresh()
    return () => {
      mounted.current = false
      version.value++
      unsubscribe()
    }
  }, [api, refresh])

  const change = async (operation: 'start' | 'stop'): Promise<void> => {
    setBusy(true)
    setError(false)
    const current = revision.current.value
    try {
      const next = await api[operation]()
      if (mounted.current) {
        if (current === revision.current.value) setState(next)
        setConfirm(false)
      }
    } catch {
      if (mounted.current) {
        setError(true)
        setConfirm(false)
      }
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  if (state === 'unsupported') return null
  const running = state === 'recording' || state === 'idle' || state === 'suspended'
  const pending = busy || state === 'starting' || state === 'stopping'
  const status = {
    off: t('Not recording'),
    starting: t('Starting recording…'),
    recording: t('Recording'),
    idle: t('Paused'),
    suspended: t('Paused'),
    stopping: t('Stopping recording…'),
    failed: t('Recording failed')
  }
  return (
    <SettingsRow
      label={t('Resource usage')}
      description={<span role="status">{state ? status[state] : t('Loading…')}</span>}
    >
      <div className="flex flex-col items-start gap-2">
        <Button
          ref={trigger}
          type="button"
          variant="outline"
          disabled={pending || state === null}
          onClick={() => (running ? void change('stop') : setConfirm(true))}
        >
          {pending ? (
            <LoaderCircle
              className="size-4 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : running ? (
            <Square className="size-4" aria-hidden="true" />
          ) : (
            <CircleDot className="size-4" aria-hidden="true" />
          )}
          {running ? t('Stop recording') : t('Start recording…')}
        </Button>
        {error && (
          <ErrorNotice
            inline
            title={t('Could not update resource recording.')}
            secondaryButton={{ label: t('Retry'), onClick: () => void refresh() }}
          />
        )}
        <ConfirmActionDialog
          open={confirm}
          title={t('Record resource usage?')}
          description={t(
            'Records memory and process activity locally, up to 64 MiB. May affect performance. Pauses when idle or asleep and stops on restart. Saved logs remain; nothing is uploaded.'
          )}
          cancelLabel={t('Cancel')}
          confirmLabel={t('Start recording')}
          loading={busy}
          onCancel={() => setConfirm(false)}
          onConfirm={() => void change('start')}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            trigger.current?.focus()
          }}
        />
      </div>
    </SettingsRow>
  )
}
