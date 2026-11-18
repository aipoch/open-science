import { acquireDataRootWriter } from '../storage/migration-state'
import { ImageResultStore } from '../image-model/result-store'
import { resolveDataRoot } from '../storage-root'
import { tunnelThroughProxy } from '@aipoch/notebook-network-sandbox'
import type { ApplicationModuleBuilder } from '../application-runtime'
import { downloadImageResult } from '../image-model/download'
import { ImageModelService } from '../image-model/service'
import { netFetchWithManualRedirect } from '../network-fetch'
import { runtimeNetwork } from '../runtime-network'
import type { SessionAuxiliaryTurnUsageRecord } from '../session-persistence/auxiliary-turn-usage'
import type { ManagedFileVersionService } from '../managed-file-versions/service'
import type { SettingsService } from '../settings/service'
import { parseSystemProxyRules } from '../settings/system-proxy'
import { assertDiskReserve } from '../bounded-file-io'
import { LOCAL_RESOURCE_BUDGETS, ResourceBudgetExceededError } from '../resource-budget'
import { availableBytes } from '../storage/usage'
import { ImageModelError, MAX_IMAGE_BYTES } from '../image-model/contract'

export async function composeImageModel({
  settingsService,
  managedFileVersionService,
  recordAuxiliaryUsage,
  modules
}: {
  managedFileVersionService: Pick<ManagedFileVersionService, 'openUnpublishedVersion'>
  settingsService: SettingsService
  recordAuxiliaryUsage: (record: SessionAuxiliaryTurnUsageRecord) => Promise<void>
  modules: ApplicationModuleBuilder
}): Promise<ImageModelService> {
  return modules.add(undefined, () => {
    // During publication the pending file and the immutable Version briefly coexist.
    const resultBytes = MAX_IMAGE_BYTES * 2
    let reservedBytes = 0
    const service = new ImageModelService({
      retainWrite: acquireDataRootWriter,
      results: new ImageResultStore(resolveDataRoot, (context, { artifactId, versionId }) =>
        managedFileVersionService.openUnpublishedVersion(
          { source: 'artifact', projectId: context.projectId, fileId: artifactId },
          versionId
        )
      ),
      resolveTarget: (selection) => settingsService.imageModels.resolve(selection),
      fetch: netFetchWithManualRedirect,
      recordUsage: recordAuxiliaryUsage,
      reserveResult: async () => {
        reservedBytes += resultBytes
        try {
          assertDiskReserve(
            await availableBytes(resolveDataRoot()),
            reservedBytes,
            LOCAL_RESOURCE_BUDGETS.diskReserveBytes
          )
        } catch (error) {
          reservedBytes -= resultBytes
          if (!(error instanceof ResourceBudgetExceededError)) throw error
          throw new ImageModelError('STORAGE_FULL', 'Not enough disk space to save the image.')
        }
        return () => {
          reservedBytes -= resultBytes
        }
      },
      download: (url, signal, providerUrl, reserveDelivery) =>
        downloadImageResult(url, signal, {
          providerUrl,
          reserveDelivery,
          resolveProxy: async (target) => {
            const proxy = parseSystemProxyRules(await runtimeNetwork().resolveProxy(target))
            return proxy.HTTPS_PROXY ?? proxy.ALL_PROXY
          },
          tunnel: (proxy, address, port, signal) =>
            tunnelThroughProxy(proxy, address, port, undefined, signal)
        })
    })
    return { name: 'image-model', capability: service, dispose: () => service.close() }
  })
}
