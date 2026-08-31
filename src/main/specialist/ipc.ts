import { ipcMainHandle } from '../ipc-handler-registry'

import type {
  CreateSpecialistRequest,
  UpdateSpecialistRequest,
  SetSpecialistEnabledRequest,
  DuplicateSpecialistRequest,
  CreateSpecialistInput,
  SpecialistCatalogSnapshot,
  SpecialistView,
  SetSessionSpecialistRequest,
  SetSessionSpecialistResponse,
  ResolveSessionSpecialistRequest,
  SessionSpecialistResolution
} from '../../shared/specialist'
import { SPECIALIST_IPC } from '../../shared/specialist'
import { SpecialistService } from './service'
import { SessionBindingService } from './session-binding'
import { createLogger } from '../logger'
import { broadcastToRenderers } from '../renderer-broadcast'
import type {
  ContributionTemplateExportResult,
  SpecialistPackageCandidatePreview,
  SpecialistPackageInstallRequest,
  SpecialistPackageInstallResult,
  SpecialistPackageReport,
  SpecialistPackageReportSaveResult,
  SpecialistExportPreview,
  SpecialistExportRequest,
  SpecialistExportSaveResult,
  SpecialistDeleteRequest,
  SpecialistDeleteResult,
  SpecialistDeletePreview
} from '../../shared/specialist-package'
import type { SpecialistPackageService } from './package/service'
import type { SessionSpecialistReconfiguration } from './session-reconfiguration'
import {
  SPECIALIST_MARKETPLACE_IPC,
  type AddMarketplaceSourceRequest,
  type GetMarketplaceReleaseRequest,
  type InspectGitHubMarketplaceSourceRequest,
  type MarketplaceDownloadProgress,
  type MarketplaceInstallRequest,
  type PrepareMarketplaceInstallRequest,
  type RemoveMarketplaceSourceRequest
} from '../../shared/specialist-marketplace'
import type { MarketplaceService } from './marketplace/service'

const log = createLogger('specialist:ipc')

const APPEARANCE_UPDATE_KEYS = new Set<keyof UpdateSpecialistRequest>([
  'id',
  'revision',
  'iconKey',
  'colorKey'
])

const isAppearanceOnlyUpdate = (request: UpdateSpecialistRequest): boolean =>
  (request.iconKey !== undefined || request.colorKey !== undefined) &&
  (Object.keys(request) as Array<keyof UpdateSpecialistRequest>).every((key) =>
    APPEARANCE_UPDATE_KEYS.has(key)
  )

type PackageImportIpc = {
  service: Pick<
    SpecialistPackageService,
    | 'preview'
    | 'previewOversizedArchive'
    | 'install'
    | 'cancel'
    | 'dispose'
    | 'report'
    | 'previewExport'
    | 'export'
    | 'previewSpecialistDelete'
    | 'deleteSpecialist'
  >
  selectArchive: () => Promise<
    { cancelled: true } | { bytes: Uint8Array } | { tooLarge: true; compressedBytes: number }
  >
  saveReport: (report: SpecialistPackageReport) => Promise<SpecialistPackageReportSaveResult>
  saveExport: (archive: {
    fileName: string
    archiveBytes: Uint8Array
  }) => Promise<SpecialistExportSaveResult>
}

type MarketplaceIpc = Pick<
  MarketplaceService,
  | 'list'
  | 'installedSpecialistProvenance'
  | 'inspectGitHubSource'
  | 'addSource'
  | 'removeSource'
  | 'getRelease'
  | 'prepareInstall'
  | 'install'
  | 'cancel'
  | 'dispose'
>

const isCandidateRequest = (request: unknown): request is SpecialistPackageInstallRequest =>
  typeof request === 'object' &&
  request !== null &&
  Object.keys(request).length === 1 &&
  typeof (request as { candidateToken?: unknown }).candidateToken === 'string' &&
  Boolean((request as { candidateToken: string }).candidateToken)

