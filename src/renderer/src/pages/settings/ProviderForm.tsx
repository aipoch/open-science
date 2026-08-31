import type { TFunction } from 'i18next'
import { ChevronDown, Eye, EyeOff } from 'lucide-react'
import { useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'

import { ExternalTextLink } from '@/components/ExternalTextLink'
import { FieldHelp } from '@/components/FieldHelp'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger
} from '@/components/ui/select'
import {
  getOfficialVendor,
  getOfficialVendorModelIds,
  resolveVendorApiKeyUrl
} from '../../../../shared/provider-registry'
import {
  CUSTOM_REASONING_EFFORT_PRESETS,
  CUSTOM_REASONING_EFFORT_TRANSPORTS,
  type CustomReasoningEffortTransport,
  type ReasoningEffortPresetId
} from '../../../../shared/reasoning-effort'
import { getApiKeySecurityCopyKeys } from './provider-key-security'
import { ProviderKindIcon } from './provider-icons'
import {
  PROVIDER_KIND_GROUPS,
  PROVIDER_KINDS,
  providerKindPatch,
  selectedKindKey,
  type ProviderFormErrors,
  type ProviderFormValue,
  type ProviderKind
} from './provider-form-value'

type ProviderFormProps = {
  value: ProviderFormValue
  onChange: (patch: Partial<ProviderFormValue>) => void
  // Whether a stored key already exists (drives the "leave blank to keep" affordance).
  hasStoredKey?: boolean
  // Masked hint for the stored key; never the plaintext value.
  maskedKey?: string
  // True when the stored key could not be decrypted and must be re-entered.
  needsKey?: boolean
  // Per-field required-field errors to display inline.
  errors?: ProviderFormErrors
  // Effective supported-model list to show as tags (defaults to the vendor's bundled catalog). Passed
  // in edit mode so live-fetched models are reflected.
  supportedModels?: string[]
  // When provided (a saved official provider with a key), renders a "refresh from vendor" control.
  onRefreshModels?: () => void
  isRefreshingModels?: boolean
  disabled?: boolean
  // Whether Electron can protect new keys with the operating system's secure storage.
  encryptionAvailable?: boolean
  showCodexSubscriptions?: boolean
  // Whether to surface the Claude subscription option in the provider-kind picker. Mirrors
  // showCodexSubscriptions: claude-isolated is only meaningful while Claude Code is the active
  // framework, so the wizard/settings page toggles this rather than showing it unconditionally.
  showClaudeIsolated?: boolean
  // Preferred protocol for a newly selected Custom Gateway, derived from the active framework.
  defaultCustomApiEndpoint?: ProviderFormValue['apiEndpoint']
}

const fieldLabelClassName = 'text-xs font-medium text-muted-foreground'
const fieldErrorClassName = 'text-xs text-destructive'
const CUSTOM_PROVIDER_CONTEXT_WINDOW_PRESETS = [
  32_000, 64_000, 128_000, 200_000, 256_000, 1_000_000
] as const
const CUSTOM_PROVIDER_MAX_INPUT_TOKEN_PRESETS = CUSTOM_PROVIDER_CONTEXT_WINDOW_PRESETS
const CUSTOM_PROVIDER_MAX_OUTPUT_TOKEN_PRESETS = [
  4_000, 8_000, 16_000, 32_000, 64_000, 128_000
] as const

// API format labels name the wire protocol and its literal path, so they read the same in every
// locale and stay out of the catalog — translating `Messages API (/v1/messages)` would make it harder
// to match against a gateway's own documentation.
const API_FORMAT_LABELS: Record<ProviderFormValue['apiEndpoint'], string> = {
  openai: 'Chat Completions (/v1/chat/completions) — GPT / DeepSeek / OpenAI-compatible',
  anthropic: 'Messages (/v1/messages) — Claude / Anthropic-compatible',
  responses: 'Responses (/v1/responses) — GPT / OpenAI'
}

// Custom gateways declare exactly one protocol. Official vendors may serve several endpoints; that
// multi-endpoint set lives in the registry and is not a selectable custom option.
const selectableApiFormats = (): ProviderFormValue['apiEndpoint'][] => [
  'openai',
  'anthropic',
  'responses'
]

