import { BookOpen, Check, KeyRound, Server } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { ProviderView } from '../../../../shared/settings'
import type { OpenAlexCredentialValidation } from '../../../../shared/settings'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { errorDetail } from '@/lib/error-detail'
import { useSettingsStore } from '@/stores/settings-store'
import { GitHubTokenControl } from './GitHubTokenControl'
import { MaskedPasswordField } from './MaskedPasswordField'

export type CredentialsServiceId = 'github' | 'literature' | 'openalex'
export type CredentialsView =
  { kind: 'list' } | { kind: 'service'; serviceId: CredentialsServiceId }

type CredentialsPanelProps = {
  view: CredentialsView
  onNavigate(view: CredentialsView): void
  onOpenConnector(id: string): void
  onOpenProvider(provider: ProviderView): void
}

const statusLabel = (configured: boolean): React.JSX.Element | null =>
  configured ? <Check className="size-4 text-primary" aria-hidden="true" /> : null

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
  const providers = useSettingsStore((state) => state.providers)
  const loadConnectors = useSettingsStore((state) => state.loadConnectors)
  const setOpenAlexCredential = useSettingsStore((state) => state.setOpenAlexCredential)
  const validateOpenAlexCredential = useSettingsStore((state) => state.validateOpenAlexCredential)
  const setNcbiCredentials = useSettingsStore((state) => state.setNcbiCredentials)
  const encryptionAvailable = useSettingsStore((state) => state.encryptionAvailable)
  const [githubConfigured, setGithubConfigured] = useState(false)
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
    void window.api.settings
      .getGitHubTokenStatus()
      .then((status) => setGithubConfigured(status.configured))
      .catch(() => undefined)
  }, [loadConnectors])

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

  if (view.kind === 'service') {
    if (view.serviceId === 'github') {
      return (
        <div className="p-5">
          <p className="mb-4 text-sm text-muted-foreground">
            {t(
              'Used for GitHub Skill discovery and imports. The credential is verified before saving.'
            )}
          </p>
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
            <GitHubTokenControl defaultExpanded />
          </div>
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
      Icon: KeyRound
    },
    {
      id: 'literature' as const,
      label: t('Literature access'),
      description: t('Contact email and optional NCBI API key for research services.'),
      configured: Boolean(ncbi.contactEmail || ncbi.hasApiKey),
      Icon: BookOpen
    },
    {
      id: 'openalex' as const,
      label: t('OpenAlex'),
      description: t('API key required by OpenAlex tools in the Literature Connector.'),
      configured: openAlex.hasApiKey,
      Icon: KeyRound
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
          {services.map(({ id, label, description, configured, Icon }) => (
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
                onClick={() => onNavigate({ kind: 'service', serviceId: id })}
              >
                {configured ? t('Manage') : t('Connect')}
              </Button>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-base font-semibold">{t('Custom')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t(
            'Credentials managed by Custom MCP Connectors and model providers stay in their existing configuration.'
          )}
        </p>
        <div className="mt-4 space-y-2">
          {customServers.map((server) => {
            const configured = Boolean(
              server.hasEnv ||
              server.hasHeaders ||
              server.oauth?.hasClientSecret ||
              server.oauth?.hasTokens
            )
            return (
              <div
                key={server.id}
                className="flex items-center gap-3 rounded-lg border border-border px-4 py-3"
              >
                <Server className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{server.displayName}</p>
                  <p className="text-xs text-muted-foreground">
                    {configured
                      ? t('Credential fields configured')
                      : t('No credential fields configured')}
                  </p>
                </div>
                <Button type="button" variant="outline" onClick={() => onOpenConnector(server.id)}>
                  {t('Manage')}
                </Button>
              </div>
            )
          })}
          {providers.map((provider) => (
            <div
              key={provider.id}
              className="flex items-center gap-3 rounded-lg border border-border px-4 py-3"
            >
              <KeyRound className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
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
          {customServers.length === 0 && providers.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('No custom credentials yet.')}</p>
          ) : null}
        </div>
      </section>
    </div>
  )
}
