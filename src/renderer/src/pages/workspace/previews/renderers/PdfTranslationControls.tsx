/* Hallmark · component: translation controls · theme: existing Open-Science tokens */
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Collapsible } from 'radix-ui'
import {
  Check,
  ChevronDown,
  ChevronRight,
  Info,
  LoaderCircle,
  Pause,
  Play,
  TriangleAlert
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Input } from '@/components/ui/input'
import { PdfTranslationGlossaryEditor } from './PdfTranslationGlossaryEditor'
import { glossaryError } from './pdf-translation-glossary'
import {
  formatPdfTranslationGlossary,
  pdfTranslationGlossarySchema
} from '../../../../../../shared/pdf-translation'
import * as Dialog from '@/components/ui/dialog'
import {
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { selectFrameworkApiEndpoints, useSettingsStore } from '@/stores/settings-store'
import {
  pdfTranslationAgentModels,
  pdfTranslationApiModels
} from '../../../../../../shared/pdf-translation-models'
import { configuredModelKey } from '../../../../../../shared/configured-model-catalog'
import type {
  AgentFrameworkId,
  ChatApiEndpoint,
  ProviderView
} from '../../../../../../shared/settings'
import { modelUnavailableReason } from '../../composer-model-picker-utils'
import { resolveProviderEffectiveModel } from '../../../../../../shared/provider-reasoning-effort'
import { ErrorNotice } from '@/components/error-notice'
import {
  PDF_TRANSLATION_LANGUAGES,
  isPdfTranslationLanguageSupported
} from '../../../../../../shared/pdf-translation-languages'
import { PdfTranslationActionHint } from './PdfTranslationActionHint'
import { LocalPdfTranslationModel } from './LocalPdfTranslationModel'
import { useLocalPdfTranslationModel } from './use-pdf-translation-agent'
import type {
  PdfTranslationExecutor,
  PdfTranslationJob,
  PdfTranslationOptions
} from './use-pdf-translation-job'

const TARGET_LANGUAGES = PDF_TRANSLATION_LANGUAGES

function defaultTargetLanguage(locale?: string): string {
  const language = locale?.toLocaleLowerCase().split(/[-_]/)[0]
  return (
    (
      {
        ar: 'Arabic',
        de: 'German',
        es: 'Spanish',
        fr: 'French',
        hi: 'Hindi',
        it: 'Italian',
        ja: 'Japanese',
        ko: 'Korean',
        nl: 'Dutch',
        pt: 'Portuguese',
        ru: 'Russian',
        zh: 'Chinese'
      } as Record<string, string>
    )[language ?? ''] ?? 'English'
  )
}

function TargetLanguageCombobox({
  inputId,
  value,
  onChange,
  disabled
}: {
  inputId: string
  value: string
  onChange: (value: string) => void
  disabled: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const listboxId = useId()
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(-1)
  const label = (language: (typeof TARGET_LANGUAGES)[number]): string =>
    language === 'English' ? language : t(language)
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const matches = TARGET_LANGUAGES.filter((language) =>
    label(language).toLocaleLowerCase().includes(normalizedQuery)
  )
  const selectLanguage = (language: string): void => {
    onChange(language)
    setQuery('')
    setActiveIndex(-1)
    setOpen(false)
    inputRef.current?.focus()
  }
  const openWithIndex = (index: number): void => {
    if (disabled) return
    setOpen(true)
    setActiveIndex(index)
  }
  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (disabled) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setOpen(true)
      setActiveIndex((current) => {
        if (!matches.length) return -1
        const next = event.key === 'ArrowDown' ? current + 1 : current - 1
        return (next + matches.length) % matches.length
      })
    } else if (event.key === 'Enter' && open && matches[activeIndex]) {
      event.preventDefault()
      selectLanguage(matches[activeIndex])
    } else if (event.key === 'Escape' && open) {
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      setActiveIndex(-1)
    }
  }

  return (
    <div
      ref={containerRef}
      className="relative"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setOpen(false)
          setActiveIndex(-1)
        }
      }}
    >
      <div className="flex h-9 min-w-0 items-center overflow-hidden rounded-md border border-input bg-background focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/40">
        <Input
          ref={inputRef}
          id={inputId}
          maxLength={80}
          value={value}
          disabled={disabled}
          aria-required="true"
          role="combobox"
          aria-expanded={open && !disabled}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-activedescendant={
            open && activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined
          }
          onClick={() => {
            setQuery('')
            openWithIndex(-1)
          }}
          onChange={(event) => {
            onChange(event.target.value)
            setQuery(event.target.value)
            setActiveIndex(0)
            openWithIndex(0)
          }}
          onKeyDown={handleKeyDown}
          className="h-full min-w-0 flex-1 rounded-none border-0 bg-transparent pr-1 shadow-none ring-0 focus-visible:border-0 focus-visible:ring-0"
        />
        <button
          type="button"
          tabIndex={-1}
          aria-label={t('Show target languages')}
          aria-expanded={open && !disabled}
          aria-haspopup="listbox"
          disabled={disabled}
          onMouseDown={(event) => {
            event.preventDefault()
          }}
          onClick={() => {
            if (open) {
              setOpen(false)
              setActiveIndex(-1)
            } else {
              openWithIndex(-1)
            }
          }}
          className="flex h-full w-9 shrink-0 cursor-pointer items-center justify-center rounded-e-md text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        >
          <ChevronDown
            aria-hidden="true"
            className={`size-4 transition-transform duration-150 motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}
          />
        </button>
      </div>
      {open && !disabled ? (
        <div
          id={listboxId}
          role="listbox"
          className="absolute inset-x-0 top-full z-50 mt-1 max-h-56 overflow-y-auto rounded-md border border-border bg-popover p-1.5 text-popover-foreground shadow-menu"
        >
          {matches.length ? (
            matches.map((language, index) => (
              <button
                key={language}
                id={`${listboxId}-option-${index}`}
                type="button"
                role="option"
                aria-selected={value === language}
                tabIndex={-1}
                onMouseEnter={() => setActiveIndex(index)}
                className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm outline-none ${activeIndex === index ? 'bg-muted' : ''} hover:bg-muted focus-visible:bg-muted`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => selectLanguage(language)}
              >
                <span>{label(language)}</span>
                {value === language ? <Check aria-hidden="true" className="size-4" /> : null}
              </button>
            ))
          ) : (
            <p className="px-2 py-2 text-xs leading-5 text-muted-foreground">
              {t('No matching languages.')}
            </p>
          )}
        </div>
      ) : null}
    </div>
  )
}

