import { createHash } from 'node:crypto'
import type { PermissionCapability, PermissionGrantScope } from '../../shared/permission-grants'
import type { PermissionProfileId } from '../../shared/permission-profiles'
import type { AgentFrameworkId } from '../../shared/settings'
import type { AcpPermissionRequest } from '../../shared/acp'
import type { AgentModelRoute } from '../agent-framework/types'
import { createLogger } from '../logger'
import { isPreRegisteredPermissionIdentity } from './identity-catalog'

// Keep this boundary metadata-only. Provider IDs and capability keys can contain arbitrary text;
// fingerprints allow correlation without putting titles, arguments, paths or custom names in logs.
type PermissionDiagnostic = {
  stage: 'request' | 'decision' | 'settlement' | 'context' | 'profile'
  sessionId: string
  toolCallId?: string
  requestId?: string
  frameworkId?: AgentFrameworkId
  modelRoute?: AgentModelRoute
  profile?: PermissionProfileId
  capability?: PermissionCapability
  reportedToolName?: string
  identitySource?: 'verified_context' | 'provider_metadata' | 'tool_kind' | 'unavailable'
  authority?:
    | 'registry_grant'
    | 'automatic_policy'
    | 'legacy_session'
    | 'human'
    | 'system'
    | 'restored_once'
    | 'provider_native'
    | 'connector_policy'
  reason?: string // Callers supply fixed product reason codes, never provider text.
  fallback?: boolean
  outcome?: 'allowed' | 'approval_required' | 'rejected' | 'cancelled' | 'resolved'
  matchedScope?: PermissionGrantScope['kind']
  waitMs?: number
  toolKind?: AcpPermissionRequest['toolKind']
  hasReportedToolName?: boolean
  hasRawInput?: boolean
  hasLocations?: boolean
}
const fingerprint = (value: string): string =>
  createHash('sha256').update(value).digest('hex').slice(0, 16)

const logPermissionDiagnostic = (event: PermissionDiagnostic): void => {
  // Filter before creating a logger: debug levels can still mirror events to the console.
  // Native profile configuration and ordinary approvals/rejections are not anomalies.
  if (!(
    (event.fallback === true && (event.stage === 'decision' || event.stage === 'context')) ||
    (event.stage === 'decision' && event.reason === 'permission_settlement_failed')
  ))
    return
  try {
    const {
      sessionId,
      toolCallId,
      requestId,
      capability,
      reportedToolName,
      toolKind,
      ...metadata
    } = event
    createLogger('permission').info('permission decision trace', {
      ...metadata,
      ...([
        'read',
        'edit',
        'delete',
        'move',
        'search',
        'execute',
        'think',
        'fetch',
        'switch_mode',
        'other'
      ].includes(toolKind ?? '')
        ? { toolKind }
        : {}),
      sessionRef: fingerprint(sessionId),
      ...(toolCallId ? { toolCallRef: fingerprint(toolCallId) } : {}),
      ...(requestId ? { requestRef: fingerprint(requestId) } : {}),
      ...(reportedToolName ? { reportedToolRef: fingerprint(reportedToolName) } : {}),
      ...(capability
        ? {
            capabilityKind: capability.kind,
            capabilityRef: fingerprint(capability.key),
            ...(isPreRegisteredPermissionIdentity(capability.kind, capability.key)
              ? { capabilityKey: capability.key }
              : {})
          }
        : {})
    })
  } catch {
    // Diagnostics must never grant, deny or interrupt a tool call.
  }
}

export { logPermissionDiagnostic }
export type { PermissionDiagnostic }
