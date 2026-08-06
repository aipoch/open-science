/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4 */

import { AlertTriangle, CheckCircle2, Download, FileJson } from 'lucide-react'
import { useEffect, useState } from 'react'

import type { ConnectorTemplateExportPreview } from '../../../../shared/settings'
import { Button } from '@/components/ui/button'

type ConnectorExportViewProps = {
  id: string
  onDone: () => void
}

export function ConnectorExportView({ id, onDone }: ConnectorExportViewProps): React.JSX.Element {
  const [preview, setPreview] = useState<ConnectorTemplateExportPreview>()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    let active = true
    void window.api.settings
      .previewCustomServerTemplateExport(id)
      .then((result) => {
        if (active) setPreview(result)
      })
      .catch((cause) => {
        if (active)
          setError(cause instanceof Error ? cause.message : 'Could not preview the configuration.')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [id])

  const save = async (): Promise<void> => {
    if (!preview?.ready || !preview.digest) return
    setSaving(true)
    setSaved(false)
    setError(undefined)
    try {
      const result = await window.api.settings.exportCustomServerTemplate({
        id,
        expectedDigest: preview.digest
      })
      setSaved(result.saved)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save the configuration.')
    } finally {
      setSaving(false)
    }
  }

  const definition = preview?.definition
  const secretNames = [
    ...(definition?.requiredSecrets?.environment ?? []),
    ...(definition?.requiredSecrets?.headers ?? [])
  ]

  return (
    <div className="p-5">
      <div className="flex w-full flex-col gap-5">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Export Connector configuration</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Review the portable configuration before saving it. Secret values, OAuth tokens, local
            permissions, and trust state are excluded.
          </p>
        </div>

        {loading ? <p className="text-xs text-muted-foreground">Preparing preview…</p> : null}

        {error ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-danger-000/30 bg-danger-000/10 px-3 py-2 text-xs text-danger-000"
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
                <dd className="text-foreground">{definition.transport}</dd>
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
                    ? 'OAuth configuration only; tokens excluded'
                    : secretNames.length
                      ? `Names only: ${secretNames.join(', ')}`
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
                className={`flex items-start gap-2 text-xs ${
                  item.severity === 'warning'
                    ? 'text-amber-600 dark:text-amber-400'
                    : 'text-destructive'
                }`}
              >
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <span>{item.message}</span>
              </div>
            ))}
          </div>
        ) : null}

        {saved ? (
          <p className="flex items-center gap-2 text-xs text-foreground" role="status">
            <CheckCircle2 className="size-4 text-primary" aria-hidden="true" />
            Configuration saved.
          </p>
        ) : null}

        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onDone}>
            {saved ? 'Done' : 'Cancel'}
          </Button>
          <Button
            type="button"
            disabled={!preview?.ready || !preview.digest || saving}
            onClick={() => void save()}
          >
            <Download data-icon="inline-start" aria-hidden="true" />
            {saving ? 'Saving…' : 'Save configuration'}
          </Button>
        </div>
      </div>
    </div>
  )
}
