import { z } from 'zod'

const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u)
const key = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u)
const checksum = z.string().regex(/^[a-f0-9]{64}$/u)
export const researchEnvironmentVariableSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{0,127}$/u)
  .refine(
    (name) =>
      !/^(?:OPEN_SCIENCE_|NODE_|DYLD_|LD_|BASH_|ENV$|BASH_ENV$|SHELLOPTS$|BASHOPTS$|PATH$|HOME$|TMPDIR$|TMP$|TEMP$|USERPROFILE$|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$|SHELL$|IFS$|CDPATH$|ZDOTDIR$)/u.test(
        name
      ),
    'Runtime control variables cannot be configured.'
  )
export const researchNetworkHostSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u)
  .refine(
    (host) =>
      host !== 'localhost' &&
      !host.endsWith('.localhost') &&
      !host.endsWith('.local') &&
      !/^\d+(?:\.\d+){3}$/u.test(host),
    'Use an exact public service hostname.'
  )
export const researchExecutionBindingSchema = z
  .object({
    projectId: identity,
    sourceSessionId: identity,
    sourceIdentity: z.string().min(1).max(4096),
    descriptorVersionId: identity,
    descriptorSha256: checksum,
    planKey: key
  })
  .strict()
export type ResearchExecutionBinding = z.infer<typeof researchExecutionBindingSchema>
export const researchExecutionPreflightRequestSchema = researchExecutionBindingSchema
  .omit({ descriptorSha256: true })
  .extend({ sessionId: identity, profileId: identity.optional() })
  .strict()
export type ResearchExecutionPreflightRequest = z.infer<
  typeof researchExecutionPreflightRequestSchema
>
export const saveResearchExecutionProfileRequestSchema = researchExecutionPreflightRequestSchema
  .extend({
    descriptorSha256: checksum,
    displayName: z.string().trim().min(1).max(160),
    variables: z
      .record(
        researchEnvironmentVariableSchema,
        z
          .string()
          .max(4096)
          .refine((value) => !value.includes('\0'))
      )
      .default({}),
    // Values only enter through the trusted local desktop IPC. No Agent/HTTP setter exists.
    credentials: z
      .record(
        key,
        z
          .string()
          .min(1)
          .max(16_384)
          .refine((value) => !value.includes('\0'))
      )
      .default({}),
    allowedNetworkHosts: z.array(researchNetworkHostSchema).max(32).default([]),
    conditionChanges: z.array(z.string().trim().min(1).max(2048)).max(32).default([])
  })
  .strict()
export type SaveResearchExecutionProfileRequest = z.input<
  typeof saveResearchExecutionProfileRequestSchema
>
export type ResearchExecutionSecretSlot = {
  key: string
  description: string
  environmentVariable: string
  required: boolean
}
export type ResearchExecutionProfileView = {
  profileId: string
  binding: ResearchExecutionBinding
  displayName: string
  variables: Record<string, string>
  allowedNetworkHosts: string[]
  conditionChanges: string[]
  configuredCredentialKeys: string[]
  updatedAt: number
}
export type ResearchExecutionPreflight = {
  status: 'ready' | 'blocked'
  sourceTitle?: string
  planTitle?: string
  binding?: ResearchExecutionBinding
  issues: Array<{
    code:
      | 'description-unavailable'
      | 'plan-unavailable'
      | 'material-unavailable'
      | 'runtime-unavailable'
      | 'profile-required'
      | 'profile-unavailable'
      | 'credential-required'
      | 'credential-unavailable'
    key?: string
  }>
  compatibleRuntimeIds: string[]
  profiles: ResearchExecutionProfileView[]
  selectedProfileId?: string
  slots: Array<ResearchExecutionSecretSlot & { status: 'configured' | 'missing' | 'unavailable' }>
  // Ready means the local prerequisites exist; remote credentials and research claims are unverified.
  remoteServicesVerified: false
}

export const requestResearchExecutionConfigurationSchema = researchExecutionPreflightRequestSchema
  .extend({ requestId: identity })
  .strict()
export const getResearchExecutionConfigurationSchema = z
  .object({ projectId: identity, sessionId: identity, configurationId: z.string().uuid() })
  .strict()
export const resolveResearchExecutionConfigurationSchema = z
  .object({
    configurationId: z.string().uuid(),
    outcome: z.enum(['configured', 'dismissed']),
    profileId: identity.optional()
  })
  .strict()
export type RequestResearchExecutionConfiguration = z.infer<
  typeof requestResearchExecutionConfigurationSchema
>
export type GetResearchExecutionConfiguration = z.infer<
  typeof getResearchExecutionConfigurationSchema
>
export type ResolveResearchExecutionConfiguration = z.infer<
  typeof resolveResearchExecutionConfigurationSchema
>
export type ResearchExecutionConfigurationSnapshot = {
  configurationId: string
  requestId: string
  scope: ResearchExecutionPreflightRequest
  status: 'pending' | 'configured' | 'dismissed' | 'expired'
  preflight: ResearchExecutionPreflight
  createdAt: number
  expiresAt: number
  profileId?: string
}
