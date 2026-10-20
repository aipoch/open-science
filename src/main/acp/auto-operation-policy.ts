import { z } from 'zod'
import { createPlanDocumentV1, generatePlanContentSchema } from '../../shared/session-plan/contract'
import { NOTEBOOK_RPC_TOOLS } from '../notebook/mcp-server'
import { requestSkillImportToolSchema } from '../skills/mcp-server'
import { generatePlanToolSchema } from '../session-plan/plan-mcp-server'

export type AutoOperationDecision =
  | { kind: 'allow_once'; reason: string }
  | { kind: 'inner_authorization'; reason: string }
  | { kind: 'legacy' }

export const APP_AUTO_OPERATION_IDENTITIES: ReadonlySet<string> = new Set([
  'open-science-notebook/background_run',
  'open-science-notebook/manage_environments',
  'open-science-plan/generate_plan',
  'open-science-skills/request_skill_import'
])

const legacy: AutoOperationDecision = { kind: 'legacy' }
const notebookSchema = (name: string): z.ZodObject<z.ZodRawShape> => {
  const definition = NOTEBOOK_RPC_TOOLS.find((tool) => tool.name === name)
  if (!definition) throw new Error(`Missing Auto operation tool definition: ${name}`)
  return z.strictObject(definition.inputSchema)
}
const backgroundRunSchema = notebookSchema('background_run')
const environmentSchema = notebookSchema('manage_environments')
const skillImportSchema = z.strictObject(requestSkillImportToolSchema)
const planDecisionSchema = generatePlanToolSchema.pick({ decision: true, approve: true })

// This classification removes only the outer card. Run ownership and the existing Plan/Skill
// confirmation services remain authoritative, and no result here creates a durable grant.
export const classifyAppAutoOperation = (
  trustedIdentity: string,
  input: unknown
): AutoOperationDecision => {
  switch (trustedIdentity) {
    case 'open-science-notebook/background_run': {
      const parsed = backgroundRunSchema.safeParse(input)
      if (!parsed.success) return legacy
      const { action, runId, submissionIdentity } = parsed.data
      if (action !== 'query' && action !== 'cancel') return legacy
      if (!runId && !submissionIdentity) return legacy
      return { kind: 'allow_once', reason: `background_run_${action}` }
    }
    case 'open-science-notebook/manage_environments': {
      const parsed = environmentSchema.safeParse(input)
      return parsed.success && parsed.data.action === 'list'
        ? { kind: 'allow_once', reason: 'environment_list' }
        : legacy
    }
    case 'open-science-plan/generate_plan': {
      // Recording a decision only reaches the existing version/interaction authorization gate.
      // Neither this handoff nor the provider's one-call response supplies user consent.
      const decisionInput = planDecisionSchema.safeParse(input)
      if (decisionInput.success) {
        const { decision, approve } = decisionInput.data
        if ((decision !== undefined) !== (approve === true)) {
          return {
            kind: 'inner_authorization',
            reason: `plan_record_${decision ?? 'approved'}`
          }
        }
        return legacy
      }
      // Mixed decision/content inputs inherit neither operation's handoff.
      const parsed = generatePlanContentSchema.strict().safeParse(input)
      if (!parsed.success) return legacy
      try {
        createPlanDocumentV1(parsed.data)
        return { kind: 'inner_authorization', reason: 'plan_content_review' }
      } catch {
        return legacy
      }
    }
    case 'open-science-skills/request_skill_import': {
      const parsed = skillImportSchema.safeParse(input)
      if (!parsed.success) return legacy
      const { github_url, attachment_uri, turn_token } = parsed.data
      if (github_url) {
        if (attachment_uri || turn_token) return legacy
      } else if (!attachment_uri || !turn_token) {
        return legacy
      }
      if (attachment_uri && new URL(attachment_uri).protocol !== 'file:') return legacy
      return { kind: 'inner_authorization', reason: 'skill_import_preview' }
    }
    default:
      return legacy
  }
}
