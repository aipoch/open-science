/* Hallmark · pre-emit critique: P5 H5 E4 S5 R5 V4 */
import { ChevronDown } from 'lucide-react'
import { RadioGroup } from 'radix-ui'
import { useMemo, useState } from 'react'
import { useTranslation, Trans } from 'react-i18next'

import type {
  AddCustomServerRequest,
  ConnectorTemplateDefinition,
  CustomServerTransport,
  CustomServerView,
  UpdateCustomServerRequest
} from '../../../../shared/settings'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useSettingsStore } from '@/stores/settings-store'
import { ConnectorOAuthSignInDialog } from './ConnectorOAuthSignInDialog'
import { isCustomConnectorName, toCustomConnectorName } from '../../../../shared/custom-connector'
import {
  RESOURCE_ID_MAX_LENGTH,
  inferResourceId,
  validateResourceId
} from '../../../../shared/resource-id'

// Which kind of custom connector is being added: a local stdio command or a remote HTTP/SSE server.
type ConnectorMode = 'local' | 'remote'

// The two remote transports, kept out of the local (stdio) mode.
type RemoteTransport = Extract<CustomServerTransport, 'streamable_http' | 'sse'>
type RemoteAuth = 'none' | 'oauth' | 'headers'

const fieldClassName = 'grid min-w-0 gap-1.5'
const fieldLabelClassName = 'text-sm font-medium text-foreground'
const helperClassName = 'text-xs leading-5 text-muted-foreground'

// Splits an arguments textarea on any whitespace/newlines into a positional arg list, dropping empties.
const parseArgs = (raw: string, onePerLine = false): string[] =>
  raw
    .split(onePerLine ? /\n/ : /\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)

// Parses one KEY=VALUE per line into a record; blank lines and lines without '=' are ignored.
const parseEnv = (raw: string): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return env
}

// Parses one "Name: Value" per line into a headers record; blank/invalid lines are ignored.
const parseHeaders = (raw: string): Record<string, string> => {
  const headers: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const colon = trimmed.indexOf(':')
    if (colon <= 0) continue
    headers[trimmed.slice(0, colon).trim()] = trimmed.slice(colon + 1).trim()
  }
  return headers
}

// A required-field marker next to a label. Purely visual; the real guard is the disabled Add button.
const RequiredMark = (): React.JSX.Element => (
  <span aria-hidden="true" className="ml-0.5 text-destructive">
    *
  </span>
)

const REMOTE_TRANSPORTS: { id: RemoteTransport; label: string }[] = [
  { id: 'streamable_http', label: 'Streamable HTTP' },
  { id: 'sse', label: 'SSE' }
]

// Common runtimes used to launch a local stdio MCP server, plus an "other" escape hatch for an
// absolute path or an uncommon binary. Labels are catalog keys, resolved at render.
const COMMAND_OPTIONS = [
  { value: 'npx', labelKey: 'npx — Node package' },
  { value: 'uvx', labelKey: 'uvx — Python (uv)' },
  { value: 'node', labelKey: 'node — script file' },
  { value: 'python3', labelKey: 'python3 — script file' },
  { value: 'docker', labelKey: 'docker — container' },
  { value: 'other', labelKey: 'Other…' }
] as const satisfies { value: string; labelKey: string }[]

type ConnectorAddFormProps = {
  initialTransport?: ConnectorMode
  initialTemplate?: ConnectorTemplateDefinition
  // When set, the form edits this custom server instead of adding a new one. Its name is immutable.
  editServer?: CustomServerView
  // Stable edit intent from Settings navigation. Unlike editServer, this remains set if a live
  // catalog refresh removes the target while the draft is open.
  editServerId?: string
  // Called after the custom server has been added/updated successfully.
  onDone: () => void
  onCancel: () => void
}

// Maps a stored transport to the form's local/remote mode.
const modeForTransport = (transport: CustomServerTransport): ConnectorMode =>
  transport === 'stdio' ? 'local' : 'remote'

