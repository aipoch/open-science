import { Plus, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { fieldErrorClassName } from '@/components/ui/notice-chrome'
import { LOCAL_PROVIDER_MODEL_LIMIT } from '../../../../shared/local-provider-preset'
import { DEFAULT_CUSTOM_MODEL_CONTEXT_WINDOW } from '../../../../shared/provider-model-policy'
import {
  CUSTOM_REASONING_EFFORT_PRESETS,
  isReasoningEffortPresetSetting
} from '../../../../shared/reasoning-effort'
import { localModelFormRow, type LocalModelFormRow } from './local-provider-model-form'

type LocalProviderModelsEditorProps = {
  providerName: string
  rows: readonly LocalModelFormRow[]
  onChange: (rows: LocalModelFormRow[]) => void
  refreshButton: React.ReactNode
  disabled?: boolean
  modelError?: string
  contextError?: string
}

const rowGrid =
  'items-start gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(6rem,.65fr)_minmax(0,1fr)_auto]'

export function LocalProviderModelsEditor({
  providerName,
  rows,
  onChange,
  refreshButton,
  disabled,
  modelError,
  contextError
}: LocalProviderModelsEditorProps): React.JSX.Element {
  const { t } = useTranslation()
  const displayName = t('Display name')
  const modelId = t('Model ID')
  const contextWindow = t('Context window')
  const reasoningLevels = t('Reasoning effort levels')
  const update = (rowId: string, patch: Partial<LocalModelFormRow>): void => {
    onChange(rows.map((row) => (row.rowId === rowId ? { ...row, ...patch } : row)))
  }

  return (
    <section className="space-y-2" aria-labelledby="provider-local-models-label">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="provider-local-models-label" className="text-xs font-medium text-muted-foreground">
          {t('Models')}
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          {refreshButton}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || rows.length >= LOCAL_PROVIDER_MODEL_LIMIT}
            onClick={() => onChange([...rows, localModelFormRow()])}
          >
            <Plus aria-hidden="true" />
            {t('Add model')}
          </Button>
        </div>
      </div>
      {rows.length > 0 && (
        <div
          className={`${rowGrid} hidden text-xs text-muted-foreground md:grid`}
          aria-hidden="true"
        >
          <span>{displayName}</span>
          <span>{modelId}</span>
          <span>{contextWindow}</span>
          <span>{reasoningLevels}</span>
          <span className="w-8" />
        </div>
      )}
      {rows.map((row) => (
        <div
          key={row.rowId}
          className={`${rowGrid} grid rounded-md border border-border p-2 md:border-0 md:p-0`}
        >
          <Input
            aria-label={displayName}
            placeholder={providerName || displayName}
            value={row.displayName ?? providerName}
            maxLength={128}
            disabled={disabled}
            onChange={(event) => update(row.rowId, { displayName: event.target.value })}
            onBlur={(event) => {
              if (!event.target.value.trim() && row.displayName !== undefined)
                update(row.rowId, { displayName: undefined })
            }}
          />
          <Input
            aria-label={modelId}
            aria-required="true"
            placeholder={modelId}
            value={row.id}
            maxLength={512}
            disabled={disabled}
            onChange={(event) => update(row.rowId, { id: event.target.value })}
          />
          <Input
            aria-label={contextWindow}
            placeholder={String(DEFAULT_CUSTOM_MODEL_CONTEXT_WINDOW)}
            inputMode="numeric"
            value={row.contextWindow}
            disabled={disabled}
            onChange={(event) => update(row.rowId, { contextWindow: event.target.value })}
          />
          <Select
            value={row.reasoningEffortPreset}
            disabled={disabled}
            onValueChange={(reasoningEffortPreset) => {
              if (isReasoningEffortPresetSetting(reasoningEffortPreset))
                update(row.rowId, { reasoningEffortPreset })
            }}
          >
            <SelectTrigger aria-label={reasoningLevels}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="unsupported">{t('Off')}</SelectItem>
              {CUSTOM_REASONING_EFFORT_PRESETS.map(({ id, label }) => (
                <SelectItem key={id} value={id}>
                  {label.split(' — ')[0]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t('Remove model')}
            disabled={disabled}
            onClick={() => onChange(rows.filter(({ rowId }) => rowId !== row.rowId))}
          >
            <Trash2 aria-hidden="true" />
          </Button>
        </div>
      ))}
      {[modelError, contextError].filter(Boolean).map((error) => (
        <p key={error} className={fieldErrorClassName} role="alert">
          {error}
        </p>
      ))}
    </section>
  )
}