// A kind's dropdown label: a registry proper noun passes through untranslated, the custom gateway
// resolves from the catalog. Exhaustive over the ProviderKind union, so adding a third shape is a
// typecheck failure rather than a blank label.
const kindLabel = (kind: ProviderKind, t: TFunction): string =>
  kind.labelKey === undefined ? kind.label : t(kind.labelKey)

// Marks a required field next to its label. Purely visual; the actual guard lives in the form errors.
const RequiredMark = (): React.JSX.Element => (
  <span aria-hidden="true" className="ml-0.5 text-destructive">
    *
  </span>
)

type AdvancedSettingsDisclosureProps = {
  expanded: boolean
  label: string
  onToggle: () => void
  children: React.ReactNode
}

const AdvancedSettingsDisclosure = ({
  expanded,
  label,
  onToggle,
  children
}: AdvancedSettingsDisclosureProps): React.JSX.Element => (
  <div>
    <button
      type="button"
      aria-expanded={expanded}
      aria-controls="provider-advanced-settings"
      onClick={onToggle}
      className="flex min-h-8 w-full items-center gap-2 rounded-lg py-1.5 text-left text-sm font-medium whitespace-nowrap text-foreground transition-colors duration-150 outline-none motion-reduce:transition-none hover:text-primary focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <ChevronDown
        className={`size-4 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none ${
          expanded ? '' : '-rotate-90'
        }`}
        aria-hidden="true"
      />
      {label}
    </button>

    {expanded ? (
      <div id="provider-advanced-settings" className="mt-3 flex min-w-0 flex-col gap-4 pl-6">
        {children}
      </div>
    ) : null}
  </div>
)

const tokenPresetLabel = (value: number): string =>
  value >= 1_000_000 && value % 1_000_000 === 0
    ? `${value / 1_000_000}M`
    : value >= 1_000 && value % 1_000 === 0
      ? `${value / 1_000}K`
      : String(value)

type TokenLimitFieldProps = {
  id: string
  label: string
  help: string
  value: string
  presets: readonly number[]
  disabled: boolean
  error?: ProviderFormErrors['maxInputTokens']
  onValueChange: (value: string) => void
  t: TFunction
}

const TokenLimitField = ({
  id,
  label,
  help,
  value,
  presets,
  disabled,
  error,
  onValueChange,
  t
}: TokenLimitFieldProps): React.JSX.Element => (
  <div className="space-y-1.5">
    <div className="flex items-center gap-1">
      <label id={`${id}-label`} className={fieldLabelClassName} htmlFor={id}>
        {label}
      </label>
      <FieldHelp content={help} />
    </div>
    <Input
      id={id}
      aria-label={label}
      aria-describedby={error ? `${id}-error` : undefined}
      aria-invalid={Boolean(error) || undefined}
      inputMode="numeric"
      value={value}
      disabled={disabled}
      placeholder={t('Use provider default')}
      onChange={(event) => onValueChange(event.target.value)}
      className="tabular-nums"
    />
    <div role="group" aria-labelledby={`${id}-label`} className="flex flex-wrap gap-1">
      {presets.map((preset) => {
        const selected = value === String(preset)
        return (
          <button
            key={preset}
            type="button"
            aria-pressed={selected}
            disabled={disabled}
            onClick={() => onValueChange(String(preset))}
            className={cn(
              'min-h-7 rounded-md border border-transparent px-2 text-xs tabular-nums text-muted-foreground outline-none transition-[color,background-color,border-color,transform] duration-150 motion-reduce:transition-none active:translate-y-px disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 focus-visible:ring-3 focus-visible:ring-ring/50 [@media(hover:hover)]:hover:bg-muted [@media(hover:hover)]:hover:text-foreground',
              selected && 'border-border bg-muted text-foreground'
            )}
          >
            {tokenPresetLabel(preset)}
          </button>
        )
      })}
    </div>
    {error ? (
      <p id={`${id}-error`} className={fieldErrorClassName} role="alert">
        {t(error)}
      </p>
    ) : null}
  </div>
)

