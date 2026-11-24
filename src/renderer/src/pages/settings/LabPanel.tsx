import { ExternalLink, LoaderCircle, LogOut, RefreshCw, UserRound } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ErrorNotice } from '@/components/error-notice'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useSettingsStore } from '@/stores/settings-store'
import type {
  LabConnectionState,
  LabErrorCode,
  LabUsage,
  LabUsageAmount
} from '../../../../shared/lab'
import { SettingsField, SettingsSection } from './SettingsLayout'
import { labErrorCopyKey, labModelProtocolLabel, labStatusLabelKey } from './lab-panel-view'

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
const usageCurrency = (usage: LabUsage): string => {
  const currency = usage.display?.currency ?? 'CNY'
  if (currency === 'USD') return '$'
  if (currency === 'CNY' || currency === 'RMB') return '¥'
  return currency
}

const usageAmount = (usage: LabUsage, amount: LabUsageAmount | undefined): string | undefined => {
  if (!amount) return undefined
  const symbol = usageCurrency(usage)
  return `${symbol}${amount.remaining.toFixed(2)} / ${symbol}${amount.limit.toFixed(2)}`
}

const usageQuotaText = (
  usage: LabUsage,
  quota: { unlimited: boolean } | undefined,
  amount: LabUsageAmount | undefined,
  t: (key: string) => string
): string => {
  if (quota?.unlimited) return t('Unlimited')
  const formatted = usageAmount(usage, amount)
  return formatted ?? t('Unavailable')
}

const usageAmountFor = (usage: LabUsage, layer: 'token' | 'org'): LabUsageAmount | undefined =>
  usage.display?.currency === 'USD' ? usage.display.usd[layer] : usage.display?.cny[layer]

const effectiveUsageText = (usage: LabUsage): string | undefined => {
  if (!usage.effective) return undefined
  if (!usage.display) return `${usage.effective.remaining}`
  const value =
    usage.display.currency === 'USD'
      ? usage.effective.remaining / usage.display.perUnit
      : (usage.effective.remaining / usage.display.perUnit) * usage.display.exchangeRate
  return `${usageCurrency(usage)}${value.toFixed(2)}`
}

