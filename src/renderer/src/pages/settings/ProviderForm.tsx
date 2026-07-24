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
import { getApiKeySecurityCopy } from './provider-key-security'
import { ProviderKindIcon } from './provider-icons'
import {
  PROVIDER_KIND_GROUPS,
  PROVIDER_KINDS,
  providerKindPatch,
  selectedKindKey,
  type ProviderFormErrors,
  type ProviderFormValue
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
}

const fieldLabelClassName = 'text-xs font-medium text-muted-foreground'
const fieldErrorClassName = 'text-xs text-destructive'

// Static field guidance stays close to the form while FieldHelp remains content-agnostic.
const BASE_URL_HELP_CONTENT = (
  <>
    The gateway root; a trailing <code>/v1</code> is added automatically. Choose the API format
    below to match the endpoint.
  </>
)

// Human labels for the provider API format (which chat endpoint the gateway speaks).
const API_FORMAT_LABELS: Record<ProviderFormValue['apiEndpoint'], string> = {
  openai: 'Chat Completions API (/v1/chat/completions)',
  anthropic: 'Messages API (/v1/messages)',
  responses: 'Responses API (/v1/responses)'
}

const API_FORMAT_HELP_CONTENT = (
  <>
    Which chat API this gateway speaks. Claude Code uses <code>/v1/messages</code>, OpenCode accepts
    Messages or Chat Completions, and Codex uses <code>/v1/responses</code>. A provider is only
    selectable under an agent framework that supports its format.
  </>
)

// Custom gateways declare exactly one protocol. Official vendors may serve several endpoints; that
// multi-endpoint set lives in the registry and is not a selectable custom option.
const selectableApiFormats = (): ProviderFormValue['apiEndpoint'][] => [
  'openai',
  'anthropic',
  'responses'
]

