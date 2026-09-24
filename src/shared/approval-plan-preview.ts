/** App-owned, transient review data. Never use generic tool-payload redaction on exact plans. */
export const MAX_APPROVAL_PLAN_CHARS = 4 * 1024 * 1024
export type ApprovalPlanPreview = { format: 'json-v1'; json: string }
export function createApprovalPlanPreview(plan: unknown): ApprovalPlanPreview {
  const json = JSON.stringify(plan)
  if (!json || json.length > MAX_APPROVAL_PLAN_CHARS)
    throw new Error('Approval plan exceeds the supported review size; no approval was requested.')
  const value = JSON.parse(json)
  if (
    !value ||
    !['package-installation', 'agent-configuration', 'skill-publication'].includes(value.kind)
  )
    throw new Error('Unsupported approval plan.')
  return { format: 'json-v1', json }
}
