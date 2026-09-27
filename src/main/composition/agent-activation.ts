import { createAcpRuntime } from '../acp/runtime-composition'
import { type ApplicationModuleBuilder } from '../application-runtime'
import { type DiagnosticOperation } from '../diagnostics/operation'
import { createLogger, diagnosticErrorFields } from '../logger'
import { broadcastToRenderers } from '../renderer-broadcast'
import { UserSkillCatalogObserver } from '../skills/user-skill-catalog-observer'
import type { composeAgentRuntime } from './agent-runtime'
import type { composeBackgroundResults } from './background-results'
import type { composeSessionAuthority } from './session-authority'
import type { composeSessionFoundation } from './session-foundation'
import type { composeSettingsBootstrap } from './settings-bootstrap'
import type { composeSessionSpecialists } from './specialists'

export async function composeAgentActivation({
  settingsBootstrap,
  runtimeRef,
  backgroundResults,
  sessionFoundation,
  sessionAuthority,
  sessionSpecialists,
  agentRuntime,
  modules,
  composition
}: {
  settingsBootstrap: Awaited<ReturnType<typeof composeSettingsBootstrap>>
  runtimeRef: { current: ReturnType<typeof createAcpRuntime> | undefined }
  backgroundResults: Awaited<ReturnType<typeof composeBackgroundResults>>
  sessionFoundation: Awaited<ReturnType<typeof composeSessionFoundation>>
  sessionAuthority: Awaited<ReturnType<typeof composeSessionAuthority>>
  sessionSpecialists: ReturnType<typeof composeSessionSpecialists>
  agentRuntime: Awaited<ReturnType<typeof composeAgentRuntime>>
  modules: ApplicationModuleBuilder
  composition: DiagnosticOperation
}): Promise<void> {
  runtimeRef.current = agentRuntime.runtime
  void backgroundResults.backgroundResultDelivery
    .recover()
    .catch((error) =>
      createLogger('background-result-delivery').warn(
        'Background result delivery recovery failed',
        diagnosticErrorFields(error)
      )
    )
  composition.phase('acp-runtime')
  agentRuntime.runtime.setSessionResumeObserver(async (request) => {
    if (request.specialistBindingPending !== true) return
    await sessionSpecialists.sessionSpecialistReconfiguration.completeResume(
      request.sessionId,
      request.specialistId
    )
  })
  const userSkillCatalogObserver = await modules.add(
    {
      storageRoot: sessionAuthority.configRoot,
      catalog: { list: () => settingsBootstrap.settingsService.listUserSkills() },
      onCatalogChanged: async () => {
        await settingsBootstrap.settingsService.registeredHelperCatalog().refresh()
        broadcastToRenderers('skills:catalog-changed', undefined)
        await agentRuntime.runtime.requestSkillsReload()
      }
    } satisfies ConstructorParameters<typeof UserSkillCatalogObserver>[0],
    (options) => {
      const observer = new UserSkillCatalogObserver(options)
      return {
        name: 'user-skill-catalog-observer',
        capability: observer,
        start: () => observer.start(),
        rollback: () => observer.dispose(),
        dispose: () => observer.dispose()
      }
    }
  )
  sessionFoundation.userSkillCatalogObserverRef.current = userSkillCatalogObserver
  composition.phase('skills')
}
