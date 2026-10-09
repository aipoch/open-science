import { runtimeMetadata } from '../runtime-metadata'
import { SPECIALIST_IPC } from '../../shared/specialist'
import { createAcpRuntime } from '../acp/runtime-composition'
import { PendingSessionSpecialistBindings } from '../agents/pending-session-specialist-bindings'
import { isCustomMcpServerRouteSafe } from '../connectors/custom-mcp'
import { ALL_CONNECTOR_IDS } from '../connectors/registry'
import { type DiagnosticOperation } from '../diagnostics/operation'
import { createLogger, diagnosticErrorFields } from '../logger'
import { broadcastToRenderers } from '../renderer-broadcast'
import type { SessionPersistenceCommands } from '../session-persistence/coordinator'
import { createDefaultSessionRepository } from '../session-persistence/ipc'
import { createSessionRuntimeLookup } from '../session-persistence/runtime-lookup'
import { SettingsRepository } from '../settings/repository'
import { SettingsService } from '../settings/service'
import { netFetchWithManualRedirect } from '../skills/net-fetch'
import { UserSkillSpecialistPackageAdapter } from '../skills/specialist-package-adapter'
import { BuiltinSpecialistRegistry } from '../specialist/builtin-registry'
import { OFFICIAL_MARKETPLACE_SOURCE } from '../specialist/marketplace/official-source'
import { MarketplaceOperationCoordinator } from '../specialist/marketplace/operation-coordinator'
import { MarketplaceRepository } from '../specialist/marketplace/repository'
import { MarketplaceService } from '../specialist/marketplace/service'
import { composeBuiltinSkillCatalog } from '../specialist/package/builtin-skill-catalog'
import { SpecialistPackageService } from '../specialist/package/service'
import { SpecialistRepository } from '../specialist/repository'
import { SpecialistService } from '../specialist/service'
import { SessionBindingService } from '../specialist/session-binding'
import {
  SessionSpecialistReconfiguration,
  type PersistedSessionSpecialistBinding
} from '../specialist/session-reconfiguration'
import { resolveConfigRoot } from '../storage-root'
import { TagService } from '../tags/service'

export async function composeSpecialistCatalog({
  specialistPackageRecovery,
  settingsService,
  composition
}: {
  specialistPackageRecovery: {
    current: (<T>(operation: () => Promise<T>) => Promise<T>) | undefined
  }
  settingsService: SettingsService
  composition: DiagnosticOperation
}): Promise<{
  specialistRepository: SpecialistRepository
  specialistService: SpecialistService
  marketplaceRepository: MarketplaceRepository
  marketplaceOperationCoordinator: MarketplaceOperationCoordinator
}> {
  // Builtins are validated once at startup from read-only repository resources. Package imports use
  // the same repository while keeping their dynamic Connector/custom-Skill catalog separate.
  const specialistRepository = new SpecialistRepository(resolveConfigRoot())
  const appVersion = runtimeMetadata().version
  const specialistSkills = await settingsService.listSpecialistSkillCatalog({ bundledOnly: true })
  composition.phase('specialist-catalog')
  const builtinRegistry = new BuiltinSpecialistRegistry({
    appVersion,
    builtinSkills: composeBuiltinSkillCatalog(appVersion, specialistSkills),
    skills: specialistSkills.map((skill) => {
      return {
        id: skill.id,
        name: skill.frameworkName,
        builtin: skill.source === 'featured',
        displayName: skill.displayName,
        source: skill.source,
        mainEnabled: skill.mainEnabled
      }
    }),
    connectorIds: ALL_CONNECTOR_IDS,
    protectedSpecialistIds: ['reviewer'],
    protectedSpecialistNames: ['Reviewer']
  })
  const specialistService = new SpecialistService(
    specialistRepository,
    builtinRegistry,
    (operation) => specialistPackageRecovery.current?.(operation) ?? operation()
  )
  const marketplaceRepository = new MarketplaceRepository(resolveConfigRoot())
  const marketplaceOperationCoordinator = new MarketplaceOperationCoordinator()
  await specialistService.ensureBuiltinCatalogReady()
  composition.phase('builtin-specialists')
  return {
    specialistRepository,
    specialistService,
    marketplaceRepository,
    marketplaceOperationCoordinator
  }
}

