import { ChevronDown } from 'lucide-react'
import type { ComponentType } from 'react'
import { Trans, useTranslation } from 'react-i18next'

import type {
  ComputeAuthenticationMode,
  ComputePasswordCapability
} from '../../../../shared/compute'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { MaskedPasswordField } from './MaskedPasswordField'
import {
  COMPUTE_AUTHENTICATION_MODES,
  type ComputeAuthenticationFieldSet,
  type ComputeAuthenticationStrategy
} from './compute-authentication-form'

type AuthenticationFieldProps = Readonly<{
  user: string
  port: string
  identityFile: string
  password: string
  onUserChange(value: string): void
  onPortChange(value: string): void
  onIdentityFileChange(value: string): void
  onPasswordChange(value: string): void
}>

const SshConfigAuthenticationFields = (props: AuthenticationFieldProps): React.JSX.Element => {
  const { t } = useTranslation()
  return (
    <>
      <p className="text-xs text-muted-foreground">
        <Trans
          i18nKey="By default Open Science resolves connection details by running <code>ssh -G</code> against the alias in your <path>~/.ssh/config</path>. Set these only if you need to override that."
          components={{
            code: <code className="font-mono" />,
            path: <code className="font-mono" />
          }}
        />
      </p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="compute-user" className="text-sm font-medium text-foreground">
          {t('User')}
        </Label>
        <Input
          id="compute-user"
          value={props.user}
          onChange={(event) => props.onUserChange(event.target.value)}
          placeholder="argocd"
        />
        <span className="text-xs text-muted-foreground">
          {t('Leave empty to use User from ~/.ssh/config.')}
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="compute-port" className="text-sm font-medium text-foreground">
          {t('Port')}
        </Label>
        <Input
          id="compute-port"
          inputMode="numeric"
          value={props.port}
          onChange={(event) => props.onPortChange(event.target.value)}
          placeholder="22"
        />
        <span className="text-xs text-muted-foreground">
          {t('Leave empty for 22 or Port from ~/.ssh/config.')}
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="compute-identity" className="text-sm font-medium text-foreground">
          {t('Identity file')}
        </Label>
        <Input
          id="compute-identity"
          value={props.identityFile}
          onChange={(event) => props.onIdentityFileChange(event.target.value)}
          placeholder="~/.ssh/id_ed25519"
        />
        <span className="text-xs text-muted-foreground">
          {t('Leave empty for ssh-agent / IdentityFile from ~/.ssh/config.')}
        </span>
      </div>
    </>
  )
}

const PasswordAuthenticationFields = (props: AuthenticationFieldProps): React.JSX.Element => {
  const { t } = useTranslation()
  return (
    <>
      <p className="text-xs text-muted-foreground">
        {t('Password authentication requires a User and Port and never uses keys or ssh-agent.')}
      </p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="compute-password-user" className="text-sm font-medium text-foreground">
          {t('User')}
        </Label>
        <Input
          id="compute-password-user"
          value={props.user}
          onChange={(event) => props.onUserChange(event.target.value)}
          placeholder="argocd"
          required
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="compute-password-port" className="text-sm font-medium text-foreground">
          {t('Port')}
        </Label>
        <Input
          id="compute-password-port"
          inputMode="numeric"
          value={props.port}
          onChange={(event) => props.onPortChange(event.target.value)}
          placeholder="22"
          required
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="compute-password" className="text-sm font-medium">
          {t('Password')}
        </Label>
        <MaskedPasswordField
          id="compute-password"
          value={props.password}
          onChange={props.onPasswordChange}
          required
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {t('The Compute Host is added only after this connection test succeeds.')}
      </p>
    </>
  )
}

const AUTHENTICATION_FIELDS = {
  ssh_config: SshConfigAuthenticationFields,
  password: PasswordAuthenticationFields
} satisfies Record<ComputeAuthenticationFieldSet, ComponentType<AuthenticationFieldProps>>

const ComputeAuthenticationIntroduction = ({
  strategy
}: Readonly<{ strategy: ComputeAuthenticationStrategy }>): React.JSX.Element => {
  const { t } = useTranslation()
  return strategy.introduction.kind === 'ssh_config_trans' ? (
    <Trans
      i18nKey={strategy.introduction.i18nKey}
      components={{ path: <code className="font-mono text-xs" /> }}
    />
  ) : (
    <>{strategy.introduction.copy(t)}</>
  )
}

type ComputeAuthenticationSectionProps = Readonly<{
  mode: ComputeAuthenticationMode
  passwordCapability: ComputePasswordCapability | undefined
  onModeChange(mode: ComputeAuthenticationMode): void
}>

const ComputeAuthenticationSection = (
  props: ComputeAuthenticationSectionProps
): React.JSX.Element => {
  const { t } = useTranslation()
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-medium text-foreground">{t('Authentication')}</legend>
      {COMPUTE_AUTHENTICATION_MODES.map((strategy) => {
        const available = strategy.isAvailable(props.passwordCapability)
        return (
          <Label
            key={strategy.mode}
            className={`flex items-start gap-2 rounded-lg border border-border p-3 ${
              available ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'
            }`}
          >
            <input
              type="radio"
              name="compute-authentication"
              value={strategy.mode}
              checked={props.mode === strategy.mode}
              disabled={!available}
              className="mt-0.5 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
              onChange={() => props.onModeChange(strategy.mode)}
            />
            <span>
              <span className="block text-sm font-medium">{strategy.choiceLabel(t)}</span>
              <span className="block text-xs font-normal text-muted-foreground">
                {strategy.choiceDescription(t, props.passwordCapability)}
              </span>
            </span>
          </Label>
        )
      })}
    </fieldset>
  )
}

type ComputeAdvancedSettingsProps = AuthenticationFieldProps &
  Readonly<{
    strategy: ComputeAuthenticationStrategy
    open: boolean
    onOpenChange(open: boolean): void
  }>

type ComputeAuthenticationFieldsProps = AuthenticationFieldProps &
  Readonly<{ strategy: ComputeAuthenticationStrategy }>

const ComputeAuthenticationFields = (
  props: ComputeAuthenticationFieldsProps
): React.JSX.Element => {
  const Fields = AUTHENTICATION_FIELDS[props.strategy.fieldSet]
  return <Fields {...props} />
}

const ComputeAdvancedSettings = (props: ComputeAdvancedSettingsProps): React.JSX.Element => {
  const { t } = useTranslation()
  return (
    <div>
      <button
        type="button"
        aria-expanded={props.open}
        aria-controls="compute-advanced-settings"
        onClick={() => props.onOpenChange(!props.open)}
        className="flex w-full touch-manipulation items-center gap-2 py-2.5 text-left text-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
      >
        <ChevronDown
          className={`size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none ${
            props.open ? '' : '-rotate-90'
          }`}
          aria-hidden="true"
        />
        {t('Advanced settings')}
      </button>
      <div
        id="compute-advanced-settings"
        hidden={!props.open}
        className={props.open ? 'flex flex-col gap-4 pb-1 pl-6 pt-2' : 'hidden'}
      >
        <ComputeAuthenticationFields {...props} />
      </div>
    </div>
  )
}

export {
  ComputeAdvancedSettings,
  ComputeAuthenticationFields,
  ComputeAuthenticationIntroduction,
  ComputeAuthenticationSection
}
