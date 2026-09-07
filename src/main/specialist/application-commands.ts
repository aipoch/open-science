import { readFile, stat } from 'node:fs/promises'
import { z } from 'zod'
import {
  SPECIALIST_PACKAGE_ARCHIVE_LIMITS,
  type SpecialistPackageInstallRequest,
  type SpecialistPackageCandidatePreview,
  type SpecialistPackageInstallResult
} from '../../shared/specialist-package'
import {
  type BeginUploadTransferRequest,
  type UploadTransferRequest,
  type UploadTransferStatus
} from '../../shared/uploads'
import type { UpdateSpecialistRequest, SetSpecialistEnabledRequest } from '../../shared/specialist'
import {
  defineApplicationCommand,
  defineApplicationCommandGroup,
  type ApplicationCallerLease,
  type ApplicationInvocation,
  type ApplicationCommandRegistrar,
  type ApplicationCommand,
  type ApplicationCommandInstallation
} from '../application-command-router'
import type { UploadCommandOwner } from '../uploads/command-owner'
import type { SpecialistService } from './service'
import type { SpecialistPackageService } from './package/service'

type Dependencies = {
  service: Pick<SpecialistService, 'listForSettingsSnapshot' | 'update' | 'setEnabled'>
  packages: Pick<SpecialistPackageService, 'preview' | 'install' | 'cancel' | 'dispose'>
  uploads: UploadCommandOwner
  onProfilesChanged: () => void
}

const beginRequest = z
  .object({
    transferId: z.string().min(1),
    name: z.string().min(1),
    mimeType: z.string().optional(),
    size: z.number().int().nonnegative().max(SPECIALIST_PACKAGE_ARCHIVE_LIMITS.compressedBytes)
  })
  .strict()
const transferRequest = z.object({ transferId: z.string().min(1) }).strict()
const candidateRequest = z.object({ candidateToken: z.string().min(1) }).strict()
const enabledRequest = z.object({ id: z.string().min(1), enabled: z.boolean() }).strict()

// Web callers receive negative, process-local IDs, disjoint from Electron WebContents IDs.
// Candidate identity stays in the existing package service, never in browser-supplied data.
let nextOwnerId = -1
const LIFETIME_MS = 10 * 60 * 1000

export type SpecialistApplicationOwner = {
  list: Dependencies['service']['listForSettingsSnapshot']
  update: Dependencies['service']['update']
  setEnabled: (
    request: SetSpecialistEnabledRequest
  ) => ReturnType<Dependencies['service']['setEnabled']>
  beginUpload: (
    invocation: ApplicationInvocation<readonly [BeginUploadTransferRequest]>
  ) => Promise<UploadTransferStatus>
  previewUpload: (
    invocation: ApplicationInvocation<readonly [UploadTransferRequest]>
  ) => Promise<SpecialistPackageCandidatePreview>
  abortUpload: (
    invocation: ApplicationInvocation<readonly [UploadTransferRequest]>
  ) => Promise<void>
  install: (
    invocation: ApplicationInvocation<readonly [SpecialistPackageInstallRequest]>
  ) => Promise<SpecialistPackageInstallResult>
  cancel: (invocation: ApplicationInvocation<readonly [SpecialistPackageInstallRequest]>) => void
  dispose: () => void
}

