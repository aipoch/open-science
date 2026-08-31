/* Hallmark · component: named credential editor · genre: modern-minimal · theme: Open Science
 * states: default · hover · focus · active · disabled · loading · error · success
 * contrast: project semantic tokens
 */
/* Hallmark · pre-emit critique: P5 H4 E4 S5 R5 V4 */
import { useMemo, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { DeviceCredentialView } from '../../../../shared/settings'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import {
  parseNamedCredentialText,
  type NamedCredentialKind
} from './connector-named-credential-parser'
import { SettingsSegmentedControl } from './SettingsSegmentedControl'

type NamedCredentialEditorMode = 'fields' | 'text'
type NamedCredentialPreviewState =
  'default' | 'hover' | 'focus' | 'active' | 'disabled' | 'loading' | 'error' | 'success'

type ConnectorNamedCredentialEditorProps = {
  kind: NamedCredentialKind
  text: string
  onTextChange(text: string): void
  credentials: DeviceCredentialView[]
  credentialIdForName(name: string): string | undefined
  onCredentialChange(name: string, credentialId: string): void
  onNameChange(previousName: string, nextName: string): void
  onRemoveName(name: string): void
  onCreateCredential(name: string): void
  caseInsensitiveNames?: boolean
  required?: boolean
  describedBy?: string
  previewState?: NamedCredentialPreviewState
}

const NEW_CREDENTIAL_VALUE = '__new_credential__'
const ENVIRONMENT_PLACEHOLDER = 'API_TOKEN='
const HEADER_PLACEHOLDER = 'Authorization:\nX-Api-Key:'

const nameFromLine = (line: string, kind: NamedCredentialKind): string => {
  const separator = line.indexOf(kind === 'environment' ? '=' : ':')
  return (separator >= 0 ? line.slice(0, separator) : line).trim()
}

const normalizeNameInput = (value: string, kind: NamedCredentialKind): string =>
  value.replace(kind === 'environment' ? /[=\r\n]/gu : /[:\r\n]/gu, '').trim()

const lineForName = (name: string, kind: NamedCredentialKind): string =>
  kind === 'environment' ? `${name}=` : `${name}: `

const previewClassName = (state: NamedCredentialPreviewState | undefined): string | undefined => {
  if (state === 'hover') return 'bg-muted/40'
  if (state === 'focus') return 'ring-3 ring-ring/50'
  if (state === 'active') return 'translate-y-px motion-reduce:transform-none'
  if (state === 'error') return 'border-destructive ring-3 ring-destructive/20'
  if (state === 'success') return 'border-primary'
  return undefined
}

function ConnectorNamedCredentialEditor({
  kind,
  text,
  onTextChange,
  credentials,
  credentialIdForName,
  onCredentialChange,
  onNameChange,
  onRemoveName,
  onCreateCredential,
  caseInsensitiveNames = false,
  required = false,
  describedBy,
  previewState
}: ConnectorNamedCredentialEditorProps): React.JSX.Element {
  const { t } = useTranslation()
  const [mode, setMode] = useState<NamedCredentialEditorMode>('fields')
  const disabled = previewState === 'disabled' || previewState === 'loading'
  const parsed = useMemo(
    () => parseNamedCredentialText(text, kind, caseInsensitiveNames),
    [caseInsensitiveNames, kind, text]
  )
  const sourceLines = text
    .split('\n')
    .map((line, index) => ({ index, line, name: nameFromLine(line, kind) }))
    .filter(({ line }) => line.trim().length > 0)
  const rows =
    sourceLines.length > 0
      ? sourceLines
      : [{ index: 0, line: '', name: '', virtual: true as const }]
  const separator = kind === 'environment' ? '=' : ':'
  const displayedInvalidLines =
    mode === 'fields'
      ? parsed.invalidLines.filter((line) => text.split('\n')[line - 1]?.trim() !== separator)
      : parsed.invalidLines
  const editorLabel =
    kind === 'environment' ? t('Environment variable editor mode') : t('Header editor mode')
  const nameLabel = kind === 'environment' ? t('Variable name') : t('Header name')
  const addLabel = kind === 'environment' ? t('Add variable') : t('Add header')

  const replaceLine = (sourceIndex: number, previousName: string, nextNameValue: string): void => {
    const nextName = normalizeNameInput(nextNameValue, kind)
    const lines = text ? text.split('\n') : ['']
    lines[sourceIndex] = lineForName(nextName, kind)
    onTextChange(lines.join('\n'))
    if (previousName !== nextName) onNameChange(previousName, nextName)
  }

  const removeLine = (sourceIndex: number, name: string): void => {
    const lines = text.split('\n')
    lines.splice(sourceIndex, 1)
    onTextChange(lines.filter((line) => line.trim().length > 0).join('\n'))
    if (name) onRemoveName(name)
  }

  const addLine = (): void => {
    const nextLine = lineForName('', kind)
    onTextChange(text.trim() ? `${text.replace(/\s+$/u, '')}\n${nextLine}` : nextLine)
  }

  return (
    <div className="grid min-w-0 gap-2.5" data-slot={`${kind}-credential-editor`}>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs leading-5 text-muted-foreground">
          {mode === 'fields'
            ? t('Select or create a Credential for each name.')
            : t('Text mode only imports names. Values are provided by Credentials.')}
        </p>
        <fieldset
          disabled={disabled}
          className={cn(
            'min-w-0 border-0 p-0',
            disabled && 'cursor-not-allowed opacity-50 [&_*]:cursor-not-allowed'
          )}
        >
          <SettingsSegmentedControl
            value={mode}
            options={[
              { value: 'fields', label: t('Fields') },
              { value: 'text', label: t('Text') }
            ]}
            onValueChange={setMode}
            ariaLabel={editorLabel}
            columnWidth="3.75rem"
            segmentClassName="min-h-7"
          />
        </fieldset>
      </div>

      {mode === 'text' ? (
        <Textarea
          id={kind === 'environment' ? 'connector-env' : 'connector-headers'}
          aria-label={kind === 'environment' ? t('Environment variables') : t('Headers')}
          aria-required={required || undefined}
          aria-invalid={
            parsed.invalidLines.length > 0 ||
            parsed.duplicateLines.length > 0 ||
            previewState === 'error' ||
            undefined
          }
          aria-describedby={describedBy}
          value={text}
          rows={3}
          disabled={disabled}
          placeholder={kind === 'environment' ? ENVIRONMENT_PLACEHOLDER : HEADER_PLACEHOLDER}
          className={cn('resize-y font-mono text-[13px]', previewClassName(previewState))}
          onChange={(event) => onTextChange(event.target.value)}
        />
      ) : (
        <div
          className={cn(
            'divide-y divide-border rounded-lg border border-border bg-card',
            previewClassName(previewState)
          )}
        >
          {rows.map((row, visibleIndex) => {
            const credentialId = row.name ? credentialIdForName(row.name) : undefined
            const rowHasError =
              displayedInvalidLines.includes(row.index + 1) ||
              parsed.duplicateLines.some(({ line }) => line === row.index + 1)
            return (
              <div
                key={row.index}
                className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 p-2 sm:grid-cols-[minmax(8rem,1fr)_auto_minmax(10rem,1.35fr)_auto]"
              >
                <Input
                  aria-label={nameLabel}
                  aria-required={required || undefined}
                  aria-invalid={rowHasError || previewState === 'error' || undefined}
                  aria-describedby={describedBy}
                  value={row.name}
                  disabled={disabled}
                  placeholder={nameLabel}
                  className="col-start-1 row-start-1 font-mono text-[13px] sm:col-auto sm:row-auto"
                  onChange={(event) => replaceLine(row.index, row.name, event.target.value)}
                />
                <span
                  className="col-start-2 row-start-1 font-mono text-xs text-muted-foreground sm:col-auto sm:row-auto"
                  aria-hidden="true"
                >
                  {separator}
                </span>
                <Select
                  value={credentialId ?? ''}
                  disabled={disabled || !row.name}
                  onValueChange={(credentialIdValue) => {
                    if (credentialIdValue === NEW_CREDENTIAL_VALUE) {
                      onCreateCredential(row.name)
                      return
                    }
                    onCredentialChange(row.name, credentialIdValue)
                  }}
                >
                  <SelectTrigger
                    aria-label={
                      row.name ? t('Credential for {{name}}', { name: row.name }) : t('Credential')
                    }
                    className="col-start-1 row-start-2 sm:col-auto sm:row-auto"
                  >
                    <SelectValue placeholder={t('Select credential')} />
                  </SelectTrigger>
                  <SelectContent>
                    {credentials.length > 0 ? (
                      credentials.map((credential) => (
                        <SelectItem key={credential.id} value={credential.id}>
                          {credential.displayName} ·{' '}
                          {credential.kind === 'api_key' ? t('API key') : t('Access token')}
                        </SelectItem>
                      ))
                    ) : (
                      <SelectItem value="__no_static_credentials__" disabled>
                        {t('No matching credentials')}
                      </SelectItem>
                    )}
                    <SelectSeparator />
                    <SelectItem value={NEW_CREDENTIAL_VALUE}>{t('New credential')}</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={kind === 'environment' ? t('Remove variable') : t('Remove header')}
                  disabled={disabled || ('virtual' in row && row.virtual)}
                  className="col-start-2 row-start-2 sm:col-auto sm:row-auto"
                  onClick={() => removeLine(row.index, row.name)}
                >
                  <Trash2 aria-hidden="true" />
                </Button>
                {previewState === 'loading' && visibleIndex === 0 ? (
                  <span className="col-span-full text-xs text-muted-foreground" role="status">
                    {t('Loading…')}
                  </span>
                ) : null}
              </div>
            )
          })}
        </div>
      )}

      {mode === 'fields' ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-fit"
          disabled={disabled || rows.some((row) => !row.name)}
          onClick={addLine}
        >
          <Plus data-icon="inline-start" aria-hidden="true" />
          {addLabel}
        </Button>
      ) : null}

      {displayedInvalidLines.map((line) => (
        <p key={line} className="text-xs text-status-failure" role="alert">
          {kind === 'environment'
            ? t('Line {{line}}: use KEY=.', { line })
            : t('Line {{line}}: use Name: Value.', { line })}
        </p>
      ))}
      {parsed.duplicateLines.map(({ line, name }) => (
        <p key={`${line}-${name}`} className="text-xs text-status-failure" role="alert">
          {t('Line {{line}}: {{name}} is duplicated.', { line, name })}
        </p>
      ))}
      {previewState === 'success' ? (
        <p className="text-xs text-primary" role="status">
          {t('Credential selected.')}
        </p>
      ) : null}
    </div>
  )
}

export { ConnectorNamedCredentialEditor }
export type { ConnectorNamedCredentialEditorProps, NamedCredentialPreviewState }
