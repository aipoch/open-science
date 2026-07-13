import { ExternalTextLink } from '@/components/ExternalTextLink'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger
} from '@/components/ui/select'
import { getOfficialVendor, resolveVendorApiKeyUrl } from '../../../../shared/provider-registry'
import { ProviderKindIcon } from './provider-icons'
import {
  PROVIDER_KINDS,
  providerKindPatch,
  selectedKindKey,
  type ProviderFormErrors,
  type ProviderFormValue,
  type ProviderKindGroup
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
}

const fieldLabelClassName = 'text-xs font-medium text-muted-foreground'
const fieldErrorClassName = 'text-xs text-destructive'

// Group headers shown in the provider-type dropdown, in display order. ('coding' is reserved for
// subscription coding-plan endpoints once those are wired up.)
const KIND_GROUPS: { id: ProviderKindGroup; label: string }[] = [
  { id: 'api', label: 'Official API' },
  { id: 'other', label: 'Other' }
]

// Marks a required field next to its label. Purely visual; the actual guard lives in the form errors.
const RequiredMark = (): React.JSX.Element => (
  <span aria-hidden="true" className="ml-0.5 text-destructive">
    *
  </span>
)

// Provider fields switch by type: pick a type first, then reveal its options. Custom exposes an
// Anthropic-compatible gateway/key/model; an official vendor exposes a key (+ region) and picks a
// model from the registry catalog; claude-default only a model override. No plaintext key is rendered.
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
  disabled = false
}: ProviderFormProps): React.JSX.Element => {
  const isCustom = value.type === 'custom'
  const isOfficial = value.type === 'official'
  const vendor = isOfficial && value.vendorId ? getOfficialVendor(value.vendorId) : undefined

  const selectedKey = selectedKindKey(value)
  const selectedKind = PROVIDER_KINDS.find((kind) => kind.key === selectedKey)
  // Where to get a key for an official vendor (region-specific console); custom providers have none.
  const apiKeyUrl =
    isOfficial && value.vendorId ? resolveVendorApiKeyUrl(value.vendorId, value.region) : undefined

  const keyField = (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <label className={fieldLabelClassName} htmlFor="provider-key">
          API key
          <RequiredMark />
        </label>
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
        <span className={fieldLabelClassName}>Provider type</span>
        <Select value={selectedKey} onValueChange={(key) => onChange(providerKindPatch(key))}>
          <SelectTrigger aria-label="Provider type">
            <span className="flex items-center gap-2">
              <ProviderKindIcon kindKey={selectedKey} />
              <span>{selectedKind?.label}</span>
            </span>
          </SelectTrigger>
          <SelectContent>
            {KIND_GROUPS.map((group) => {
              const kinds = PROVIDER_KINDS.filter((kind) => kind.group === group.id)

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
        {selectedKind ? (
          <p className="text-xs text-muted-foreground">{selectedKind.description}</p>
        ) : null}
      </div>

      <div className="space-y-1.5">
        <label className={fieldLabelClassName} htmlFor="provider-name">
          Name
        </label>
        <Input
          id="provider-name"
          aria-label="Provider name"
          value={value.name}
          disabled={disabled}
          placeholder={vendor ? vendor.label : isCustom ? 'e.g. My gateway' : 'e.g. Local Claude'}
          onChange={(event) => onChange({ name: event.target.value })}
        />
      </div>

      {isCustom ? (
        <>
          <div className="space-y-1.5">
            <label className={fieldLabelClassName} htmlFor="provider-base-url">
              Base URL
              <RequiredMark />
            </label>
            <Input
              id="provider-base-url"
              aria-label="Base URL"
              value={value.baseUrl}
              disabled={disabled}
              placeholder="https://gateway.example"
              onChange={(event) => onChange({ baseUrl: event.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              Only Anthropic <code>/v1/messages</code>–compatible gateways are supported (an
              Anthropic-format endpoint, not an OpenAI-compatible one). Give the root — a trailing{' '}
              <code>/v1</code> is added automatically.
            </p>
            {errors.baseUrl ? (
              <p className={fieldErrorClassName} role="alert">
                {errors.baseUrl}
              </p>
            ) : null}
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
            const models = supportedModels ?? vendor?.models ?? []

            if (models.length === 0) return null

            return (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className={fieldLabelClassName}>Supported models</span>
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
                <p className="text-xs text-muted-foreground">
                  Bundled with the app. Refresh from the vendor to pull the latest. Choose one from
                  the Active model selector after adding.
                </p>
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