export const createSpecialistApplicationOwner = ({
  service,
  packages,
  uploads,
  onProfilesChanged
}: Dependencies): SpecialistApplicationOwner => {
  type Caller = {
    ownerId: number
    transferId?: string
    busy: boolean
    disposed: boolean
    timer?: ReturnType<typeof setTimeout>
    release: () => void
  }
  const callers = new Map<ApplicationCallerLease, Caller>()
  const callerFor = (invocation: ApplicationInvocation<readonly unknown[]>): Caller => {
    const { callerLease } = invocation
    if (callerLease.signal.aborted || !callerLease.isCurrent())
      throw new Error('Specialist import caller expired.')
    let caller = callers.get(callerLease)
    if (!caller) {
      const current: Caller = {
        ownerId:
          invocation.callerContext.surface === 'electron'
            ? Number(invocation.callerContext.clientId)
            : nextOwnerId--,
        busy: false,
        disposed: false,
        release: () => {
          current.disposed = true
          clearTimeout(current.timer)
          callers.delete(callerLease)
          callerLease.signal.removeEventListener('abort', current.release)
          packages.dispose(current.ownerId)
          if (current.transferId && !current.busy) {
            void uploads
              .abortTransfer({ ...invocation, args: [{ transferId: current.transferId }] })
              .catch(() => undefined)
          }
        }
      }
      callers.set(callerLease, current)
      callerLease.signal.addEventListener('abort', current.release, { once: true })
      caller = current
    }
    return caller
  }
  const refreshExpiry = (caller: Caller): void => {
    clearTimeout(caller.timer)
    caller.timer = setTimeout(caller.release, LIFETIME_MS)
    caller.timer.unref?.()
  }
  const assertActive = (caller: Caller): void => {
    if (caller.disposed) throw new Error('Specialist import caller expired.')
  }

  return {
    list: () => service.listForSettingsSnapshot(),
    update: async (request: UpdateSpecialistRequest) => {
      const result = await service.update(request)
      if (
        Object.keys(request).some((key) => !['id', 'revision', 'iconKey', 'colorKey'].includes(key))
      )
        onProfilesChanged()
      return result
    },
    setEnabled: async (request: SetSpecialistEnabledRequest) => {
      const { id, enabled } = enabledRequest.parse(request)
      const result = await service.setEnabled(id, enabled)
      onProfilesChanged()
      return result
    },
    beginUpload: async (
      invocation: ApplicationInvocation<readonly [BeginUploadTransferRequest]>
    ) => {
      beginRequest.parse(invocation.args[0])
      const [request] = invocation.args
      if (request.size > SPECIALIST_PACKAGE_ARCHIVE_LIMITS.compressedBytes)
        throw new Error('Specialist ZIP exceeds the 50 MB compressed limit.')
      const caller = callerFor(invocation)
      if (caller.busy) throw new Error('Specialist package preview is in progress.')
      if (caller.transferId && caller.transferId !== request.transferId)
        throw new Error('Cancel the previous Specialist upload first.')
      caller.busy = true
      try {
        const result = await uploads.beginTransfer(invocation)
        caller.transferId = request.transferId
        assertActive(caller)
        packages.dispose(caller.ownerId)
        refreshExpiry(caller)
        return result
      } catch (error) {
        await uploads.abortTransfer(invocation).catch(() => undefined)
        throw error
      } finally {
        caller.busy = false
      }
    },
    previewUpload: async (invocation: ApplicationInvocation<readonly [UploadTransferRequest]>) => {
      const request = transferRequest.parse(invocation.args[0])
      const caller = callerFor(invocation)
      if (caller.busy || caller.transferId !== request.transferId)
        throw new Error('Specialist upload does not belong to this caller.')
      caller.busy = true
      let path: string | undefined
      try {
        // The server resolves the completed transfer. Never accept a renderer filesystem path.
        const attachment = await uploads.finishTransfer(invocation)
        path = attachment.path
        assertActive(caller)
        const info = await stat(path)
        if (info.size > SPECIALIST_PACKAGE_ARCHIVE_LIMITS.compressedBytes)
          throw new Error('Specialist ZIP exceeds the 50 MB compressed limit.')
        const preview = await packages.preview(new Uint8Array(await readFile(path)), caller.ownerId)
        if (caller.disposed) packages.dispose(caller.ownerId)
        assertActive(caller)
        refreshExpiry(caller)
        return preview
      } finally {
        caller.transferId = undefined
        caller.busy = false
        if (path) await uploads.deleteUpload({ ...invocation, args: [{ path }] })
        else await uploads.abortTransfer(invocation).catch(() => undefined)
      }
    },
    abortUpload: async (invocation: ApplicationInvocation<readonly [UploadTransferRequest]>) => {
      const request = transferRequest.parse(invocation.args[0])
      const caller = callerFor(invocation)
      if (caller.transferId !== request.transferId) return
      if (caller.busy) throw new Error('Specialist package preview is in progress.')
      await uploads.abortTransfer(invocation)
      caller.transferId = undefined
    },
    install: async (
      invocation: ApplicationInvocation<readonly [SpecialistPackageInstallRequest]>
    ) => {
      const caller = callerFor(invocation)
      return packages.install(invocation.args[0], caller.ownerId)
    },
    cancel: (invocation: ApplicationInvocation<readonly [SpecialistPackageInstallRequest]>) => {
      const request = candidateRequest.parse(invocation.args[0])
      packages.cancel(request.candidateToken, callerFor(invocation).ownerId)
    },
    dispose: () => {
      for (const caller of callers.values()) caller.release()
    }
  }
}

