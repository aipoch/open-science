/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4 */

import { AlertTriangle, FileJson, Upload } from 'lucide-react'
import { useState } from 'react'

import type {
  ConnectorTemplateDefinition,
  ConnectorTemplateSelectionResult
} from '../../../../shared/settings'
import { Button } from '@/components/ui/button'

type ConnectorImportViewProps = {
  onUse: (definition: ConnectorTemplateDefinition) => void
  onCancel: () => void
}

const transportLabel = (definition: ConnectorTemplateDefinition): string =>
  definition.transport === 'stdio'
    ? 'Local command'
    : definition.transport === 'streamable_http'
      ? 'Streamable HTTP'
      : 'SSE'

export function ConnectorImportView({
  onUse,
  onCancel
}: ConnectorImportViewProps): React.JSX.Element {
  const [selection, setSelection] = useState<ConnectorTemplateSelectionResult>()
  const [selecting, setSelecting] = useState(false)
  const [error, setError] = useState<string>()

  const selectFile = async (): Promise<void> => {
    setSelecting(true)
    setError(undefined)
    try {
      const result = await window.api.settings.selectCustomServerTemplate()
      if (!result.cancelled) setSelection(result)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not validate the configuration.')
    } finally {
      setSelecting(false)
    }
  }

  const preview = selection && !selection.cancelled ? selection.preview : undefined
  const definition = preview?.definition
  const secretNames = [
    ...(definition?.requiredSecrets?.environment ?? []),
    ...(definition?.requiredSecrets?.headers ?? [])
  ]

  return (
    <div className="p-5">
      <div className="flex max-w-xl flex-col gap-5">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Import Connector configuration</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Select a configuration to validate it before adding the Connector. Credentials are never
            read from the file.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={selecting}
            onClick={() => void selectFile()}
          >
            <Upload data-icon="inline-start" aria-hidden="true" />
            {selecting ? 'Validating…' : selection ? 'Choose another file' : 'Choose configuration'}
          </Button>
          {selection && !selection.cancelled ? (
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              {selection.fileName}
            </span>
          ) : null}
        </div>

        {error ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive"
          >
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </div>
        ) : null}

        {definition ? (
          <div>
            <div className="mb-2 flex items-center gap-2">
              <FileJson className="size-4 text-muted-foreground" aria-hidden="true" />
              <h4 className="text-sm font-medium text-foreground">Configuration preview</h4>
            </div>
            <dl className="divide-y divide-border border-y border-border text-sm">
              <div className="grid grid-cols-[8rem_1fr] gap-3 py-2.5">
                <dt className="text-muted-foreground">Name</dt>
                <dd className="min-w-0 break-words text-foreground">{definition.name}</dd>
              </div>
              <div className="grid grid-cols-[8rem_1fr] gap-3 py-2.5">
                <dt className="text-muted-foreground">Transport</dt>
                <dd className="text-foreground">{transportLabel(definition)}</dd>
              </div>
              <div className="grid grid-cols-[8rem_1fr] gap-3 py-2.5">
                <dt className="text-muted-foreground">
                  {definition.transport === 'stdio' ? 'Command' : 'Server URL'}
                </dt>
                <dd className="min-w-0 break-all font-mono text-xs text-foreground">
                  {definition.transport === 'stdio'
                    ? [definition.command, ...(definition.args ?? [])].filter(Boolean).join(' ')
                    : definition.url}
                </dd>
              </div>
              <div className="grid grid-cols-[8rem_1fr] gap-3 py-2.5">
                <dt className="text-muted-foreground">Credentials</dt>
                <dd className="text-foreground">
                  {definition.oauth
                    ? 'OAuth browser sign-in after adding'
                    : secretNames.length
                      ? `Enter locally: ${secretNames.join(', ')}`
                      : 'None declared'}
                </dd>
              </div>
            </dl>
          </div>
        ) : null}

        {preview?.diagnostics.length ? (
          <div className="space-y-2" aria-label="Configuration diagnostics">
            {preview.diagnostics.map((item) => (
              <div
                key={`${item.code}:${item.path ?? ''}`}
                className="flex items-start gap-2 text-xs text-destructive"
              >
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <span>{item.message}</span>
              </div>
            ))}
          </div>
        ) : null}

        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!preview?.ready || !definition}
            onClick={() => definition && onUse(definition)}
          >
            Use configuration
          </Button>
        </div>
      </div>
    </div>
  )
}