export function LabPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const lab = useSettingsStore((state) => state.lab)
  const [serverUrl, setServerUrl] = useState(() => lab?.serverUrl ?? '')
  const serverUrlRef = useRef(serverUrl)
  const editedRef = useRef(false)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [actionErrorKey, setActionErrorKey] = useState<string>()
  const [actionSuccessKey, setActionSuccessKey] = useState<string>()
  const [authorizationUrl, setAuthorizationUrl] = useState<string>()
  const [pendingSignIn, setPendingSignIn] = useState(false)
  const signingInRef = useRef(false)
  const signInButton = useRef<HTMLButtonElement>(null)
  const restoreSignInFocus = useRef(false)

  useEffect(() => {
    signingInRef.current = lab?.state === 'signingIn'
  }, [lab?.state])

  // Background restore may publish the saved address after this panel mounted. Sync it while the
  // user has not edited the draft; never overwrite a draft the user is typing.
  useEffect(() => {
    if (editedRef.current) return
    const next = lab?.serverUrl ?? ''
    serverUrlRef.current = next
    setServerUrl(next)
  }, [lab?.serverUrl])

  // Leaving Settings while the loopback callback is still pending must release the main-process
  // attempt; the cancellation itself is fire-and-forget because the component is going away.
  useEffect(
    () => () => {
      if (signingInRef.current) void window.api?.settings?.labCancelLogin?.()
    },
    []
  )

  const state: LabConnectionState = pendingSignIn ? 'signingIn' : (lab?.state ?? 'unconfigured')
  const busy = busyAction !== null
  const canSignIn = state === 'signedOut' || state === 'expired'

  useEffect(() => {
    if (!busy && canSignIn && restoreSignInFocus.current) {
      restoreSignInFocus.current = false
      signInButton.current?.focus()
    }
  }, [busy, canSignIn])
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
      if (serverUrlRef.current.trim() === testedServerUrl.trim()) {
        setActionErrorKey(errorCopyKey(error))
      }
    } finally {
      setBusyAction(null)
    }
  }

  const signIn = async (): Promise<void> => {
    if (busyAction !== null) return
    setBusyAction('sign-in')
    setAuthorizationUrl(undefined)
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
    restoreSignInFocus.current = true
    setActionErrorKey(undefined)
    setActionSuccessKey(undefined)
    try {
      const view = await window.api.settings.labCancelLogin()
      restoreSignInFocus.current = view.state === 'signedOut' || view.state === 'expired'
      setAuthorizationUrl(undefined)
    } catch (error) {
      restoreSignInFocus.current = false
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
  const accountName = state === 'authenticated' ? lab?.accountName : undefined
  const initials = accountName
    ?.trim()
    .split(/\s+/u)
    .slice(0, 2)
    .map((word) => Array.from(word)[0])
    .join('')
    .toLocaleUpperCase()

  return (
    <div className="space-y-5 p-5">
      <SettingsSection data-settings-anchor="lab.connection" title={t('Connection')}>
        {isWeb ? (
          <ErrorNotice
            inline
            level="error"
            role="alert"
            description={t('Lab is not available in the browser version.')}
          />
        ) : (
          <div className="space-y-4">
            <div className="divide-y divide-border rounded-lg border border-border">
              <div className="flex flex-wrap items-center gap-2.5 px-3 py-2.5">
                <span
                  className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-xs font-medium text-muted-foreground"
                  aria-hidden="true"
                >
                  {state === 'signingIn' ? (
                    <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
                  ) : (
                    initials || <UserRound className="size-4" />
                  )}
                </span>
                <div className="min-w-0 flex-1 basis-40 break-words" role="status">
                  {accountName ? (
                    <p className="text-sm font-medium">
                      <span className="sr-only">
                        {t('Signed in as {{name}}', { name: accountName })}
                      </span>
                      <span aria-hidden="true">{accountName}</span>
                    </p>
                  ) : (
                    <p className="text-sm font-medium">{t(labStatusLabelKey(state))}</p>
                  )}
                  {state === 'authenticated' && lab?.deviceName ? (
                    <p className="text-xs text-muted-foreground">
                      <span className="sr-only">
                        {t('Device: {{name}}', { name: lab.deviceName })}
                      </span>
                      <span aria-hidden="true">{lab.deviceName}</span>
                    </p>
                  ) : null}
                </div>
                {canSignIn ? (
                  <Button
                    ref={signInButton}
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void signIn()}
                    disabled={busy}
                  >
                    {t('Sign in with browser')}
                    <ExternalLink aria-hidden="true" />
                  </Button>
                ) : null}
                {state === 'signingIn' ? (
                  <div className="flex flex-wrap gap-2">
                    {authorizationUrl ? (
                      <Button asChild size="sm" variant="outline">
                        <a href={authorizationUrl} target="_blank" rel="noreferrer">
                          {t('Open the sign-in page again')}
                          <ExternalLink aria-hidden="true" />
                        </a>
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void cancelSignIn()}
                      disabled={busyAction === 'cancel'}
                    >
                      {t('Cancel sign-in')}
                    </Button>
                  </div>
                ) : null}
                {state === 'authenticated' ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void signOut()}
                    disabled={busy}
                  >
                    <LogOut aria-hidden="true" />
                    {t('Sign out')}
                  </Button>
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
              <form
                className="flex flex-wrap items-end gap-2 px-3 py-2.5"
                onSubmit={(event) => {
                  event.preventDefault()
                  void save()
                }}
              >
                <SettingsField label={t('Server address')} className="min-w-0 flex-1 basis-56">
                  <Input
                    aria-label={t('Lab server address')}
                    placeholder={t('https://lab.example.com')}
                    value={serverUrl}
                    disabled={busyAction === 'save' || state === 'signingIn'}
                    onChange={(event) => {
                      const next = event.target.value
                      editedRef.current = true
                      serverUrlRef.current = next
                      setServerUrl(next)
                      setActionErrorKey(undefined)
                      setActionSuccessKey(undefined)
                    }}
                  />
                </SettingsField>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void check()}
                    disabled={busy || state === 'signingIn'}
                  >
                    {t('Test connection')}
                  </Button>
                  <Button
                    type="submit"
                    variant="outline"
                    disabled={
                      busy || state === 'signingIn' || serverUrl.trim() === (lab?.serverUrl ?? '')
                    }
                  >
                    {t('Save')}
                  </Button>
                </div>
              </form>
            </div>

            {state === 'unconfigured' ? (
              <p className="text-sm text-muted-foreground">{t('Enter a Lab server address.')}</p>
            ) : null}

            {state === 'authenticated' ? (
              <div className="space-y-5">
                {lab?.usage ? (
                  <div data-settings-anchor="lab.usage" className="space-y-2 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <h4 className="font-medium text-foreground">{t('Usage')}</h4>
                      {lab.usage.stale || lab.usage.org.stale ? (
                        <Badge variant="outline">{t('Cached')}</Badge>
                      ) : null}
                    </div>
                    {lab.usage.available ? (
                      <dl className="divide-y divide-border rounded-lg border border-border px-3">
                        <div className="flex flex-wrap items-baseline justify-between gap-x-4 py-2">
                          <dt className="text-muted-foreground">{t('Access token quota')}</dt>
                          <dd className="tabular-nums">
                            {usageQuotaText(
                              lab.usage,
                              lab.usage.token.quota,
                              usageAmountFor(lab.usage, 'token'),
                              t
                            )}
                          </dd>
                        </div>
                        {lab.usage.effective ? (
                          <div className="flex flex-wrap items-baseline justify-between gap-x-4 py-2">
                            <dt className="text-muted-foreground">{t('Effective remaining')}</dt>
                            <dd className="font-medium tabular-nums">
                              {effectiveUsageText(lab.usage)}
                            </dd>
                          </div>
                        ) : null}
                      </dl>
                    ) : (
                      <p className="text-muted-foreground">
                        {t('Usage information is unavailable.')}
                      </p>
                    )}
                  </div>
                ) : null}
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h4 className="text-sm font-medium text-foreground">{t('Models')}</h4>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void refreshModels()}
                      disabled={busy}
                    >
                      <RefreshCw aria-hidden="true" />
                      {t('Refresh models')}
                    </Button>
                  </div>
                  {models.length > 0 ? (
                    <ul className="divide-y divide-border rounded-lg border border-border">
                      {models.map((model) => (
                        <li
                          key={model.id}
                          className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
                        >
                          <span className="min-w-0 flex-1 break-words">{model.name}</span>
                          <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
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