function useAvailableApiModels(): ReturnType<typeof pdfTranslationApiModels> {
  const providers = useSettingsStore((store) => store.providers)
  return useMemo(() => pdfTranslationApiModels(providers), [providers])
}

function useAgentModels(overrideFramework?: AgentFrameworkId): {
  models: ReturnType<typeof pdfTranslationAgentModels>
  providers: ProviderView[]
  frameworkId: AgentFrameworkId
  frameworkEndpoints: ChatApiEndpoint[]
  activeProviderId?: string
  frameworkName: string
} {
  const providers = useSettingsStore((store) => store.providers)
  const activeProviderId = useSettingsStore((store) => store.activeProviderId)
  const claudeSubscriptionProviderId = useSettingsStore(
    (store) => store.claudeSubscriptionProviderId
  )
  const activeFramework = useSettingsStore((store) => store.agentFrameworkId)
  const frameworks = useSettingsStore((store) => store.agentFrameworks)
  const activeEndpoints = useSettingsStore(selectFrameworkApiEndpoints)
  const frameworkId = overrideFramework ?? activeFramework
  const framework = frameworks.find((entry) => entry.id === frameworkId)
  const frameworkEndpoints = framework?.supportedApiTypes ?? activeEndpoints
  const models = useMemo(
    () =>
      pdfTranslationAgentModels({
        providers,
        activeProviderId,
        claudeSubscriptionProviderId,
        frameworkId,
        frameworkEndpoints
      }),
    [providers, activeProviderId, claudeSubscriptionProviderId, frameworkId, frameworkEndpoints]
  )
  return {
    models,
    providers,
    frameworkId,
    frameworkEndpoints,
    activeProviderId,
    frameworkName: framework?.displayName ?? frameworkId
  }
}