// The list endpoint accepts no renderer data beyond one optional boolean: a user-initiated
// refresh sets forceRefresh to bypass the cached-root TTL. Anything else is rejected as before.
const parseListMarketplaceRequest = (request: unknown): { forceRefresh?: boolean } | undefined => {
  if (request === undefined) return undefined
  if (
    typeof request !== 'object' ||
    request === null ||
    Object.keys(request).length !== 1 ||
    typeof (request as { forceRefresh?: unknown }).forceRefresh !== 'boolean'
  ) {
    throw new Error('Marketplace list does not accept renderer data.')
  }
  return { forceRefresh: (request as { forceRefresh: boolean }).forceRefresh }
}

const isInstallCandidateRequest = (
  request: unknown
): request is SpecialistPackageInstallRequest => {
  if (
    typeof request !== 'object' ||
    request === null ||
    Object.keys(request).some(
      (key) => !['candidateToken', 'confirmOverwrite', 'skillConflictResolutions'].includes(key)
    ) ||
    typeof (request as { candidateToken?: unknown }).candidateToken !== 'string' ||
    !(request as { candidateToken: string }).candidateToken ||
    ((request as { confirmOverwrite?: unknown }).confirmOverwrite !== undefined &&
      (request as { confirmOverwrite?: unknown }).confirmOverwrite !== true)
  ) {
    return false
  }
  const resolutions = (request as { skillConflictResolutions?: unknown }).skillConflictResolutions
  return (
    resolutions === undefined ||
    (Array.isArray(resolutions) &&
      resolutions.every(
        (resolution) =>
          typeof resolution === 'object' &&
          resolution !== null &&
          Object.keys(resolution).length === 2 &&
          typeof (resolution as { skillId?: unknown }).skillId === 'string' &&
          Boolean((resolution as { skillId: string }).skillId) &&
          ['use-installed', 'use-incoming'].includes(
            (resolution as { resolution?: string }).resolution ?? ''
          )
      ))
  )
}

const isExportPreviewRequest = (request: unknown): request is { specialistId: string } =>
  typeof request === 'object' &&
  request !== null &&
  Object.keys(request).length === 1 &&
  typeof (request as { specialistId?: unknown }).specialistId === 'string' &&
  Boolean((request as { specialistId: string }).specialistId)

const isExportRequest = (request: unknown): request is SpecialistExportRequest =>
  typeof request === 'object' &&
  request !== null &&
  Object.keys(request).every((key) =>
    ['specialistId', 'expectedRevision', 'includedSkillIds'].includes(key)
  ) &&
  Object.keys(request).length === 3 &&
  typeof (request as { specialistId?: unknown }).specialistId === 'string' &&
  Number.isInteger((request as { expectedRevision?: unknown }).expectedRevision) &&
  Array.isArray((request as { includedSkillIds?: unknown }).includedSkillIds) &&
  (request as { includedSkillIds: unknown[] }).includedSkillIds.every(
    (id) => typeof id === 'string'
  )

const rendererOwnerId = (event: unknown): number | undefined => {
  const id = (event as { sender?: { id?: unknown } } | undefined)?.sender?.id
  return typeof id === 'number' ? id : undefined
}

const sendMarketplaceDownloadProgress = (
  event: unknown,
  progress: MarketplaceDownloadProgress
): void => {
  const sender = (
    event as {
      sender?: {
        isDestroyed?: () => boolean
        send: (channel: string, payload: MarketplaceDownloadProgress) => void
      }
    }
  ).sender
  if (!sender || sender.isDestroyed?.()) return
  sender.send(SPECIALIST_MARKETPLACE_IPC.DOWNLOAD_PROGRESS, progress)
}

const bindMarketplaceOwnerLifetime = (
  event: unknown,
  marketplace: MarketplaceIpc,
  boundSenders: WeakSet<object>
): { ownerId: number | undefined; assertActive: () => void } => {
  const ownerId = rendererOwnerId(event)
  const sender = (
    event as {
      sender?: {
        isDestroyed?: () => boolean
        once?: (name: string, listener: () => void) => void
      }
    }
  )?.sender
  const dispose = (): void => marketplace.dispose(ownerId)
  if (sender?.isDestroyed?.()) dispose()
  else if (sender?.once && !boundSenders.has(sender)) {
    boundSenders.add(sender)
    sender.once('destroyed', dispose)
  }
  return {
    ownerId,
    assertActive: () => {
      if (!sender?.isDestroyed?.()) return
      dispose()
      throw new Error('Marketplace candidate owner is no longer available.')
    }
  }
}

