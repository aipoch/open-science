import { readFile, stat, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import type { ApplicationInvocation } from '../application-command-router'
import {
  defineApplicationCommand,
  defineApplicationCommandGroup
} from '../application-command-router'
import { requireDesktopCaller } from '../caller-context'
import { desktopFileInteraction } from '../desktop-interaction'
import { runtimeMetadata } from '../runtime-metadata'
import { publishUserFile } from '../user-file-publisher'
import type { NativeTranslator } from '../locale/main-process-messages'
import type { SpecialistService } from './service'
import type { SpecialistPackageService } from './package/service'
import type { MarketplaceService } from './marketplace/service'
import type { SessionBindingService } from './session-binding'
import {
  createContributionTemplateExporter,
  resolveContributionTemplateReadmePath
} from './package/contribution-template'
import {
  selectSpecialistArchive,
  saveSpecialistPackageReport,
  saveSpecialistExport
} from './package/electron-adapter'
import type {
  CreateSpecialistRequest,
  DuplicateSpecialistRequest,
  ResolveSessionSpecialistRequest
} from '../../shared/specialist'
import type {
  SpecialistExportRequest,
  SpecialistDeleteRequest
} from '../../shared/specialist-package'
import type {
  InspectGitHubMarketplaceSourceRequest,
  AddMarketplaceSourceRequest,
  RemoveMarketplaceSourceRequest,
  PrepareMarketplaceInstallRequest,
  MarketplaceInstallRequest,
  MarketplaceDownloadProgress
} from '../../shared/specialist-marketplace'

type Invocation = ApplicationInvocation<readonly unknown[]>
export type SpecialistDesktopDependencies = {
  service: Pick<SpecialistService, 'create' | 'duplicate'>
  packages: Pick<
    SpecialistPackageService,
    | 'preview'
    | 'previewOversizedArchive'
    | 'dispose'
    | 'report'
    | 'previewExport'
    | 'export'
    | 'previewSpecialistDelete'
    | 'deleteSpecialist'
  >
  marketplace: Pick<
    MarketplaceService,
    | 'inspectGitHubSource'
    | 'addSource'
    | 'removeSource'
    | 'prepareInstall'
    | 'install'
    | 'cancel'
    | 'dispose'
  >
  bindings: Pick<SessionBindingService, 'resolve'>
  translate: NativeTranslator
  reportProgress: (clientId: string, progress: MarketplaceDownloadProgress) => void
}
const candidate = z.object({ candidateToken: z.string().min(1) }).strict()
const exportPreview = z
  .object({ specialistId: z.string().min(1), includedSkillIds: z.array(z.string()).optional() })
  .strict()
const exportRequest = z
  .object({
    specialistId: z.string(),
    expectedRevision: z.number().int(),
    includedSkillIds: z.array(z.string())
  })
  .strict()
const deletePreview = z.object({ id: z.string() }).strict()
const assertCaller = (invocation: Invocation): void => {
  requireDesktopCaller(invocation.callerContext)
  invocation.callerLease.signal.throwIfAborted()
  if (!invocation.callerLease.isCurrent())
    throw new Error('Specialist caller is no longer current.')
}

// Caller identity is allocated by the existing application owner, shared with Web package imports.
// These workflows do not own candidates or stores; they only combine the existing owners and files.
// The command descriptors below derive their argument/result types from this handler map.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createSpecialistDesktopCommands(
  deps: SpecialistDesktopDependencies,
  callerId: (invocation: Invocation) => number
) {
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  const nativeFiles = (invocation: Invocation) => {
    const files = desktopFileInteraction()
    const publish: typeof publishUserFile = (path, write, options) => {
      assertCaller(invocation)
      return publishUserFile(
        path,
        async (temporary) => {
          await write(temporary)
          assertCaller(invocation)
        },
        {
          ...options,
          validateDestination: async () => {
            await options?.validateDestination?.()
            assertCaller(invocation)
          }
        }
      )
    }
    return {
      showSaveDialog: (options: Parameters<typeof files.chooseSavePath>[0]) =>
        files.chooseSavePath(options, invocation.callerContext.clientId),
      showOpenDialog: (options: Parameters<typeof files.chooseFiles>[0]) =>
        files.chooseFiles(options, invocation.callerContext.clientId),
      readFile: async (path: string) => {
        assertCaller(invocation)
        return readFile(path)
      },
      getFileSize: async (path: string) => {
        assertCaller(invocation)
        return (await stat(path)).size
      },
      writeFile: async (path: string, value: string | Uint8Array) => {
        assertCaller(invocation)
        await writeFile(path, value)
      },
      publishUserFile: publish
    }
  }
  const owned = async <T>(invocation: Invocation, work: (id: number) => Promise<T>): Promise<T> => {
    assertCaller(invocation)
    const id = callerId(invocation)
    try {
      const result = await work(id)
      assertCaller(invocation)
      return result
    } finally {
      if (!invocation.callerLease.isCurrent() || invocation.callerLease.signal.aborted) {
        deps.marketplace.dispose(id)
        deps.packages.dispose(id)
      }
    }
  }
  return {
    'specialist:create': (invocation: ApplicationInvocation<readonly [CreateSpecialistRequest]>) =>
      owned(invocation, () => deps.service.create(invocation.args[0])),
    'specialist:duplicate': (
      invocation: ApplicationInvocation<readonly [DuplicateSpecialistRequest]>
    ) => owned(invocation, () => deps.service.duplicate(invocation.args[0].id)),
    'specialist:delete': (invocation: ApplicationInvocation<readonly [SpecialistDeleteRequest]>) =>
      owned(invocation, () => deps.packages.deleteSpecialist(invocation.args[0])),
    'specialist:delete-preview': (invocation: ApplicationInvocation<readonly [{ id: string }]>) =>
      owned(invocation, () =>
        deps.packages.previewSpecialistDelete(deletePreview.parse(invocation.args[0]))
      ),
    'specialist:export-preview': (
      invocation: ApplicationInvocation<
        readonly [{ specialistId: string; includedSkillIds?: readonly string[] }]
      >
    ) =>
      owned(invocation, () => {
        const request = exportPreview.parse(invocation.args[0])
        return deps.packages.previewExport(request.specialistId, request.includedSkillIds)
      }),
    'specialist:export-save': (
      invocation: ApplicationInvocation<readonly [SpecialistExportRequest]>
    ) =>
      owned(invocation, async () => {
        const archive = await deps.packages.export(exportRequest.parse(invocation.args[0]))
        assertCaller(invocation)
        return saveSpecialistExport(nativeFiles(invocation), archive, deps.translate)
      }),
    'specialist:package-select': (invocation: ApplicationInvocation<readonly []>) =>
      owned(invocation, async (id) => {
        if (invocation.args.length)
          throw new Error('Package selection does not accept renderer data.')
        deps.packages.dispose(id)
        const selected = await selectSpecialistArchive(nativeFiles(invocation), deps.translate)
        assertCaller(invocation)
        if ('cancelled' in selected) return selected
        const preview =
          'tooLarge' in selected
            ? await deps.packages.previewOversizedArchive(selected.compressedBytes, id)
            : await deps.packages.preview(selected.bytes, id)
        if (!invocation.callerLease.isCurrent() || invocation.callerLease.signal.aborted)
          deps.packages.dispose(id)
        return preview
      }),
    'specialist:package-report-save': (
      invocation: ApplicationInvocation<readonly [{ candidateToken: string }]>
    ) =>
      owned(invocation, async (id) => {
        const request = candidate.safeParse(invocation.args[0])
        if (!request.success) return { saved: false }
        const report = deps.packages.report(request.data.candidateToken, id)
        return report
          ? saveSpecialistPackageReport(nativeFiles(invocation), report, deps.translate)
          : { saved: false }
      }),
    'specialist:export-contribution-template': (invocation: ApplicationInvocation<readonly []>) =>
      owned(invocation, () =>
        createContributionTemplateExporter({
          ...nativeFiles(invocation),
          appVersion: runtimeMetadata().version,
          translate: deps.translate,
          readReadme: () =>
            readFile(
              resolveContributionTemplateReadmePath(runtimeMetadata().applicationPath),
              'utf8'
            )
        })()
      ),
    'specialist:resolve-session-specialist': (
      invocation: ApplicationInvocation<readonly [ResolveSessionSpecialistRequest]>
    ) =>
      owned(invocation, () =>
        deps.bindings.resolve(
          z.object({ sessionId: z.string() }).parse(invocation.args[0]).sessionId
        )
      ),
    'specialist:marketplace-source-inspect-github': (
      invocation: ApplicationInvocation<readonly [InspectGitHubMarketplaceSourceRequest]>
    ) => owned(invocation, (id) => deps.marketplace.inspectGitHubSource(invocation.args[0], id)),
    'specialist:marketplace-source-add': (
      invocation: ApplicationInvocation<readonly [AddMarketplaceSourceRequest]>
    ) => owned(invocation, (id) => deps.marketplace.addSource(invocation.args[0], id)),
    'specialist:marketplace-source-remove': (
      invocation: ApplicationInvocation<readonly [RemoveMarketplaceSourceRequest]>
    ) => owned(invocation, () => deps.marketplace.removeSource(invocation.args[0])),
    'specialist:marketplace-install-prepare': (
      invocation: ApplicationInvocation<readonly [PrepareMarketplaceInstallRequest]>
    ) =>
      owned(invocation, (id) =>
        deps.marketplace.prepareInstall(invocation.args[0], id, (progress) => {
          if (invocation.callerLease.isCurrent() && !invocation.callerLease.signal.aborted)
            deps.reportProgress(invocation.callerContext.clientId, progress)
        })
      ),
    'specialist:marketplace-install': (
      invocation: ApplicationInvocation<readonly [MarketplaceInstallRequest]>
    ) => owned(invocation, (id) => deps.marketplace.install(invocation.args[0], id)),
    'specialist:marketplace-candidate-cancel': async (
      invocation: ApplicationInvocation<readonly [{ candidateToken: string }]>
    ) => {
      assertCaller(invocation)
      deps.marketplace.cancel(
        candidate.parse(invocation.args[0]).candidateToken,
        callerId(invocation)
      )
    }
  }
}
export type SpecialistDesktopCommands = ReturnType<typeof createSpecialistDesktopCommands>

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const command = <Name extends keyof SpecialistDesktopCommands>(name: Name) =>
  defineApplicationCommand<
    Name,
    Parameters<SpecialistDesktopCommands[Name]>[0]['args'],
    Awaited<ReturnType<SpecialistDesktopCommands[Name]>>
  >(name)
export const specialistDesktopCommandGroup = defineApplicationCommandGroup('specialist-desktop', [
  command('specialist:create'),
  command('specialist:duplicate'),
  command('specialist:delete'),
  command('specialist:delete-preview'),
  command('specialist:export-preview'),
  command('specialist:export-save'),
  command('specialist:package-select'),
  command('specialist:package-report-save'),
  command('specialist:export-contribution-template'),
  command('specialist:resolve-session-specialist'),
  command('specialist:marketplace-source-inspect-github'),
  command('specialist:marketplace-source-add'),
  command('specialist:marketplace-source-remove'),
  command('specialist:marketplace-install-prepare'),
  command('specialist:marketplace-install'),
  command('specialist:marketplace-candidate-cancel')
] as const)
