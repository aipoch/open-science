import { ipcMainHandle } from '../ipc-handler-registry'

import type {
  CreateSpecialistRequest,
  UpdateSpecialistRequest,
  SetSpecialistEnabledRequest,
  DuplicateSpecialistRequest,
  CreateSpecialistInput,
  SpecialistListItem,
  SpecialistProfileView,
  SetSessionSpecialistRequest,
  SetSessionSpecialistResponse,
  ResolveSessionSpecialistRequest,
  SessionSpecialistResolution
} from '../../shared/specialist'
import { SPECIALIST_IPC } from '../../shared/specialist'
import { ProfileService } from './service'
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

const log = createLogger('specialist:ipc')

type PersistSessionSpecialist = (
  sessionId: string,
  specialistId: string | undefined
) => Promise<void>

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

const isCandidateRequest = (request: unknown): request is SpecialistPackageInstallRequest =>
  typeof request === 'object' &&
  request !== null &&
  Object.keys(request).every((key) => ['candidateToken', 'confirmOverwrite'].includes(key)) &&
  typeof (request as { candidateToken?: unknown }).candidateToken === 'string' &&
  Boolean((request as { candidateToken: string }).candidateToken) &&
  ((request as { confirmOverwrite?: unknown }).confirmOverwrite === undefined ||
    (request as { confirmOverwrite?: unknown }).confirmOverwrite === true)

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

// Broadcasts a catalog-changed event to all renderer windows.
const broadcastCatalogChanged = (): void => {
  broadcastToRenderers(SPECIALIST_IPC.CATALOG_CHANGED, undefined)
}

// Registers all specialist IPC handlers against ipcMain.
// Call once per app lifecycle, after the ProfileService is ready.
export const registerSpecialistIpcHandlers = (
  service: ProfileService,
  sessionBindingService: SessionBindingService,
  // Persists the specialist UUID to the durable session file before exposing the binding to the
  // runtime. Required — an absent writer silently disables durability, which is the same failure
  // shape the previous TODO introduced. Tests pass a vi.fn() mock; headless callers may pass an
  // explicit no-op if session persistence is unavailable in their environment.
  persistSessionSpecialist: PersistSessionSpecialist,
  // Applies a switch to the live agent runtime. Kept as a callback so this module stays decoupled
  // from the ACP coordinator. Returns whether the runtime replaced the agent session (context reset),
  // which tells the renderer to replay conversation history into the next prompt.
  switchSessionSpecialist?: (
    sessionId: string,
    specialistId: string | undefined
  ) => Promise<{ contextReset: boolean }>,
  // Notifies the runtime that a specialist profile's capabilities changed (skills/connectors/enabled).
  // The runtime reconnects so live sessions re-provision skills and re-apply the updated whitelist on
  // the next turn. Optional so headless/tests can omit it.
  onProfilesChanged?: () => void,
  exportContributionTemplate?: () => Promise<ContributionTemplateExportResult>,
  packageImport?: PackageImportIpc
): void => {
  // Subscribe once so every mutation (create, setEnabled) triggers a broadcast.
  service.subscribe(broadcastCatalogChanged)

  ipcMainHandle(SPECIALIST_IPC.LIST, async (): Promise<SpecialistListItem[]> => {
    try {
      return await service.listForSettings()
    } catch (error) {
      log.error('specialist:list failed', { error })
      throw error
    }
  })

  ipcMainHandle(
    SPECIALIST_IPC.CREATE,
    async (_event, request: CreateSpecialistRequest): Promise<SpecialistProfileView> => {
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
        packageImport.service.dispose()
        const selected = await packageImport.selectArchive()
        if ('cancelled' in selected) return selected
        const sender = (
          event as { sender?: { once?: (name: string, listener: () => void) => void } }
        )?.sender
        sender?.once?.('destroyed', () => packageImport.service.dispose())
        return 'tooLarge' in selected
          ? packageImport.service.previewOversizedArchive(selected.compressedBytes)
          : packageImport.service.preview(selected.bytes)
      }
    )

    ipcMainHandle(
      SPECIALIST_IPC.INSTALL_PACKAGE,
      async (_event, request: unknown): Promise<SpecialistPackageInstallResult> => {
        if (!isCandidateRequest(request)) return { status: 'failed', code: 'candidate-invalid' }
        return packageImport.service.install(request)
      }
    )

    ipcMainHandle(
      SPECIALIST_IPC.CANCEL_PACKAGE,
      async (_event, request: unknown): Promise<void> => {
        if (!isCandidateRequest(request)) throw new Error('Invalid Specialist package candidate.')
        packageImport.service.cancel(request.candidateToken)
      }
    )

    ipcMainHandle(
      SPECIALIST_IPC.SAVE_PACKAGE_REPORT,
      async (_event, request: unknown): Promise<SpecialistPackageReportSaveResult> => {
        if (!isCandidateRequest(request)) return { saved: false }
        const report = packageImport.service.report(request.candidateToken)
        if (!report) return { saved: false }
        const result = await packageImport.saveReport(report)
        return { saved: result.saved }
      }
    )
  }

  ipcMainHandle(
    SPECIALIST_IPC.UPDATE,
    async (_event, request: UpdateSpecialistRequest): Promise<SpecialistProfileView> => {
      // Re-validate in main process — renderer input is untrusted.
      try {
        const updated = await service.update(request)
        // A capability edit (skills/connectors) must reach live sessions: trigger a reconnect so the
        // next turn re-provisions skills and re-applies the updated specialist whitelist.
        onProfilesChanged?.()
        return updated
      } catch (error) {
        log.error('specialist:update failed', { error })
        throw error
      }
    }
  )

  ipcMainHandle(
    SPECIALIST_IPC.SET_ENABLED,
    async (_event, request: SetSpecialistEnabledRequest): Promise<SpecialistProfileView> => {
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

  // Session switching. This handler is a named seam: the future host.agents.switch() SDK (issue 08)
  // will resolve name→UUID and call this same channel, not a parallel path.
  ipcMainHandle(
    SPECIALIST_IPC.SET_SESSION_SPECIALIST,
    async (_event, request: SetSessionSpecialistRequest): Promise<SetSessionSpecialistResponse> => {
      if (!request || typeof request.sessionId !== 'string') {
        throw new Error('SET_SESSION_SPECIALIST: sessionId must be a string.')
      }
      if (request.specialistId !== undefined && typeof request.specialistId !== 'string') {
        throw new Error('SET_SESSION_SPECIALIST: specialistId must be a string or undefined.')
      }
      // Validate the UUID exists and is enabled before accepting it.
      if (request.specialistId !== undefined) {
        const resolution = await sessionBindingService.resolve(
          request.sessionId,
          request.specialistId
        )
        if (resolution.kind === 'unavailable') {
          // Surface the reason so the renderer can show a meaningful message.
          throw new Error(resolution.reason)
        }
      }
      // Make the durable session file authoritative before exposing the new binding to runtime.
      // Otherwise an app restart between these steps would silently restore the old specialist.
      await persistSessionSpecialist(request.sessionId, request.specialistId)
      sessionBindingService.setBinding(request.sessionId, request.specialistId)

      // Apply the switch to the live agent session so the new specialist takes effect now, not
      // just on the next session create/resume. When no runtime is wired (headless/tests) this is
      // a no-op and the binding recorded above still takes effect on the next create/resume.
      let contextReset = false
      if (switchSessionSpecialist) {
        const result = await switchSessionSpecialist(request.sessionId, request.specialistId)
        contextReset = result.contextReset
      }
      return { contextReset }
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