const command = <const Name extends string, Args extends readonly unknown[], Result>(
  name: Name
): ApplicationCommand<Name, Args, Result> => defineApplicationCommand<Name, Args, Result>(name)
const commands = [
  command<'specialist:list', readonly [], Awaited<ReturnType<SpecialistApplicationOwner['list']>>>(
    'specialist:list'
  ),
  command<
    'specialist:update',
    readonly [UpdateSpecialistRequest],
    Awaited<ReturnType<SpecialistApplicationOwner['update']>>
  >('specialist:update'),
  command<
    'specialist:set-enabled',
    readonly [SetSpecialistEnabledRequest],
    Awaited<ReturnType<SpecialistApplicationOwner['setEnabled']>>
  >('specialist:set-enabled'),
  command<
    'specialist:package-upload-begin',
    readonly [BeginUploadTransferRequest],
    Awaited<ReturnType<SpecialistApplicationOwner['beginUpload']>>
  >('specialist:package-upload-begin'),
  command<
    'specialist:package-upload-preview',
    readonly [UploadTransferRequest],
    Awaited<ReturnType<SpecialistApplicationOwner['previewUpload']>>
  >('specialist:package-upload-preview'),
  command<'specialist:package-upload-abort', readonly [UploadTransferRequest], void>(
    'specialist:package-upload-abort'
  ),
  command<
    'specialist:package-install',
    readonly [SpecialistPackageInstallRequest],
    Awaited<ReturnType<SpecialistApplicationOwner['install']>>
  >('specialist:package-install'),
  command<'specialist:package-cancel', readonly [SpecialistPackageInstallRequest], void>(
    'specialist:package-cancel'
  )
] as const

export const specialistApplicationCommandGroup = defineApplicationCommandGroup(
  'specialist',
  commands
)
export const registerSpecialistApplicationCommands = (
  registrar: ApplicationCommandRegistrar,
  owner: SpecialistApplicationOwner
): ApplicationCommandInstallation => {
  const scope = registrar.createScope()
  try {
    scope.registerGroup(specialistApplicationCommandGroup, {
      'specialist:list': () => owner.list(),
      'specialist:update': ({ args }) => owner.update(args[0]),
      'specialist:set-enabled': ({ args }) => owner.setEnabled(args[0]),
      'specialist:package-upload-begin': (invocation) => owner.beginUpload(invocation),
      'specialist:package-upload-preview': (invocation) => owner.previewUpload(invocation),
      'specialist:package-upload-abort': (invocation) => owner.abortUpload(invocation),
      'specialist:package-install': (invocation) => owner.install(invocation),
      'specialist:package-cancel': (invocation) => owner.cancel(invocation)
    })
    return scope.complete(() => owner.dispose())
  } catch (error) {
    scope.rollback()
    throw error
  }
}
