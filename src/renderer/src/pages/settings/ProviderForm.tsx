import type { TFunction } from 'i18next'
import { ChevronDown } from 'lucide-react'
import { useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'

import { ExternalTextLink } from '@/components/ExternalTextLink'
import { FieldHelp } from '@/components/FieldHelp'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
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

// API format labels name the wire protocol and its literal path, so they read the same in every
// locale and stay out of the catalog — translating `Messages API (/v1/messages)` would make it harder
// to match against a gateway's own documentation.
const API_FORMAT_LABELS: Record<ProviderFormValue['apiEndpoint'], string> = {
  openai: 'Chat Completions API (/v1/chat/completions)',
  anthropic: 'Messages API (/v1/messages)',
  responses: 'Responses API (/v1/responses)'
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

// Provider fields switch by type: pick a type first, then reveal its options. Custom exposes an
// Anthropic-compatible gateway/key/model; an official vendor exposes a key (+ region) and picks a
// model from the registry catalog. No plaintext key is rendered.
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
  const vendor = isOfficial && value.vendorId ? getOfficialVendor(value.vendorId) : undefined
  const [advancedOpen, setAdvancedOpen] = useState(
    () => Boolean(value.maxInputTokens.trim()) || Boolean(value.maxOutputTokens.trim())
  )
  const advancedVisible =
    advancedOpen || Boolean(errors.maxInputTokens) || Boolean(errors.maxOutputTokens)

  const selectedKey = selectedKindKey(value)
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
      <Input
        id="provider-key"
        aria-label={t('API key')}
        type="password"
        value={value.key}
        disabled={disabled}
        placeholder={
          hasStoredKey
            ? t('{{masked}} — leave blank to keep', {
                masked: maskedKey ?? t('stored key')
              })
            : 'sk-...'
        }
        onChange={(event) => onChange({ key: event.target.value })}
      />
      {needsKey ? (
        <p className={fieldErrorClassName} role="alert">
          {t('The stored key could not be decrypted. Enter it again to continue.')}
        </p>
      ) : errors.key ? (
        <p className={fieldErrorClassName} role="alert">
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

      {!isCodexSubscription && !isClaudeSubscription ? (
        <div className="space-y-1.5">
          <label className={fieldLabelClassName} htmlFor="provider-name">
            {t('Name')}
          </label>
          <Input
            id="provider-name"
            aria-label={t('Provider name')}
            value={value.name}
            disabled={disabled}
            placeholder={vendor ? vendor.label : t('e.g. My gateway')}
            onChange={(event) => onChange({ name: event.target.value })}
          />
        </div>
      ) : null}

      {isCodexSubscription ? (
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
              value={value.baseUrl}
              disabled={disabled}
              placeholder={t('https://gateway.example')}
              onChange={(event) => onChange({ baseUrl: event.target.value })}
            />
            {errors.baseUrl ? (
              <p className={fieldErrorClassName} role="alert">
                {t(errors.baseUrl)}
              </p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center gap-1">
              <span className={fieldLabelClassName}>{t('API format')}</span>
              <FieldHelp
                content={
                  <Trans
                    t={t}
                    i18nKey="Which chat API this gateway speaks. Claude Code uses <code>/v1/messages</code>, OpenCode accepts Messages or Chat Completions, and Codex uses <code>/v1/responses</code>. A provider is only selectable under an agent framework that supports its format."
                    components={{ code: <code /> }}
                  />
                }
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

          <div className="flex items-center justify-between gap-4 border-t border-border-200 pt-3">
            <label className="space-y-0.5" htmlFor="provider-image-input">
              <span className="block text-xs font-medium">{t('Image input')}</span>
              <span className="block text-xs text-muted-foreground">
                {t('Enable only when this gateway and model accept image content.')}
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

          <div className="space-y-3 border-t border-border-200 pt-3">
            <div className="flex items-center justify-between gap-4">
              <label className="space-y-0.5" htmlFor="provider-reasoning-effort">
                <span className="block text-xs font-medium">{t('Reasoning effort')}</span>
                <span className="block text-xs text-muted-foreground">
                  {t(
                    'Choose the exact effort levels accepted by this model. Open Science maps five relative strengths onto them, then sends the selected level using the request format below. Disable when the model does not accept an effort parameter.'
                  )}
                </span>
              </label>
              <Switch
                id="provider-reasoning-effort"
                aria-label={t('Supports reasoning effort')}
                checked={value.reasoningEffortPreset !== 'unsupported'}
                disabled={disabled}
                onCheckedChange={(supported) =>
                  onChange({
                    reasoningEffortPreset: supported ? 'standard-5' : 'unsupported'
                  })
                }
              />
            </div>

            {value.reasoningEffortPreset !== 'unsupported' ? (
              <div className="space-y-3">
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

                <div className="space-y-1.5">
                  <span className="block text-xs font-medium">{t('Request format')}</span>
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
              </div>
            ) : null}
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
              value={value.model}
              disabled={disabled}
              placeholder="claude-sonnet-4-5"
              onChange={(event) => onChange({ model: event.target.value })}
            />
            {errors.model ? (
              <p className={fieldErrorClassName} role="alert">
                {t(errors.model)}
              </p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center gap-1">
              <label className={fieldLabelClassName} htmlFor="provider-context-window">
                {t('Context window')}
              </label>
              <FieldHelp content={t('Total tokens shared by the request and response.')} />
            </div>
            <Input
              id="provider-context-window"
              aria-label={t('Context window')}
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              list="provider-context-window-presets"
              value={value.contextWindow}
              disabled={disabled}
              placeholder="200000"
              onChange={(event) => onChange({ contextWindow: event.target.value })}
            />
            <datalist id="provider-context-window-presets">
              {CUSTOM_PROVIDER_CONTEXT_WINDOW_PRESETS.map((limit) => (
                <option key={limit} value={limit} />
              ))}
            </datalist>
            {errors.contextWindow ? (
              <p className={fieldErrorClassName} role="alert">
                {t(errors.contextWindow)}
              </p>
            ) : null}
          </div>

          <div>
            <button
              type="button"
              aria-expanded={advancedVisible}
              aria-controls="provider-model-limit-advanced-settings"
              onClick={() => setAdvancedOpen((open) => !open)}
              className="flex min-h-8 w-full items-center gap-2 rounded-lg py-1.5 text-left text-sm font-medium whitespace-nowrap text-foreground transition-colors duration-150 outline-none motion-reduce:transition-none hover:text-primary focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <ChevronDown
                className={`size-4 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none ${
                  advancedVisible ? '' : '-rotate-90'
                }`}
                aria-hidden="true"
              />
              {t('Advanced settings')}
            </button>

            {advancedVisible ? (
              <div id="provider-model-limit-advanced-settings" className="mt-3 flex flex-col gap-4">
                <div className="space-y-1.5">
                  <div className="flex items-center gap-1">
                    <label className={fieldLabelClassName} htmlFor="provider-max-input-tokens">
                      {t('Maximum input tokens')}
                    </label>
                    <FieldHelp content={t('Optional provider-reported input cap.')} />
                  </div>
                  <Input
                    id="provider-max-input-tokens"
                    aria-label={t('Maximum input tokens')}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    step={1}
                    value={value.maxInputTokens}
                    disabled={disabled}
                    onChange={(event) => onChange({ maxInputTokens: event.target.value })}
                  />
                  {errors.maxInputTokens ? (
                    <p className={fieldErrorClassName} role="alert">
                      {t(errors.maxInputTokens)}
                    </p>
                  ) : null}
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center gap-1">
                    <label className={fieldLabelClassName} htmlFor="provider-max-output-tokens">
                      {t('Maximum output tokens')}
                    </label>
                    <FieldHelp content={t('Optional provider-reported output cap.')} />
                  </div>
                  <Input
                    id="provider-max-output-tokens"
                    aria-label={t('Maximum output tokens')}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    step={1}
                    value={value.maxOutputTokens}
                    disabled={disabled}
                    onChange={(event) => onChange({ maxOutputTokens: event.target.value })}
                  />
                  {errors.maxOutputTokens ? (
                    <p className={fieldErrorClassName} role="alert">
                      {t(errors.maxOutputTokens)}
                    </p>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
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