// Add or edit a custom MCP server ("custom connector"): a local stdio command or a remote HTTP/SSE
// server, gated behind an explicit trust confirmation the way Claude Science's "Add connector" flow is.
export function ConnectorAddForm({
  initialTransport,
  initialTemplate,
  editServer,
  editServerId,
  onDone,
  onCancel
}: ConnectorAddFormProps): React.JSX.Element {
  const { t } = useTranslation()
  const { t: tCommon } = useTranslation()
  const addCustomServer = useSettingsStore((s) => s.addCustomServer)
  const updateCustomServer = useSettingsStore((s) => s.updateCustomServer)
  const encryptionAvailable = useSettingsStore((s) => s.encryptionAvailable)
  const connectors = useSettingsStore((s) => s.connectors)
  const customServers = useSettingsStore((s) => s.customServers)
  const reservedCustomServerIds = useSettingsStore((s) => s.reservedCustomServerIds ?? [])
  const stableEditServerId = editServerId ?? editServer?.id
  const isEdit = stableEditServerId !== undefined
  const editTargetMissing = isEdit && editServer === undefined

  const [mode, setMode] = useState<ConnectorMode>(
    editServer
      ? modeForTransport(editServer.transport)
      : initialTemplate
        ? modeForTransport(initialTemplate.transport)
        : (initialTransport ?? 'local')
  )
  const [displayName, setDisplayName] = useState(
    editServer?.displayName ?? initialTemplate?.displayName ?? ''
  )
  const [name, setName] = useState(editServer?.name ?? initialTemplate?.name ?? '')
  const [nameTouched, setNameTouched] = useState(initialTemplate !== undefined)
  const currentName = isEdit ? name : nameTouched ? name : toCustomConnectorName(displayName)
  const [id, setId] = useState('')
  const [idTouched, setIdTouched] = useState(false)
  const [fallbackId] = useState(() => crypto.randomUUID())
  const usedIds = useMemo(
    () =>
      new Set([
        ...connectors.map((connector) => connector.id),
        ...customServers.flatMap((server) => [server.id, server.name]),
        ...reservedCustomServerIds
      ]),
    [connectors, customServers, reservedCustomServerIds]
  )
  const inferredId = inferResourceId(currentName)
  const generatedId = inferredId && !usedIds.has(inferredId) ? inferredId : fallbackId
  const currentId = isEdit ? (stableEditServerId ?? '') : idTouched ? id : generatedId
  const submittedId = idTouched ? id.trim() : generatedId === fallbackId ? fallbackId : undefined
  const rawIdError = useMemo((): string | null => {
    if (isEdit || !idTouched || !id.trim()) return null
    const validationError = validateResourceId(id.trim())
    if (validationError) return validationError
    return usedIds.has(id.trim()) ? 'ID is already in use.' : null
  }, [id, idTouched, isEdit, usedIds])
  const idError =
    rawIdError === 'ID may only contain lowercase letters, numbers, and hyphens.'
      ? t('ID may only contain lowercase letters, numbers, and hyphens.')
      : rawIdError === 'IDs starting with os- or mcp- are reserved.'
        ? t('IDs starting with os- or mcp- are reserved.')
        : rawIdError === 'ID is already in use.'
          ? t('ID is already in use.')
          : rawIdError
  const nameError = useMemo((): string | null => {
    if (!currentName || !isCustomConnectorName(currentName)) {
      return t('Use only lowercase letters, numbers, and hyphens.')
    }
    if (connectors.some((connector) => connector.id === currentName)) {
      return t('This name is reserved by a built-in Connector.')
    }
    if (
      customServers.some(
        (server) =>
          server.id !== stableEditServerId &&
          (server.name === currentName || (!isEdit && server.id === currentName))
      )
    ) {
      return t('A custom Connector with this name already exists.')
    }
    return null
  }, [connectors, currentName, customServers, stableEditServerId, isEdit, t])
  const [description, setDescription] = useState(
    editServer?.description ?? initialTemplate?.description ?? ''
  )
  // Local (stdio) fields. The command is chosen from common runtimes, with an "other" escape hatch
  // for an absolute path or an uncommon binary.
  const initialCommand = editServer?.command ?? initialTemplate?.command
  const initialCommandIsPreset = initialCommand
    ? COMMAND_OPTIONS.some((o) => o.value === initialCommand)
    : true
  const [commandChoice, setCommandChoice] = useState<string>(
    initialCommand ? (initialCommandIsPreset ? initialCommand : 'other') : 'npx'
  )
  const [customCommand, setCustomCommand] = useState(
    initialCommand && !initialCommandIsPreset ? initialCommand : ''
  )
  const command = commandChoice === 'other' ? customCommand : commandChoice
  const [argsText, setArgsText] = useState(
    (editServer?.args ?? initialTemplate?.args ?? []).join(initialTemplate ? '\n' : ' ')
  )
  const [envText, setEnvText] = useState(
    (initialTemplate?.requiredSecrets?.environment ?? []).map((key) => `${key}=`).join('\n')
  )
  // Remote fields.
  const [url, setUrl] = useState(editServer?.url ?? initialTemplate?.url ?? '')
  const [remoteTransport, setRemoteTransport] = useState<RemoteTransport>(
    editServer && editServer.transport !== 'stdio'
      ? editServer.transport
      : initialTemplate && initialTemplate.transport !== 'stdio'
        ? initialTemplate.transport
        : 'streamable_http'
  )
  const [remoteAuth, setRemoteAuth] = useState<RemoteAuth>(
    editServer?.oauth || initialTemplate?.oauth
      ? 'oauth'
      : editServer?.hasHeaders || initialTemplate?.requiredSecrets?.headers?.length
        ? 'headers'
        : 'none'
  )
  const [oauthScopesText, setOauthScopesText] = useState(
    (editServer?.oauth?.scopes ?? initialTemplate?.oauth?.scopes ?? []).join(' ')
  )
  const [authorizationServerUrl, setAuthorizationServerUrl] = useState(
    editServer?.oauth?.authorizationServerUrl ??
      initialTemplate?.oauth?.authorizationServerUrl ??
      ''
  )
  const [clientMetadataUrl, setClientMetadataUrl] = useState(
    editServer?.oauth?.clientMetadataUrl ?? initialTemplate?.oauth?.clientMetadataUrl ?? ''
  )
  const [clientId, setClientId] = useState(
    editServer?.oauth?.clientId ?? initialTemplate?.oauth?.clientId ?? ''
  )
  // Secrets are write-only: an edit starts blank and preserves the encrypted value unless the user
  // enters a replacement or explicitly removes it.
  const [clientSecret, setClientSecret] = useState('')
  const [removeClientSecret, setRemoveClientSecret] = useState(false)
  const [headersText, setHeadersText] = useState(
    (initialTemplate?.requiredSecrets?.headers ?? []).map((header) => `${header}: `).join('\n')
  )
  const [advancedOpen, setAdvancedOpen] = useState(
    initialTemplate !== undefined ||
      Boolean(
        editServer?.description ||
        editServer?.args?.length ||
        editServer?.hasHeaders ||
        editServer?.oauth ||
        (editServer?.transport &&
          editServer.transport !== 'stdio' &&
          editServer.transport !== 'streamable_http')
      )
  )
  // Add-time trust confirmation and submission state. An existing (already-trusted) server starts trusted.
  const [trusted, setTrusted] = useState(isEdit)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [oauthSignInServer, setOAuthSignInServer] = useState<CustomServerView>()
  // A generated-ID collision must remain visible instead of leaving the disabled submit button as
  // the only sign that something needs attention.
  const advancedVisible =
    advancedOpen || Boolean(displayName.trim() && nameError) || Boolean(idError)

  const parsedArgs = parseArgs(argsText, initialTemplate !== undefined)
  const parsedEnv = parseEnv(envText)
  const parsedHeaders = parseHeaders(headersText)
  const commandPreview = [command.trim(), ...parsedArgs].filter((part) => part.length > 0).join(' ')
  const requiredEnvironment = initialTemplate?.requiredSecrets?.environment ?? []
  const requiredHeaders = initialTemplate?.requiredSecrets?.headers ?? []
  const requiresOAuthClientSecret = initialTemplate?.requiredSecrets?.oauthClientSecret === true
  const oauthRegistrationValid =
    remoteAuth !== 'oauth' ||
    (!clientSecret.trim() && !clientId.trim()) ||
    (Boolean(clientId.trim()) &&
      Boolean(authorizationServerUrl.trim()) &&
      !clientMetadataUrl.trim())
  const requiredSecretValuesFilled =
    (requiredEnvironment.length === 0 ||
      (mode === 'local' &&
        requiredEnvironment.every((key) => (parsedEnv[key] ?? '').trim().length > 0))) &&
    (requiredHeaders.length === 0 ||
      (mode === 'remote' &&
        remoteAuth === 'headers' &&
        requiredHeaders.every((header) => (parsedHeaders[header] ?? '').trim().length > 0))) &&
    (!requiresOAuthClientSecret ||
      (mode === 'remote' &&
        remoteAuth === 'oauth' &&
        encryptionAvailable &&
        clientSecret.trim().length > 0))

  const requiredFilled =
    displayName.trim().length > 0 &&
    !nameError &&
    !idError &&
    (mode === 'local' ? command.trim().length > 0 : url.trim().length > 0) &&
    oauthRegistrationValid &&
    requiredSecretValuesFilled
  const canSubmit = requiredFilled && trusted && !submitting && !editTargetMissing

  const switchMode = (next: ConnectorMode): void => {
    setMode(next)
    setError(null)
  }

  const handleSubmit = async (): Promise<void> => {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      const env = parsedEnv
      const headers = parsedHeaders
      const oauthScopes = oauthScopesText
        .split(/[\s,]+/)
        .map((scope) => scope.trim())
        .filter(Boolean)
      // Omitted env/headers keep the stored (secret) values on edit; on add they are simply unset.
      const hasEnv = envText.trim().length > 0
      const hasHeaders = headersText.trim().length > 0
      const transport: CustomServerTransport = mode === 'local' ? 'stdio' : remoteTransport
      const oauth =
        remoteAuth === 'oauth'
          ? {
              ...(authorizationServerUrl.trim()
                ? { authorizationServerUrl: authorizationServerUrl.trim() }
                : {}),
              ...(clientMetadataUrl.trim() ? { clientMetadataUrl: clientMetadataUrl.trim() } : {}),
              ...(oauthScopes.length ? { scopes: oauthScopes } : {}),
              ...(clientId.trim() ? { clientId: clientId.trim() } : {})
            }
          : null
      const shared = {
        displayName: displayName.trim(),
        description: description.trim() || undefined,
        transport,
        ...(mode === 'local'
          ? {
              command: command.trim(),
              ...(parsedArgs.length > 0 ? { args: parsedArgs } : {})
            }
          : {
              url: url.trim(),
              oauth
            })
      }

      if (isEdit) {
        if (editTargetMissing || !stableEditServerId) return
        const request: UpdateCustomServerRequest = {
          id: stableEditServerId,
          ...shared,
          ...(mode === 'local' && hasEnv ? { env } : {}),
          ...(mode === 'remote' && remoteAuth !== 'headers'
            ? { headers: {} }
            : hasHeaders
              ? { headers }
              : {}),
          ...(mode === 'remote' && remoteAuth !== 'oauth' ? { oauth: null } : {})
        }
        if (mode === 'remote' && oauth) {
          request.oauth = {
            ...oauth,
            ...(removeClientSecret
              ? { clientSecret: null }
              : clientSecret.trim()
                ? { clientSecret: clientSecret.trim() }
                : {})
          }
        }
        await updateCustomServer(request)
        onDone()
      } else {
        const request: AddCustomServerRequest = {
          ...(submittedId ? { id: submittedId } : {}),
          name: currentName,
          ...shared,
          ...(mode === 'local' && Object.keys(env).length > 0 ? { env } : {}),
          ...(mode === 'remote' && remoteAuth === 'headers' && Object.keys(headers).length > 0
            ? { headers }
            : {})
        }
        if (mode === 'remote' && oauth) {
          request.oauth = {
            ...oauth,
            ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {})
          }
        }
        const created = await addCustomServer(request)
        if (request.oauth) setOAuthSignInServer(created)
        else onDone()
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : undefined
      const localizedMessage =
        message === 'Authorization server URL is required for a pre-registered client.'
          ? t('Authorization server URL is required for a pre-registered client.')
          : message === 'Client metadata URL cannot be combined with a pre-registered client.'
            ? t('Client metadata URL cannot be combined with a pre-registered client.')
            : message === 'Client ID is required when a client secret is configured.'
              ? t('Client ID is required when a client secret is configured.')
              : message ===
                  'Secure credential storage is unavailable. Unlock the system keychain and retry.'
                ? t(
                    'Secure credential storage is unavailable. Unlock the system keychain and retry.'
                  )
                : undefined
      setError(localizedMessage ?? message ?? t('Failed to save connector.'))
    } finally {
      setSubmitting(false)
    }
  }

  const segmentButtonClassName = (active: boolean): string =>
    `inline-flex h-7 items-center rounded-md px-3 text-sm transition-colors motion-reduce:transition-none ${
      active
        ? 'bg-card font-medium text-foreground shadow-sm'
        : 'text-muted-foreground hover:text-foreground'
    }`

  return (
    <div className="p-5">
      <div className="flex w-full flex-col gap-4">
        {initialTemplate ? (
          <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs leading-5 text-muted-foreground">
            {t(
              'Imported configuration is prefilled below. Enter required credentials locally, review every field, then confirm that you trust the Connector.'
            )}
          </div>
        ) : null}
        {editTargetMissing ? (
          <p
            className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive"
            role="alert"
          >
            {t('This Connector no longer exists. Your draft has not been saved.')}
          </p>
        ) : null}
        <RadioGroup.Root
          aria-label={t('Connector type')}
          value={mode}
          onValueChange={(value) => switchMode(value as ConnectorMode)}
          orientation="horizontal"
          className="inline-flex w-fit items-center rounded-lg bg-muted p-0.5"
        >
          <RadioGroup.Item value="local" className={segmentButtonClassName(mode === 'local')}>
            {t('Local command')}
          </RadioGroup.Item>
          <RadioGroup.Item value="remote" className={segmentButtonClassName(mode === 'remote')}>
            {t('Remote server')}
          </RadioGroup.Item>
        </RadioGroup.Root>

        <div data-slot="settings-editor-field" className={fieldClassName}>
          <label className={fieldLabelClassName} htmlFor="connector-name">
            {t('Display name')}
            <RequiredMark />
          </label>
          <Input
            id="connector-name"
            aria-label={t('Display name')}
            value={displayName}
            placeholder={t('e.g. Memory server')}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </div>

        {mode === 'local' ? (
          <div data-slot="settings-editor-field" className={fieldClassName}>
            <label className={fieldLabelClassName} htmlFor="connector-command">
              {t('Command')}
              <RequiredMark />
            </label>
            <Select value={commandChoice} onValueChange={setCommandChoice}>
              <SelectTrigger aria-label={t('Command')}>
                <span>
                  {t(
                    COMMAND_OPTIONS.find((o) => o.value === commandChoice)?.labelKey ??
                      commandChoice
                  )}
                </span>
              </SelectTrigger>
              <SelectContent>
                {COMMAND_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {t(option.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {commandChoice === 'other' ? (
              <Input
                aria-label={t('Custom command')}
                value={customCommand}
                placeholder="/absolute/path/to/executable"
                className="font-mono"
                onChange={(event) => setCustomCommand(event.target.value)}
              />
            ) : null}
          </div>
        ) : (
          <div data-slot="settings-editor-field" className={fieldClassName}>
            <label className={fieldLabelClassName} htmlFor="connector-url">
              {t('Server URL')}
              <RequiredMark />
            </label>
            <Input
              id="connector-url"
              aria-label={t('Server URL')}
              value={url}
              placeholder="https://example.com/mcp"
              className="font-mono"
              onChange={(event) => setUrl(event.target.value)}
            />
          </div>
        )}

        <div>
          <button
            type="button"
            aria-expanded={advancedVisible}
            aria-controls="connector-advanced-settings"
            onClick={() => setAdvancedOpen((open) => !open)}
            className="flex min-h-8 w-full items-center gap-2 rounded-lg py-1.5 text-left text-sm font-medium whitespace-nowrap text-foreground transition-colors duration-150 outline-none motion-reduce:transition-none hover:text-primary focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <ChevronDown
              className={`size-4 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none ${
                advancedVisible ? '' : '-rotate-90'
              }`}
              aria-hidden="true"
            />
            {t('Advanced settings')}
          </button>

          {advancedVisible ? (
            <div id="connector-advanced-settings" className="mt-3 flex flex-col gap-4">
              <div data-slot="settings-editor-field" className={fieldClassName}>
                <label className={fieldLabelClassName} htmlFor="connector-name-id">
                  {t('Connector name')}
                  {isEdit ? null : <RequiredMark />}
                </label>
                <Input
                  id="connector-name-id"
                  aria-label={t('Connector name')}
                  value={currentName}
                  disabled={isEdit}
                  aria-invalid={nameError ? true : undefined}
                  aria-describedby="connector-name-id-help"
                  className="font-mono"
                  onChange={
                    isEdit
                      ? undefined
                      : (event) => {
                          setNameTouched(true)
                          setName(event.target.value.toLowerCase())
                        }
                  }
                />
                <p
                  id="connector-name-id-help"
                  className={nameError ? 'text-xs leading-5 text-destructive' : helperClassName}
                >
                  {nameError ??
                    t(
                      'Used by host.mcp("{{name}}", …), Specialists, and the generated MCP skill.',
                      {
                        name: currentName
                      }
                    )}
                </p>
              </div>

              <div data-slot="settings-editor-field" className={fieldClassName}>
                <label className={fieldLabelClassName} htmlFor="connector-id">
                  {t('Connector ID')}{' '}
                  {isEdit ? null : (
                    <span className="font-normal text-muted-foreground">{t('(optional)')}</span>
                  )}
                </label>
                <Input
                  id="connector-id"
                  aria-label={t('Connector ID')}
                  value={currentId}
                  disabled={isEdit}
                  maxLength={RESOURCE_ID_MAX_LENGTH}
                  aria-invalid={idError ? true : undefined}
                  aria-describedby="connector-id-help"
                  className="font-mono"
                  onChange={
                    isEdit
                      ? undefined
                      : (event) => {
                          setIdTouched(true)
                          setId(event.target.value)
                        }
                  }
                />
                <p
                  id="connector-id-help"
                  className={idError ? 'text-xs leading-5 text-destructive' : helperClassName}
                  role={idError ? 'alert' : undefined}
                >
                  {idError ??
                    t(
                      'Generated from the name when possible. Edit it now or leave it blank to generate automatically; it cannot be changed after creation.'
                    )}
                </p>
              </div>

              <div data-slot="settings-editor-field" className={fieldClassName}>
                <label className={fieldLabelClassName} htmlFor="connector-description">
                  {t('Description')}{' '}
                  <span className="font-normal text-muted-foreground">{t('(optional)')}</span>
                </label>
                <Input
                  id="connector-description"
                  aria-label={t('Description')}
                  value={description}
                  placeholder={t('What this connector provides')}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </div>

              {mode === 'local' ? (
                <>
                  <div data-slot="settings-editor-field" className={fieldClassName}>
                    <label className={fieldLabelClassName} htmlFor="connector-args">
                      {t('Arguments')}{' '}
                      <span className="font-normal text-muted-foreground">{t('(optional)')}</span>
                    </label>
                    <Textarea
                      id="connector-args"
                      aria-label={t('Arguments')}
                      value={argsText}
                      rows={2}
                      placeholder={t('-y @modelcontextprotocol/server-memory')}
                      className="resize-y font-mono text-[13px]"
                      onChange={(event) => setArgsText(event.target.value)}
                    />
                    <p className={helperClassName}>
                      {initialTemplate
                        ? t('One argument per line.')
                        : t('Separated by spaces or newlines.')}
                    </p>
                  </div>

                  <div data-slot="settings-editor-field" className={fieldClassName}>
                    <label className={fieldLabelClassName} htmlFor="connector-env">
                      {t('Environment variables')}{' '}
                      <span className="font-normal text-muted-foreground">{t('(optional)')}</span>
                    </label>
                    <Textarea
                      id="connector-env"
                      aria-label={t('Environment variables')}
                      value={envText}
                      rows={3}
                      placeholder={'KEY=value\nANOTHER_KEY=value'}
                      className="resize-y font-mono text-[13px]"
                      onChange={(event) => setEnvText(event.target.value)}
                    />
                    <p className={helperClassName}>
                      {t('One KEY=VALUE per line.')}
                      {initialTemplate?.requiredSecrets?.environment?.length
                        ? ' ' +
                          t('Required: {{names}}.', {
                            names: initialTemplate.requiredSecrets.environment.join(', ')
                          })
                        : ''}
                      {isEdit ? ' ' + t('Leave blank to keep the current values.') : ''}
                    </p>
                  </div>
                </>
              ) : (
                <>
                  <div data-slot="settings-editor-field" className={fieldClassName}>
                    <span className={fieldLabelClassName}>{t('Transport')}</span>
                    <Select
                      value={remoteTransport}
                      onValueChange={(value) => setRemoteTransport(value as RemoteTransport)}
                    >
                      <SelectTrigger aria-label={t('Transport')}>
                        <span>
                          {REMOTE_TRANSPORTS.find((entry) => entry.id === remoteTransport)?.label}
                        </span>
                      </SelectTrigger>
                      <SelectContent>
                        {REMOTE_TRANSPORTS.map((entry) => (
                          <SelectItem key={entry.id} value={entry.id}>
                            {entry.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div data-slot="settings-editor-field" className={fieldClassName}>
                    <span className={fieldLabelClassName}>{t('Authentication')}</span>
                    <Select
                      value={remoteAuth}
                      onValueChange={(value) => setRemoteAuth(value as RemoteAuth)}
                    >
                      <SelectTrigger aria-label={t('Authentication')}>
                        <span>
                          {remoteAuth === 'oauth'
                            ? t('OAuth (browser sign-in)')
                            : remoteAuth === 'headers'
                              ? t('Static headers')
                              : t('None')}
                        </span>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">{t('None')}</SelectItem>
                        <SelectItem value="oauth">{t('OAuth (browser sign-in)')}</SelectItem>
                        <SelectItem value="headers">{t('Static headers')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {remoteAuth === 'oauth' ? (
                    <>
                      <div data-slot="settings-editor-field" className={fieldClassName}>
                        <label className={fieldLabelClassName} htmlFor="connector-oauth-scopes">
                          {t('OAuth scopes')}{' '}
                          <span className="font-normal text-muted-foreground">
                            {t('(optional)')}
                          </span>
                        </label>
                        <Input
                          id="connector-oauth-scopes"
                          aria-label={t('OAuth scopes')}
                          value={oauthScopesText}
                          placeholder="openid profile"
                          onChange={(event) => setOauthScopesText(event.target.value)}
                        />
                      </div>
                      <div data-slot="settings-editor-field" className={fieldClassName}>
                        <label className={fieldLabelClassName} htmlFor="connector-oauth-server">
                          {t('Authorization server URL')}{' '}
                          <span className="font-normal text-muted-foreground">
                            {t('(optional)')}
                          </span>
                        </label>
                        <Input
                          id="connector-oauth-server"
                          aria-label={t('Authorization server URL')}
                          value={authorizationServerUrl}
                          placeholder={t('Auto-discover from MCP server')}
                          className="font-mono"
                          onChange={(event) => setAuthorizationServerUrl(event.target.value)}
                        />
                        {clientId.trim() && !authorizationServerUrl.trim() ? (
                          <p className="text-xs leading-5 text-destructive">
                            {t('Authorization server URL is required for a pre-registered client.')}
                          </p>
                        ) : null}
                      </div>
                      <div data-slot="settings-editor-field" className={fieldClassName}>
                        <label
                          className={fieldLabelClassName}
                          htmlFor="connector-oauth-client-metadata"
                        >
                          {t('Client metadata URL')}{' '}
                          <span className="font-normal text-muted-foreground">
                            {t('(optional)')}
                          </span>
                        </label>
                        <Input
                          id="connector-oauth-client-metadata"
                          aria-label={t('Client metadata URL')}
                          value={clientMetadataUrl}
                          placeholder={t('Use dynamic client registration by default')}
                          className="font-mono"
                          disabled={Boolean(clientId.trim()) && !clientMetadataUrl.trim()}
                          onChange={(event) => setClientMetadataUrl(event.target.value)}
                        />
                        {clientId.trim() && clientMetadataUrl.trim() ? (
                          <p className="text-xs leading-5 text-destructive">
                            {t(
                              'Client metadata URL cannot be combined with a pre-registered client.'
                            )}
                          </p>
                        ) : null}
                      </div>
                      <div data-slot="settings-editor-field" className={fieldClassName}>
                        <label className={fieldLabelClassName} htmlFor="connector-oauth-client-id">
                          {t('Client ID')}{' '}
                          <span className="font-normal text-muted-foreground">
                            {t('(optional)')}
                          </span>
                        </label>
                        <Input
                          id="connector-oauth-client-id"
                          aria-label={t('Client ID')}
                          value={clientId}
                          placeholder={t('Pre-registered client ID')}
                          className="font-mono"
                          disabled={Boolean(clientMetadataUrl.trim()) && !clientId.trim()}
                          onChange={(event) => {
                            const nextClientId = event.target.value
                            setClientId(nextClientId)
                            if (editServer?.oauth?.hasClientSecret) {
                              setRemoveClientSecret(
                                nextClientId.trim() !== (editServer.oauth.clientId ?? '')
                              )
                            }
                          }}
                        />
                        {clientSecret.trim() && !clientId.trim() ? (
                          <p className="text-xs leading-5 text-destructive">
                            {t('Client ID is required when a client secret is configured.')}
                          </p>
                        ) : null}
                      </div>
                      <div data-slot="settings-editor-field" className={fieldClassName}>
                        <label
                          className={fieldLabelClassName}
                          htmlFor="connector-oauth-client-secret"
                        >
                          {t('Client secret')}{' '}
                          <span className="font-normal text-muted-foreground">
                            {t('(optional)')}
                          </span>
                        </label>
                        <Input
                          id="connector-oauth-client-secret"
                          aria-label={t('Client secret')}
                          type="password"
                          value={clientSecret}
                          placeholder={
                            isEdit && editServer?.oauth?.hasClientSecret
                              ? t('Leave blank to keep the saved secret')
                              : t('Pre-registered client secret')
                          }
                          className="font-mono"
                          disabled={
                            !encryptionAvailable ||
                            (Boolean(clientMetadataUrl.trim()) && !clientId.trim())
                          }
                          onChange={(event) => {
                            setClientSecret(event.target.value)
                            if (event.target.value) setRemoveClientSecret(false)
                          }}
                        />
                        {!encryptionAvailable ? (
                          <p className="text-xs leading-5 text-destructive">
                            {t(
                              'Secure credential storage is unavailable. Unlock the system keychain and retry.'
                            )}
                          </p>
                        ) : null}
                        {isEdit && editServer?.oauth?.hasClientSecret ? (
                          <div className="flex items-center justify-between gap-3">
                            <p className={helperClassName}>
                              {removeClientSecret
                                ? t('The saved client secret will be removed.')
                                : t('A client secret is saved securely.')}
                            </p>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                setRemoveClientSecret((remove) => {
                                  if (!remove) setClientSecret('')
                                  return !remove
                                })
                              }}
                            >
                              {removeClientSecret
                                ? t('Keep saved client secret')
                                : t('Remove saved client secret')}
                            </Button>
                          </div>
                        ) : null}
                        {requiresOAuthClientSecret ? (
                          <p className={helperClassName}>
                            {t('This imported Connector requires a client secret entered locally.')}
                          </p>
                        ) : null}
                      </div>
                    </>
                  ) : null}

                  {remoteAuth === 'headers' ? (
                    <div data-slot="settings-editor-field" className={fieldClassName}>
                      <label className={fieldLabelClassName} htmlFor="connector-headers">
                        {t('Headers')}{' '}
                        <span className="font-normal text-muted-foreground">{t('(optional)')}</span>
                      </label>
                      <Textarea
                        id="connector-headers"
                        aria-label={t('Headers')}
                        value={headersText}
                        rows={3}
                        placeholder={'Authorization: Bearer <token>\nX-Api-Key: <key>'}
                        className="resize-y font-mono text-[13px]"
                        onChange={(event) => setHeadersText(event.target.value)}
                      />
                      <p className={helperClassName}>
                        <Trans
                          i18nKey="One <code>Name: Value</code> per line (not JSON)."
                          components={{ code: <span className="font-mono" /> }}
                        />
                        {initialTemplate?.requiredSecrets?.headers?.length
                          ? ' ' +
                            t('Required: {{names}}.', {
                              names: initialTemplate.requiredSecrets.headers.join(', ')
                            })
                          : ''}
                        {isEdit ? ' ' + t('Leave blank to keep the current values.') : ''}
                      </p>
                    </div>
                  ) : null}
                </>
              )}
            </div>
          ) : null}
        </div>

        <div className="rounded-lg border border-border bg-muted/30 p-3">
          {mode === 'local' && commandPreview ? (
            <p className="mb-2 break-all font-mono text-xs text-muted-foreground">
              {commandPreview}
            </p>
          ) : null}
          <label className="flex items-start gap-2.5">
            <input
              type="checkbox"
              aria-label={t('I trust this connector')}
              checked={trusted}
              className="mt-0.5 size-4 shrink-0"
              onChange={(event) => setTrusted(event.target.checked)}
            />
            <span className="text-sm text-foreground">
              {t('I trust this connector. Only add connectors from developers you trust.')}
            </span>
          </label>
        </div>

        {error ? (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        ) : null}

        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>
            {tCommon('Cancel')}
          </Button>
          <Button type="button" onClick={() => void handleSubmit()} disabled={!canSubmit}>
            {submitting
              ? isEdit
                ? t('Saving…')
                : t('Adding…')
              : isEdit
                ? t('Save changes')
                : mode === 'remote' && remoteAuth === 'oauth'
                  ? t('Add and sign in')
                  : t('Add connector')}
          </Button>
        </div>
      </div>
      {oauthSignInServer ? (
        <ConnectorOAuthSignInDialog
          server={oauthSignInServer}
          onAuthenticated={() => {
            setOAuthSignInServer(undefined)
            onDone()
          }}
          onFinish={() => {
            setOAuthSignInServer(undefined)
            onDone()
          }}
        />
      ) : null}
    </div>
  )
}
