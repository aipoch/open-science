import { Input } from '@/components/ui/input'
import type { ProviderFormErrors, ProviderFormValue } from './provider-form-value'

type ProviderFormProps = {
  value: ProviderFormValue
  onChange: (patch: Partial<ProviderFormValue>) => void
  // Whether a stored key already exists (drives the "leave blank to keep" affordance).
  hasStoredKey?: boolean
  // Masked hint for the stored key; never the plaintext value.
  maskedKey?: string
  // True when the stored key could not be decrypted and must be re-entered.
  needsKey?: boolean
  // Per-field required-field errors to display inline (custom only).
  errors?: ProviderFormErrors
  disabled?: boolean
}

const fieldLabelClassName = 'text-xs font-medium text-muted-foreground'
const fieldErrorClassName = 'text-xs text-destructive'
const typeButtonBaseClassName =
  'flex-1 rounded-lg border px-3 py-2 text-left text-sm transition-colors'

// Provider fields that switch by type: custom exposes gateway/key/model, claude-default only a model
// override. No plaintext key is ever rendered — the stored key surfaces only as a masked placeholder.
const ProviderForm = ({
  value,
  onChange,
  hasStoredKey = false,
  maskedKey,
  needsKey = false,
  errors = {},
  disabled = false
}: ProviderFormProps): React.JSX.Element => {
  const isCustom = value.type === 'custom'

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <span className={fieldLabelClassName}>Provider type</span>
        <div className="flex gap-2">
          <button
            type="button"
            aria-pressed={isCustom}
            disabled={disabled}
            onClick={() => onChange({ type: 'custom' })}
            className={`${typeButtonBaseClassName} ${
              isCustom ? 'border-primary bg-primary/5' : 'border-border'
            }`}
          >
            <span className="font-medium text-foreground">Custom gateway</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              Base URL, API key, and model
            </span>
          </button>
          <button
            type="button"
            aria-pressed={!isCustom}
            disabled={disabled}
            onClick={() => onChange({ type: 'claude-default' })}
            className={`${typeButtonBaseClassName} ${
              !isCustom ? 'border-primary bg-primary/5' : 'border-border'
            }`}
          >
            <span className="font-medium text-foreground">Local Claude</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              Reuse this machine&apos;s Claude login
            </span>
          </button>
        </div>
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
          placeholder={isCustom ? 'e.g. My gateway' : 'e.g. Local Claude'}
          onChange={(event) => onChange({ name: event.target.value })}
        />
      </div>

      {isCustom ? (
        <>
          <div className="space-y-1.5">
            <label className={fieldLabelClassName} htmlFor="provider-base-url">
              Base URL
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
              The gateway root — don&apos;t include a trailing <code>/v1</code>; it&apos;s added
              automatically.
            </p>
            {errors.baseUrl ? (
              <p className={fieldErrorClassName} role="alert">
                {errors.baseUrl}
              </p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <label className={fieldLabelClassName} htmlFor="provider-key">
              API key
            </label>
            <Input
              id="provider-key"
              aria-label="API key"
              type="password"
              value={value.key}
              disabled={disabled}
              placeholder={
                hasStoredKey ? `${maskedKey ?? 'stored key'} — leave blank to keep` : 'sk-...'
              }
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

          <div className="space-y-1.5">
            <label className={fieldLabelClassName} htmlFor="provider-model">
              Model
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
