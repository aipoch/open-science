import { LoaderCircle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ErrorNotice } from '@/components/error-notice'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useSettingsStore } from '@/stores/settings-store'
import type { LabConnectionState, LabErrorCode } from '../../../../shared/lab'
import { SettingsField, SettingsSection } from './SettingsLayout'
import {
  labErrorCopyKey,
  labModelProtocolLabel,
  labStatusLabelKey,
  labStatusTone,
  type LabStatusTone
} from './lab-panel-view'

const STATUS_TONE_CLASS_NAMES: Record<LabStatusTone, string> = {
  neutral: 'border-border bg-muted text-muted-foreground',
  success:
    'border-status-success-accent/30 bg-status-success-surface text-status-success-foreground dark:border-status-success-accent/30 dark:bg-status-success-dark-surface dark:text-status-success-dark-foreground',
  warning:
    'border-status-warning-foreground/30 bg-status-warning-surface text-status-warning-foreground dark:border-status-warning-dark-foreground/30 dark:bg-status-warning-dark-surface dark:text-status-warning-dark-foreground',
  error:
    'border-status-failure-border bg-status-failure-surface text-status-failure-foreground dark:border-status-failure-dark-border dark:bg-status-failure-dark-surface dark:text-status-failure-dark-foreground'
}

const LAB_ERROR_CODES: readonly LabErrorCode[] = [
  'server-url-missing',
  'server-url-invalid',
  'server-url-insecure',
  'server-url-query',
  'server-url-credentials',
  'network',
  'timeout',
  'unauthorized',
  'license-inactive',
  'seat-required',
  'org-inactive',
  'account-disabled',
  'device-limit',
  'rate-limited',
  'server-error',
  'invalid-response',
  'cancelled',
  'expired',
  'unknown'
]

// IPC rejections lose custom Error properties across the context bridge, so recognize a Lab error
// either from a structured code or from the serialized message that main used for the rejection.
const labErrorCodeFrom = (error: unknown): LabErrorCode | undefined => {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && (LAB_ERROR_CODES as readonly string[]).includes(code))
      return code as LabErrorCode
  }
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const normalized = message.toLowerCase()
  return LAB_ERROR_CODES.find((code) => normalized.includes(code))
}

const errorCopyKey = (error: unknown): string =>
  labErrorCopyKey(labErrorCodeFrom(error)) ?? 'The Lab server rejected the request.'

