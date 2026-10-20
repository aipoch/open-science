import { createLogger, errorLogFields } from '@aipoch/diagnostics/node'
import type {
  LiteratureCatalogCommand,
  LiteratureCatalogReceipt
} from '@aipoch/literature-library/contracts'
import type { ContentRepository } from '../storage/content-repository'
import type { LiteratureCatalog } from './catalog'

const literatureContextLog = createLogger('literature-reading-context')

export async function transactLiterature(
  literatureCatalog: Pick<LiteratureCatalog, 'transact' | 'contentBlobIdsForItems'>,
  contentRepository: Pick<ContentRepository, 'sweep'>,
  command: LiteratureCatalogCommand
): Promise<LiteratureCatalogReceipt> {
  if (command.kind !== 'delete-items-permanently') {
    return literatureCatalog.transact(command)
  }
  const contentBlobIds = await literatureCatalog.contentBlobIdsForItems(command.itemIds)
  const receipt = await literatureCatalog.transact(command)
  let cleanupPending = false
  try {
    const sweep = await contentRepository.sweep({
      createdBefore: new Date(Date.now() + 1),
      contentIds: contentBlobIds
    })
    cleanupPending = sweep.failedIds.length > 0
    if (cleanupPending) {
      literatureContextLog.warn('Permanent Literature deletion left content for later cleanup', {
        failedContentCount: sweep.failedIds.length
      })
    }
  } catch (error) {
    cleanupPending = true
    literatureContextLog.warn(
      'Permanent Literature deletion could not start content cleanup',
      errorLogFields(error)
    )
  }
  return { ...receipt, cleanupPending }
}