export async function composeSpecialistPackages({
  specialistPackageSkillAdapter,
  specialistPackageRecovery,
  settingsRepository,
  settingsService,
  requestSkillCatalogRefresh,
  specialistRepository,
  specialistService,
  marketplaceRepository,
  marketplaceOperationCoordinator,
  removeResourceTagsOrThrow,
  composition
}: {
  specialistPackageSkillAdapter: UserSkillSpecialistPackageAdapter
  specialistPackageRecovery: {
    current: (<T>(operation: () => Promise<T>) => Promise<T>) | undefined
  }
  settingsRepository: SettingsRepository
  settingsService: SettingsService
  requestSkillCatalogRefresh: () => void
  specialistRepository: SpecialistRepository
  specialistService: SpecialistService
  marketplaceRepository: MarketplaceRepository
  marketplaceOperationCoordinator: MarketplaceOperationCoordinator
  removeResourceTagsOrThrow: (
    resources: Parameters<TagService['removeResources']>[0]
  ) => Promise<void>
  composition: DiagnosticOperation
}): Promise<{
  specialistPackageService: SpecialistPackageService
  marketplaceService: MarketplaceService
}> {
  const specialistPackageService = new SpecialistPackageService({
    storageDir: resolveConfigRoot(),
    repository: specialistRepository,
    catalog: async () => {
      const appVersion = runtimeMetadata().version
      const [skills, packageSkills, connectorSettings] = await Promise.all([
        settingsService.listSpecialistSkillCatalog(),
        specialistPackageSkillAdapter.snapshot(),
        settingsService.getConnectors()
      ])
      const customMcpServers = connectorSettings?.customMcpServers ?? []
      const baseCatalog = {
        appVersion,
        builtinSkills: composeBuiltinSkillCatalog(appVersion, skills),
        skills: skills.map((skill) => {
          const packageSkill = packageSkills.find((candidate) => candidate.id === skill.id)
          return {
            id: skill.id,
            name: skill.frameworkName,
            builtin: skill.source === 'featured',
            displayName: skill.displayName,
            source: skill.source,
            mainEnabled: skill.mainEnabled,
            ...(packageSkill ?? {})
          }
        }),
        connectorIds: [
          ...ALL_CONNECTOR_IDS,
          ...customMcpServers
            .filter((server) => isCustomMcpServerRouteSafe(server, customMcpServers))
            .map((server) => server.id)
        ],
        connectorAliases: Object.fromEntries([
          ...ALL_CONNECTOR_IDS.map((id) => [id, id] as const),
          ...customMcpServers
            .filter((server) => isCustomMcpServerRouteSafe(server, customMcpServers))
            .map((server) => [server.id, server.name] as const)
        ]),
        protectedSpecialistIds: ['reviewer'],
        protectedSpecialistNames: ['Reviewer']
      }
      const builtinSpecialists = await new BuiltinSpecialistRegistry(baseCatalog).load()
      return {
        ...baseCatalog,
        protectedSpecialistIds: [
          ...baseCatalog.protectedSpecialistIds,
          ...builtinSpecialists.entries.map((entry) => entry.id)
        ],
        protectedSpecialistNames: [
          ...(baseCatalog.protectedSpecialistNames ?? []),
          ...builtinSpecialists.entries.flatMap((entry) => [
            entry.name,
            entry.displayName ?? entry.name
          ])
        ]
      }
    },
    skillPort: specialistPackageSkillAdapter,
    skillSettings: settingsRepository,
    marketplaceOperationCoordinator,
    onSpecialistDeleted: (specialistId) =>
      marketplaceRepository.removeInstallationsForSpecialist(specialistId),
    onSkillsDeleted: async (skillIds) => {
      if (skillIds.length > 0) {
        // User Skills are default-on. Remove disabled-ID tombstones so reinstalling the same
        // package does not inherit the deleted Skill's old Main Agent state.
        await settingsRepository.setSkillsEnabled([...skillIds], true)
      }
    },
    onResourcesDeleted: (specialistId, skillIds) =>
      removeResourceTagsOrThrow([
        { resourceType: 'catalog.specialist', resourceId: specialistId },
        ...skillIds.map((resourceId) => ({
          resourceType: 'catalog.skill' as const,
          resourceId
        }))
      ]),
    onCommitted: () => {
      broadcastToRenderers(SPECIALIST_IPC.CATALOG_CHANGED, undefined)
      requestSkillCatalogRefresh()
    }
  })
  specialistPackageRecovery.current = (operation) =>
    specialistPackageService.withRecoveryBarrier(operation)
  await settingsService.migrateAgentHomeSkillIdentities()
  composition.phase('agent-home-skill-identity-migration')
  const marketplaceService = new MarketplaceService({
    repository: marketplaceRepository,
    operationCoordinator: marketplaceOperationCoordinator,
    packages: specialistPackageService,
    fetch: netFetchWithManualRedirect,
    officialSource: OFFICIAL_MARKETPLACE_SOURCE,
    getInstalledSpecialists: async () =>
      (await specialistService.list()).map((profile) => ({
        id: profile.id,
        revision: profile.revision,
        ...(profile.modifiedSinceImport === undefined
          ? {}
          : { modifiedSinceImport: profile.modifiedSinceImport }),
        ...(profile.origin ? { origin: profile.origin } : {}),
        ...(profile.importBaseline?.archiveDigest
          ? { archiveDigest: profile.importBaseline.archiveDigest }
          : {})
      })),
    markMarketplaceManaged: async (id, expectedRevision) => {
      await specialistService.markMarketplaceManaged(id, expectedRevision)
    },
    setSkillsMainEnabled: async (ids, enabled) => {
      await settingsRepository.setSkillsEnabled([...new Set(ids)], enabled)
      // Startup recovery runs before the ACP runtime exists, so its initial catalog reads the
      // restored settings directly. Later recovery must refresh the already-live catalog.
      requestSkillCatalogRefresh()
    }
  })
  try {
    await marketplaceService.recover()
  } catch (error) {
    createLogger('specialist:marketplace').error(
      'Marketplace install recovery incomplete; Marketplace remains fail-closed',
      diagnosticErrorFields(error)
    )
  }
  composition.phase('marketplace-recover')
  settingsService.setSkillDeletionGuard((request) =>
    specialistPackageService.assertSkillDeletionAllowed(
      request.id,
      request.source,
      request.directoryName
    )
  )
  return { specialistPackageService, marketplaceService }
}

