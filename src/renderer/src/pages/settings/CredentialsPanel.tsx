import { BookOpen, Check, KeyRound, Server, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { ProviderView } from '../../../../shared/settings'
import type { OpenAlexCredentialValidation } from '../../../../shared/settings'
import { GitHubMark } from '@/components/GitHubStarBadge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { errorDetail } from '@/lib/error-detail'
import { useSettingsStore } from '@/stores/settings-store'
import { GitHubTokenControl } from './GitHubTokenControl'
import { MaskedPasswordField } from './MaskedPasswordField'
import { DeviceCredentialEditor } from './DeviceCredentialEditor'
import { SettingsSection } from './SettingsLayout'

export type CredentialsServiceId = 'github' | 'literature' | 'openalex'
export type CredentialsView =
  | { kind: 'list' }
  | { kind: 'service'; serviceId: CredentialsServiceId }
  | { kind: 'create' }
  | { kind: 'credential'; id: string }
type DesktopCredentialAvailability = 'checking' | 'available' | 'unavailable'

type CredentialsPanelProps = {
  view: CredentialsView
  onNavigate(view: CredentialsView): void
  onOpenConnector(id: string): void
  onOpenProvider(provider: ProviderView): void
}

const statusLabel = (configured: boolean): React.JSX.Element | null =>
  configured ? <Check className="size-4 text-primary" aria-hidden="true" /> : null
const isLocalOnlyActionError = (error: unknown): boolean =>
  error instanceof Error && error.message.includes('only available in the local desktop app')

export function CredentialsPanel({
  view,
  onNavigate,
  onOpenConnector,
  onOpenProvider
}: CredentialsPanelProps): React.JSX.Element {
  const { t } = useTranslation()
  const openAlex = useSettingsStore((state) => state.openAlex)
  const ncbi = useSettingsStore((state) => state.ncbi)
  const customServers = useSettingsStore((state) => state.customServers)
  const deviceCredentials = useSettingsStore((state) => state.deviceCredentials)
  const providers = useSettingsStore((state) => state.providers)
  const loadConnectors = useSettingsStore((state) => state.loadConnectors)
  const loadDeviceCredentials = useSettingsStore((state) => state.loadDeviceCredentials)
  const removeDeviceCredential = useSettingsStore((state) => state.removeDeviceCredential)
  const setOpenAlexCredential = useSettingsStore((state) => state.setOpenAlexCredential)
  const validateOpenAlexCredential = useSettingsStore((state) => state.validateOpenAlexCredential)
  const setNcbiCredentials = useSettingsStore((state) => state.setNcbiCredentials)
  const encryptionAvailable = useSettingsStore((state) => state.encryptionAvailable)
  const [githubConfigured, setGithubConfigured] = useState(false)
  const [desktopCredentialAvailability, setDesktopCredentialAvailability] =
    useState<DesktopCredentialAvailability>('checking')
  const activeServiceId = view.kind === 'service' ? view.serviceId : undefined
  const [apiKeyDraft, setApiKeyDraft] = useState<{
    serviceId: CredentialsServiceId
    value: string
  }>()
  const apiKey = apiKeyDraft && apiKeyDraft.serviceId === activeServiceId ? apiKeyDraft.value : ''
  const storedEmail = ncbi.contactEmail ?? ''
  const [emailDraft, setEmailDraft] = useState<{ source: string; value: string }>()
  const email = emailDraft?.source === storedEmail ? emailDraft.value : storedEmail
  const [busy, setBusy] = useState(false)
  const [credentialMessage, setCredentialMessage] = useState<string>()
  const [feedback, setFeedback] = useState<{
    serviceId: CredentialsServiceId
    message: string
  }>()
  const message = feedback && feedback.serviceId === activeServiceId ? feedback.message : undefined
  const setMessage = (next?: string): void => {
    setFeedback(activeServiceId && next ? { serviceId: activeServiceId, message: next } : undefined)
  }

  const openAlexValidationMessage = (result: OpenAlexCredentialValidation): string => {
    if (result.valid) return t('OpenAlex API key is valid.')
    if (result.reason === 'invalid-format') {
      return t('Enter a valid OpenAlex API key without spaces.')
    }
    if (result.reason === 'rejected') return t('OpenAlex rejected this API key.')
    return t('OpenAlex validation is temporarily unavailable. Try again.')
  }

  useEffect(() => {
    void loadConnectors().catch(() => undefined)
    void loadDeviceCredentials().catch(() => undefined)
    void window.api.settings
      .getGitHubTokenStatus()
      .then((status) => {
        setGithubConfigured(status.configured)
        setDesktopCredentialAvailability('available')
      })
      .catch((error: unknown) => {
        setDesktopCredentialAvailability(
          isLocalOnlyActionError(error) ? 'unavailable' : 'available'
        )
      })
  }, [loadConnectors, loadDeviceCredentials])

  if (
    (view.kind === 'create' || view.kind === 'credential') &&
    desktopCredentialAvailability !== 'available'
  ) {
    if (desktopCredentialAvailability === 'checking') {
      return <p className="p-5 text-sm text-muted-foreground">{t('Checking…')}</p>
    }
    return (
      <div className="space-y-5 p-5">
        <p className="text-sm text-muted-foreground">
          {t('This credential can only be configured in the local desktop app.')}
        </p>
        <div className="flex justify-end">
          <Button type="button" variant="ghost" onClick={() => onNavigate({ kind: 'list' })}>
            {t('Cancel')}
          </Button>
        </div>
      </div>
    )
  }

  if (view.kind === 'create') {
    return (
      <DeviceCredentialEditor
        onDone={() => onNavigate({ kind: 'list' })}
        onCancel={() => onNavigate({ kind: 'list' })}
      />
    )
  }

  if (view.kind === 'credential') {
    const credential = deviceCredentials.find(({ id }) => id === view.id)
    return credential ? (
      <DeviceCredentialEditor
        credential={credential}
        onDone={() => onNavigate({ kind: 'list' })}
        onCancel={() => onNavigate({ kind: 'list' })}
      />
    ) : (
      <div className="p-5 text-sm text-muted-foreground">
        {t('This credential no longer exists.')}
      </div>
    )
  }

  const saveOpenAlex = async (): Promise<void> => {
    const candidate = apiKey.trim()
    if (!candidate || busy) return
    setBusy(true)
    setMessage(undefined)
    try {
      const validation = await validateOpenAlexCredential({ apiKey: candidate })
      if (!validation.valid) {
        setMessage(openAlexValidationMessage(validation))
        return
      }
      await setOpenAlexCredential({ apiKey: candidate })
      setApiKeyDraft(undefined)
      setMessage(t('OpenAlex API key saved.'))
    } catch (error) {
      setMessage(errorDetail(error) ?? t('Could not save the OpenAlex API key.'))
    } finally {
      setBusy(false)
    }
  }

  const validateOpenAlex = async (): Promise<void> => {
    const candidate = apiKey.trim()
    if (!candidate || busy) return
    setBusy(true)
    setMessage(undefined)
    try {
      const validation = await validateOpenAlexCredential({ apiKey: candidate })
      setMessage(openAlexValidationMessage(validation))
    } catch {
      setMessage(t('OpenAlex validation is temporarily unavailable. Try again.'))
    } finally {
      setBusy(false)
    }
  }

  const clearOpenAlex = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setMessage(undefined)
    try {
      await setOpenAlexCredential({ apiKey: '' })
      setApiKeyDraft(undefined)
    } catch (error) {
      setMessage(errorDetail(error) ?? t('Could not remove the OpenAlex API key.'))
    } finally {
      setBusy(false)
    }
  }

  const saveLiterature = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setMessage(undefined)
    try {
      await setNcbiCredentials({ contactEmail: email, ...(apiKey ? { apiKey } : {}) })
      setApiKeyDraft(undefined)
      setMessage(t('Literature credentials saved.'))
    } catch (error) {
      setMessage(errorDetail(error) ?? t('Could not save literature credentials.'))
    } finally {
      setBusy(false)
    }
  }

  const clearLiteratureApiKey = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setMessage(undefined)
    try {
      await setNcbiCredentials({ contactEmail: email, apiKey: '' })
      setApiKeyDraft(undefined)
      setMessage(t('Literature credentials saved.'))
    } catch (error) {
      setMessage(errorDetail(error) ?? t('Could not save literature credentials.'))
    } finally {
      setBusy(false)
    }
  }

  if (view.kind === 'service') {
    const isDesktopOnlyService = view.serviceId === 'github' || view.serviceId === 'openalex'
    if (isDesktopOnlyService && desktopCredentialAvailability === 'checking') {
      return <p className="p-5 text-sm text-muted-foreground">{t('Checking…')}</p>
    }
    if (isDesktopOnlyService && desktopCredentialAvailability === 'unavailable') {
      const serviceLabel = view.serviceId === 'github' ? t('GitHub') : t('OpenAlex')
      return (
        <div className="space-y-5 p-5">
          <div>
            <h2 className="text-base font-semibold">{serviceLabel}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('This credential can only be configured in the local desktop app.')}
            </p>
          </div>
          <div className="flex justify-end">
            <Button type="button" variant="ghost" onClick={() => onNavigate({ kind: 'list' })}>
              {t('Cancel')}
            </Button>
          </div>
        </div>
      )
    }

    if (view.serviceId === 'github') {
      return (
        <div className="p-5">
          <GitHubTokenControl onCancel={() => onNavigate({ kind: 'list' })} />
        </div>
      )
    }

    const isOpenAlex = view.serviceId === 'openalex'
    return (
      <div className="space-y-5 p-5">
        <div>
          <h2 className="text-base font-semibold">
            {isOpenAlex ? t('OpenAlex API key') : t('Literature access')}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {isOpenAlex
              ? t(
                  'Used by OpenAlex tools in the Literature Connector. Every OpenAlex request requires this key.'
                )
              : t(
                  'Contact information and an optional NCBI API key used by research-service Connector calls.'
                )}
          </p>
        </div>
        {!isOpenAlex ? (
          <div className="space-y-1.5">
            <label htmlFor="literature-contact-email" className="text-sm font-medium">
              {t('Contact email')}
            </label>
            <Input
              id="literature-contact-email"
              type="email"
              value={email}
              onChange={(event) =>
                setEmailDraft({ source: storedEmail, value: event.target.value })
              }
              placeholder="you@example.com"
              disabled={busy}
            />
          </div>
        ) : null}
        <div className="space-y-1.5">
          <label htmlFor="service-api-key" className="text-sm font-medium">
            {isOpenAlex ? t('API key') : t('NCBI API key')}
          </label>
          <MaskedPasswordField
            id="service-api-key"
            value={apiKey}
            onChange={(value) => setApiKeyDraft({ serviceId: view.serviceId, value })}
            placeholder={
              (isOpenAlex ? openAlex.hasApiKey : ncbi.hasApiKey)
                ? t('Paste a replacement key')
                : t('Paste an API key')
            }
            disabled={busy}
          />
          <p className="text-xs text-muted-foreground">
            {t(
              'Stored encrypted on this computer. Secret values are never returned to the interface.'
            )}
          </p>
        </div>
        {!encryptionAvailable ? (
          <p className="text-xs text-danger-000">
            {t('Secure key storage is unavailable. Unlock the system keychain and try again.')}
          </p>
        ) : null}
        {message ? (
          <p role="status" className="text-xs text-muted-foreground">
            {message}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => onNavigate({ kind: 'list' })}>
            {t('Cancel')}
          </Button>
          {isOpenAlex && openAlex.hasApiKey ? (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void clearOpenAlex()}
            >
              {t('Remove key')}
            </Button>
          ) : null}
          {!isOpenAlex && ncbi.hasApiKey ? (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void clearLiteratureApiKey()}
            >
              {t('Remove key')}
            </Button>
          ) : null}
          {isOpenAlex ? (
            <Button
              type="button"
              variant="outline"
              disabled={busy || !apiKey.trim()}
              onClick={() => void validateOpenAlex()}
            >
              {busy ? t('Validating…') : t('Validate')}
            </Button>
          ) : null}
          <Button
            type="button"
            disabled={
              busy ||
              (Boolean(apiKey.trim()) && !encryptionAvailable) ||
              (isOpenAlex && !apiKey.trim())
            }
            onClick={() => void (isOpenAlex ? saveOpenAlex() : saveLiterature())}
          >
            {busy ? t('Saving…') : t('Save')}
          </Button>
        </div>
      </div>
    )
  }

  const services = [
    {
      id: 'github' as const,
      label: t('GitHub'),
      description: t('Personal access token for GitHub Skill discovery and imports.'),
      configured: githubConfigured,
      desktopOnly: true,
      Icon: GitHubMark
    },
    {
      id: 'literature' as const,
      label: t('Literature access'),
      description: t('Contact email and optional NCBI API key for research services.'),
      configured: Boolean(ncbi.contactEmail || ncbi.hasApiKey),
      desktopOnly: false,
      Icon: BookOpen
    },
    {
      id: 'openalex' as const,
      label: t('OpenAlex'),
      description: t('API key required by OpenAlex tools in the Literature Connector.'),
      configured: openAlex.hasApiKey,
      desktopOnly: true,
      Icon: BookOpen
    }
  ]

  return (
    <div className="space-y-8 p-5">
      <section>
        <h2 className="text-base font-semibold">{t('Services')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t(
            'API keys and credentials used by Open Science on your behalf, stored encrypted on this computer.'
          )}
        </p>
        <div className="mt-4 divide-y divide-border rounded-xl border border-border">
          {services.map(({ id, label, description, configured, desktopOnly, Icon }) => {
            const checking = desktopOnly && desktopCredentialAvailability === 'checking'
            const unavailable = desktopOnly && desktopCredentialAvailability === 'unavailable'
            return (
              <div key={id} className="flex items-center gap-3 px-4 py-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40">
                  <Icon className="size-4" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {label}
                    {statusLabel(configured)}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">{description}</p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  disabled={checking || unavailable}
                  onClick={() => onNavigate({ kind: 'service', serviceId: id })}
                >
                  {checking
                    ? t('Checking…')
                    : unavailable
                      ? t('Desktop only')
                      : configured
                        ? t('Manage')
                        : t('Connect')}
                </Button>
              </div>
            )
          })}
        </div>
      </section>

      {desktopCredentialAvailability === 'available' ? (
        <SettingsSection
          title={t('Connector credentials')}
          description={t(
            'Device-wide credentials that can be shared by the Custom Connectors you choose.'
          )}
          action={
            <Button type="button" onClick={() => onNavigate({ kind: 'create' })}>
              {t('New credential')}
            </Button>
          }
        >
          {deviceCredentials.length > 0 ? (
            <div className="divide-y divide-border rounded-xl border border-border">
              {deviceCredentials.map((credential) => (
                <div key={credential.id} className="flex items-center gap-3 px-4 py-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40">
                    <KeyRound className="size-4 text-muted-foreground" aria-hidden="true" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{credential.displayName}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {credential.kind === 'api_key'
                        ? t('API key · Stored')
                        : credential.kind === 'token'
                          ? t('Access token · Stored')
                          : credential.status === 'connected'
                            ? t('OAuth · Connected')
                            : t('OAuth · Sign-in required')}
                      {' · '}
                      {t('{{count}} Connectors', {
                        count: credential.consumerCount,
                        defaultValue_one: '{{count}} Connector'
                      })}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => onNavigate({ kind: 'credential', id: credential.id })}
                  >
                    {t('Manage')}
                  </Button>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          aria-label={t('Remove {{name}}', { name: credential.displayName })}
                          aria-disabled={credential.consumerCount > 0 || undefined}
                          disabled={busy}
                          onClick={() => {
                            if (credential.consumerCount > 0) return
                            if (!window.confirm(t('Remove this credential from this device?')))
                              return
                            setBusy(true)
                            setCredentialMessage(undefined)
                            void removeDeviceCredential({ id: credential.id })
                              .catch((error) =>
                                setCredentialMessage(
                                  errorDetail(error) ?? t('Could not remove credential.')
                                )
                              )
                              .finally(() => setBusy(false))
                          }}
                        >
                          <Trash2 className="size-4" aria-hidden="true" />
                        </Button>
                      </TooltipTrigger>
                      {credential.consumerCount > 0 ? (
                        <TooltipContent>
                          {t('Remove this credential from its Connectors first.')}
                        </TooltipContent>
                      ) : null}
                    </Tooltip>
                  </TooltipProvider>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t('No Connector credentials yet.')}</p>
          )}
          {credentialMessage ? (
            <p className="mt-3 text-sm text-destructive" role="alert">
              {credentialMessage}
            </p>
          ) : null}
        </SettingsSection>
      ) : null}

      <section>
        <h2 className="text-base font-semibold">{t('Custom')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t(
            'Credentials managed by Custom MCP Connectors and model providers stay in their existing configuration.'
          )}
        </p>
        {customServers.length > 0 || providers.length > 0 ? (
          <div className="mt-4 divide-y divide-border rounded-xl border border-border">
            {customServers.map((server) => {
              const configured = Boolean(
                server.hasEnv ||
                server.hasHeaders ||
                server.oauth?.hasClientSecret ||
                server.oauth?.hasTokens
              )
              return (
                <div key={server.id} className="flex items-center gap-3 px-4 py-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40">
                    <Server className="size-4 text-muted-foreground" aria-hidden="true" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{server.displayName}</p>
                    <p className="text-xs text-muted-foreground">
                      {configured
                        ? t('Credential fields configured')
                        : t('No credential fields configured')}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => onOpenConnector(server.id)}
                  >
                    {t('Manage')}
                  </Button>
                </div>
              )
            })}
            {providers.map((provider) => (
              <div key={provider.id} className="flex items-center gap-3 px-4 py-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40">
                  <KeyRound className="size-4 text-muted-foreground" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{provider.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {provider.hasKey ? t('API key configured') : t('Provider authentication')}
                  </p>
                </div>
                <Button type="button" variant="outline" onClick={() => onOpenProvider(provider)}>
                  {t('Manage')}
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">{t('No custom credentials yet.')}</p>
        )}
      </section>
    </div>
  )
}