// Broadcasts a catalog-changed event to all renderer windows.
const broadcastCatalogChanged = (): void => {
  broadcastToRenderers(SPECIALIST_IPC.CATALOG_CHANGED, undefined)
}

// Registers all specialist IPC handlers against ipcMain.
// Call once per app lifecycle, after the SpecialistService is ready.
export const registerSpecialistIpcHandlers = (
  service: SpecialistService,
  sessionBindingService: SessionBindingService,
  // One owner commits desired+pending, applies runtime, then clears pending. Keeping this transaction
  // behind one port prevents IPC from independently advancing disk, Main memory, and runtime.
  sessionReconfiguration: Pick<SessionSpecialistReconfiguration, 'requestSwitch'>,
  // Notifies the runtime that a Specialist's capabilities changed (skills/connectors/enabled).
  // The runtime reconnects so live sessions re-provision skills and re-apply the updated whitelist on
  // the next turn. Optional so headless/tests can omit it.
  onProfilesChanged?: () => void,
  exportContributionTemplate?: () => Promise<ContributionTemplateExportResult>,
  packageImport?: PackageImportIpc,
  marketplace?: MarketplaceIpc
): void => {
  // Subscribe once so every mutation (create, setEnabled) triggers a broadcast.
  service.subscribe(broadcastCatalogChanged)

  ipcMainHandle(SPECIALIST_IPC.LIST, async (): Promise<SpecialistCatalogSnapshot> => {
    try {
      const snapshot = await service.listForSettingsSnapshot()
      if (!marketplace) return snapshot
      try {
        const installedSpecialists = snapshot.items.flatMap((item) =>
          item.kind === 'custom'
            ? [
                {
                  id: item.id,
                  revision: item.revision,
                  ...(item.origin ? { origin: item.origin } : {}),
                  ...(item.importBaseline?.archiveDigest
                    ? { archiveDigest: item.importBaseline.archiveDigest }
                    : {})
                }
              ]
            : []
        )
        const marketplaceProvenance =
          await marketplace.installedSpecialistProvenance(installedSpecialists)
        if (marketplaceProvenance.size === 0) return snapshot
        return {
          ...snapshot,
          items: snapshot.items.map((item) => {
            if (item.kind !== 'custom') return item
            const provenance = marketplaceProvenance.get(item.id)
            return provenance ? { ...item, marketplaceProvenance: provenance } : item
          })
        }
      } catch (error) {
        // Marketplace metadata is optional enrichment. A damaged or unavailable provenance file
        // must not hide the otherwise healthy Specialist catalog.
        log.error('specialist:list Marketplace provenance failed', { error })
        return snapshot
      }
    } catch (error) {
      log.error('specialist:list failed', { error })
      throw error
    }
  })

  ipcMainHandle(
    SPECIALIST_IPC.CREATE,
    async (_event, request: CreateSpecialistRequest): Promise<SpecialistView> => {
      // Re-validate in main process — renderer input is untrusted.
      try {
        return await service.create(request)
      } catch (error) {
        log.error('specialist:create failed', { error })
        throw error
      }
    }
  )

  if (packageImport) {
    ipcMainHandle(
      SPECIALIST_IPC.PREVIEW_EXPORT,
      async (_event, request: unknown): Promise<SpecialistExportPreview> => {
        if (!isExportPreviewRequest(request)) throw new Error('Invalid Specialist export preview.')
        return packageImport.service.previewExport(request.specialistId)
      }
    )

    ipcMainHandle(
      SPECIALIST_IPC.EXPORT,
      async (_event, request: unknown): Promise<SpecialistExportSaveResult> => {
        if (!isExportRequest(request)) throw new Error('Invalid Specialist export request.')
        const archive = await packageImport.service.export(request)
        return packageImport.saveExport(archive)
      }
    )

    ipcMainHandle(
      SPECIALIST_IPC.SELECT_PACKAGE,
      async (
        event,
        request: unknown
      ): Promise<{ cancelled: true } | SpecialistPackageCandidatePreview> => {
        if (request !== undefined)
          throw new Error('Package selection does not accept renderer data.')
        const ownerId = rendererOwnerId(event)
        packageImport.service.dispose(ownerId)
        const selected = await packageImport.selectArchive()
        if ('cancelled' in selected) return selected
        const sender = (
          event as { sender?: { once?: (name: string, listener: () => void) => void } }
        )?.sender
        sender?.once?.('destroyed', () => packageImport.service.dispose(ownerId))
        return 'tooLarge' in selected
          ? packageImport.service.previewOversizedArchive(selected.compressedBytes, ownerId)
          : packageImport.service.preview(selected.bytes, ownerId)
      }
    )

    ipcMainHandle(
      SPECIALIST_IPC.INSTALL_PACKAGE,
      async (event, request: unknown): Promise<SpecialistPackageInstallResult> => {
        if (!isInstallCandidateRequest(request))
          return { status: 'failed', code: 'candidate-invalid' }
        return packageImport.service.install(request, rendererOwnerId(event))
      }
    )

    ipcMainHandle(SPECIALIST_IPC.CANCEL_PACKAGE, async (event, request: unknown): Promise<void> => {
      if (!isCandidateRequest(request)) throw new Error('Invalid Specialist package candidate.')
      packageImport.service.cancel(request.candidateToken, rendererOwnerId(event))
    })

    ipcMainHandle(
      SPECIALIST_IPC.SAVE_PACKAGE_REPORT,
      async (event, request: unknown): Promise<SpecialistPackageReportSaveResult> => {
        if (!isCandidateRequest(request)) return { saved: false }
        const report = packageImport.service.report(request.candidateToken, rendererOwnerId(event))
        if (!report) return { saved: false }
        const result = await packageImport.saveReport(report)
        return { saved: result.saved }
      }
    )
  }

  if (marketplace) {
    // One renderer owns all of its Marketplace candidates, so one listener can release them all.
    // Binding per request would retain every completed request until the renderer is destroyed.
    const boundMarketplaceSenders = new WeakSet<object>()
    ipcMainHandle(SPECIALIST_MARKETPLACE_IPC.LIST, async (_event, request: unknown) => {
      return marketplace.list(parseListMarketplaceRequest(request))
    })
    ipcMainHandle(
      SPECIALIST_MARKETPLACE_IPC.INSPECT_GITHUB_SOURCE,
      async (event, request: InspectGitHubMarketplaceSourceRequest) => {
        const lifetime = bindMarketplaceOwnerLifetime(event, marketplace, boundMarketplaceSenders)
        const candidate = await marketplace.inspectGitHubSource(request, lifetime.ownerId)
        lifetime.assertActive()
        return candidate
      }
    )
    ipcMainHandle(
      SPECIALIST_MARKETPLACE_IPC.ADD_SOURCE,
      async (event, request: AddMarketplaceSourceRequest) =>
        marketplace.addSource(request, rendererOwnerId(event))
    )
    ipcMainHandle(
      SPECIALIST_MARKETPLACE_IPC.REMOVE_SOURCE,
      async (_event, request: RemoveMarketplaceSourceRequest) => marketplace.removeSource(request)
    )
    ipcMainHandle(
      SPECIALIST_MARKETPLACE_IPC.GET_RELEASE,
      async (_event, request: GetMarketplaceReleaseRequest) => marketplace.getRelease(request)
    )
    ipcMainHandle(
      SPECIALIST_MARKETPLACE_IPC.PREPARE_INSTALL,
      async (event, request: PrepareMarketplaceInstallRequest) => {
        const lifetime = bindMarketplaceOwnerLifetime(event, marketplace, boundMarketplaceSenders)
        const preview = await marketplace.prepareInstall(
          request,
          lifetime.ownerId,
          (progress: MarketplaceDownloadProgress) =>
            sendMarketplaceDownloadProgress(event, progress)
        )
        lifetime.assertActive()
        return preview
      }
    )
    ipcMainHandle(
      SPECIALIST_MARKETPLACE_IPC.CANCEL_CANDIDATE,
      async (event, request: unknown): Promise<void> => {
        if (!isCandidateRequest(request)) throw new Error('Invalid Marketplace candidate.')
        marketplace.cancel(request.candidateToken, rendererOwnerId(event))
      }
    )
    ipcMainHandle(
      SPECIALIST_MARKETPLACE_IPC.INSTALL,
      async (event, request: MarketplaceInstallRequest) =>
        marketplace.install(request, rendererOwnerId(event))
    )
  }

  ipcMainHandle(
    SPECIALIST_IPC.UPDATE,
    async (_event, request: UpdateSpecialistRequest): Promise<SpecialistView> => {
      // Re-validate in main process — renderer input is untrusted.
      try {
        const updated = await service.update(request)
        // A capability edit (skills/connectors) must reach live sessions: trigger a reconnect so the
        // next turn re-provisions skills and re-applies the updated specialist whitelist.
        if (!isAppearanceOnlyUpdate(request)) onProfilesChanged?.()
        return updated
      } catch (error) {
        log.error('specialist:update failed', { error })
        throw error
      }
    }
  )

  ipcMainHandle(
    SPECIALIST_IPC.SET_ENABLED,
    async (_event, request: SetSpecialistEnabledRequest): Promise<SpecialistView> => {
      try {
        const updated = await service.setEnabled(request.id, request.enabled)
        onProfilesChanged?.()
        return updated
      } catch (error) {
        log.error('specialist:set-enabled failed', { error })
        throw error
      }
    }
  )

  ipcMainHandle(
    SPECIALIST_IPC.PREVIEW_DELETE,
    async (_event, request: unknown): Promise<SpecialistDeletePreview> => {
      if (
        !packageImport ||
        !request ||
        typeof request !== 'object' ||
        Object.keys(request).some((key) => key !== 'id') ||
        typeof (request as { id?: unknown }).id !== 'string'
      ) {
        throw new Error('Invalid Specialist delete preview request.')
      }
      return packageImport.service.previewSpecialistDelete(request as { id: string })
    }
  )

  ipcMainHandle(
    SPECIALIST_IPC.DELETE,
    async (_event, request: SpecialistDeleteRequest): Promise<SpecialistDeleteResult> => {
      try {
        if (packageImport) return await packageImport.service.deleteSpecialist(request)
        await service.delete(request.id, request.expectedRevision)
        onProfilesChanged?.()
        return { status: 'deleted' }
      } catch (error) {
        log.error('specialist:delete failed', { error })
        throw error
      }
    }
  )

  ipcMainHandle(
    SPECIALIST_IPC.DUPLICATE,
    async (_event, request: DuplicateSpecialistRequest): Promise<CreateSpecialistInput> =>
      service.duplicate(request.id)
  )

  if (exportContributionTemplate) {
    ipcMainHandle(SPECIALIST_IPC.EXPORT_CONTRIBUTION_TEMPLATE, exportContributionTemplate)
  }

  // Renderer-initiated session switching. host.agents.switch reuses the same SessionBindingService
  // and persistence seam through SwitchOperation instead of routing through renderer IPC.
  ipcMainHandle(
    SPECIALIST_IPC.SET_SESSION_SPECIALIST,
    async (_event, request: SetSessionSpecialistRequest): Promise<SetSessionSpecialistResponse> => {
      if (!request || typeof request.sessionId !== 'string') {
        throw new Error('SET_SESSION_SPECIALIST: sessionId must be a string.')
      }
      if (request.specialistId !== undefined && typeof request.specialistId !== 'string') {
        throw new Error('SET_SESSION_SPECIALIST: specialistId must be a string or undefined.')
      }
      return sessionReconfiguration.requestSwitch(request.sessionId, request.specialistId)
    }
  )

  ipcMainHandle(
    SPECIALIST_IPC.RESOLVE_SESSION_SPECIALIST,
    async (
      _event,
      request: ResolveSessionSpecialistRequest
    ): Promise<SessionSpecialistResolution> => {
      if (!request || typeof request.sessionId !== 'string') {
        throw new Error('RESOLVE_SESSION_SPECIALIST: sessionId must be a string.')
      }
      return sessionBindingService.resolve(request.sessionId)
    }
  )
}
