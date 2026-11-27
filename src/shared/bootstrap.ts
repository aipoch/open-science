import { z } from 'zod'
import type { ModelProtocol } from '@aipoch/providers'
import { AGENT_FRAMEWORK_ID_VALUES, type AgentFrameworkId } from './agent-framework-id'
import type { ProviderType, ValidationCategory } from './settings-types'

const framework = z.enum(AGENT_FRAMEWORK_ID_VALUES)
const id = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/)
const model = z.string().trim().min(1).max(512)
const protocol = z.enum(['messages', 'chat-completions', 'responses'])
const apiProviderDraft = {
  providerType: z.enum(['official', 'custom']),
  framework,
  model,
  name: z.string().trim().min(1).max(128).optional(),
  vendorId: id.optional(),
  region: id.optional(),
  baseUrl: z.string().trim().min(1).max(2048).optional(),
  protocol: protocol.optional()
}
const providerCredentialTarget = z.strictObject({
  action: z.literal('provider-credential-target'),
  ...apiProviderDraft,
  providerId: z.uuid()
})

export const isProviderSetupAction = (value: unknown): boolean =>
  value === 'provider-options' ||
  value === 'provider-save' ||
  value === 'provider-activate' ||
  value === 'provider-credential-target'

export const bootstrapRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }).strict(),
  z.object({ action: z.literal('runtime') }).strict(),
  z.object({ action: z.literal('agent-runtime'), framework }).strict(),
  z.object({ action: z.literal('kilo-free'), framework }).strict(),
  z.object({ action: z.literal('codex-prepare') }).strict(),
  z.object({ action: z.literal('codex-complete') }).strict(),
  z.strictObject({ action: z.literal('provider-options'), framework: framework.optional() }),
  providerCredentialTarget,
  z.strictObject({
    action: z.literal('provider-save'),
    ...apiProviderDraft,
    credentialRef: id.optional(),
    providerId: z.uuid().optional(),
    expectedProtocol: protocol.optional(),
    expectedEndpoint: z.url().max(4096).optional(),
    // Internal loopback transport only. The public CLI/MCP schema accepts an environment name.
    key: z.string().trim().min(1).max(8192).optional()
  }),
  z.strictObject({
    action: z.literal('provider-activate'),
    framework,
    providerId: id,
    model,
    expectedActiveProviderId: id.nullable(),
    expectedActiveModel: model.nullable()
  }),
  z
    .object({
      action: z.literal('provider'),
      key: z.string().trim().min(1).max(8192),
      model: z.string().trim().min(1).max(256)
    })
    .strict(),
  z.object({ action: z.literal('openalex'), key: z.string().trim().min(1).max(8192) }).strict()
])

export type BootstrapRequest = z.infer<typeof bootstrapRequestSchema>

type ProviderModelOption = {
  id: string
  compatible: boolean
  apiEndpoints: ModelProtocol[]
  credentialRequired: boolean
}

export type BootstrapProviderOptions = {
  framework: AgentFrameworkId
  selectedFramework: AgentFrameworkId | null
  active: { providerId: string | null; model: string | null }
  providers: {
    id: string
    name: string
    type: ProviderType
    models: ProviderModelOption[]
    lastValidated?: { model: string; protocol: ModelProtocol }
    authentication: 'api' | 'user-sign-in' | 'app-managed'
  }[]
  official: {
    vendorId: string
    name: string
    region?: string
    regionLabel?: string
    models: ProviderModelOption[]
  }[]
  customProtocols: ModelProtocol[]
  credentialRefs: { id: string; displayName: string }[]
}

export type BootstrapProviderSetup = {
  providerId: string
  framework: AgentFrameworkId
  model: string
  saved: true
  validation: 'passed'
  active: boolean
}

export type BootstrapProviderCredentialTarget = { protocol: ModelProtocol; endpoint: string }

export type BootstrapResult =
  | {
      ok: true
      providerId?: string
      selectedFramework?: AgentFrameworkId | null
      keylessKiloAvailable?: boolean
      providerOptions?: BootstrapProviderOptions
      providerSetup?: BootstrapProviderSetup
      providerCredentialTarget?: BootstrapProviderCredentialTarget
      next?: { runtime?: string[]; provider?: string[] }
    }
  | {
      ok: false
      code:
        | 'invalid_request'
        | 'configuration_conflict'
        | 'runtime_unavailable'
        | 'credential_invalid'
        | 'provider_credential_missing'
        | 'provider_validation_failed'
        | 'bootstrap_failed'
      category?: ValidationCategory
    }

export class BootstrapError extends Error {
  constructor(
    readonly code: Exclude<BootstrapResult, { ok: true }>['code'],
    readonly category?: ValidationCategory
  ) {
    super(code)
  }
}
