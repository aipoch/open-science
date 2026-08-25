/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4 */

import { AlertTriangle, CheckCircle2, Download, FileJson } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type {
  ConnectorTemplateExportFormat,
  ConnectorTemplateExportPreview
} from '../../../../shared/settings'
import { Button } from '@/components/ui/button'
import { localizeConnectorError } from './connector-error-message'

type ConnectorExportViewProps = {
  id: string
  onDone: () => void
}

export function ConnectorExportView({ id, onDone }: ConnectorExportViewProps): React.JSX.Element {
  const { t } = useTranslation()

  const [preview, setPreview] = useState<ConnectorTemplateExportPreview>()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [format, setFormat] = useState<ConnectorTemplateExportFormat>('open-science')
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
    const expectedDigest = format === 'mcp-client' ? preview?.mcpClientDigest : preview?.digest
    if (!preview?.ready || !expectedDigest) return
    setSaving(true)
    setSaved(false)
    setError(undefined)
    try {
      const result = await window.api.settings.exportCustomServerTemplate({
        id,
        expectedDigest,
        format
      })
      setSaved(result.saved)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save the configuration.')
    } finally {
      setSaving(false)
    }
  }

  const definition = preview?.definition
  const selectedDigest = format === 'mcp-client' ? preview?.mcpClientDigest : preview?.digest
  const diagnostics =
    format === 'mcp-client' ? (preview?.mcpClientDiagnostics ?? []) : (preview?.diagnostics ?? [])
  const secretNames = [
    ...(definition?.requiredSecrets?.environment ?? []),
    ...(definition?.requiredSecrets?.headers ?? [])
  ]

  return (
    <div className="p-5">
      <div className="flex w-full flex-col gap-5">
        <div>
          <h3 className="text-sm font-semibold text-foreground">
            {t('Export Connector configuration')}
          </h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {t(
              'Review the portable configuration before saving it. Secret values, OAuth tokens, local permissions, and trust state are excluded.'
            )}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2" aria-label={t('Export format')}>
          <Button
            type="button"
            variant={format === 'open-science' ? 'default' : 'outline'}
            onClick={() => {
              setFormat('open-science')
              setSaved(false)
            }}
          >
            {t('Open Science Connector')}
          </Button>
          <Button
            type="button"
            variant={format === 'mcp-client' ? 'default' : 'outline'}
            onClick={() => {
              setFormat('mcp-client')
              setSaved(false)
            }}
          >
            {t('MCP client config')}
          </Button>
        </div>

        {loading ? (
          <p className="text-xs text-muted-foreground">{t('Preparing preview…')}</p>
        ) : null}

        {error ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-danger-000/30 bg-danger-000/10 px-3 py-2 text-xs text-danger-000"
          >
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span>{t(error)}</span>
          </div>
        ) : null}

        {definition ? (
          <div>
            <div className="mb-2 flex items-center gap-2">
              <FileJson className="size-4 text-muted-foreground" aria-hidden="true" />
              <h4 className="text-sm font-medium text-foreground">{t('Configuration preview')}</h4>
            </div>
            <dl className="divide-y divide-border border-y border-border text-sm">
              <div className="grid grid-cols-[8rem_1fr] gap-3 py-2.5">
                <dt className="text-muted-foreground">{t('Name')}</dt>
                <dd className="min-w-0 break-words text-foreground">{definition.name}</dd>
              </div>
              <div className="grid grid-cols-[8rem_1fr] gap-3 py-2.5">
                <dt className="text-muted-foreground">{t('Transport')}</dt>
                <dd className="text-foreground">{definition.transport}</dd>
              </div>
              <div className="grid grid-cols-[8rem_1fr] gap-3 py-2.5">
                <dt className="text-muted-foreground">
                  {definition.transport === 'stdio' ? t('Command') : t('Server URL')}
                </dt>
                <dd className="min-w-0 break-all font-mono text-xs text-foreground">
                  {definition.transport === 'stdio'
                    ? [definition.command, ...(definition.args ?? [])].filter(Boolean).join(' ')
                    : definition.url}
                </dd>
              </div>
              <div className="grid grid-cols-[8rem_1fr] gap-3 py-2.5">
                <dt className="text-muted-foreground">{t('Credentials')}</dt>
                <dd className="text-foreground">
                  {definition.oauth
                    ? t('OAuth configuration only; tokens excluded')
                    : secretNames.length
                      ? t('Names only: {{names}}', { names: secretNames.join(', ') })
                      : t('None declared')}
                </dd>
              </div>
            </dl>
          </div>
        ) : null}

        {diagnostics.length ? (
          <div className="space-y-2" aria-label={t('Configuration diagnostics')}>
            {diagnostics.map((item) => (
              <div
                key={`${item.code}:${item.path ?? ''}`}
                className={`flex items-start gap-2 text-xs ${
                  item.severity === 'warning'
                    ? 'text-amber-600 dark:text-amber-400'
                    : 'text-destructive'
                }`}
              >
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <span>{localizeConnectorError(item.message, t)}</span>
              </div>
            ))}
          </div>
        ) : null}

        {saved ? (
          <p className="flex items-center gap-2 text-xs text-foreground" role="status">
            <CheckCircle2 className="size-4 text-primary" aria-hidden="true" />
            {t('Configuration saved.')}
          </p>
        ) : null}

        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onDone}>
            {saved ? t('Done') : t('Cancel')}
          </Button>
          <Button
            type="button"
            disabled={!preview?.ready || !selectedDigest || saving}
            onClick={() => void save()}
          >
            <Download data-icon="inline-start" aria-hidden="true" />
            {saving ? t('Saving…') : t('Save configuration')}
          </Button>
        </div>
      </div>
    </div>
  )
}