// Provider fields switch by type: pick a type first, then reveal its options. Custom exposes an
// Anthropic-compatible gateway/key/model; an official vendor exposes a key (+ region) and picks a
// model from the registry catalog. Stored plaintext keys are never rendered; users can reveal only
// a replacement key currently held in this form draft.
const ProviderForm = ({
  value,
  onChange,
  hasStoredKey = false,
  maskedKey,
  needsKey = false,
  errors = {},
  supportedModels,
  onRefreshModels,
  isRefreshingModels = false,
  disabled = false,
  encryptionAvailable = true,
  showCodexSubscriptions = false,
  showClaudeIsolated = false,
  defaultCustomApiEndpoint = 'anthropic'
}: ProviderFormProps): React.JSX.Element => {
  const { t } = useTranslation()
  const isCustom = value.type === 'custom'
  const isOfficial = value.type === 'official'
  const isCodexSubscription = value.type === 'codex-shared' || value.type === 'codex-isolated'
  const isClaudeSubscription = value.type === 'claude-shared' || value.type === 'claude-isolated'
  const isXaiSubscription = value.type === 'xai-subscription'
  const vendor = isOfficial && value.vendorId ? getOfficialVendor(value.vendorId) : undefined
  const [advancedOpen, setAdvancedOpen] = useState(
    () =>
      value.codexTransport !== 'auto' ||
      value.supportsImageInput ||
      value.reasoningEffortPreset !== 'unsupported' ||
      Boolean(value.maxInputTokens.trim()) ||
      Boolean(value.maxOutputTokens.trim())
  )
  const selectedKey = selectedKindKey(value)
  // Scope reveal state to the exact provider kind and draft value. Input events advance that scope
  // only while already revealed, so an externally replaced provider record starts masked.
  const [revealedKeyDraft, setRevealedKeyDraft] = useState<{
    kind: string
    key: string
  }>()
  const keyVisible = revealedKeyDraft?.kind === selectedKey && revealedKeyDraft.key === value.key
  const keyRequired = needsKey || !hasStoredKey

  const advancedVisible =
    advancedOpen || Boolean(errors.maxInputTokens) || Boolean(errors.maxOutputTokens)

  const selectedKind = PROVIDER_KINDS.find((kind) => kind.key === selectedKey)
  // Where to get a key for an official vendor (region-specific console); custom providers have none.
  const apiKeyUrl =
    isOfficial && value.vendorId ? resolveVendorApiKeyUrl(value.vendorId, value.region) : undefined
  const securityCopyKeys = getApiKeySecurityCopyKeys(encryptionAvailable)

  const keyField = (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <label className={fieldLabelClassName} htmlFor="provider-key">
            {t('API key')}
            <RequiredMark />
          </label>
          <FieldHelp
            content={
              <>
                <span className="block font-medium">{t(securityCopyKeys.title)}</span>
                <span className="block text-bg-000/80">{t(securityCopyKeys.description)}</span>
              </>
            }
          />
        </div>
        {apiKeyUrl ? (
          <ExternalTextLink href={apiKeyUrl} className="text-xs">
            {t('Get an API key')}
          </ExternalTextLink>
        ) : null}
      </div>
      <div className="relative">
        <Input
          id="provider-key"
          aria-label={t('API key')}
          aria-required={keyRequired || undefined}
          aria-invalid={Boolean(needsKey || errors.key) || undefined}
          aria-describedby={needsKey || errors.key ? 'provider-key-error' : undefined}
          type={keyVisible ? 'text' : 'password'}
          value={value.key}
          disabled={disabled}
          placeholder={
            hasStoredKey
              ? t('{{masked}} — leave blank to keep', {
                  masked: maskedKey ?? t('stored key')
                })
              : t('Paste API key')
          }
          className="pe-9"
          onChange={(event) => {
            const key = event.target.value
            setRevealedKeyDraft(keyVisible ? { kind: selectedKey, key } : undefined)
            onChange({ key })
          }}
        />
        <button
          type="button"
          aria-label={keyVisible ? t('Hide API key') : t('Show API key')}
          aria-pressed={keyVisible}
          disabled={disabled}
          onClick={() =>
            setRevealedKeyDraft(keyVisible ? undefined : { kind: selectedKey, key: value.key })
          }
          className="absolute inset-y-0 end-0 flex w-9 items-center justify-center rounded-e-lg text-muted-foreground outline-none transition-colors duration-150 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none"
        >
          {keyVisible ? (
            <EyeOff className="size-4" aria-hidden="true" />
          ) : (
            <Eye className="size-4" aria-hidden="true" />
          )}
        </button>
      </div>
      {needsKey ? (
        <p id="provider-key-error" className={fieldErrorClassName} role="alert">
          {t('The stored key could not be decrypted. Enter it again to continue.')}
        </p>
      ) : errors.key ? (
        <p id="provider-key-error" className={fieldErrorClassName} role="alert">
          {t(errors.key)}
        </p>
      ) : null}
    </div>
  )

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <div className="flex items-center gap-1">
          <span className={fieldLabelClassName}>{t('Provider type')}</span>
          {selectedKind ? <FieldHelp content={t(selectedKind.descriptionKey)} /> : null}
        </div>
        <Select
          value={selectedKey}
          onValueChange={(key) => onChange(providerKindPatch(key, defaultCustomApiEndpoint))}
        >
          <SelectTrigger aria-label={t('Provider type')}>
            <span className="flex items-center gap-2">
              <ProviderKindIcon kindKey={selectedKey} />
              <span>{selectedKind ? kindLabel(selectedKind, t) : null}</span>
            </span>
          </SelectTrigger>
          <SelectContent scrollToTopOnOpen>
            {PROVIDER_KIND_GROUPS.map((group) => {
              const kinds = PROVIDER_KINDS.filter((kind) => {
                if (kind.group !== group.id) return false
                // The Codex subscription section only shows when Codex is the active framework
                // (the only one that can drive it), mirroring the showCodexSubscriptions gate.
                if (group.id === 'codex' && !showCodexSubscriptions) return false
                // The Claude subscription section mirrors it: gate on Claude Code being active,
                // the only framework that speaks the app-owned bearer token.
                if (group.id === 'claude' && !showClaudeIsolated) return false

                return true
              })

              if (kinds.length === 0) return null

              return (
                <SelectGroup key={group.id}>
                  <SelectLabel>{t(group.labelKey)}</SelectLabel>
                  {kinds.map((kind) => (
                    <SelectItem
                      key={kind.key}
                      value={kind.key}
                      icon={<ProviderKindIcon kindKey={kind.key} />}
                    >
                      {kindLabel(kind, t)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              )
            })}
          </SelectContent>
        </Select>
      </div>

      {!isCodexSubscription && !isClaudeSubscription && !isXaiSubscription ? (
        <div className="space-y-1.5">
          <label className={fieldLabelClassName} htmlFor="provider-name">
            {t('Name')}
          </label>
          <Input
            id="provider-name"
            aria-label={t('Provider name')}
            value={value.name}
            disabled={disabled}
            placeholder={vendor ? vendor.label : t('Optional display name')}
            onChange={(event) => onChange({ name: event.target.value })}
          />
        </div>
      ) : null}

      {isXaiSubscription ? (
        <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
          <p className="text-sm font-medium text-foreground">{t('One xAI login, every agent')}</p>
          <p className="text-xs text-muted-foreground">
            {t(
              'Save this provider, then sign in from its card with a device code. Open Science securely refreshes the login and exposes Messages, Chat Completions, and Responses locally.'
            )}
          </p>
          <code className="font-mono text-xs text-muted-foreground">{t('grok-4.6 · 500K')}</code>
        </div>
      ) : isCodexSubscription ? (
        <>
          <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
            <div className="space-y-1.5">
              <span className={fieldLabelClassName}>{t('Codex authentication')}</span>
              <Select
                value={value.type}
                disabled={disabled}
                onValueChange={(type) =>
                  onChange({ type: type as 'codex-shared' | 'codex-isolated' })
                }
              >
                <SelectTrigger aria-label={t('Codex authentication')} disabled={disabled}>
                  <span>
                    {value.type === 'codex-shared'
                      ? t('Import existing Codex sign-in')
                      : t('Sign in with Open Science')}
                  </span>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="codex-shared">{t('Import existing Codex sign-in')}</SelectItem>
                  <SelectItem value="codex-isolated">{t('Sign in with Open Science')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <p className="text-xs text-muted-foreground">
              {value.type === 'codex-shared'
                ? t(
                    "Copies Codex authentication and, when compatible, the active provider's non-secret loopback route into Open Science app data. Other global config, Skills and sessions are not imported."
                  )
                : t(
                    'Stores a separate Codex login in Open Science app data without changing your Codex CLI profile.'
                  )}
            </p>
          </div>
          <AdvancedSettingsDisclosure
            expanded={advancedVisible}
            label={t('Advanced settings')}
            onToggle={() => setAdvancedOpen((open) => !open)}
          >
            <div className="space-y-1.5">
              <div className="flex items-center gap-1">
                <span className={fieldLabelClassName}>{t('Transport')}</span>
                <FieldHelp
                  content={t(
                    'Auto uses WebSocket when available and falls back to HTTPS. Use HTTPS for compatibility or WebSocket for lower latency.'
                  )}
                />
              </div>
              <Select
                value={value.codexTransport}
                disabled={disabled}
                onValueChange={(codexTransport) =>
                  onChange({
                    codexTransport: codexTransport as ProviderFormValue['codexTransport']
                  })
                }
              >
                <SelectTrigger aria-label={t('Transport')} disabled={disabled}>
                  <span>
                    {value.codexTransport === 'auto'
                      ? t('Auto (recommended)')
                      : value.codexTransport === 'https'
                        ? t('HTTPS')
                        : t('WebSocket')}
                  </span>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">{t('Auto (recommended)')}</SelectItem>
                  <SelectItem value="https">{t('HTTPS')}</SelectItem>
                  <SelectItem value="websocket">{t('WebSocket')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </AdvancedSettingsDisclosure>
        </>
      ) : isClaudeSubscription ? (
        <>
          <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
            <div className="space-y-1.5">
              <span className={fieldLabelClassName}>{t('Claude authentication')}</span>
              <Select
                value={value.type}
                disabled={disabled}
                onValueChange={(type) =>
                  onChange({ type: type as 'claude-shared' | 'claude-isolated' })
                }
              >
                <SelectTrigger aria-label={t('Claude authentication')} disabled={disabled}>
                  <span>
                    {value.type === 'claude-shared'
                      ? t('Use existing Claude profile (Recommended)')
                      : t('Sign in separately (isolated)')}
                  </span>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="claude-shared">
                    {t('Use existing Claude profile (Recommended)')}
                  </SelectItem>
                  <SelectItem value="claude-isolated">
                    {t('Sign in separately (isolated)')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <p className="text-xs text-muted-foreground">
              {value.type === 'claude-shared'
                ? t(
                    'Recommended. Uses your existing Claude login from ~/.claude. Sign in once via browser OAuth and use across all Claude tools.'
                  )
                : t(
                    'Advanced. Signs in through the browser and stores a separate Claude login in Open Science, completely isolated from your personal Claude profile.'
                  )}
            </p>
            <div className="space-y-1.5 border-t border-border-200 pt-3">
              <p className="text-xs text-muted-foreground">
                {/* Paths and the CLI command sit mid-sentence, so the catalog carries a <code> tag and
                    the translator places it — Chinese word order puts them elsewhere in the clause. */}
                <Trans
                  t={t}
                  i18nKey={
                    value.type === 'claude-shared'
                      ? 'Sign in via browser OAuth. The Settings card will open your browser to sign in with your Claude account. Your credentials are stored in <code>~/.claude</code>.'
                      : 'Run <code>claude setup-token</code> in a terminal and paste the token below. It is stored encrypted under your app-owned Claude config dir; nothing is read from or written to <code>~/.claude</code>.'
                  }
                  components={{ code: <code className="font-mono" /> }}
                />
              </p>
            </div>
            {value.type === 'claude-isolated' && (
              <p className="text-xs text-muted-foreground">
                {t(
                  "Paste the token in the Settings card after saving — the wizard's Test & continue flow signs you in."
                )}
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <label className={fieldLabelClassName} htmlFor="provider-model">
              {t('Model')} <span className="text-muted-foreground">{t('(optional override)')}</span>
            </label>
            <Input
              id="provider-model"
              aria-label={t('Model')}
              value={value.model}
              disabled={disabled}
              placeholder={t("Leave blank to use Claude's default")}
              onChange={(event) => onChange({ model: event.target.value })}
            />
          </div>
        </>
      ) : isCustom ? (
        <>
          <div className="space-y-1.5">
            <div className="flex items-center gap-1">
              <label className={fieldLabelClassName} htmlFor="provider-base-url">
                {t('Base URL')}
                <RequiredMark />
              </label>
              <FieldHelp
                content={
                  <Trans
                    t={t}
                    i18nKey="The gateway root; a trailing <code>/v1</code> is added automatically. Choose the API format below to match the endpoint."
                    components={{ code: <code /> }}
                  />
                }
              />
            </div>
            <Input
              id="provider-base-url"
              aria-label={t('Base URL')}
              aria-required="true"
              aria-invalid={Boolean(errors.baseUrl) || undefined}
              aria-describedby={errors.baseUrl ? 'provider-base-url-error' : undefined}
              value={value.baseUrl}
              disabled={disabled}
              placeholder={t('https://gateway.example')}
              onChange={(event) => onChange({ baseUrl: event.target.value })}
            />
            {errors.baseUrl ? (
              <p id="provider-base-url-error" className={fieldErrorClassName} role="alert">
                {t(errors.baseUrl)}
              </p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center gap-1">
              <span className={fieldLabelClassName}>{t('API format')}</span>
              <FieldHelp
                content={t(
                  'Choose the protocol documented by the gateway. The model name does not determine the protocol. A provider is only selectable under an agent framework that supports its format.'
                )}
              />
            </div>
            <Select
              value={value.apiEndpoint}
              disabled={disabled}
              onValueChange={(apiEndpoint) =>
                onChange({ apiEndpoint: apiEndpoint as ProviderFormValue['apiEndpoint'] })
              }
            >
              <SelectTrigger aria-label={t('API format')} disabled={disabled}>
                <span>{API_FORMAT_LABELS[value.apiEndpoint]}</span>
              </SelectTrigger>
              <SelectContent>
                {selectableApiFormats().map((apiEndpoint) => (
                  <SelectItem key={apiEndpoint} value={apiEndpoint}>
                    {API_FORMAT_LABELS[apiEndpoint]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {keyField}

          <div className="space-y-1.5">
            <label className={fieldLabelClassName} htmlFor="provider-model">
              {t('Model')}
              <RequiredMark />
            </label>
            <Input
              id="provider-model"
              aria-label={t('Model')}
              aria-required="true"
              aria-invalid={Boolean(errors.model) || undefined}
              aria-describedby={errors.model ? 'provider-model-error' : undefined}
              value={value.model}
              disabled={disabled}
              placeholder={t('e.g. deepseek-v4-flash')}
              onChange={(event) => onChange({ model: event.target.value })}
            />
            {errors.model ? (
              <p id="provider-model-error" className={fieldErrorClassName} role="alert">
                {t(errors.model)}
              </p>
            ) : null}
          </div>

          <TokenLimitField
            id="provider-context-window"
            label={t('Context window')}
            help={t('Total tokens shared by the request and response.')}
            value={value.contextWindow}
            presets={CUSTOM_PROVIDER_CONTEXT_WINDOW_PRESETS}
            disabled={disabled}
            error={errors.contextWindow}
            onValueChange={(contextWindow) => onChange({ contextWindow })}
            t={t}
          />

          <AdvancedSettingsDisclosure
            expanded={advancedVisible}
            label={t('Advanced settings')}
            onToggle={() => setAdvancedOpen((open) => !open)}
          >
            <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
              <div className="flex items-start justify-between gap-3">
                <label className="space-y-0.5" htmlFor="provider-image-input">
                  <span className="block text-xs font-medium">{t('Image input')}</span>
                  <span className="block text-xs text-muted-foreground">
                    {t('The gateway and model accept image content.')}
                  </span>
                </label>
                <Switch
                  id="provider-image-input"
                  aria-label={t('Supports image input')}
                  checked={value.supportsImageInput}
                  disabled={disabled}
                  onCheckedChange={(supportsImageInput) => onChange({ supportsImageInput })}
                />
              </div>

              <div className="flex items-start justify-between gap-3">
                <label className="space-y-0.5" htmlFor="provider-thinking-mode">
                  <span className="block text-xs font-medium">{t('Thinking mode')}</span>
                  <span className="block text-xs text-muted-foreground">
                    {t('The gateway and model accept thinking or effort controls.')}
                  </span>
                </label>
                <Switch
                  id="provider-thinking-mode"
                  aria-label={t('Supports thinking mode')}
                  checked={value.reasoningEffortPreset !== 'unsupported'}
                  disabled={disabled}
                  onCheckedChange={(supported) =>
                    onChange({
                      reasoningEffortPreset: supported ? 'standard-5' : 'unsupported'
                    })
                  }
                />
              </div>
            </div>

            {value.reasoningEffortPreset !== 'unsupported' ? (
              <div className="space-y-3 border-t border-border-200 pt-3">
                <div
                  className={cn('grid gap-3', value.apiEndpoint === 'openai' && 'sm:grid-cols-2')}
                >
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-1">
                      <span className={fieldLabelClassName}>{t('Supported effort levels')}</span>
                      <FieldHelp
                        content={
                          <>
                            <span className="block">
                              {t(
                                'Open Science maps five relative strengths onto the exact levels accepted by this model.'
                              )}
                            </span>
                            <span className="mt-1 block">
                              {t(
                                'Examples reflect common native model APIs. A gateway may use different mappings.'
                              )}
                            </span>
                            {value.apiEndpoint === 'anthropic' ? (
                              <span className="mt-1 block">
                                {t(
                                  "Messages API uses the framework's Anthropic-compatible thinking request automatically."
                                )}
                              </span>
                            ) : value.apiEndpoint === 'responses' ? (
                              <span className="mt-1 block">
                                {t(
                                  'Responses API uses its native reasoning request automatically.'
                                )}
                              </span>
                            ) : null}
                          </>
                        }
                      />
                    </div>
                    <Select
                      value={value.reasoningEffortPreset}
                      disabled={disabled}
                      onValueChange={(reasoningEffortPreset) =>
                        onChange({
                          reasoningEffortPreset: reasoningEffortPreset as ReasoningEffortPresetId
                        })
                      }
                    >
                      <SelectTrigger aria-label={t('Reasoning effort levels')} disabled={disabled}>
                        <span>
                          {
                            CUSTOM_REASONING_EFFORT_PRESETS.find(
                              (preset) => preset.id === value.reasoningEffortPreset
                            )?.label
                          }
                        </span>
                      </SelectTrigger>
                      <SelectContent>
                        {CUSTOM_REASONING_EFFORT_PRESETS.map((preset) => (
                          <SelectItem key={preset.id} value={preset.id}>
                            {preset.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {value.apiEndpoint === 'openai' ? (
                    <div className="space-y-1.5">
                      <div className="flex items-center gap-1">
                        <span className={fieldLabelClassName}>{t('Reasoning request format')}</span>
                        <FieldHelp
                          content={t(
                            'The JSON fields sent to a Chat Completions gateway. Follow the gateway documentation; OpenAI-compatible services commonly use {{parameter}}.',
                            { parameter: 'reasoning_effort' }
                          )}
                        />
                      </div>
                      <Select
                        value={value.reasoningEffortTransport}
                        disabled={disabled}
                        onValueChange={(reasoningEffortTransport) =>
                          onChange({
                            reasoningEffortTransport:
                              reasoningEffortTransport as CustomReasoningEffortTransport
                          })
                        }
                      >
                        <SelectTrigger
                          aria-label={t('Reasoning effort request format')}
                          disabled={disabled}
                        >
                          <span>
                            {
                              CUSTOM_REASONING_EFFORT_TRANSPORTS.find(
                                (transport) => transport.id === value.reasoningEffortTransport
                              )?.label
                            }
                          </span>
                        </SelectTrigger>
                        <SelectContent>
                          {CUSTOM_REASONING_EFFORT_TRANSPORTS.map((transport) => (
                            <SelectItem key={transport.id} value={transport.id}>
                              {transport.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}

            <div className="grid gap-4 border-t border-border-200 pt-3 sm:grid-cols-2">
              <TokenLimitField
                id="provider-max-input-tokens"
                label={t('Maximum input tokens')}
                help={t('Optional provider-reported input cap.')}
                value={value.maxInputTokens}
                presets={CUSTOM_PROVIDER_MAX_INPUT_TOKEN_PRESETS}
                disabled={disabled}
                error={errors.maxInputTokens}
                onValueChange={(maxInputTokens) => onChange({ maxInputTokens })}
                t={t}
              />
              <TokenLimitField
                id="provider-max-output-tokens"
                label={t('Maximum output tokens')}
                help={t('Optional provider-reported output cap.')}
                value={value.maxOutputTokens}
                presets={CUSTOM_PROVIDER_MAX_OUTPUT_TOKEN_PRESETS}
                disabled={disabled}
                error={errors.maxOutputTokens}
                onValueChange={(maxOutputTokens) => onChange({ maxOutputTokens })}
                t={t}
              />
            </div>
          </AdvancedSettingsDisclosure>
        </>
      ) : isOfficial ? (
        <>
          {vendor?.regions ? (
            <div className="space-y-1.5">
              <span className={fieldLabelClassName}>{t('Endpoint')}</span>
              <Select
                value={value.region ?? vendor.regions[0]?.id}
                onValueChange={(region) => onChange({ region })}
              >
                <SelectTrigger aria-label={t('Endpoint')}>
                  <span>
                    {vendor.regions.find((region) => region.id === value.region)?.label ??
                      vendor.regions[0]?.label}
                  </span>
                </SelectTrigger>
                <SelectContent>
                  {vendor.regions.map((region) => (
                    <SelectItem key={region.id} value={region.id}>
                      {region.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          {keyField}

          {(() => {
            const models =
              supportedModels ?? (value.vendorId ? getOfficialVendorModelIds(value.vendorId) : [])

            if (models.length === 0) return null

            return (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1">
                    <span className={fieldLabelClassName}>{t('Supported models')}</span>
                    <FieldHelp
                      content={t(
                        'Bundled with the app. Refresh from the vendor to pull the latest. Choose one from the Active model selector after adding.'
                      )}
                    />
                  </div>
                  {onRefreshModels ? (
                    <button
                      type="button"
                      onClick={onRefreshModels}
                      disabled={disabled || isRefreshingModels}
                      className="text-xs font-medium text-primary underline underline-offset-2 hover:text-primary/80 disabled:opacity-50"
                    >
                      {isRefreshingModels ? t('Refreshing…') : t('Refresh from vendor')}
                    </button>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {models.map((model) => (
                    <span
                      key={model}
                      className="rounded-md border border-border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground"
                    >
                      {model}
                    </span>
                  ))}
                </div>
              </div>
            )
          })()}
        </>
      ) : (
        <div className="space-y-1.5">
          <label className={fieldLabelClassName} htmlFor="provider-model">
            {t('Model')} <span className="text-muted-foreground">{t('(optional override)')}</span>
          </label>
          <Input
            id="provider-model"
            aria-label={t('Model')}
            value={value.model}
            disabled={disabled}
            placeholder={t("Leave blank to use Claude's default")}
            onChange={(event) => onChange({ model: event.target.value })}
          />
        </div>
      )}
    </div>
  )
}

export { ProviderForm }