export function composeSessionSpecialists({
  runtimeRef,
  sessionRepository,
  sessionPersistenceCoordinator,
  pendingSpecialistBindings,
  specialistService
}: {
  runtimeRef: { current: ReturnType<typeof createAcpRuntime> | undefined }
  sessionRepository: ReturnType<typeof createDefaultSessionRepository>
  sessionPersistenceCoordinator: Pick<
    SessionPersistenceCommands,
    'saveSessionSpecialistBinding' | 'sessionProjectId'
  >
  pendingSpecialistBindings: PendingSessionSpecialistBindings
  specialistService: SpecialistService
}): {
  sessionBindingService: SessionBindingService
  findRuntimeSessions: ReturnType<typeof createSessionRuntimeLookup>
  sessionSpecialistReconfiguration: SessionSpecialistReconfiguration
} {
  // Per-session specialist binding store. Shared between the SET_SESSION_SPECIALIST barrier
  // (validate + record) and the runtime switch so a hot-switch lands on the same source of truth.
  const sessionBindingService = new SessionBindingService(specialistService)
  const specialistPersistLog = createLogger('specialist:persist')
  const findRuntimeSessions = createSessionRuntimeLookup({
    repository: sessionRepository,
    coordinator: sessionPersistenceCoordinator
  })
  const loadSessionSpecialistBinding = async (
    sessionId: string
  ): Promise<PersistedSessionSpecialistBinding | undefined> => {
    const session = (await findRuntimeSessions(sessionId))[0]
    return session
      ? {
          specialistId: session.specialistId,
          specialistBindingPending: session.specialistBindingPending
        }
      : undefined
  }
  const persistSessionSpecialistBinding = async (
    sessionId: string,
    specialistId: string | undefined,
    pending: boolean
  ): Promise<void> => {
    const session = (await findRuntimeSessions(sessionId))[0]
    if (!session) {
      // Fresh unsent drafts are not durable yet. Carry both the desired ID and pending marker into
      // their first save; the marker can also be cleared here when runtime applies before that save.
      pendingSpecialistBindings.stash(sessionId, specialistId, pending)
      specialistPersistLog.debug('session not yet durable; stashed Specialist binding state', {
        sessionId,
        specialistId,
        pending
      })
      return
    }
    pendingSpecialistBindings.take(sessionId)
    await sessionPersistenceCoordinator.saveSessionSpecialistBinding(session, specialistId, pending)
  }
  const sessionSpecialistReconfiguration = new SessionSpecialistReconfiguration({
    sessionBinding: sessionBindingService,
    loadBinding: loadSessionSpecialistBinding,
    persistBinding: persistSessionSpecialistBinding,
    discardPendingBinding: (sessionId) => {
      pendingSpecialistBindings.take(sessionId)
    },
    applyRuntime: async (sessionId, specialistId) => {
      const runtime = runtimeRef.current
      if (!runtime) throw new Error('Agent runtime is not initialized.')
      return runtime.switchSpecialist(sessionId, specialistId)
    }
  })
  return { sessionBindingService, findRuntimeSessions, sessionSpecialistReconfiguration }
}