export function LabPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const lab = useSettingsStore((state) => state.lab)
  const [serverUrl, setServerUrl] = useState(() => lab?.serverUrl ?? '')
  const serverUrlRef = useRef(serverUrl)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [actionErrorKey, setActionErrorKey] = useState<string>()
  const [actionSuccessKey, setActionSuccessKey] = useState<string>()
  const [authorizationUrl, setAuthorizationUrl] = useState<string>()
  const [pendingSignIn, setPendingSignIn] = useState(false)
  const signingInRef = useRef(false)

  useEffect(() => {
    signingInRef.current = lab?.state === 'signingIn'
  }, [lab?.state])

  // Leaving Settings while the loopback callback is still pending must release the main-process
  // attempt; the cancellation itself is fire-and-forget because the component is going away.
  useEffect(
    () => () => {
      if (signingInRef.current) void window.api?.settings?.labCancelLogin?.()
    },
    []
  )

  const state: LabConnectionState = pendingSignIn ? 'signingIn' : (lab?.state ?? 'unconfigured')
  const isWeb =
    typeof document !== 'undefined' &&
    document.documentElement.hasAttribute('data-open-science-web-events')

  const save = async (): Promise<void> => {
    if (busyAction !== null) return
    setBusyAction('save')
    setActionErrorKey(undefined)
    setActionSuccessKey(undefined)
    try {
      const view = await window.api.settings.labSetServer({ serverUrl })
      if (view.error?.code) setActionErrorKey(labErrorCopyKey(view.error.code))
    } catch (error) {
      setActionErrorKey(errorCopyKey(error))
    } finally {
      setBusyAction(null)
    }
  }

  const check = async (): Promise<void> => {
    if (busyAction !== null) return
    setBusyAction('check')
    setActionErrorKey(undefined)
    setActionSuccessKey(undefined)
    const testedServerUrl = serverUrl
    try {
      // Probe the address in the field without changing the saved deployment or clearing a login.
      const view = await window.api.settings.labCheck({ serverUrl: testedServerUrl })
      // Ignore a result if the user edited the address while the probe was in flight.
      if (serverUrlRef.current.trim() !== testedServerUrl.trim()) return
      if (view.error?.code) setActionErrorKey(labErrorCopyKey(view.error.code))
      else setActionSuccessKey('Lab server address is reachable.')
    } catch (error) {
      setActionErrorKey(errorCopyKey(error))
    } finally {
      setBusyAction(null)
    }
  }

  const signIn = async (): Promise<void> => {
    if (busyAction !== null) return
    setBusyAction('sign-in')
    setActionErrorKey(undefined)
    setActionSuccessKey(undefined)
    setPendingSignIn(true)
    signingInRef.current = true
    try {
      const challenge = await window.api.settings.labBeginLogin()
      setAuthorizationUrl(challenge.authorizationUrl)
      const view = await window.api.settings.labWaitLogin()
      if (view.error?.code) setActionErrorKey(labErrorCopyKey(view.error.code))
    } catch (error) {
      setActionErrorKey(errorCopyKey(error))
    } finally {
      signingInRef.current = false
      setPendingSignIn(false)
      setBusyAction(null)
    }
  }

  const cancelSignIn = async (): Promise<void> => {
    if (busyAction === 'cancel') return
    setBusyAction('cancel')
    setActionErrorKey(undefined)
    setActionSuccessKey(undefined)
    try {
      await window.api.settings.labCancelLogin()
    } catch (error) {
      setActionErrorKey(errorCopyKey(error))
    } finally {
      signingInRef.current = false
      setPendingSignIn(false)
      setBusyAction(null)
    }
  }

  const refreshModels = async (): Promise<void> => {
    if (busyAction !== null) return
    setBusyAction('refresh')
    setActionErrorKey(undefined)
    try {
      const view = await window.api.settings.labRefresh()
      if (view.error?.code) setActionErrorKey(labErrorCopyKey(view.error.code))
    } catch (error) {
      setActionErrorKey(errorCopyKey(error))
    } finally {
      setBusyAction(null)
    }
  }

  const signOut = async (): Promise<void> => {
    if (busyAction !== null) return
    setBusyAction('sign-out')
    setActionErrorKey(undefined)
    try {
      const view = await window.api.settings.labLogout()
      if (view.error?.code) setActionErrorKey(labErrorCopyKey(view.error.code))
      setAuthorizationUrl(undefined)
    } catch (error) {
      setActionErrorKey(errorCopyKey(error))
    } finally {
      setBusyAction(null)
    }
  }

  const viewErrorKey = lab?.error?.code ? labErrorCopyKey(lab.error.code) : undefined
  const models = lab?.models ?? []
  const modelCount = lab?.modelCount ?? models.length
  const busy = busyAction !== null

  return (
    <div className="space-y-5 p-5">
      <SettingsSection
        data-settings-anchor="lab.connection"
        title={t('Lab')}
        description={t("Connect Open-Science to your organization's Lab gateway.")}
      >
        {isWeb ? (
          <ErrorNotice
            inline
            level="error"
            role="alert"
            description={t('Lab is not available in the browser version.')}
          />
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <h4 className="text-sm font-medium text-foreground">{t('Lab server')}</h4>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <SettingsField label={t('Server address')} className="min-w-0 flex-1">
                  <Input
                    aria-label={t('Lab server address')}
                    placeholder={t('https://lab.example.com')}
                    value={serverUrl}
                    disabled={busyAction === 'save'}
                    onChange={(event) => {
                      const next = event.target.value
                      serverUrlRef.current = next
                      setServerUrl(next)
                      setActionErrorKey(undefined)
                      setActionSuccessKey(undefined)
                    }}
                  />
                </SettingsField>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <Button type="button" onClick={() => void save()} disabled={busy}>
                    {t('Save')}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void check()}
                    disabled={busy}
                  >
                    {t('Test connection')}
                  </Button>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant="outline"
                className={STATUS_TONE_CLASS_NAMES[labStatusTone(state)]}
                role="status"
              >
                {t(labStatusLabelKey(state))}
              </Badge>
              {state === 'signedOut' || state === 'expired' ? (
                <Button type="button" size="sm" onClick={() => void signIn()} disabled={busy}>
                  {t('Sign in')}
                </Button>
              ) : null}
              {state === 'authenticated' ? (
                <>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void refreshModels()}
                    disabled={busy}
                  >
                    {t('Refresh models')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => void signOut()}
                    disabled={busy}
                  >
                    {t('Sign out')}
                  </Button>
                </>
              ) : null}
              {state === 'blocked' || state === 'unreachable' ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void check()}
                  disabled={busy}
                >
                  {t('Retry')}
                </Button>
              ) : null}
            </div>

            {state === 'unconfigured' ? (
              <p className="text-sm text-muted-foreground">{t('Enter a Lab server address.')}</p>
            ) : null}

            {state === 'signedOut' ? (
              <p className="text-sm text-muted-foreground">
                {t('Lab models are unavailable while signed out.')}
              </p>
            ) : null}

            {state === 'signingIn' ? (
              <div className="space-y-3">
                <div
                  className="flex items-center gap-2 text-sm text-muted-foreground"
                  role="status"
                >
                  <LoaderCircle
                    className="size-4 animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                  <span>{t('Waiting for browser confirmation…')}</span>
                </div>
                {authorizationUrl ? (
                  <div className="space-y-1">
                    <a
                      href={authorizationUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex text-sm font-medium text-primary underline underline-offset-4 hover:text-primary/80 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      {t('Open the sign-in page again')}
                    </a>
                    <p className="text-xs text-muted-foreground">
                      {t('If the browser did not open, use this link.')}
                    </p>
                  </div>
                ) : null}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void cancelSignIn()}
                  disabled={busyAction === 'cancel'}
                >
                  {t('Cancel sign-in')}
                </Button>
              </div>
            ) : null}

            {state === 'authenticated' ? (
              <div className="space-y-3">
                <div className="space-y-1 text-sm">
                  <p>{t('Signed in as {{name}}', { name: lab?.accountName ?? '' })}</p>
                  <p className="text-muted-foreground">
                    {t('Device: {{name}}', { name: lab?.deviceName ?? '' })}
                  </p>
                  <p className="text-muted-foreground">
                    {t('{{count}} models available', {
                      count: modelCount,
                      defaultValue_one: '{{count}} model available'
                    })}
                  </p>
                </div>
                <div className="space-y-2">
                  <h4 className="text-sm font-medium text-foreground">{t('Available models')}</h4>
                  {models.length > 0 ? (
                    <ul className="divide-y divide-border rounded-lg border border-border">
                      {models.map((model) => (
                        <li
                          key={model.id}
                          className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
                        >
                          <span className="min-w-0 break-words">{model.name}</span>
                          <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                            <span>{t(labModelProtocolLabel(model.protocols))}</span>
                            {!model.streaming ? (
                              <Badge variant="outline">{t('Non-streaming')}</Badge>
                            ) : null}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      {t('No Lab models are assigned to this account.')}
                    </p>
                  )}
                </div>
              </div>
            ) : null}

            {viewErrorKey && !actionErrorKey ? (
              <ErrorNotice inline level="error" role="alert" description={t(viewErrorKey)} />
            ) : null}

            {actionErrorKey ? (
              <ErrorNotice inline level="error" role="alert" description={t(actionErrorKey)} />
            ) : null}

            {actionSuccessKey ? (
              <ErrorNotice inline level="success" role="status" description={t(actionSuccessKey)} />
            ) : null}
          </div>
        )}
      </SettingsSection>
    </div>
  )
}
