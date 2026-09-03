import { z } from 'zod'

import { PERMISSION_PROFILE_IDS } from './permission-profiles'

const reasoningEffortSchema = z.enum(['default', 'low', 'medium', 'high', 'xhigh', 'max'])
const delegationPolicySchema = z.enum(['allow', 'deny'])
const nonEmptyStringSchema = z.string().trim().min(1)
const permissionProfileIdSchema = z.enum(PERMISSION_PROFILE_IDS)

export const sessionAgentConfigurationSchema = z
  .object({
    providerId: nonEmptyStringSchema,
    model: nonEmptyStringSchema.optional(),
    reasoningEffort: reasoningEffortSchema
  })
  .strict()

export const sessionComputeHostsSchema = z
  .object({
    enabled: z.array(nonEmptyStringSchema),
    selected: z.array(nonEmptyStringSchema)
  })
  .strict()
  .superRefine(({ enabled, selected }, context) => {
    const enabledIds = new Set(enabled)
    for (const providerId of selected) {
      if (!enabledIds.has(providerId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Selected Compute Host is not enabled: ${providerId}`
        })
      }
    }
  })

export const projectSessionDefaultsSchema = z
  .object({
    agentConfiguration: sessionAgentConfigurationSchema.optional(),
    permissionProfile: permissionProfileIdSchema.optional(),
    autoReviewEnabled: z.boolean().optional(),
    memoryEnabled: z.boolean().optional(),
    delegationPolicy: delegationPolicySchema.optional(),
    specialistId: nonEmptyStringSchema.optional(),
    computeHosts: sessionComputeHostsSchema.optional()
  })
  .strict()

export const sessionAgentConfigurationPatchSchema = z
  .object({
    providerId: nonEmptyStringSchema.optional(),
    model: nonEmptyStringSchema.nullable().optional(),
    reasoningEffort: reasoningEffortSchema.optional()
  })
  .strict()

export const sessionConfigurationPatchSchema = z
  .object({
    agentConfiguration: sessionAgentConfigurationPatchSchema.optional(),
    permissionProfile: permissionProfileIdSchema.optional(),
    autoReviewEnabled: z.boolean().optional(),
    memoryEnabled: z.boolean().optional(),
    delegationPolicy: delegationPolicySchema.optional(),
    computeHosts: sessionComputeHostsSchema.optional()
  })
  .strict()

export const updateSessionConfigurationRequestSchema = sessionConfigurationPatchSchema
  .extend({ expectedRevision: z.number().int().nonnegative() })
  .strict()

export const projectSessionDefaultsPatchSchema = z
  .object({
    agentConfiguration: sessionAgentConfigurationPatchSchema.nullable().optional(),
    permissionProfile: permissionProfileIdSchema.nullable().optional(),
    autoReviewEnabled: z.boolean().nullable().optional(),
    memoryEnabled: z.boolean().nullable().optional(),
    delegationPolicy: delegationPolicySchema.nullable().optional(),
    specialistId: nonEmptyStringSchema.nullable().optional(),
    computeHosts: sessionComputeHostsSchema.nullable().optional()
  })
  .strict()

export const updateProjectSessionDefaultsRequestSchema = z
  .object({
    expectedUpdatedAt: z.number().int().positive(),
    patch: projectSessionDefaultsPatchSchema
  })
  .strict()

export type SessionAgentConfigurationValue = z.infer<typeof sessionAgentConfigurationSchema>
export type SessionComputeHosts = z.infer<typeof sessionComputeHostsSchema>
export type ProjectSessionDefaults = z.infer<typeof projectSessionDefaultsSchema>
export type SessionAgentConfigurationPatch = z.infer<typeof sessionAgentConfigurationPatchSchema>
export type SessionConfigurationPatch = z.infer<typeof sessionConfigurationPatchSchema>
export type UpdateSessionConfigurationRequest = z.infer<
  typeof updateSessionConfigurationRequestSchema
>
export type ProjectSessionDefaultsPatch = z.infer<typeof projectSessionDefaultsPatchSchema>
export type UpdateProjectSessionDefaultsRequest = z.infer<
  typeof updateProjectSessionDefaultsRequestSchema
>
