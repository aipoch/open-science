import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Languages, X } from 'lucide-react'
import { createPdfTranslationSource } from '@aipoch/pdf-translation/reader'
import { ErrorNotice } from '@/components/error-notice'
import { Button } from '@/components/ui/button'
import { PopoverContent } from '@/components/ui/popover'
import {
  defaultTargetLanguage,
  useAgentModels,
  useAvailableApiModels
} from './pdf-translation-model-options'
import { AGENT_TARGET, API_TARGET } from './pdf-translation-agent'
import { usePdfTranslationAgent } from './use-pdf-translation-agent'
import type { PdfTranslationOptions } from './use-pdf-translation-job'

type SelectionModel = Pick<PdfTranslationOptions, 'targetId' | 'agentModel' | 'apiModel'>
const mainModel: SelectionModel = { targetId: 'agent' }

function TranslationResult({
  text,
  selectionId,
  language,
  model,
  retry
}: {
  text: string
  selectionId: string
  language: string
  model: SelectionModel
  retry: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const executor = usePdfTranslationAgent()
  const [result, setResult] = useState<{ text: string } | { failed: true }>()
  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    const run = async (): Promise<void> => {
      signal.throwIfAborted()
      if (!executor?.begin) throw new Error('Translation unavailable')
      const source = createPdfTranslationSource({
        resourceRequestKey: selectionId,
        fingerprint: selectionId,
        pages: [],
        units: [{ id: selectionId, source: text, fragments: [] }]
      })
      await executor.begin(source, { ...model, language, glossary: [] }, signal)
      try {
        const translation = await executor.translate({
          target: model.targetId === 'api' ? API_TARGET : AGENT_TARGET,
          sourceIndex: 0,
          source: text,
          language,
          glossary: [],
          signal
        })
        if (!signal.aborted) setResult({ text: translation })
      } finally {
        await executor.end?.(signal)
      }
    }
    void Promise.resolve()
      .then(run)
      .catch(() => {
        if (!signal.aborted) setResult({ failed: true })
      })
    return () => controller.abort()
  }, [executor, language, model, selectionId, text])
  if (result && 'failed' in result)
    return (
      <ErrorNotice
        inline
        role="alert"
        title={t('Translation failed')}
        primaryButton={{ label: t('Retry'), onClick: retry }}
      />
    )
  return (
    <div
      role="status"
      className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-relaxed"
    >
      {result?.text ?? t('Translating…')}
    </div>
  )
}

export function PdfSelectionTranslation({
  text,
  selectionId,
  onClose
}: {
  text: string
  selectionId: string
  onClose: () => void
}): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const catalog = useAgentModels()
  const apiModels = useAvailableApiModels()
  const [selected, setSelected] = useState({ key: 'main', model: mainModel })
  const [attempt, setAttempt] = useState(0)
  const language = defaultTargetLanguage(i18n.resolvedLanguage ?? navigator.language)
  return (
    <PopoverContent
      align="start"
      collisionPadding={8}
      aria-label={t('Translation')}
      className="annotation-popover z-[110] flex w-80 flex-col gap-2.5 rounded-xl p-3"
    >
      <div className="flex items-center gap-2 text-muted-foreground">
        <Languages aria-hidden="true" className="size-4 shrink-0" />
        <select
          aria-label={t('Model')}
          className="min-w-0 flex-1 rounded bg-transparent py-1 text-xs focus-visible:ring-2 focus-visible:ring-ring"
          value={selected.key}
          onChange={(event) => {
            const key = event.target.value
            const agent = catalog.models.find(
              (entry) => 'agent:' + entry.key === key && entry.selectable
            )
            const api = apiModels.find((entry) => 'api:' + entry.key === key)
            setSelected({
              key,
              model: agent
                ? {
                    targetId: 'agent',
                    agentModel: {
                      frameworkId: catalog.frameworkId,
                      providerId: agent.providerId,
                      modelId: agent.model || undefined,
                      reasoningEffort: 'default'
                    }
                  }
                : api
                  ? {
                      targetId: 'api',
                      apiModel: { providerId: api.providerId, modelId: api.model }
                    }
                  : mainModel
            })
          }}
        >
          <option value="main">{t('Main model')}</option>
          <optgroup label={t('Agent')}>
            {catalog.models
              .filter((entry) => entry.selectable)
              .map((entry) => (
                <option key={entry.key} value={'agent:' + entry.key}>
                  {entry.providerName} · {entry.label}
                </option>
              ))}
          </optgroup>
          <optgroup label={t('Direct API')}>
            {apiModels.map((entry) => (
              <option key={entry.key} value={'api:' + entry.key}>
                {entry.providerName} · {entry.label}
              </option>
            ))}
          </optgroup>
        </select>
        <Button variant="ghost" size="icon-xs" aria-label={t('Close')} onClick={onClose}>
          <X />
        </Button>
      </div>
      <TranslationResult
        key={JSON.stringify([selectionId, selected.key, language, attempt])}
        text={text}
        selectionId={selectionId}
        language={language}
        model={selected.model}
        retry={() => setAttempt((n) => n + 1)}
      />
    </PopoverContent>
  )
}
