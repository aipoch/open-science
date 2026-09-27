import { createAcpRuntime } from '../acp/runtime-composition'
import { AgentsService } from '../agents/agents-service'
import {
  CompletionGateCoordinator,
  createCompletionGateSwitchNotifier
} from '../agents/completion-gate'
import { CompletionHandoffLifecycle } from '../agents/completion-handoff-lifecycle'
import {
  AcpSpecialistApprovalGateway,
  createAcpBackedSpecialistBridge
} from '../agents/specialist-approval-gateway'
import { SettingsService } from '../settings/service'
import { SpecialistPackageService } from '../specialist/package/service'
import { SpecialistService } from '../specialist/service'
import { SessionBindingService } from '../specialist/session-binding'
import { SessionSpecialistReconfiguration } from '../specialist/session-reconfiguration'

export function composeAgentControls({
  settingsService,
  runtimeRef,
  specialistService,
  specialistPackageService,
  sessionBindingService,
  sessionSpecialistReconfiguration,
  completionHandoffLifecycle,
  completionGateCoordinator,
  connectorRuntimeSettings,
  getRuntime
}: {
  settingsService: SettingsService
  runtimeRef: { current: ReturnType<typeof createAcpRuntime> | undefined }
  specialistService: SpecialistService
  specialistPackageService: SpecialistPackageService
  sessionBindingService: SessionBindingService
  sessionSpecialistReconfiguration: SessionSpecialistReconfiguration
  completionHandoffLifecycle: CompletionHandoffLifecycle
  completionGateCoordinator: CompletionGateCoordinator
  connectorRuntimeSettings: import('../connectors/runtime-settings-projection').ConnectorRuntimeSettingsProjection
  getRuntime: () => ReturnType<typeof createAcpRuntime>
}): { agentsService: AgentsService } {
  // host.agents control-plane SDK (issue 02/05): read Specialist/catalog surface plus the durable
  // immediate-handoff lifecycle. The catalog adapter delegates to the authoritative
  // SettingsService + SpecialistService; switch() reuses the SAME SessionBindingService and durable
  // session-file persistence seam the SET_SESSION_SPECIALIST IPC handler uses (no parallel switch
  // service). The runtime reconfigure callback is intentionally NOT wired here — it runs at the safe
  // next-message boundary, not inside the SDK call. Privileged operations use the existing ACP
  // permission broker/card; its response is the only approve/decline authority.
  const specialistApprovalGateway = new AcpSpecialistApprovalGateway({
    bridge: createAcpBackedSpecialistBridge({
      request: async (payload, session) => {
        const sessionId = session.sessionId
        const runtime = runtimeRef.current
        if (!sessionId || !runtime) {
          return { outcome: 'declined', reason: 'The approval surface is unavailable.' }
        }
        const target = payload.kind === 'switch' ? payload.targetName : undefined
        const approved = await runtime.requestAppApproval({
          sessionId,
          title:
            payload.kind === 'switch'
              ? target === null
                ? 'Switch to Main Agent?'
                : `Switch to ${target}?`
              : payload.kind === 'delete'
                ? `Delete ${payload.name}?`
                : `Rename ${payload.name} to ${payload.newName}?`,
          rawInput: { specialistApproval: payload }
        })
        return approved ? { outcome: 'approved' } : { outcome: 'declined' }
      }
    })
  })
  const agentsService = new AgentsService({
    specialistService,
    catalog: {
      listSkillCatalog: () => settingsService.listSpecialistSkillCatalog(),
      getConnectors: () => settingsService.getConnectors()
    },
    customServerAvailability: (id) => connectorRuntimeSettings.customServerAvailability(id),
    sessionBinding: sessionBindingService,
    approvalGateway: specialistApprovalGateway,
    approvalLifecycle: completionHandoffLifecycle,
    // The completion gate is the sole execution authority. The legacy pending-switch renderer
    // broadcast is intentionally not emitted: lifecycle events are a read-only projection and can
    // neither delay nor re-run the approved continuation.
    switchNotifier: createCompletionGateSwitchNotifier(completionGateCoordinator),
    deleteSpecialist: (request) => specialistPackageService.deleteSpecialist(request),
    // Catalog invalidation after a successful privileged mutation: reconnect live sessions so the
    // agent respawns (re-provisioning skills) and re-applies the updated Specialist whitelist. The
    // SpecialistService already broadcasts specialist:catalog-changed on update/delete; this refreshes the
    // RUNTIME capability resolution (mirrors the Settings IPC path's onProfilesChanged callback).
    invalidateCatalog: () => void getRuntime().requestSkillsReload(),
    persistSessionSpecialist: (sessionId, specialistId) =>
      sessionSpecialistReconfiguration.commitDesired(sessionId, specialistId)
  })
  return { agentsService }
}
