import type { TFunction } from 'i18next'

import type {
  ComputeAuthenticationMode,
  ComputeHost,
  ComputePasswordCapability,
  CreateComputeHostRequest,
  CreatePasswordComputeHostRequest,
  SshOverrides
} from '../../../../shared/compute'
import {
  computeAuthenticationPresentation,
  isComputeAuthenticationErrorCode
} from './compute-authentication-presentation'

type ComputeAuthenticationValues = Readonly<{
  mode: ComputeAuthenticationMode
  user: string
  port: string
  identityFile: string
  password: string
}>

type ComputeHostCreationActions = Readonly<{
  createSshConfigHost(request: CreateComputeHostRequest): Promise<ComputeHost>
  createPasswordHost(request: CreatePasswordComputeHostRequest): Promise<ComputeHost>
}>

type ComputeHostCreationCommon = Readonly<{
  sshAlias: string
  detailsDoc?: string
  operationId: string
}>

type ComputeAuthenticationIntroduction =
  | Readonly<{
      kind: 'ssh_config_trans'
      i18nKey: 'Pick a host alias from your <path>~/.ssh/config</path>, or type one. Open Science will use it as a compute provider via your existing SSH key — no credentials are copied.'
    }>
  | Readonly<{ kind: 'text'; copy(t: TFunction): string }>

type ComputeAuthenticationFieldSet = 'ssh_config' | 'password'

type ComputeAuthenticationStrategy = Readonly<{
  mode: ComputeAuthenticationMode
  introduction: ComputeAuthenticationIntroduction
  fieldSet: ComputeAuthenticationFieldSet
  usesPassword: boolean
  isAvailable(capability: ComputePasswordCapability | undefined): boolean
  choiceLabel(t: TFunction): string
  choiceDescription(t: TFunction, capability: ComputePasswordCapability | undefined): string
  progressLabel(t: TFunction): string
  isValid(
    values: ComputeAuthenticationValues,
    capability: ComputePasswordCapability | undefined
  ): boolean
  create(
    values: ComputeAuthenticationValues,
    common: ComputeHostCreationCommon,
    actions: ComputeHostCreationActions
  ): Promise<ComputeHost>
}>

const createSshConfigHost = (
  values: ComputeAuthenticationValues,
  common: ComputeHostCreationCommon,
  actions: ComputeHostCreationActions
): Promise<ComputeHost> => {
  const sshOverrides: SshOverrides = {}
  if (values.user.trim()) sshOverrides.user = values.user.trim()
  const port = Number.parseInt(values.port.trim(), 10)
  if (values.port.trim() && Number.isFinite(port)) sshOverrides.port = port
  if (values.identityFile.trim()) sshOverrides.identityFile = values.identityFile.trim()
  return actions.createSshConfigHost({
    sshAlias: common.sshAlias,
    detailsDoc: common.detailsDoc,
    sshOverrides: Object.keys(sshOverrides).length > 0 ? sshOverrides : undefined
  })
}

const createPasswordHost = (
  values: ComputeAuthenticationValues,
  common: ComputeHostCreationCommon,
  actions: ComputeHostCreationActions
): Promise<ComputeHost> =>
  actions.createPasswordHost({
    ...common,
    authenticationMode: 'password',
    username: values.user.trim(),
    port: Number(values.port),
    password: values.password
  })

const COMPUTE_AUTHENTICATION_STRATEGIES = {
  ssh_config: {
    mode: 'ssh_config',
    introduction: {
      kind: 'ssh_config_trans',
      i18nKey:
        'Pick a host alias from your <path>~/.ssh/config</path>, or type one. Open Science will use it as a compute provider via your existing SSH key — no credentials are copied.'
    },
    fieldSet: 'ssh_config',
    usesPassword: false,
    isAvailable: () => true,
    choiceLabel: (t) => t('SSH configuration'),
    choiceDescription: (t) =>
      t('Recommended. Uses your existing SSH configuration, keys, and agent.'),
    progressLabel: (t) => t('Adding host…'),
    isValid: () => true,
    create: createSshConfigHost
  },
  password: {
    mode: 'password',
    introduction: {
      kind: 'text',
      copy: (t) =>
        t('Enter a host alias and the account used for password-only SSH authentication.')
    },
    fieldSet: 'password',
    usesPassword: true,
    isAvailable: (capability) => capability?.available === true,
    choiceLabel: (t) => t('Username and password'),
    choiceDescription: (t, capability) =>
      capability?.available === false
        ? capability.reason === 'unsupported_platform'
          ? t('Password authentication is not supported on this platform.')
          : t(
              'Password authentication is unavailable because secure operating-system storage is not available.'
            )
        : t('The password is encrypted by your operating system and never shown again.'),
    progressLabel: (t) => t('Testing…'),
    isValid: (values, capability) => {
      const port = Number(values.port)
      return (
        capability?.available === true &&
        values.user.trim().length > 0 &&
        values.password.length > 0 &&
        Number.isInteger(port) &&
        port >= 1 &&
        port <= 65_535
      )
    },
    create: createPasswordHost
  }
} as const satisfies Record<ComputeAuthenticationMode, ComputeAuthenticationStrategy>

const COMPUTE_AUTHENTICATION_MODES = Object.freeze(Object.values(COMPUTE_AUTHENTICATION_STRATEGIES))

const getComputeAuthenticationStrategy = (
  mode: ComputeAuthenticationMode
): ComputeAuthenticationStrategy => COMPUTE_AUTHENTICATION_STRATEGIES[mode]

const computeAuthenticationErrorCopy = (error: unknown, t: TFunction): string => {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined
  const presentation = isComputeAuthenticationErrorCode(code)
    ? computeAuthenticationPresentation(code, 'create')
    : undefined
  return presentation?.copy(t) ?? t('Could not add host.')
}

export {
  COMPUTE_AUTHENTICATION_MODES,
  computeAuthenticationErrorCopy,
  getComputeAuthenticationStrategy
}
export type {
  ComputeAuthenticationFieldSet,
  ComputeAuthenticationStrategy,
  ComputeAuthenticationValues
}
