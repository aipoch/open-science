/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V5 */
/* Hallmark · component: device credential editor · genre: modern-minimal · theme: existing Settings tokens · slop: pass */
import { ChevronDown, Copy } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import type {
  DeviceCredentialKind,
  DeviceCredentialView,
  DeviceOAuthRegistration,
  DeviceOAuthTransport
} from '../../../../shared/settings'
import { DEFAULT_LOOPBACK_OAUTH_REDIRECT_URI } from '../../../../shared/oauth-redirect'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useSettingsStore } from '@/stores/settings-store'
import { localizeCredentialError } from './credential-error-message'
import { MaskedPasswordField } from './MaskedPasswordField'

type DeviceCredentialEditorProps = {
  credential?: DeviceCredentialView
  initialKind?: DeviceCredentialKind
  initialResourceUri?: string
  initialOAuthTransport?: DeviceOAuthTransport
  initialOAuth?: DeviceOAuthRegistration
  requiresOAuthClientSecret?: boolean
  onDone(credential?: DeviceCredentialView): void
  onCancel(): void
  previewState?:
    'default' | 'hover' | 'focus' | 'active' | 'disabled' | 'loading' | 'error' | 'success'
}

type EditorMessage = { text: string; tone: 'success' | 'error' }
type BusyAction = 'saving' | 'authenticating' | 'disconnecting'

const fieldClassName = 'grid min-w-0 gap-1.5'
const labelClassName = 'text-sm font-medium text-foreground'
const helperClassName = 'min-h-[1lh] text-xs leading-5 text-muted-foreground'
const RequiredMark = (): React.JSX.Element => (
  <span aria-hidden="true" className="ml-0.5 text-destructive">
    *
  </span>
)