function AgentModelDetails({
  state,
  direct,
  current = false
}: {
  state: PdfTranslationJob
  direct?: boolean
  current?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const activeModel = useSettingsStore((store) => store.activeModel)
  const activeProviderId = useSettingsStore((store) => store.activeProviderId)
  const providers = useSettingsStore((store) => store.providers)
  const frameworkId = useSettingsStore((store) => store.agentFrameworkId)
  const frameworks = useSettingsStore((store) => store.agentFrameworks)
  const provider = providers.find((value) => value.id === activeProviderId)
  const model = current ? undefined : state.model
  const label = model
    ? (model.modelId ?? t('Default'))
    : current
      ? (resolveProviderEffectiveModel(provider, activeModel) ?? t('Default'))
      : t('Not recorded')
  const framework = frameworks.find(
    (value) => value.id === (model?.frameworkId ?? (current ? frameworkId : undefined))
  )
  return (
    <p className="break-words text-xs leading-5 text-muted-foreground">
      {direct || (!current && state.options?.agentModel) ? t('Model') : t('Main model')}: {label}
      {direct ? ` · ${t('Direct API')}` : framework ? ` · ${framework.displayName}` : ''}
    </p>
  )
}

function TranslationSettingsFields({
  executor,
  options,
  state,
  disabled = false,
  localModel,
  onChange
}: {
  executor: PdfTranslationExecutor
  options: PdfTranslationOptions
  state: PdfTranslationJob
  disabled?: boolean
  localModel: ReturnType<typeof useLocalPdfTranslationModel>
  onChange: (options: PdfTranslationOptions) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const modelLabelId = useId()
  const targetLanguageId = useId()
  const concurrencyId = useId()
  const apiModelId = useId()
  const apiModels = useAvailableApiModels()
  const agentCatalog = useAgentModels(options.agentModel?.frameworkId)
  const target = executor.targets.find((value) => value.id === options.targetId)
  const apiModelHint = t('Direct API only supports API models. Subscription models must use Agent.')
  const lockedSettingsReason = disabled
    ? t('Start a new translation to change these settings.')
    : undefined
  const apiModelDisabledReason = !apiModels.length
    ? t('No available API models. Configure an API provider in Settings.')
    : disabled
      ? t('Start a new translation to change the model.')
      : undefined
  return (
    <>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={targetLanguageId}>{t('Target language')}</label>
        <PdfTranslationActionHint reason={lockedSettingsReason} className="w-full [&>div]:w-full">
          <TargetLanguageCombobox
            inputId={targetLanguageId}
            value={options.language}
            disabled={disabled}
            onChange={(language) => onChange({ ...options, language })}
          />
        </PdfTranslationActionHint>
        {options.language.trim() && !isPdfTranslationLanguageSupported(options.language) ? (
          <p className="text-xs leading-5 text-muted-foreground">
            {t(
              'This target language is not supported for translated PDFs. Choose a supported language.'
            )}
          </p>
        ) : null}
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1">
          <span id={modelLabelId}>{t('Translation method')}</span>
          {target && target.mode !== 'local' ? (
            <TooltipProvider delayDuration={100}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="size-6 text-muted-foreground"
                    aria-label={t('Translation data usage')}
                  >
                    <Info aria-hidden="true" className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent className="z-[130] max-w-64">
                  {t('The document text and glossary will be sent to the selected model.')}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : null}
        </div>
        <PdfTranslationActionHint
          reason={lockedSettingsReason}
          className="w-full [&>button]:w-full"
        >
          <Select
            value={options.targetId}
            disabled={disabled}
            onValueChange={(targetId) =>
              onChange({
                ...options,
                targetId,
                apiModel: undefined,
                agentModel: undefined,
                ...(targetId === 'local' ? { concurrency: 1 } : {})
              })
            }
          >
            <SelectTrigger aria-labelledby={modelLabelId} aria-required="true">
              <SelectValue placeholder={t('Select a translation method')} />
            </SelectTrigger>
            <SelectContent className="z-[120]" onEscapeKeyDown={(event) => event.stopPropagation()}>
              {executor.targets.map((value) => (
                <SelectItem key={value.id} value={value.id}>
                  {value.id === 'agent'
                    ? t('Agent')
                    : value.id === 'api'
                      ? t('Direct API')
                      : value.id === 'local'
                        ? t('Local model')
                        : value.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </PdfTranslationActionHint>
      </div>
      {target?.id === 'local' ? (
        <LocalPdfTranslationModel model={localModel} running={state.status === 'running'} />
      ) : null}
      {target?.id === 'api' && (!disabled || options.apiModel) ? (
        <TooltipProvider delayDuration={100}>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-1">
              <span id={apiModelId}>{t('Model')}</span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="size-6 text-muted-foreground"
                    aria-label={t('Model settings')}
                  >
                    <Info aria-hidden="true" className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent
                  className="z-[130] max-w-64"
                  onEscapeKeyDown={(event) => event.stopPropagation()}
                >
                  {apiModelHint}
                </TooltipContent>
              </Tooltip>
            </div>
            <Select
              value={
                options.apiModel
                  ? configuredModelKey(options.apiModel.providerId, options.apiModel.modelId)
                  : ''
              }
              disabled={disabled || !apiModels.length}
              onValueChange={(key) => {
                const model = apiModels.find((entry) => entry.key === key)
                if (model)
                  onChange({
                    ...options,
                    apiModel: { providerId: model.providerId, modelId: model.model }
                  })
              }}
            >
              <Tooltip>
                <TooltipTrigger
                  asChild
                  onFocus={(event) => {
                    if (!event.currentTarget.matches(':focus-visible')) event.preventDefault()
                  }}
                >
                  <span
                    className="block"
                    role={apiModelDisabledReason ? 'group' : undefined}
                    aria-labelledby={apiModelDisabledReason ? apiModelId : undefined}
                    tabIndex={apiModelDisabledReason ? 0 : undefined}
                  >
                    <SelectTrigger aria-labelledby={apiModelId} aria-required="true">
                      <SelectValue placeholder={t('Select a model')} />
                    </SelectTrigger>
                  </span>
                </TooltipTrigger>
                {apiModelDisabledReason ? (
                  <TooltipContent
                    className="z-[130] max-w-64"
                    onEscapeKeyDown={(event) => event.stopPropagation()}
                  >
                    {apiModelDisabledReason}
                  </TooltipContent>
                ) : null}
              </Tooltip>
              <SelectContent
                className="z-[120]"
                onEscapeKeyDown={(event) => event.stopPropagation()}
              >
                {options.apiModel &&
                !apiModels.some(
                  (entry) =>
                    entry.key ===
                    configuredModelKey(options.apiModel!.providerId, options.apiModel!.modelId)
                ) ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <SelectItem
                        disabled
                        className="data-[disabled]:pointer-events-auto data-[disabled]:cursor-not-allowed"
                        value={configuredModelKey(
                          options.apiModel.providerId,
                          options.apiModel.modelId
                        )}
                      >
                        {options.apiModel.modelId} · {t('Unavailable')}
                      </SelectItem>
                    </TooltipTrigger>
                    <TooltipContent
                      className="z-[130] max-w-64"
                      onEscapeKeyDown={(event) => event.stopPropagation()}
                    >
                      {t(
                        'The selected model is no longer available. Select another model or check its configuration in Settings.'
                      )}
                    </TooltipContent>
                  </Tooltip>
                ) : null}
                {apiModels.map((entry) => (
                  <SelectItem key={entry.key} value={entry.key}>
                    {entry.model} · {entry.providerName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </TooltipProvider>
      ) : null}
      {target?.id === 'agent' ? (
        <div className="flex flex-col gap-1.5">
          <label id={apiModelId}>{t('Model')}</label>
          <PdfTranslationActionHint
            reason={lockedSettingsReason}
            className="w-full [&>button]:w-full"
          >
            <Select
              disabled={disabled}
              value={
                options.agentModel
                  ? configuredModelKey(
                      options.agentModel.providerId,
                      options.agentModel.modelId ?? ''
                    )
                  : 'main-model'
              }
              onValueChange={(key) => {
                const entry = agentCatalog.models.find(
                  (value) => value.key === key && value.selectable
                )
                if (key === 'main-model') onChange({ ...options, agentModel: undefined })
                else if (entry)
                  onChange({
                    ...options,
                    agentModel: {
                      frameworkId: agentCatalog.frameworkId,
                      providerId: entry.providerId,
                      ...(entry.model ? { modelId: entry.model } : {}),
                      reasoningEffort: 'default'
                    }
                  })
              }}
            >
              <SelectTrigger aria-labelledby={apiModelId}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent
                className="z-[120]"
                onEscapeKeyDown={(event) => event.stopPropagation()}
              >
                <SelectItem value="main-model">{t('Main model')}</SelectItem>
                {options.agentModel &&
                !agentCatalog.models.some(
                  (entry) =>
                    entry.key ===
                    configuredModelKey(
                      options.agentModel!.providerId,
                      options.agentModel!.modelId ?? ''
                    )
                ) ? (
                  <TooltipProvider delayDuration={100}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <SelectItem
                          disabled
                          className="data-[disabled]:pointer-events-auto data-[disabled]:cursor-not-allowed"
                          value={configuredModelKey(
                            options.agentModel.providerId,
                            options.agentModel.modelId ?? ''
                          )}
                        >
                          {options.agentModel.modelId ?? options.agentModel.providerId} ·{' '}
                          {t('Unavailable')}
                        </SelectItem>
                      </TooltipTrigger>
                      <TooltipContent
                        className="z-[130] max-w-64"
                        onEscapeKeyDown={(event) => event.stopPropagation()}
                      >
                        {t(
                          'The selected model is no longer available. Select another model or check its configuration in Settings.'
                        )}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                ) : null}
                {agentCatalog.models.map((entry) => {
                  const reason = entry.subscriptionUnsupported
                    ? t('This subscription model cannot run PDF translation. Select another model.')
                    : entry.credentialsUnavailable
                      ? t(
                          'The selected model is unavailable. Check its configuration in Settings or start a new translation with another model.'
                        )
                      : modelUnavailableReason(
                          entry,
                          agentCatalog.providers.find(
                            (provider) => provider.id === entry.providerId
                          )!,
                          agentCatalog.frameworkName,
                          agentCatalog.frameworkEndpoints,
                          t
                        )
                  return (
                    <TooltipProvider key={entry.key} delayDuration={100}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <SelectItem
                            value={entry.key}
                            disabled={!entry.selectable}
                            className="data-[disabled]:pointer-events-auto data-[disabled]:cursor-not-allowed"
                          >
                            {entry.model
                              ? `${entry.label} · ${entry.providerName}`
                              : entry.providerName}
                          </SelectItem>
                        </TooltipTrigger>
                        {reason ? (
                          <TooltipContent
                            className="z-[130] max-w-64"
                            onEscapeKeyDown={(event) => event.stopPropagation()}
                          >
                            {reason}
                          </TooltipContent>
                        ) : null}
                      </Tooltip>
                    </TooltipProvider>
                  )
                })}
              </SelectContent>
            </Select>
          </PdfTranslationActionHint>
          {!options.agentModel ? <AgentModelDetails state={state} current={!disabled} /> : null}
        </div>
      ) : null}
      {target?.id === 'api' && disabled && !options.apiModel ? (
        <AgentModelDetails state={state} direct={target.id === 'api'} />
      ) : null}
      <Collapsible.Root className="overflow-hidden rounded-md border border-border/60 bg-background/70">
        <Collapsible.Trigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="group min-h-8 w-full justify-start gap-2 rounded-none px-2 text-left hover:bg-muted/60 aria-expanded:bg-muted/50"
          >
            <ChevronRight
              aria-hidden="true"
              className="size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-data-[state=open]:rotate-90 motion-reduce:transition-none"
            />
            {t('Translation glossary')}
          </Button>
        </Collapsible.Trigger>
        <Collapsible.Content
          forceMount
          className="space-y-3 border-t border-border/60 px-3 pb-2 pt-2 data-[state=closed]:hidden"
        >
          <PdfTranslationActionHint reason={lockedSettingsReason} className="w-full">
            <PdfTranslationGlossaryEditor
              value={options.glossary}
              disabled={disabled}
              onChange={(glossary) => onChange({ ...options, glossary })}
            />
          </PdfTranslationActionHint>
        </Collapsible.Content>
      </Collapsible.Root>
      <Collapsible.Root className="overflow-hidden rounded-md border border-border/60 bg-background/70">
        <Collapsible.Trigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="group min-h-8 w-full justify-start gap-2 rounded-none px-2 text-left hover:bg-muted/60 aria-expanded:bg-muted/50"
          >
            <ChevronRight
              aria-hidden="true"
              className="size-4 shrink-0 transition-transform duration-150 group-data-[state=open]:rotate-90 motion-reduce:transition-none"
            />
            {t('Advanced')}
          </Button>
        </Collapsible.Trigger>
        <Collapsible.Content className="flex flex-col gap-1.5 border-t border-border/60 px-3 pb-3 pt-3 data-[state=closed]:hidden">
          <label id={concurrencyId}>{t('Concurrent translations')}</label>
          <PdfTranslationActionHint
            reason={
              target?.mode === 'local'
                ? t('Local translation runs one paragraph at a time to limit memory use.')
                : lockedSettingsReason
            }
            className="w-full [&>button]:w-full"
          >
            <Select
              value={String(target?.mode === 'local' ? 1 : (options.concurrency ?? 1))}
              disabled={disabled || target?.mode === 'local'}
              onValueChange={(value) =>
                onChange({ ...options, concurrency: Number(value) as 1 | 2 | 4 })
              }
            >
              <SelectTrigger aria-labelledby={concurrencyId}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent
                className="z-[120]"
                onEscapeKeyDown={(event) => event.stopPropagation()}
              >
                <SelectItem value="1">{t('1x (serial)')}</SelectItem>
                <SelectItem value="2">{'2x'}</SelectItem>
                <SelectItem value="4">{'4x'}</SelectItem>
              </SelectContent>
            </Select>
          </PdfTranslationActionHint>
        </Collapsible.Content>
      </Collapsible.Root>
    </>
  )
}

export function PdfTranslationControls({
  executor,
  state,
  ready,
  hasTranslatableText,
  onStart,
  onCancel,
  onSkip,
  onNewTranslation
}: {
  executor?: PdfTranslationExecutor
  state: PdfTranslationJob
  ready: boolean
  hasTranslatableText: boolean
  onStart: (options: PdfTranslationOptions) => void
  onCancel: () => void
  onSkip?: (unitId: string) => void
  onNewTranslation: (options: PdfTranslationOptions) => void
}): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const apiModels = useAvailableApiModels()
  const activeProviderId = useSettingsStore((store) => store.activeProviderId)
  const [apiModel, setApiModel] = useState<PdfTranslationOptions['apiModel']>(
    () => state.options?.apiModel
  )
  const [agentModel, setAgentModel] = useState<PdfTranslationOptions['agentModel']>(
    () => state.options?.agentModel
  )
  const [targetId, setTargetId] = useState(() => state.options?.targetId ?? ''),
    [language, setLanguage] = useState(() =>
      defaultTargetLanguage(
        i18n.resolvedLanguage ?? (typeof navigator === 'undefined' ? undefined : navigator.language)
      )
    ),
    [glossary, setGlossary] = useState(() => state.options?.glossary ?? []),
    [concurrency, setConcurrency] = useState<1 | 2 | 4 | undefined>(
      () => state.options?.concurrency
    )
  const pinned = state.options?.language.trim() ? state.options : undefined,
    running = state.status === 'running'
  const agentCatalog = useAgentModels(pinned?.agentModel?.frameworkId)
  const [draftOwner, setDraftOwner] = useState(pinned)
  const [settingsOpen, setSettingsOpen] = useState(!pinned)
  const [newOptions, setNewOptions] = useState<PdfTranslationOptions>()
  const newAgentCatalog = useAgentModels(newOptions?.agentModel?.frameworkId)
  const localModel = useLocalPdfTranslationModel(
    (pinned?.targetId ?? targetId) === 'local' || newOptions?.targetId === 'local'
  )
  const previousReady = useRef(ready)
  useEffect(() => {
    if (ready && !previousReady.current && !pinned) setSettingsOpen(true)
    previousReady.current = ready
  }, [pinned, ready])
  if (pinned && pinned !== draftOwner) {
    setDraftOwner(pinned)
    setTargetId(pinned.targetId)
    setLanguage(pinned.language)
    setGlossary(pinned.glossary)
    setConcurrency(pinned.concurrency)
    setApiModel(pinned.apiModel)
    setAgentModel(pinned.agentModel)
  }
  const selectedId = pinned?.targetId ?? targetId
  const target = executor?.targets.find((value) => value.id === selectedId)
  const targetLabel = target
    ? target.id === 'agent'
      ? t('Agent')
      : target.id === 'api'
        ? t('Direct API')
        : target.id === 'local'
          ? t('Local model')
          : target.label
    : selectedId
  const savedModelLabel = state.model?.modelId ?? (state.model ? t('Default') : t('Not recorded'))
  const unavailableReason = (
    options: PdfTranslationOptions | undefined,
    allowLegacyModel = false,
    catalog = agentCatalog
  ): string | undefined => {
    if (running) return t('Wait for the current translation to finish or cancel it.')
    if (!ready) return t('Prepare full text before translating.')
    if (!hasTranslatableText) return t('No eligible paragraphs were found in the prepared text.')
    if (!options?.language.trim()) return t('Select a target language to continue.')
    if (!isPdfTranslationLanguageSupported(options.language))
      return t(
        'This target language is not supported for translated PDFs. Choose a supported language.'
      )
    const invalidGlossary = glossaryError(options.glossary, t)
    if (invalidGlossary) return invalidGlossary
    const selectedTarget = executor?.targets.find((entry) => entry.id === options.targetId)
    if (!selectedTarget)
      return allowLegacyModel
        ? t(
            'The selected translation method is unavailable. Start a new translation with an available method.'
          )
        : t('Select a translation method to continue.')
    if (selectedTarget.id === 'local') {
      if (localModel.requestFailed)
        return t('Could not access local models. Open the local app and try again.')
      if (!localModel.snapshot) return t('Loading…')
      if (localModel.pending || localModel.snapshot.availability !== 'ready')
        return t('Install the local translation model before translating.')
    }
    if (
      selectedTarget.id === 'agent' &&
      !options.agentModel &&
      catalog.models.some(
        (entry) => entry.providerId === catalog.activeProviderId && entry.subscriptionUnsupported
      )
    )
      return t('This subscription model cannot run PDF translation. Select another model.')
    if (
      selectedTarget.id === 'agent' &&
      options.agentModel &&
      !catalog.models.some(
        (entry) =>
          entry.selectable &&
          entry.providerId === options.agentModel!.providerId &&
          entry.model === (options.agentModel!.modelId ?? '')
      )
    )
      return t(
        'The selected model is unavailable. Check its configuration in Settings or start a new translation with another model.'
      )
    if (selectedTarget.id === 'api') {
      if (!apiModels.length)
        return t('No available API models. Configure an API provider in Settings.')
      const available = apiModels.some((entry) =>
        options.apiModel
          ? entry.providerId === options.apiModel.providerId &&
            entry.model === options.apiModel.modelId
          : allowLegacyModel &&
            entry.providerId === activeProviderId &&
            entry.model === state.model?.modelId
      )
      if (!available && allowLegacyModel)
        return t(
          'The selected model is unavailable. Check its configuration in Settings or start a new translation with another model.'
        )
      if (!available)
        return options.apiModel
          ? t(
              'The selected model is no longer available. Select another model or check its configuration in Settings.'
            )
          : t('Select a model to continue.')
    }
    return undefined
  }
  const startDisabledReason = unavailableReason(
    pinned ?? { targetId, language, glossary, apiModel, agentModel },
    Boolean(pinned)
  )
  const canStart = !startDisabledReason
  const percent = state.total > 0 ? Math.min(100, Math.floor((state.done / state.total) * 100)) : 0
  const start = (): void => {
    if (!canStart) return
    setSettingsOpen(false)
    onStart(
      pinned ?? {
        targetId,
        language,
        glossary: pdfTranslationGlossarySchema.parse(glossary),
        ...(targetId === 'api' && apiModel ? { apiModel } : {}),
        ...(targetId === 'agent' && agentModel ? { agentModel } : {}),
        ...(concurrency !== undefined ? { concurrency } : {})
      }
    )
  }
  const newDisabledReason = unavailableReason(newOptions, false, newAgentCatalog)
  const canStartNew = !newDisabledReason
  const startNewTranslation = (): void => {
    if (!canStartNew || !newOptions) return
    onNewTranslation({
      ...newOptions,
      language: newOptions.language.trim(),
      glossary: pdfTranslationGlossarySchema.parse(newOptions.glossary)
    })
    setNewOptions(undefined)
    setSettingsOpen(false)
  }
  const providerFailure = state.providerFailure
  const providerDescription = providerFailure
    ? {
        authentication: t(
          'The provider rejected the API credentials. Check the API key in Settings before retrying.'
        ),
        permission: t(
          'The provider denied access. Check the model and account permissions before retrying.'
        ),
        quota: t(
          'The provider reported insufficient quota. Check the account balance or usage limit before retrying.'
        ),
        'rate-limit': t('The provider is limiting requests. Please wait before retrying.'),
        unavailable: t('The provider is temporarily unavailable. Please try again later.'),
        request: t(
          'The provider rejected the request. Check the model and API settings before retrying.'
        ),
        network: t(
          'Could not connect to the provider. Check the network and API address before retrying.'
        ),
        http: t(
          'The provider returned an unexpected response. Check the API settings before retrying.'
        )
      }[providerFailure.kind]
    : undefined
  const translationProgress =
    state.status !== 'idle' && state.status !== 'completed' ? (
      <div role="status" aria-atomic="true" className="space-y-2 px-1 py-2">
        <div className="flex h-7 items-center gap-2 [&>p]:flex-1">
          <p className="flex min-w-0 items-center gap-2 font-medium">
            {running ? (
              <LoaderCircle
                aria-hidden="true"
                className="size-4 shrink-0 animate-spin text-primary motion-reduce:animate-none"
              />
            ) : (
              <Pause aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            )}
            {running
              ? state.retryUnitId
                ? t('Translating paragraph…')
                : t('Translating…')
              : t('Translation paused')}
          </p>
          {!state.retryUnitId ? (
            <span
              className="shrink-0 text-xs text-muted-foreground tabular-nums"
              aria-label={t('Paragraphs translated: {{done}} / {{total}}', {
                done: state.done,
                total: state.total
              })}
            >
              {state.done} / {state.total}
            </span>
          ) : null}
          {!running ? (
            <TooltipProvider delayDuration={100}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label={t('More information')}>
                    <Info aria-hidden="true" className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent className="z-[120] max-w-64">
                  {state.status === 'cancelled' || providerFailure
                    ? t('Translation is incomplete. Completed paragraphs are kept.')
                    : t('Some paragraphs could not be translated.')}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : null}
        </div>
        <div className="h-1">
          {running && !state.retryUnitId ? (
            <div
              role="progressbar"
              aria-label={t('Translated paragraphs')}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              className="h-1 w-full overflow-hidden rounded-full bg-bg-300"
            >
              <div
                className="h-full origin-left rounded-full bg-primary transition-transform duration-150 ease-out motion-reduce:transition-none"
                style={{ transform: `scaleX(${percent / 100})` }}
              />
            </div>
          ) : null}
        </div>
      </div>
    ) : null
  return (
    <Dialog.Root
      open={Boolean(newOptions)}
      onOpenChange={(open) => {
        if (!open) {
          setNewOptions(undefined)
        }
      }}
    >
      <section
        className="shrink-0 space-y-2 border-b border-border px-5 pb-3 text-xs"
        aria-label={t('Translate document')}
        data-pdf-translation-controls
      >
        {!executor?.targets.length ? (
          <p className="leading-5 text-muted-foreground">
            {t('No translation engine is available. You can still prepare and read the original.')}
          </p>
        ) : (
          <>
            <Collapsible.Root
              key={pinned ? 'pinned' : 'setup'}
              open={settingsOpen}
              onOpenChange={setSettingsOpen}
              className="overflow-visible rounded-lg border border-border/70 bg-muted/20"
            >
              <Collapsible.Trigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="group grid min-h-9 w-full grid-cols-[16px_24px_minmax(0,1fr)_auto_16px] items-center gap-2 rounded-none px-3 text-left hover:bg-muted/60 aria-expanded:bg-muted/50"
                >
                  <ChevronRight
                    aria-hidden="true"
                    className="size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-data-[state=open]:rotate-90 motion-reduce:transition-none"
                  />
                  <span
                    aria-hidden="true"
                    className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground"
                  >
                    2
                  </span>
                  <span className="min-w-0 truncate">{t('Translation settings')}</span>
                  {pinned ? (
                    <span className="min-w-0 max-w-24 truncate font-normal text-xs text-muted-foreground">
                      {pinned.language}
                    </span>
                  ) : null}
                  {state.status === 'completed' && state.results?.failedUnitIds?.length ? (
                    <TriangleAlert
                      aria-label={t('Translation failed')}
                      className="size-4 text-status-warning-foreground"
                    />
                  ) : state.status === 'completed' ? (
                    <Check
                      aria-label={t('Text translation complete')}
                      className="size-4 text-status-success-foreground"
                    />
                  ) : null}
                </Button>
              </Collapsible.Trigger>
              <Collapsible.Content className="w-full space-y-3 border-t border-border/70 bg-background/60 px-3 pb-3 pt-3 data-[state=closed]:hidden">
                {pinned && state.status === 'completed' ? (
                  <div className="rounded-md bg-muted/30 px-3 py-2 text-xs">
                    <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-2 leading-5">
                      <dt className="text-muted-foreground">{t('Target language')}</dt>
                      <dd className="min-w-0 truncate font-medium">{pinned.language}</dd>
                      <dt className="text-muted-foreground">{t('Translation method')}</dt>
                      <dd className="min-w-0 truncate font-medium">{targetLabel}</dd>
                      {target?.id === 'agent' || target?.id === 'api' || target?.id === 'local' ? (
                        <>
                          <dt className="text-muted-foreground">{t('Model')}</dt>
                          <dd className="min-w-0 truncate font-medium" title={savedModelLabel}>
                            {savedModelLabel}
                          </dd>
                        </>
                      ) : null}
                      {pinned.glossary.length ? (
                        <>
                          <dt className="text-muted-foreground">{t('Translation glossary')}</dt>
                          <dd className="min-w-0 line-clamp-2 break-words">
                            {formatPdfTranslationGlossary(pinned.glossary)}
                          </dd>
                        </>
                      ) : null}
                    </dl>
                  </div>
                ) : (
                  <TranslationSettingsFields
                    executor={executor}
                    options={
                      pinned ?? {
                        targetId,
                        language,
                        glossary,
                        ...(targetId === 'api' && apiModel ? { apiModel } : {}),
                        ...(targetId === 'agent' && agentModel ? { agentModel } : {}),
                        ...(concurrency !== undefined ? { concurrency } : {})
                      }
                    }
                    state={state}
                    localModel={localModel}
                    disabled={Boolean(pinned)}
                    onChange={(options) => {
                      setTargetId(options.targetId)
                      setLanguage(options.language)
                      setGlossary(options.glossary)
                      setConcurrency(options.concurrency)
                      setApiModel(options.apiModel)
                      setAgentModel(options.agentModel)
                    }}
                  />
                )}
              </Collapsible.Content>
            </Collapsible.Root>
            {translationProgress}
            {!ready ? <p>{t('Prepare full text before translating.')}</p> : null}
            {ready && !hasTranslatableText ? (
              <p>{t('No eligible paragraphs were found in the prepared text.')}</p>
            ) : null}
            {state.status === 'error' ? (
              <ErrorNotice
                inline
                role={providerFailure ? 'status' : 'alert'}
                tone={providerFailure ? 'teal' : 'amber'}
                title={providerFailure ? undefined : t('Could not finish translation')}
                errorCode={
                  state.errorDetails ||
                  (providerFailure?.status ? `HTTP ${providerFailure.status}` : undefined)
                }
                diagnosticsLabel={t('Details')}
                description={
                  providerDescription ??
                  (state.failure === 'model-changed'
                    ? target?.id === 'local'
                      ? t('Start a new translation to change the model.')
                      : t(
                          'The main model changed. Restore the previous model in Settings, or start a new translation.'
                        )
                    : state.failure === 'document-busy'
                      ? t(
                          'This PDF is already being translated in another reader. Stop that translation before continuing here.'
                        )
                      : state.failure === 'checkpoint-failed'
                        ? t(
                            'Could not save translation progress. Reopen the PDF to load the latest saved result before continuing.'
                          )
                        : state.failure === 'unsupported-language'
                          ? t(
                              'This target language is not supported for translated PDFs. Choose a supported language.'
                            )
                          : state.failure === 'unsupported-model'
                            ? target?.id === 'local'
                              ? t(
                                  'Check the local model installation in Translation settings, then retry.'
                                )
                              : t(
                                  'This model connection does not support translation without tools. Choose a supported main model in Settings.'
                                )
                            : state.failure === 'timeout'
                              ? t(
                                  'The model took too long to respond. Completed paragraphs are kept; retry the remaining text.'
                                )
                              : state.failure === 'incomplete-output'
                                ? t(
                                    'The model returned an incomplete paragraph. It was not accepted. Retry to continue.'
                                  )
                                : target?.id === 'local'
                                  ? t(
                                      'Check the local model installation in Translation settings, then retry.'
                                    )
                                  : t(
                                      'Completed paragraphs are kept. Check the model connection in Settings, then retry.'
                                    ))
                }
                secondaryButton={
                  state.failedUnitId && onSkip
                    ? {
                        label: t('Skip and continue'),
                        onClick: () => onSkip(state.failedUnitId!)
                      }
                    : undefined
                }
              />
            ) : null}
            <div className="flex flex-wrap gap-2">
              {state.status !== 'completed' ? (
                <PdfTranslationActionHint
                  reason={running ? undefined : startDisabledReason}
                  className="min-w-fit flex-1 [&>button]:w-full"
                >
                  <Button
                    className="grid min-w-fit flex-1 whitespace-nowrap"
                    size="sm"
                    variant={running ? 'outline' : 'default'}
                    disabled={!running && !canStart}
                    onClick={running ? onCancel : start}
                  >
                    {pinned ? (
                      <span
                        aria-hidden="true"
                        className="invisible col-start-1 row-start-1 flex items-center justify-center gap-1"
                      >
                        <Play className="size-3.5" />
                        {t('Continue translation')}
                      </span>
                    ) : null}
                    <span className="col-start-1 row-start-1 flex items-center justify-center gap-1">
                      {state.status === 'cancelled' ? (
                        <Play aria-hidden="true" className="size-3.5" />
                      ) : null}
                      {running
                        ? t('Cancel')
                        : state.status === 'cancelled'
                          ? t('Continue translation')
                          : state.status === 'error'
                            ? t('Retry')
                            : t('Translate document')}
                    </span>
                  </Button>
                </PdfTranslationActionHint>
              ) : null}
              {pinned ? (
                <TooltipProvider delayDuration={100}>
                  <Tooltip>
                    <TooltipTrigger
                      asChild
                      onFocus={(event) => {
                        if (!event.currentTarget.matches(':focus-visible')) event.preventDefault()
                      }}
                    >
                      <Dialog.Trigger asChild>
                        <Button
                          className={cn(
                            'min-w-fit flex-1 whitespace-nowrap',
                            running && 'invisible'
                          )}
                          variant="outline"
                          size="sm"
                          disabled={running}
                          aria-hidden={running || undefined}
                          onClick={() => {
                            setNewOptions({
                              targetId: pinned.targetId,
                              language: pinned.language,
                              glossary: pinned.glossary,
                              ...(pinned.apiModel ? { apiModel: pinned.apiModel } : {}),
                              ...(pinned.agentModel ? { agentModel: pinned.agentModel } : {}),
                              ...(pinned.concurrency !== undefined
                                ? { concurrency: pinned.concurrency }
                                : {})
                            })
                          }}
                        >
                          {t('New translation')}
                        </Button>
                      </Dialog.Trigger>
                    </TooltipTrigger>
                    <TooltipContent className="z-[120] max-w-64">
                      {t(
                        'Keep the same model when retrying. To change models, start a new translation.'
                      )}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              ) : null}
            </div>
          </>
        )}
        <Dialog.Portal>
          <Dialog.Overlay className={cn(dialogOverlayClassName, 'z-[110]')} />
          <Dialog.Content
            onEscapeKeyDown={(event) => {
              if (
                event.target instanceof HTMLInputElement &&
                event.target.getAttribute('aria-expanded') === 'true'
              ) {
                event.preventDefault()
              } else {
                event.stopPropagation()
              }
            }}
            className={dialogPanelClassName(
              'z-[111] flex w-[min(420px,calc(100vw-2rem))] flex-col overflow-hidden'
            )}
          >
            <Dialog.Title className={cn(dialogTitleClassName, 'shrink-0')}>
              {t('New translation')}
            </Dialog.Title>
            <Dialog.Description className="sr-only">{t('Translation settings')}</Dialog.Description>
            {newOptions && executor ? (
              <div className="-mx-1 mt-4 min-h-0 space-y-3 overflow-y-auto px-1 text-sm">
                <TranslationSettingsFields
                  executor={executor}
                  options={newOptions}
                  state={{ status: 'idle', done: 0, total: 0 }}
                  localModel={localModel}
                  onChange={setNewOptions}
                />
              </div>
            ) : null}
            <div className="mt-5 flex shrink-0 justify-end gap-2">
              <Dialog.Close asChild>
                <Button variant="outline">{t('Cancel')}</Button>
              </Dialog.Close>
              <PdfTranslationActionHint reason={newDisabledReason}>
                <Button disabled={!canStartNew} onClick={startNewTranslation}>
                  {t('Translate document')}
                </Button>
              </PdfTranslationActionHint>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </section>
    </Dialog.Root>
  )
}
