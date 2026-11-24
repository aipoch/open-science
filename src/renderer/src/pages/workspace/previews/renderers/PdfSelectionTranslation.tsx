import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Cpu, X } from 'lucide-react'
import { PDF_TRANSLATION_LANGUAGES } from '@aipoch/pdf-translation/text'
import { createPdfTranslationSource } from '@aipoch/pdf-translation/reader'
import { ErrorNotice } from '@/components/error-notice'
import { useSettingsStore } from '@/stores/settings-store'
import { ProviderKindIcon } from '@/pages/settings/provider-icons'
import { providerKindKey } from '@/pages/settings/provider-form-value'
import { resolveProviderEffectiveModel } from '../../../../../../shared/provider-reasoning-effort'
import { Button } from '@/components/ui/button'
import { PopoverContent } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import {
  initialSelectionTargetLanguage,
  rememberSelectionTargetLanguage,
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
      {result ? (
        result.text
      ) : (
        <>
          <span className="sr-only">{t('Translating…')}</span>
          <div aria-hidden="true" className="space-y-2 py-1.5 motion-safe:animate-pulse">
            <div className="h-2.5 w-full rounded-full bg-muted" />
            <div className="h-2.5 w-2/3 rounded-full bg-muted" />
          </div>
        </>
      )}
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
  const titleId = useId()
  const catalog = useAgentModels()
  const agentModels = catalog.models.filter((entry) => entry.selectable)
  const apiModels = useAvailableApiModels()
  const [selected, setSelected] = useState({ key: 'main', model: mainModel })
  const [attempt, setAttempt] = useState(0)
  const [language, setLanguage] = useState(() =>
    initialSelectionTargetLanguage(i18n.resolvedLanguage ?? navigator.language)
  )
  const activeModel = useSettingsStore((state) => state.activeModel)
  const mainProvider = catalog.providers.find((entry) => entry.id === catalog.activeProviderId)
  const mainModelName = resolveProviderEffectiveModel(mainProvider, activeModel)
  const picked = selected.model.agentModel ?? selected.model.apiModel
  const provider = picked
    ? catalog.providers.find((entry) => entry.id === picked.providerId)
    : mainProvider
  const model = picked ? picked.modelId : mainModelName
  const label = [provider?.name, model].filter(Boolean).join(' · ') || t('Main model')
  const icon = provider ? (
    <ProviderKindIcon
      kindKey={providerKindKey(provider.type, provider.vendorId)}
      className="size-4"
    />
  ) : (
    <Cpu className="size-4 shrink-0" aria-hidden="true" />
  )
  return (
    <PopoverContent
      align="start"
      collisionPadding={8}
      aria-labelledby={titleId}
      className="annotation-popover z-[110] flex w-80 flex-col gap-2 rounded-xl px-3 pb-1.5 pt-3"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id={titleId} className="text-xs font-medium text-muted-foreground">
          {t('Translation')}
        </h2>
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
      <div className="flex min-w-0 items-center justify-between gap-2 border-t border-border/60 pt-1">
        <Select
          value={language}
          onValueChange={(value) => {
            setLanguage(value)
            rememberSelectionTargetLanguage(value)
          }}
        >
          <SelectTrigger
            aria-label={t('Target language')}
            className="h-7 w-auto max-w-[45%] shrink-0 gap-1 border-0 bg-transparent px-1.5 text-xs text-muted-foreground [&>svg]:size-3"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent
            align="start"
            className="z-[120] min-w-28"
            onEscapeKeyDown={(event) => event.stopPropagation()}
          >
            {PDF_TRANSLATION_LANGUAGES.map((option) => (
              <SelectItem key={option} value={option}>
                {option === 'English' ? option : t(option)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={selected.key}
          onValueChange={(key) => {
            const agent = agentModels.find((entry) => 'agent:' + entry.key === key)
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
          <SelectTrigger
            aria-label={t('Model')}
            title={label}
            className="h-7 w-auto min-w-0 max-w-full justify-start gap-1.5 border-0 bg-transparent px-1.5 text-xs text-muted-foreground"
          >
            {icon}
            <span className="truncate">
              {provider && model && <>{provider.name} · </>}
              <span className="font-medium text-foreground">{model ?? label}</span>
            </span>
          </SelectTrigger>
          <SelectContent
            align="start"
            className="z-[120] w-72 max-w-[var(--radix-select-content-available-width)] [&_[data-slot=select-item]>span]:truncate"
            onEscapeKeyDown={(event) => event.stopPropagation()}
          >
            <SelectGroup>
              {mainProvider && <SelectLabel>{t('Main model')}</SelectLabel>}
              <SelectItem
                value="main"
                icon={
                  mainProvider ? (
                    <ProviderKindIcon
                      kindKey={providerKindKey(mainProvider.type, mainProvider.vendorId)}
                      className="size-4"
                    />
                  ) : (
                    <Cpu aria-hidden="true" className="size-4" />
                  )
                }
              >
                {[mainProvider?.name, mainModelName].filter(Boolean).join(' · ') || t('Main model')}
              </SelectItem>
            </SelectGroup>
            {[
              { route: 'agent', label: t('Agent'), models: agentModels },
              { route: 'api', label: t('Direct API'), models: apiModels }
            ].map(
              ({ route, label, models }) =>
                models.length > 0 && (
                  <SelectGroup key={route}>
                    <SelectLabel>{label}</SelectLabel>
                    {models.map((entry) => (
                      <SelectItem
                        key={entry.key}
                        value={route + ':' + entry.key}
                        icon={
                          <ProviderKindIcon
                            kindKey={providerKindKey(entry.providerType, entry.vendorId)}
                            className="size-4"
                          />
                        }
                      >
                        {entry.model
                          ? entry.providerName + ' · ' + entry.label
                          : entry.providerName}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                )
            )}
          </SelectContent>
        </Select>
      </div>
    </PopoverContent>
  )
}