export function DeviceCredentialEditor({
  credential,
  initialKind,
  initialResourceUri,
  initialOAuthTransport,
  initialOAuth,
  requiresOAuthClientSecret = false,
  onDone,
  onCancel,
  previewState
}: DeviceCredentialEditorProps): React.JSX.Element {
  const { t } = useTranslation()
  const createCredential = useSettingsStore((state) => state.createDeviceCredential)
  const updateCredential = useSettingsStore((state) => state.updateDeviceCredential)
  const encryptionAvailable = useSettingsStore((state) => state.encryptionAvailable)
  const authenticateCredential = useSettingsStore((state) => state.authenticateDeviceCredential)
  const cancelAuthentication = useSettingsStore(
    (state) => state.cancelDeviceCredentialAuthentication
  )
  const disconnectCredential = useSettingsStore((state) => state.disconnectDeviceCredential)
  const deviceCredentials = useSettingsStore((state) => state.deviceCredentials)
  const [createdCredential, setCreatedCredential] = useState<DeviceCredentialView>()
  const [displayName, setDisplayName] = useState(credential?.displayName ?? '')
  const [kind, setKind] = useState<DeviceCredentialKind>(
    credential?.kind ?? initialKind ?? 'api_key'
  )
  const [secret, setSecret] = useState('')
  const [resourceUri, setResourceUri] = useState(
    credential?.resourceUri ?? initialResourceUri ?? ''
  )
  const [oauthTransport, setOAuthTransport] = useState<DeviceOAuthTransport>(
    credential?.transport ?? initialOAuthTransport ?? 'streamable_http'
  )
  const [clientMetadataUrl, setClientMetadataUrl] = useState(initialOAuth?.clientMetadataUrl ?? '')
  const [authorizationServerUrl, setAuthorizationServerUrl] = useState(
    initialOAuth?.authorizationServerUrl ?? ''
  )
  const [clientId, setClientId] = useState(initialOAuth?.clientId ?? '')
  const [redirectUri, setRedirectUri] = useState(initialOAuth?.redirectUri ?? '')
  const [scopes, setScopes] = useState((initialOAuth?.scopes ?? []).join(' '))
  const [advancedOpen, setAdvancedOpen] = useState(
    requiresOAuthClientSecret ||
      initialOAuthTransport === 'sse' ||
      Boolean(
        initialOAuth?.clientMetadataUrl ||
        initialOAuth?.authorizationServerUrl ||
        initialOAuth?.clientId ||
        initialOAuth?.redirectUri ||
        initialOAuth?.scopes?.length
      )
  )
  const [usePreRegisteredOAuthClient, setUsePreRegisteredOAuthClient] = useState(
    requiresOAuthClientSecret || Boolean(initialOAuth?.clientId || initialOAuth?.redirectUri)
  )
  const [oauthDiscoveryOpen, setOAuthDiscoveryOpen] = useState(
    Boolean(initialOAuth?.clientMetadataUrl || initialOAuth?.authorizationServerUrl)
  )
  const [customRedirectUriOpen, setCustomRedirectUriOpen] = useState(
    Boolean(initialOAuth?.redirectUri)
  )
  const [callbackUriCopied, setCallbackUriCopied] = useState(false)
  const [busyAction, setBusyAction] = useState<BusyAction | undefined>(
    previewState === 'loading' ? 'saving' : undefined
  )
  const [message, setMessage] = useState<EditorMessage | undefined>(
    previewState === 'error'
      ? { text: t('Could not save credential.'), tone: 'error' }
      : previewState === 'success'
        ? { text: t('Credential saved.'), tone: 'success' }
        : undefined
  )
  const busy = busyAction !== undefined
  const activeCredential = credential
    ? (deviceCredentials.find(({ id }) => id === credential.id) ?? credential)
    : createdCredential
      ? (deviceCredentials.find(({ id }) => id === createdCredential.id) ?? createdCredential)
      : undefined
  const editing = activeCredential !== undefined
  const secureStorageRequired = !editing || secret.trim().length > 0
  const oauthRegistrationValid =
    !usePreRegisteredOAuthClient ||
    (Boolean(clientId.trim()) &&
      Boolean(authorizationServerUrl.trim()) &&
      (!requiresOAuthClientSecret || Boolean(secret.trim())))
  const canSave =
    displayName.trim().length > 0 &&
    (editing ||
      (kind === 'oauth'
        ? resourceUri.trim().length > 0 && oauthRegistrationValid
        : secret.trim().length > 0)) &&
    (!secureStorageRequired || encryptionAvailable) &&
    !busy &&
    previewState !== 'disabled'

  const save = async (): Promise<void> => {
    if (!canSave) return
    setBusyAction('saving')
    setMessage(undefined)
    try {
      if (activeCredential) {
        await updateCredential({
          id: activeCredential.id,
          displayName: displayName.trim(),
          ...(activeCredential.kind !== 'oauth' && secret.trim() ? { secret } : {})
        })
      } else if (kind === 'oauth') {
        const created = await createCredential({
          displayName: displayName.trim(),
          kind,
          resourceUri: resourceUri.trim(),
          transport: oauthTransport,
          oauth: {
            ...(!usePreRegisteredOAuthClient && oauthDiscoveryOpen && clientMetadataUrl.trim()
              ? { clientMetadataUrl: clientMetadataUrl.trim() }
              : {}),
            ...((usePreRegisteredOAuthClient || oauthDiscoveryOpen) && authorizationServerUrl.trim()
              ? { authorizationServerUrl: authorizationServerUrl.trim() }
              : {}),
            ...(usePreRegisteredOAuthClient && clientId.trim()
              ? { clientId: clientId.trim() }
              : {}),
            ...(usePreRegisteredOAuthClient && customRedirectUriOpen && redirectUri.trim()
              ? { redirectUri: redirectUri.trim() }
              : {}),
            ...(scopes.trim()
              ? {
                  scopes: scopes
                    .split(/[\s,]+/u)
                    .map((scope) => scope.trim())
                    .filter(Boolean)
                }
              : {}),
            ...(usePreRegisteredOAuthClient && secret.trim() ? { clientSecret: secret } : {})
          }
        })
        setCreatedCredential(created)
        setBusyAction('authenticating')
        try {
          await authenticateCredential({ id: created.id })
          onDone(created)
        } catch (error) {
          setMessage({
            text: localizeCredentialError(error, t, 'Could not connect credential.'),
            tone: 'error'
          })
        }
        return
      } else {
        const created = await createCredential({ displayName: displayName.trim(), kind, secret })
        onDone(created)
        return
      }
      onDone(createdCredential ? activeCredential : undefined)
    } catch (error) {
      if (kind === 'oauth') setAdvancedOpen(true)
      setMessage({
        text: localizeCredentialError(error, t, 'Could not save credential.'),
        tone: 'error'
      })
    } finally {
      setBusyAction(undefined)
    }
  }

  const authenticate = async (): Promise<void> => {
    if (!activeCredential || activeCredential.kind !== 'oauth' || busy) return
    setBusyAction('authenticating')
    setMessage(undefined)
    try {
      await authenticateCredential({ id: activeCredential.id })
      if (createdCredential) {
        onDone(activeCredential)
        return
      }
      setMessage({ text: t('Credential connected.'), tone: 'success' })
    } catch (error) {
      setMessage({
        text: localizeCredentialError(error, t, 'Could not connect credential.'),
        tone: 'error'
      })
    } finally {
      setBusyAction(undefined)
    }
  }

  const disconnect = async (): Promise<void> => {
    if (!activeCredential || activeCredential.kind !== 'oauth' || busy) return
    setBusyAction('disconnecting')
    setMessage(undefined)
    try {
      await disconnectCredential({ id: activeCredential.id })
      setMessage({ text: t('Credential disconnected.'), tone: 'success' })
    } catch (error) {
      setMessage({
        text: localizeCredentialError(error, t, 'Could not disconnect credential.'),
        tone: 'error'
      })
    } finally {
      setBusyAction(undefined)
    }
  }

  const copyDefaultCallbackUri = async (): Promise<void> => {
    if (!navigator.clipboard?.writeText) return
    try {
      await navigator.clipboard.writeText(DEFAULT_LOOPBACK_OAUTH_REDIRECT_URI)
      setCallbackUriCopied(true)
    } catch {
      // Clipboard access may be unavailable in sandboxed renderer contexts.
    }
  }

  return (
    <div className="p-5">
      <div className="grid w-full gap-5">
        <div>
          <h2 className="text-base font-semibold">
            {editing ? t('Edit credential') : t('New credential')}
          </h2>
          <p className="mt-1 max-w-[65ch] text-sm text-muted-foreground">
            {t('Stored on this device and shared only with the Connectors you select.')}
          </p>
        </div>

        <label className={fieldClassName}>
          <span className={labelClassName}>
            {t('Name')}
            <RequiredMark />
          </span>
          <Input
            aria-required="true"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
          <span className={helperClassName}>
            {t('Use a name that identifies the account or service.')}
          </span>
        </label>

        {!editing ? (
          <label className={fieldClassName}>
            <span className={labelClassName}>{t('Credential type')}</span>
            <Select value={kind} onValueChange={(value) => setKind(value as DeviceCredentialKind)}>
              <SelectTrigger aria-label={t('Credential type')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="api_key">{t('API key')}</SelectItem>
                <SelectItem value="token">{t('Access token')}</SelectItem>
                <SelectItem value="oauth">{t('OAuth')}</SelectItem>
              </SelectContent>
            </Select>
            <span className={helperClassName}>
              {t('Access tokens use Bearer authentication only for an Authorization header.')}
            </span>
          </label>
        ) : null}

        {kind === 'oauth' && !editing ? (
          <>
            <label className={fieldClassName}>
              <span className={labelClassName}>
                {t('Resource URL')}
                <RequiredMark />
              </span>
              <Input
                aria-required="true"
                value={resourceUri}
                onChange={(event) => setResourceUri(event.target.value)}
                placeholder="https://mcp.example.com/"
              />
              <span className={helperClassName}>
                {t('Only Connectors with this exact resource URL can use the credential.')}
              </span>
            </label>

            <div>
              <button
                type="button"
                aria-expanded={advancedOpen}
                aria-controls="credential-oauth-advanced-settings"
                onClick={() => setAdvancedOpen((open) => !open)}
                className="flex min-h-8 w-full items-center gap-2 rounded-lg py-1.5 text-left text-sm font-medium whitespace-nowrap text-foreground transition-colors duration-150 outline-none motion-reduce:transition-none hover:text-primary focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <ChevronDown
                  className={`size-4 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none ${advancedOpen ? '' : '-rotate-90'}`}
                  aria-hidden="true"
                />
                {t('Advanced settings')}
              </button>

              {advancedOpen ? (
                <div id="credential-oauth-advanced-settings" className="mt-3 grid gap-4">
                  <label className={fieldClassName}>
                    <span className={labelClassName}>{t('Transport')}</span>
                    <Select
                      value={oauthTransport}
                      onValueChange={(value) => setOAuthTransport(value as DeviceOAuthTransport)}
                    >
                      <SelectTrigger aria-label={t('Transport')}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="streamable_http">{t('Streamable HTTP')}</SelectItem>
                        <SelectItem value="sse">{t('SSE')}</SelectItem>
                      </SelectContent>
                    </Select>
                    <span className={helperClassName}>
                      {t('Match the transport used by the Connector.')}
                    </span>
                  </label>

                  <label className={fieldClassName}>
                    <span className={labelClassName}>{t('Scopes')}</span>
                    <Input value={scopes} onChange={(event) => setScopes(event.target.value)} />
                    <span className={helperClassName}>
                      {t('Separate scopes with spaces or commas.')}
                    </span>
                  </label>

                  <label className="flex items-start gap-2.5 py-1">
                    <input
                      type="checkbox"
                      aria-label={t('Use a pre-registered OAuth client')}
                      checked={usePreRegisteredOAuthClient}
                      disabled={requiresOAuthClientSecret}
                      className="mt-0.5 size-4 shrink-0"
                      onChange={(event) => setUsePreRegisteredOAuthClient(event.target.checked)}
                    />
                    <span>
                      <span className="block text-sm font-medium text-foreground">
                        {t('Use a pre-registered OAuth client')}
                      </span>
                      <span className={helperClassName}>
                        {requiresOAuthClientSecret
                          ? t('Required by this imported Connector.')
                          : t('Only enable this if your OAuth provider gave you a Client ID.')}
                      </span>
                    </span>
                  </label>

                  {usePreRegisteredOAuthClient || oauthDiscoveryOpen ? (
                    <label className={fieldClassName}>
                      <span className={labelClassName}>
                        {t('Authorization server URL')}
                        {usePreRegisteredOAuthClient ? <RequiredMark /> : null}
                      </span>
                      <Input
                        aria-required={usePreRegisteredOAuthClient || undefined}
                        value={authorizationServerUrl}
                        onChange={(event) => setAuthorizationServerUrl(event.target.value)}
                        placeholder={t('Auto-discover from MCP server')}
                      />
                    </label>
                  ) : null}

                  {!usePreRegisteredOAuthClient ? (
                    oauthDiscoveryOpen ? (
                      <label className={fieldClassName}>
                        <span className={labelClassName}>{t('Client metadata URL')}</span>
                        <Input
                          value={clientMetadataUrl}
                          onChange={(event) => setClientMetadataUrl(event.target.value)}
                          placeholder="https://client.example.com/oauth/metadata.json"
                        />
                      </label>
                    ) : (
                      <Button
                        type="button"
                        variant="link"
                        size="sm"
                        className="h-auto w-fit p-0 text-xs"
                        onClick={() => setOAuthDiscoveryOpen(true)}
                      >
                        {t('Configure OAuth discovery')}
                      </Button>
                    )
                  ) : (
                    <>
                      <label className={fieldClassName}>
                        <span className={labelClassName}>
                          {t('Client ID')}
                          <RequiredMark />
                        </span>
                        <Input
                          aria-required="true"
                          value={clientId}
                          onChange={(event) => setClientId(event.target.value)}
                          placeholder={t('Pre-registered client ID')}
                        />
                      </label>

                      <div className={fieldClassName}>
                        <span className={labelClassName}>{t('Default callback URI')}</span>
                        <div className="flex min-w-0 items-center gap-2">
                          <Input
                            aria-label={t('Default callback URI')}
                            readOnly
                            value={DEFAULT_LOOPBACK_OAUTH_REDIRECT_URI}
                            className="min-w-0 font-mono"
                          />
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => void copyDefaultCallbackUri()}
                          >
                            <Copy aria-hidden="true" />
                            {callbackUriCopied ? t('Copied!') : t('Copy')}
                          </Button>
                        </div>
                        <span className={helperClassName}>
                          {t(
                            'Register this callback URI with your OAuth provider. Open Science adds an available port at runtime.'
                          )}
                        </span>
                        {!customRedirectUriOpen ? (
                          <Button
                            type="button"
                            variant="link"
                            size="sm"
                            className="h-auto w-fit p-0 text-xs"
                            onClick={() => setCustomRedirectUriOpen(true)}
                          >
                            {t('Already registered a different callback URI?')}
                          </Button>
                        ) : null}
                      </div>

                      {customRedirectUriOpen ? (
                        <label className={fieldClassName}>
                          <span className={labelClassName}>{t('Redirect URI')}</span>
                          <Input
                            type="url"
                            value={redirectUri}
                            onChange={(event) => setRedirectUri(event.target.value)}
                            placeholder="http://127.0.0.1:8080/callback"
                          />
                          <span className={helperClassName}>
                            {t(
                              'Use the exact loopback URI registered for this client. The port may differ at runtime.'
                            )}
                          </span>
                        </label>
                      ) : null}

                      <label className={fieldClassName}>
                        <span className={labelClassName}>
                          {t('Client secret')}
                          {requiresOAuthClientSecret ? <RequiredMark /> : null}
                        </span>
                        <MaskedPasswordField
                          aria-required={requiresOAuthClientSecret || undefined}
                          value={secret}
                          onChange={setSecret}
                        />
                        <span className={helperClassName}>
                          {requiresOAuthClientSecret
                            ? t('This imported Connector requires a client secret entered locally.')
                            : t('Leave blank for public clients.')}
                        </span>
                      </label>
                    </>
                  )}
                </div>
              ) : null}
            </div>
          </>
        ) : null}

        {kind !== 'oauth' ? (
          <label className={fieldClassName}>
            <span className={labelClassName}>
              {editing ? t('Replacement value') : t('Value')}
              {!editing ? <RequiredMark /> : null}
            </span>
            <MaskedPasswordField
              aria-required={!editing || undefined}
              value={secret}
              onChange={setSecret}
            />
            <span className={helperClassName}>
              {editing
                ? t('Leave blank to keep the stored value.')
                : t('The value is encrypted before it is written to disk.')}
            </span>
          </label>
        ) : null}

        {message ? (
          <p
            className={
              message.tone === 'success'
                ? 'text-sm text-status-success-foreground'
                : 'text-sm text-destructive'
            }
            role={message.tone === 'error' ? 'alert' : 'status'}
          >
            {message.text}
          </p>
        ) : null}

        {!encryptionAvailable ? (
          <p className="text-sm text-destructive">
            {t('Secure key storage is unavailable. Unlock the system keychain and try again.')}
          </p>
        ) : null}

        {activeCredential?.kind === 'oauth' ? (
          <div className="flex items-center gap-2 rounded-lg border border-border p-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">
                {activeCredential.status === 'connected' ? t('Connected') : t('Sign-in required')}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {activeCredential.resourceUri}
              </p>
              {activeCredential.consumerCount > 0 ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {t(
                    'Disconnect removes the shared OAuth tokens from this app and disables every Connector using this credential. It does not revoke access on the service.'
                  )}
                </p>
              ) : null}
            </div>
            {busyAction === 'authenticating' ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => void cancelAuthentication({ id: activeCredential.id })}
              >
                {t('Cancel sign-in')}
              </Button>
            ) : activeCredential.status === 'connected' ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy || !encryptionAvailable}
                  onClick={() => void authenticate()}
                >
                  {t('Sign in again')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void disconnect()}
                >
                  {t('Disconnect')}
                </Button>
              </>
            ) : (
              <Button
                type="button"
                variant="outline"
                disabled={busy || !encryptionAvailable}
                onClick={() => void authenticate()}
              >
                {t('Sign in')}
              </Button>
            )}
          </div>
        ) : null}

        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
            {t('Cancel')}
          </Button>
          <Button type="button" onClick={() => void save()} disabled={!canSave} aria-busy={busy}>
            {busyAction === 'saving'
              ? t('Saving…')
              : busyAction === 'authenticating'
                ? t('Signing in…')
                : !editing && kind === 'oauth'
                  ? t('Save and sign in')
                  : t('Save')}
          </Button>
        </div>
      </div>
    </div>
  )
}