const SUPPORTED_MODELS_HELP_CONTENT = (
  <>
    Bundled with the app. Refresh from the vendor to pull the latest. Choose one from the Active
    model selector after adding.
  </>
)

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
  showClaudeIsolated = false
}: ProviderFormProps): React.JSX.Element => {
  const isCustom = value.type === 'custom'
  const isOfficial = value.type === 'official'
  const isCodexSubscription = value.type === 'codex-shared' || value.type === 'codex-isolated'
  const isClaudeSubscription = value.type === 'claude-shared' || value.type === 'claude-isolated'
  const vendor = isOfficial && value.vendorId ? getOfficialVendor(value.vendorId) : undefined

  const selectedKey = selectedKindKey(value)
  const selectedKind = PROVIDER_KINDS.find((kind) => kind.key === selectedKey)
  // Where to get a key for an official vendor (region-specific console); custom providers have none.
  const apiKeyUrl =
    isOfficial && value.vendorId ? resolveVendorApiKeyUrl(value.vendorId, value.region) : undefined
  const securityCopy = getApiKeySecurityCopy(encryptionAvailable)

  const keyField = (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <label className={fieldLabelClassName} htmlFor="provider-key">
            API key
            <RequiredMark />
          </label>
          <FieldHelp
            content={
              <>
                <span className="block font-medium">{securityCopy.title}</span>
                <span className="block text-bg-000/80">{securityCopy.description}</span>
              </>
            }
          />
        </div>
        {apiKeyUrl ? (
          <ExternalTextLink href={apiKeyUrl} className="text-xs">
            Get an API key
          </ExternalTextLink>
        ) : null}
      </div>
      <Input
        id="provider-key"
        aria-label="API key"
        type="password"
        value={value.key}
        disabled={disabled}
        placeholder={hasStoredKey ? `${maskedKey ?? 'stored key'} — leave blank to keep` : 'sk-...'}
        onChange={(event) => onChange({ key: event.target.value })}
      />
      {needsKey ? (
        <p className={fieldErrorClassName} role="alert">
          The stored key could not be decrypted. Enter it again to continue.
        </p>
      ) : errors.key ? (
        <p className={fieldErrorClassName} role="alert">
          {errors.key}
        </p>
      ) : null}
    </div>
  )

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <div className="flex items-center gap-1">
          <span className={fieldLabelClassName}>Provider type</span>
          {selectedKind ? <FieldHelp content={selectedKind.description} /> : null}
        </div>
        <Select value={selectedKey} onValueChange={(key) => onChange(providerKindPatch(key))}>
          <SelectTrigger aria-label="Provider type">
            <span className="flex items-center gap-2">
              <ProviderKindIcon kindKey={selectedKey} />
              <span>{selectedKind?.label}</span>
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
                  <SelectLabel>{group.label}</SelectLabel>
                  {kinds.map((kind) => (
                    <SelectItem
                      key={kind.key}
                      value={kind.key}
                      icon={<ProviderKindIcon kindKey={kind.key} />}
                    >
                      {kind.label}
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
            Name
          </label>
          <Input
            id="provider-name"
            aria-label="Provider name"
            value={value.name}
            disabled={disabled}
            placeholder={vendor ? vendor.label : 'e.g. My gateway'}
            onChange={(event) => onChange({ name: event.target.value })}
          />
        </div>
      ) : null}

      {isCodexSubscription ? (
        <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
          <div className="space-y-1.5">
            <span className={fieldLabelClassName}>Codex authentication</span>
            <Select
              value={value.type}
              disabled={disabled}
              onValueChange={(type) =>
                onChange({ type: type as 'codex-shared' | 'codex-isolated' })
              }
            >
              <SelectTrigger aria-label="Codex authentication" disabled={disabled}>
                <span>
                  {value.type === 'codex-shared'
                    ? 'Use existing Codex profile'
                    : 'Sign in with Open Science'}
                </span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="codex-shared">Use existing Codex profile</SelectItem>
                <SelectItem value="codex-isolated">Sign in with Open Science</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <p className="text-xs text-muted-foreground">
            {value.type === 'codex-shared'
              ? 'Uses the Codex profile in your user home directory. Authentication remains managed by Codex CLI.'
              : 'Stores a separate Codex login in Open Science app data without changing your Codex CLI profile.'}
          </p>
        </div>
      ) : isClaudeSubscription ? (
        <>
          <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
            <div className="space-y-1.5">
              <span className={fieldLabelClassName}>Claude authentication</span>
              <Select
                value={value.type}
                disabled={disabled}
                onValueChange={(type) =>
                  onChange({ type: type as 'claude-shared' | 'claude-isolated' })
                }
              >
                <SelectTrigger aria-label="Claude authentication" disabled={disabled}>
                  <span>
                    {value.type === 'claude-shared'
                      ? 'Use existing Claude profile (Recommended)'
                      : 'Sign in separately (isolated)'}
                  </span>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="claude-shared">
                    Use existing Claude profile (Recommended)
                  </SelectItem>
                  <SelectItem value="claude-isolated">Sign in separately (isolated)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <p className="text-xs text-muted-foreground">
              {value.type === 'claude-shared'
                ? 'Recommended. Uses your existing Claude login from ~/.claude. Sign in once via browser OAuth and use across all Claude tools.'
                : 'Advanced. Signs in through the browser and stores a separate Claude login in Open Science, completely isolated from your personal Claude profile.'}
            </p>
            <div className="space-y-1.5 border-t border-border-200 pt-3">
              <p className="text-xs text-muted-foreground">
                {value.type === 'claude-shared' ? (
                  <>
                    Sign in via browser OAuth. The Settings card will open your browser to sign in
                    with your Claude account. Your credentials are stored in{' '}
                    <code className="font-mono">~/.claude</code>.
                  </>
                ) : (
                  <>
                    Run <code className="font-mono">claude setup-token</code> in a terminal and
                    paste the token below. It is stored encrypted under your app-owned Claude config
                    dir; nothing is read from or written to{' '}
                    <code className="font-mono">~/.claude</code>.
                  </>
                )}
              </p>
            </div>
            {value.type === 'claude-isolated' && (
              <p className="text-xs text-muted-foreground">
                Paste the token in the Settings card after saving — the wizard&apos;s Test &amp;
                continue flow signs you in.
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <label className={fieldLabelClassName} htmlFor="provider-model">
              Model <span className="text-muted-foreground">(optional override)</span>
            </label>
            <Input
              id="provider-model"
              aria-label="Model"
              value={value.model}
              disabled={disabled}
              placeholder="Leave blank to use Claude's default"
              onChange={(event) => onChange({ model: event.target.value })}
            />
          </div>
        </>
      ) : isCustom ? (
        <>
          <div className="space-y-1.5">
            <div className="flex items-center gap-1">
              <label className={fieldLabelClassName} htmlFor="provider-base-url">
                Base URL
                <RequiredMark />
              </label>
              <FieldHelp content={BASE_URL_HELP_CONTENT} />
            </div>
            <Input
              id="provider-base-url"
              aria-label="Base URL"
              value={value.baseUrl}
              disabled={disabled}
              placeholder="https://gateway.example"
              onChange={(event) => onChange({ baseUrl: event.target.value })}
            />
            {errors.baseUrl ? (
              <p className={fieldErrorClassName} role="alert">
                {errors.baseUrl}
              </p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center gap-1">
              <span className={fieldLabelClassName}>API format</span>
              <FieldHelp content={API_FORMAT_HELP_CONTENT} />
            </div>
            <Select
              value={value.apiEndpoint}
              disabled={disabled}
              onValueChange={(apiEndpoint) =>
                onChange({ apiEndpoint: apiEndpoint as ProviderFormValue['apiEndpoint'] })
              }
            >
              <SelectTrigger aria-label="API format" disabled={disabled}>
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
              <span className="block text-xs font-medium">Image input</span>
              <span className="block text-xs text-muted-foreground">
                Enable only when this gateway and model accept image content.
              </span>
            </label>
            <Switch
              id="provider-image-input"
              aria-label="Supports image input"
              checked={value.supportsImageInput}
              disabled={disabled}
              onCheckedChange={(supportsImageInput) => onChange({ supportsImageInput })}
            />
          </div>

          {keyField}

          <div className="space-y-1.5">
            <label className={fieldLabelClassName} htmlFor="provider-model">
              Model
              <RequiredMark />
            </label>
            <Input
              id="provider-model"
              aria-label="Model"
              value={value.model}
              disabled={disabled}
              placeholder="claude-sonnet-4-5"
              onChange={(event) => onChange({ model: event.target.value })}
            />
            {errors.model ? (
              <p className={fieldErrorClassName} role="alert">
                {errors.model}
              </p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <label className={fieldLabelClassName} htmlFor="provider-context-window">
              Context window
            </label>
            <Input
              id="provider-context-window"
              aria-label="Context window"
              type="number"
              inputMode="numeric"
              min={1}
              step={1000}
              value={value.contextWindow}
              disabled={disabled}
              placeholder="200000"
              onChange={(event) => onChange({ contextWindow: event.target.value })}
            />
            {errors.contextWindow ? (
              <p className={fieldErrorClassName} role="alert">
                {errors.contextWindow}
              </p>
            ) : null}
          </div>
        </>
      ) : isOfficial ? (
        <>
          {vendor?.regions ? (
            <div className="space-y-1.5">
              <span className={fieldLabelClassName}>Endpoint</span>
              <Select
                value={value.region ?? vendor.regions[0]?.id}
                onValueChange={(region) => onChange({ region })}
              >
                <SelectTrigger aria-label="Endpoint">
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
                    <span className={fieldLabelClassName}>Supported models</span>
                    <FieldHelp content={SUPPORTED_MODELS_HELP_CONTENT} />
                  </div>
                  {onRefreshModels ? (
                    <button
                      type="button"
                      onClick={onRefreshModels}
                      disabled={disabled || isRefreshingModels}
                      className="text-xs font-medium text-primary underline underline-offset-2 hover:text-primary/80 disabled:opacity-50"
                    >
                      {isRefreshingModels ? 'Refreshing…' : 'Refresh from vendor'}
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
            Model <span className="text-muted-foreground">(optional override)</span>
          </label>
          <Input
            id="provider-model"
            aria-label="Model"
            value={value.model}
            disabled={disabled}
            placeholder="Leave blank to use Claude's default"
            onChange={(event) => onChange({ model: event.target.value })}
          />
        </div>
      )}
    </div>
  )
}

export { ProviderForm }
