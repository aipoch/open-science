/* Hallmark · pre-emit critique: P5 H5 E4 S5 R5 V4 */
import { ChevronDown } from 'lucide-react'
import { useMemo, useState } from 'react'

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
import { isCustomConnectorName, toCustomConnectorName } from '../../../../shared/custom-connector'

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
// absolute path or an uncommon binary.
const COMMAND_OPTIONS: { value: string; label: string }[] = [
  { value: 'npx', label: 'npx — Node package' },
  { value: 'uvx', label: 'uvx — Python (uv)' },
  { value: 'node', label: 'node — script file' },
  { value: 'python3', label: 'python3 — script file' },
  { value: 'docker', label: 'docker — container' },
  { value: 'other', label: 'Other…' }
]

type ConnectorAddFormProps = {
  initialTransport?: ConnectorMode
  initialTemplate?: ConnectorTemplateDefinition
  // When set, the form edits this custom server instead of adding a new one. Its name is immutable.
  editServer?: CustomServerView
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
  onDone,
  onCancel
}: ConnectorAddFormProps): React.JSX.Element {
  const addCustomServer = useSettingsStore((s) => s.addCustomServer)
  const updateCustomServer = useSettingsStore((s) => s.updateCustomServer)
  const connectors = useSettingsStore((s) => s.connectors)
  const customServers = useSettingsStore((s) => s.customServers)
  const isEdit = editServer !== undefined

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
  const currentName = isEdit
    ? (editServer?.name ?? '')
    : nameTouched
      ? name
      : toCustomConnectorName(displayName)
  const nameError = useMemo((): string | null => {
    if (!currentName || !isCustomConnectorName(currentName)) {
      return 'Use only lowercase letters, numbers, and hyphens.'
    }
    if (connectors.some((connector) => connector.id === currentName)) {
      return 'This name is reserved by a built-in Connector.'
    }
    if (
      customServers.some((server) => server.id !== editServer?.id && server.name === currentName)
    ) {
      return 'A custom Connector with this name already exists.'
    }
    return null
  }, [connectors, currentName, customServers, editServer?.id])
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
  // A generated-ID collision must remain visible instead of leaving the disabled submit button as
  // the only sign that something needs attention.
  const advancedVisible = advancedOpen || Boolean(displayName.trim() && nameError)

  const parsedArgs = parseArgs(argsText, initialTemplate !== undefined)
  const parsedEnv = parseEnv(envText)
  const parsedHeaders = parseHeaders(headersText)
  const commandPreview = [command.trim(), ...parsedArgs].filter((part) => part.length > 0).join(' ')
  const requiredEnvironment = initialTemplate?.requiredSecrets?.environment ?? []
  const requiredHeaders = initialTemplate?.requiredSecrets?.headers ?? []
  const requiredSecretValuesFilled =
    (requiredEnvironment.length === 0 ||
      (mode === 'local' &&
        requiredEnvironment.every((key) => (parsedEnv[key] ?? '').trim().length > 0))) &&
    (requiredHeaders.length === 0 ||
      (mode === 'remote' &&
        remoteAuth === 'headers' &&
        requiredHeaders.every((header) => (parsedHeaders[header] ?? '').trim().length > 0)))

  const requiredFilled =
    displayName.trim().length > 0 &&
    !nameError &&
    (mode === 'local' ? command.trim().length > 0 : url.trim().length > 0) &&
    requiredSecretValuesFilled
  const canSubmit = requiredFilled && trusted && !submitting

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
              oauth:
                remoteAuth === 'oauth'
                  ? {
                      ...(authorizationServerUrl.trim()
                        ? { authorizationServerUrl: authorizationServerUrl.trim() }
                        : {}),
                      ...(clientMetadataUrl.trim()
                        ? { clientMetadataUrl: clientMetadataUrl.trim() }
                        : {}),
                      ...(oauthScopes.length ? { scopes: oauthScopes } : {})
                    }
                  : null
            })
      }

      if (isEdit && editServer) {
        const request: UpdateCustomServerRequest = {
          id: editServer.id,
          ...shared,
          ...(mode === 'local' && hasEnv ? { env } : {}),
          ...(mode === 'remote' && remoteAuth !== 'headers'
            ? { headers: {} }
            : hasHeaders
              ? { headers }
              : {}),
          ...(mode === 'remote' && remoteAuth !== 'oauth' ? { oauth: null } : {})
        }
        await updateCustomServer(request)
      } else {
        const request: AddCustomServerRequest = {
          name: currentName,
          ...shared,
          ...(mode === 'local' && Object.keys(env).length > 0 ? { env } : {}),
          ...(mode === 'remote' && remoteAuth === 'headers' && Object.keys(headers).length > 0
            ? { headers }
            : {})
        }
        await addCustomServer(request)
      }
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save connector.')
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
            Imported configuration is prefilled below. Enter required credentials locally, review
            every field, then confirm that you trust the Connector.
          </div>
        ) : null}
        <div
          role="radiogroup"
          aria-label="Connector type"
          className="inline-flex w-fit items-center rounded-lg bg-muted p-0.5"
        >
          <button
            type="button"
            role="radio"
            aria-checked={mode === 'local'}
            onClick={() => switchMode('local')}
            className={segmentButtonClassName(mode === 'local')}
          >
            Local command
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={mode === 'remote'}
            onClick={() => switchMode('remote')}
            className={segmentButtonClassName(mode === 'remote')}
          >
            Remote server
          </button>
        </div>

        <div data-slot="settings-editor-field" className={fieldClassName}>
          <label className={fieldLabelClassName} htmlFor="connector-name">
            Display name
            <RequiredMark />
          </label>
          <Input
            id="connector-name"
            aria-label="Display name"
            value={displayName}
            placeholder="e.g. Memory server"
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </div>

        {mode === 'local' ? (
          <div data-slot="settings-editor-field" className={fieldClassName}>
            <label className={fieldLabelClassName} htmlFor="connector-command">
              Command
              <RequiredMark />
            </label>
            <Select value={commandChoice} onValueChange={setCommandChoice}>
              <SelectTrigger aria-label="Command">
                <span>
                  {COMMAND_OPTIONS.find((o) => o.value === commandChoice)?.label ?? commandChoice}
                </span>
              </SelectTrigger>
              <SelectContent>
                {COMMAND_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {commandChoice === 'other' ? (
              <Input
                aria-label="Custom command"
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
              Server URL
              <RequiredMark />
            </label>
            <Input
              id="connector-url"
              aria-label="Server URL"
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
            Advanced settings
          </button>

          {advancedVisible ? (
            <div id="connector-advanced-settings" className="mt-3 flex flex-col gap-4">
              <div data-slot="settings-editor-field" className={fieldClassName}>
                <label className={fieldLabelClassName} htmlFor="connector-name-id">
                  Connector name
                  {isEdit ? null : <RequiredMark />}
                </label>
                <Input
                  id="connector-name-id"
                  aria-label="Connector name"
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
                    `Used by host.mcp("${currentName}", …), Specialists, and the generated MCP skill.`}
                </p>
              </div>

              <div data-slot="settings-editor-field" className={fieldClassName}>
                <label className={fieldLabelClassName} htmlFor="connector-description">
                  Description <span className="font-normal text-muted-foreground">(optional)</span>
                </label>
                <Input
                  id="connector-description"
                  aria-label="Description"
                  value={description}
                  placeholder="What this connector provides"
                  onChange={(event) => setDescription(event.target.value)}
                />
              </div>

              {mode === 'local' ? (
                <>
                  <div data-slot="settings-editor-field" className={fieldClassName}>
                    <label className={fieldLabelClassName} htmlFor="connector-args">
                      Arguments{' '}
                      <span className="font-normal text-muted-foreground">(optional)</span>
                    </label>
                    <Textarea
                      id="connector-args"
                      aria-label="Arguments"
                      value={argsText}
                      rows={2}
                      placeholder="-y @modelcontextprotocol/server-memory"
                      className="resize-y font-mono text-[13px]"
                      onChange={(event) => setArgsText(event.target.value)}
                    />
                    <p className={helperClassName}>
                      {initialTemplate
                        ? 'One argument per line.'
                        : 'Separated by spaces or newlines.'}
                    </p>
                  </div>

                  <div data-slot="settings-editor-field" className={fieldClassName}>
                    <label className={fieldLabelClassName} htmlFor="connector-env">
                      Environment variables{' '}
                      <span className="font-normal text-muted-foreground">(optional)</span>
                    </label>
                    <Textarea
                      id="connector-env"
                      aria-label="Environment variables"
                      value={envText}
                      rows={3}
                      placeholder={'KEY=value\nANOTHER_KEY=value'}
                      className="resize-y font-mono text-[13px]"
                      onChange={(event) => setEnvText(event.target.value)}
                    />
                    <p className={helperClassName}>
                      One KEY=VALUE per line.
                      {initialTemplate?.requiredSecrets?.environment?.length
                        ? ` Required: ${initialTemplate.requiredSecrets.environment.join(', ')}.`
                        : ''}
                      {isEdit ? ' Leave blank to keep the current values.' : ''}
                    </p>
                  </div>
                </>
              ) : (
                <>
                  <div data-slot="settings-editor-field" className={fieldClassName}>
                    <span className={fieldLabelClassName}>Transport</span>
                    <Select
                      value={remoteTransport}
                      onValueChange={(value) => setRemoteTransport(value as RemoteTransport)}
                    >
                      <SelectTrigger aria-label="Transport">
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
                    <span className={fieldLabelClassName}>Authentication</span>
                    <Select
                      value={remoteAuth}
                      onValueChange={(value) => setRemoteAuth(value as RemoteAuth)}
                    >
                      <SelectTrigger aria-label="Authentication">
                        <span>
                          {remoteAuth === 'oauth'
                            ? 'OAuth (browser sign-in)'
                            : remoteAuth === 'headers'
                              ? 'Static headers'
                              : 'None'}
                        </span>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">None</SelectItem>
                        <SelectItem value="oauth">OAuth (browser sign-in)</SelectItem>
                        <SelectItem value="headers">Static headers</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {remoteAuth === 'oauth' ? (
                    <>
                      <div data-slot="settings-editor-field" className={fieldClassName}>
                        <label className={fieldLabelClassName} htmlFor="connector-oauth-scopes">
                          OAuth scopes{' '}
                          <span className="font-normal text-muted-foreground">(optional)</span>
                        </label>
                        <Input
                          id="connector-oauth-scopes"
                          aria-label="OAuth scopes"
                          value={oauthScopesText}
                          placeholder="openid profile"
                          onChange={(event) => setOauthScopesText(event.target.value)}
                        />
                      </div>
                      <div data-slot="settings-editor-field" className={fieldClassName}>
                        <label className={fieldLabelClassName} htmlFor="connector-oauth-server">
                          Authorization server URL{' '}
                          <span className="font-normal text-muted-foreground">(optional)</span>
                        </label>
                        <Input
                          id="connector-oauth-server"
                          aria-label="Authorization server URL"
                          value={authorizationServerUrl}
                          placeholder="Auto-discover from MCP server"
                          className="font-mono"
                          onChange={(event) => setAuthorizationServerUrl(event.target.value)}
                        />
                      </div>
                      <div data-slot="settings-editor-field" className={fieldClassName}>
                        <label
                          className={fieldLabelClassName}
                          htmlFor="connector-oauth-client-metadata"
                        >
                          Client metadata URL{' '}
                          <span className="font-normal text-muted-foreground">(optional)</span>
                        </label>
                        <Input
                          id="connector-oauth-client-metadata"
                          aria-label="Client metadata URL"
                          value={clientMetadataUrl}
                          placeholder="Use dynamic client registration by default"
                          className="font-mono"
                          onChange={(event) => setClientMetadataUrl(event.target.value)}
                        />
                      </div>
                    </>
                  ) : null}

                  {remoteAuth === 'headers' ? (
                    <div data-slot="settings-editor-field" className={fieldClassName}>
                      <label className={fieldLabelClassName} htmlFor="connector-headers">
                        Headers{' '}
                        <span className="font-normal text-muted-foreground">(optional)</span>
                      </label>
                      <Textarea
                        id="connector-headers"
                        aria-label="Headers"
                        value={headersText}
                        rows={3}
                        placeholder={'Authorization: Bearer <token>\nX-Api-Key: <key>'}
                        className="resize-y font-mono text-[13px]"
                        onChange={(event) => setHeadersText(event.target.value)}
                      />
                      <p className={helperClassName}>
                        One <span className="font-mono">Name: Value</span> per line (not JSON).
                        {initialTemplate?.requiredSecrets?.headers?.length
                          ? ` Required: ${initialTemplate.requiredSecrets.headers.join(', ')}.`
                          : ''}
                        {isEdit ? ' Leave blank to keep the current values.' : ''}
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
              aria-label="I trust this connector"
              checked={trusted}
              className="mt-0.5 size-4 shrink-0"
              onChange={(event) => setTrusted(event.target.checked)}
            />
            <span className="text-sm text-foreground">
              I trust this connector. Only add connectors from developers you trust.
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
            Cancel
          </Button>
          <Button type="button" onClick={() => void handleSubmit()} disabled={!canSubmit}>
            {submitting
              ? isEdit
                ? 'Saving…'
                : 'Adding…'
              : isEdit
                ? 'Save changes'
                : 'Add connector'}
          </Button>
        </div>
      </div>
    </div>
  )
}
