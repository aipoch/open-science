import { useState } from 'react'

import type {
  AddCustomServerRequest,
  CustomServerTransport,
  CustomServerView,
  UpdateCustomServerRequest
} from '../../../../shared/settings'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { useSettingsStore } from '@/stores/settings-store'

// Which kind of custom connector is being added: a local stdio command or a remote HTTP/SSE server.
type ConnectorMode = 'local' | 'remote'

// The two remote transports, kept out of the local (stdio) mode.
type RemoteTransport = Extract<CustomServerTransport, 'streamable_http' | 'sse'>

const fieldLabelClassName = 'text-xs font-medium text-muted-foreground'
const textareaClassName =
  'w-full resize-none rounded-lg border border-input bg-transparent px-2.5 py-2 font-mono text-[13px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50'

// Splits an arguments textarea on any whitespace/newlines into a positional arg list, dropping empties.
const parseArgs = (raw: string): string[] =>
  raw
    .split(/\s+/)
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
  // When set, the form edits this custom server instead of adding a new one. The name is immutable.
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
  editServer,
  onDone,
  onCancel
}: ConnectorAddFormProps): React.JSX.Element {
  const addCustomServer = useSettingsStore((s) => s.addCustomServer)
  const updateCustomServer = useSettingsStore((s) => s.updateCustomServer)
  const isEdit = editServer !== undefined

  const [mode, setMode] = useState<ConnectorMode>(
    editServer ? modeForTransport(editServer.transport) : (initialTransport ?? 'local')
  )
  const [name, setName] = useState(editServer?.name ?? '')
  const [description, setDescription] = useState(editServer?.description ?? '')
  // Local (stdio) fields. The command is chosen from common runtimes, with an "other" escape hatch
  // for an absolute path or an uncommon binary.
  const initialCommandIsPreset = editServer?.command
    ? COMMAND_OPTIONS.some((o) => o.value === editServer.command)
    : true
  const [commandChoice, setCommandChoice] = useState<string>(
    editServer?.command ? (initialCommandIsPreset ? editServer.command : 'other') : 'npx'
  )
  const [customCommand, setCustomCommand] = useState(
    editServer?.command && !initialCommandIsPreset ? editServer.command : ''
  )
  const command = commandChoice === 'other' ? customCommand : commandChoice
  const [argsText, setArgsText] = useState((editServer?.args ?? []).join(' '))
  const [envText, setEnvText] = useState('')
  // Remote fields.
  const [url, setUrl] = useState(editServer?.url ?? '')
  const [remoteTransport, setRemoteTransport] = useState<RemoteTransport>(
    editServer && editServer.transport !== 'stdio' ? editServer.transport : 'streamable_http'
  )
  const [headersText, setHeadersText] = useState('')
  // Add-time trust confirmation and submission state. An existing (already-trusted) server starts trusted.
  const [trusted, setTrusted] = useState(isEdit)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const parsedArgs = parseArgs(argsText)
  const commandPreview = [command.trim(), ...parsedArgs].filter((part) => part.length > 0).join(' ')

  const requiredFilled =
    name.trim().length > 0 && (mode === 'local' ? command.trim().length > 0 : url.trim().length > 0)
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
      const env = parseEnv(envText)
      const headers = parseHeaders(headersText)
      // Omitted env/headers keep the stored (secret) values on edit; on add they are simply unset.
      const hasEnv = envText.trim().length > 0
      const hasHeaders = headersText.trim().length > 0
      const transport: CustomServerTransport = mode === 'local' ? 'stdio' : remoteTransport
      const shared = {
        description: description.trim() || undefined,
        transport,
        ...(mode === 'local'
          ? {
              command: command.trim(),
              ...(parsedArgs.length > 0 ? { args: parsedArgs } : {})
            }
          : { url: url.trim() })
      }

      if (isEdit && editServer) {
        const request: UpdateCustomServerRequest = {
          id: editServer.id,
          ...shared,
          ...(mode === 'local' && hasEnv ? { env } : {}),
          ...(mode === 'remote' && hasHeaders ? { headers } : {})
        }
        await updateCustomServer(request)
      } else {
        const request: AddCustomServerRequest = {
          name: name.trim(),
          ...shared,
          ...(mode === 'local' && Object.keys(env).length > 0 ? { env } : {}),
          ...(mode === 'remote' && Object.keys(headers).length > 0 ? { headers } : {})
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
    `inline-flex h-7 items-center rounded-md px-3 text-sm transition-colors ${
      active
        ? 'bg-card font-medium text-foreground shadow-sm'
        : 'text-muted-foreground hover:text-foreground'
    }`

  return (
    <div className="p-5">
      <div className="flex max-w-xl flex-col gap-4">
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

        <div className="space-y-1.5">
          <label className={fieldLabelClassName} htmlFor="connector-name">
            Name
            {isEdit ? null : <RequiredMark />}
          </label>
          <Input
            id="connector-name"
            aria-label="Name"
            value={name}
            disabled={isEdit}
            placeholder="e.g. Memory server"
            onChange={(event) => setName(event.target.value)}
          />
          {isEdit ? (
            <p className="text-xs text-muted-foreground">
              The name is the connector&apos;s identity and can&apos;t be changed.
            </p>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <label className={fieldLabelClassName} htmlFor="connector-description">
            Description <span className="text-muted-foreground">(optional)</span>
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
            <div className="space-y-1.5">
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

            <div className="space-y-1.5">
              <label className={fieldLabelClassName} htmlFor="connector-args">
                Arguments <span className="text-muted-foreground">(optional)</span>
              </label>
              <textarea
                id="connector-args"
                aria-label="Arguments"
                value={argsText}
                rows={2}
                placeholder="-y @modelcontextprotocol/server-memory"
                className={textareaClassName}
                onChange={(event) => setArgsText(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">Separated by spaces or newlines.</p>
            </div>

            <div className="space-y-1.5">
              <label className={fieldLabelClassName} htmlFor="connector-env">
                Environment variables <span className="text-muted-foreground">(optional)</span>
              </label>
              <textarea
                id="connector-env"
                aria-label="Environment variables"
                value={envText}
                rows={3}
                placeholder={'KEY=value\nANOTHER_KEY=value'}
                className={textareaClassName}
                onChange={(event) => setEnvText(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                One KEY=VALUE per line.
                {isEdit ? ' Leave blank to keep the current values.' : ''}
              </p>
            </div>
          </>
        ) : (
          <>
            <div className="space-y-1.5">
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

            <div className="space-y-1.5">
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

            <div className="space-y-1.5">
              <label className={fieldLabelClassName} htmlFor="connector-headers">
                Headers <span className="text-muted-foreground">(optional)</span>
              </label>
              <textarea
                id="connector-headers"
                aria-label="Headers"
                value={headersText}
                rows={3}
                placeholder={'Authorization: Bearer <token>\nX-Api-Key: <key>'}
                className={textareaClassName}
                onChange={(event) => setHeadersText(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                One <span className="font-mono">Name: Value</span> per line (not JSON).
                {isEdit ? ' Leave blank to keep the current values.' : ''}
              </p>
            </div>
          </>
        )}

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
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex h-8 items-center rounded-lg px-3 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
            className="inline-flex h-8 items-center rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
          >
            {submitting
              ? isEdit
                ? 'Saving…'
                : 'Adding…'
              : isEdit
                ? 'Save changes'
                : 'Add connector'}
          </button>
        </div>
      </div>
    </div>
  )
}
